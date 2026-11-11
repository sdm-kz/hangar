using System.Net;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Hangar.Server.Nodes;
using Hangar.Server.Sessions;
using WebPush;

namespace Hangar.Server.Push;

/// <summary>
/// Sends a Web Push notification when a session newly starts waiting on a prompt or newly ends a turn
/// on an error — the same transitions the in-page UI surfaces (<c>web/src/App.tsx</c>), but detected
/// server-side so the alert still fires when every tab is closed (the whole point of push).
///
/// It mirrors how <see cref="SessionHub"/> stays current: recompute on a slow tick (to catch
/// poll-only transitions like a prompt appearing on screen) and immediately on any explicit
/// <see cref="SessionManager.Changed"/> / hook change. Transitions are diffed against the previous
/// snapshot, seeded on the first tick so a session already stuck/waiting at startup doesn't alert.
///
/// De-dup with the in-page notification is handled per-device in the service worker (it suppresses the
/// OS notification when an app window is focused) plus the shared notification <c>tag</c>; we do NOT
/// gate sending on "any client connected", since that would silence the phone whenever a desktop tab
/// happens to be open.
///
/// A peer's sessions alert from here too (plans/multi-node.md §5): a browser subscribes to one node, and
/// <see cref="NodeMesh"/> already sees the rest go waiting. A phone subscribed on the peer as well gets that
/// alert twice — once from the peer, once from here — under the same tag, <c>kind-node:session</c>, so the
/// second replaces the first. Only a peer's alert names its node in the payload: the one a node sends about
/// its own sessions opens on its own origin, and that is the node it is about.
/// </summary>
public sealed class PushNotifier : BackgroundService
{
    // Match SessionHub's tick so we notice poll-only transitions about as fast as the UI does.
    private static readonly TimeSpan TickInterval = TimeSpan.FromMilliseconds(1000);

    private readonly SessionManager _mgr;
    private readonly HookEventStore _hooks;
    private readonly SessionNoticeStore _notices;
    private readonly PushSubscriptionStore _subs;
    private readonly VapidKeyStore _vapid;
    private readonly NodeMesh _mesh;
    private readonly NodeIdentityStore _identity;
    private readonly ILogger<PushNotifier> _log;
    private readonly WebPushClient _client = new();
    private static readonly TimeSpan SendTimeout = TimeSpan.FromSeconds(10);
    private readonly SemaphoreSlim _wake = new(0, 1);

    /// <summary>The marks a node's sessions carried at the last check — the state a transition is measured from.</summary>
    // Notices are the ids of the ones already sent: unlike the rest, each is an event, not a state.
    private sealed record Marks(HashSet<string> Waiting, HashSet<string> Failed, HashSet<string> Notices);

    /// <summary>A session as far as an alert needs it, whichever node it is on.</summary>
    private sealed record Row(string Id, string Name);

    private Marks? _prev;
    // Per peer, from its first snapshot after it came online: a peer that was away (or this node, starting) doesn't
    // alert for everything that is already waiting there.
    private readonly Dictionary<string, Marks> _prevPeers = new();
    // When each peer dropped out of the mesh's picture (Unix ms), so its notices from the gap are sent on its return.
    private readonly Dictionary<string, long> _peerGoneAt = new();

    public PushNotifier(SessionManager mgr, HookEventStore hooks, PushSubscriptionStore subs,
        VapidKeyStore vapid, NodeMesh mesh, NodeIdentityStore identity, SessionNoticeStore notices,
        ILogger<PushNotifier> log)
    {
        _mgr = mgr;
        _notices = notices;
        _hooks = hooks;
        _subs = subs;
        _vapid = vapid;
        _mesh = mesh;
        _identity = identity;
        _log = log;
        _mgr.Changed += Poke;
        _hooks.Changed += Poke;
        _mesh.Changed += Poke;
        _notices.Changed += Poke;
    }

    private void Poke()
    {
        try { _wake.Release(); } catch (SemaphoreFullException) { /* already pending */ }
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await CheckAsync(); }
            catch (Exception ex) { _log.LogDebug(ex, "push transition check failed"); }
            try { await CheckPeersAsync(); }
            catch (Exception ex) { _log.LogDebug(ex, "push transition check for the peers failed"); }

            try { await _wake.WaitAsync(TickInterval, ct); }
            catch (OperationCanceledException) { break; }
        }
    }

    private async Task CheckAsync()
    {
        var sessions = _mgr.List();
        var waiting = _mgr.AwaitingInputIds().ToHashSet();
        var failed = _mgr.FailedSessionIds().ToHashSet();
        // What the waiting/failed sets are about, where the hooks said: a permission dialog names the
        // command it wants to run, and a failed turn names the error it died on. On a phone that detail
        // is most of the value — "Wants to run Bash: git push --force" is a decision you can take from
        // the lock screen; "Waiting on a prompt." only tells you to go and look.
        var details = _mgr.ActivityDetails();
        var notices = _notices.Recent();

        var prev = _prev;
        var now = new Marks(waiting, failed, notices.Select(n => n.Id).ToHashSet());
        _prev = now;
        if (prev is null) return; // first tick: seed only

        await AlertAsync(_identity.Current.Id, null, sessions.Select(s => new Row(s.Id, s.Name)),
            now, prev, id => details.GetValueOrDefault(id), notices);
    }

    /// <summary>The same transitions on every peer the mesh holds a snapshot of, alerted from here.</summary>
    private async Task CheckPeersAsync()
    {
        var online = new HashSet<string>();
        foreach (var node in _mesh.Nodes())
        {
            if (node.Snapshot is not { } snap) continue;
            online.Add(node.Id);
            var rows = Rows(snap);
            var notices = Notices(snap);
            var now = new Marks(Ids(snap, "waiting"), Ids(snap, "failed"), notices.Select(n => n.Id).ToHashSet());
            var hadPrev = _prevPeers.TryGetValue(node.Id, out var prev);
            _prevPeers[node.Id] = now;
            if (!hadPrev)
            {
                // Back after a gap: its states are seeded, as on first sight — but a notice is an event,
                // and one it sent while the link was down is still news. Those, and only those, go out.
                if (!_peerGoneAt.Remove(node.Id, out var goneAt)) continue;
                prev = now with { Notices = notices.Where(n => n.At <= goneAt).Select(n => n.Id).ToHashSet() };
            }
            var details = Details(snap);
            await AlertAsync(node.Id, node.Name, rows, now, prev!, id => details.GetValueOrDefault(id), notices);
        }
        // Gone, offline or forgotten: it seeds again when it is back, noting when it went for its notices.
        foreach (var id in _prevPeers.Keys.Where(id => !online.Contains(id)).ToList())
        {
            _prevPeers.Remove(id);
            _peerGoneAt[id] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        }
        // A peer that never comes back is forgotten with its notices' lifetime.
        var stale = DateTimeOffset.UtcNow.AddMinutes(-15).ToUnixTimeMilliseconds();
        foreach (var id in _peerGoneAt.Where(kv => kv.Value < stale).Select(kv => kv.Key).ToList()) _peerGoneAt.Remove(id);
    }

    /// <param name="nodeName">The peer's name, to put in front of the session's; null for this node's own.</param>
    private async Task AlertAsync(string nodeId, string? nodeName, IEnumerable<Row> sessions, Marks now, Marks prev,
        Func<string, SessionActivityDetail?> detailOf, IReadOnlyList<SessionNotice> notices)
    {
        // No subscriptions => nothing to send; the marks above are still kept current, so the first transition
        // after a subscribe doesn't retroactively fire for a pre-existing state.
        if (_subs.All().Count == 0) return;

        // What a session asked to tell you, each once. Under the session's name, as every alert here is,
        // and tagged by the notice rather than the session: two of them are two things to read.
        var rows = sessions.ToList();
        foreach (var n in notices.Where(n => !prev.Notices.Contains(n.Id)))
        {
            var session = rows.FirstOrDefault(r => r.Id == n.SessionId)?.Name ?? "Session";
            var name = nodeName is null ? session : $"{nodeName} · {session}";
            await SendToAllAsync(n.Title is null ? name : $"{name} — {n.Title}", n.Message,
                $"notice-{nodeId}:{n.Id}", n.SessionId, nodeName is null ? null : nodeId);
        }

        foreach (var s in rows)
        {
            var name = nodeName is null ? s.Name : $"{nodeName} · {s.Name}";
            // Tagged by node as well as session: two machines can mint the same id, and a phone hearing about a
            // session from its own node and from a peer of it should see one notification, not two.
            var key = $"{nodeId}:{s.Id}";
            var peer = nodeName is null ? null : nodeId;
            if (now.Waiting.Contains(s.Id) && !prev.Waiting.Contains(s.Id))
                await SendToAllAsync(
                    $"{name} — Claude needs your input",
                    detailOf(s.Id)?.WaitingOn ?? "Waiting on a prompt.",
                    $"waiting-{key}", s.Id, peer);

            // A turn that died on a rate limit stops exactly like one that finished, so nothing else
            // here would ever fire for it — and it is the case where knowing early matters most, since
            // the session sits there doing nothing until someone comes back and retries it.
            if (now.Failed.Contains(s.Id) && !prev.Failed.Contains(s.Id))
                await SendToAllAsync(
                    $"{name} — Claude stopped early",
                    FailureLine(detailOf(s.Id)),
                    $"failed-{key}", s.Id, peer);
        }
    }

    // ---- Reading a peer's snapshot: only the fields an alert needs, and nothing it sent is trusted to be there.

    private static List<Row> Rows(JsonElement snap)
    {
        var rows = new List<Row>();
        if (!snap.TryGetProperty("sessions", out var sessions) || sessions.ValueKind != JsonValueKind.Array) return rows;
        foreach (var s in sessions.EnumerateArray())
        {
            // An id is a GUID's hex: anything else is no session of a build this one knows, and it would ride
            // the push payload (the tag, the session) to every device.
            if (s.ValueKind != JsonValueKind.Object || Str(s, "id") is not { Length: > 0 and <= 64 } id) continue;
            rows.Add(new Row(id, Clip(Str(s, "name") ?? "Session", 120)));
        }
        return rows;
    }

    // A peer's notices, each checked as a session row is: an id the length a notice id is, and text cut to
    // what this node would have accepted itself.
    private static List<SessionNotice> Notices(JsonElement snap)
    {
        var list = new List<SessionNotice>();
        if (!snap.TryGetProperty("notices", out var all) || all.ValueKind != JsonValueKind.Array) return list;
        foreach (var n in all.EnumerateArray())
        {
            if (n.ValueKind != JsonValueKind.Object
                || Str(n, "id") is not { Length: > 0 and <= 32 } id
                || Str(n, "sessionId") is not { Length: > 0 and <= 64 } sessionId
                || Str(n, "message") is not { Length: > 0 } message) continue;
            var title = Str(n, "title") is { Length: > 0 } t ? Clip(t, SessionNoticeStore.MaxTitle) : null;
            var at = n.TryGetProperty("at", out var a) && a.ValueKind == JsonValueKind.Number && a.TryGetInt64(out var ms) ? ms : 0;
            list.Add(new SessionNotice(id, sessionId, title, Clip(message, SessionNoticeStore.MaxMessage), at));
        }
        return list;
    }

    private static HashSet<string> Ids(JsonElement snap, string field)
    {
        var ids = new HashSet<string>();
        if (snap.TryGetProperty(field, out var list) && list.ValueKind == JsonValueKind.Array)
            foreach (var id in list.EnumerateArray())
                if (id.ValueKind == JsonValueKind.String) ids.Add(id.GetString()!);
        return ids;
    }

    private static Dictionary<string, SessionActivityDetail> Details(JsonElement snap)
    {
        var map = new Dictionary<string, SessionActivityDetail>();
        if (!snap.TryGetProperty("activity", out var activity) || activity.ValueKind != JsonValueKind.Object) return map;
        foreach (var p in activity.EnumerateObject())
            if (p.Value.ValueKind == JsonValueKind.Object)
                map[p.Name] = new SessionActivityDetail(Opt(p.Value, "waitingOn"), Opt(p.Value, "failure"), Opt(p.Value, "failureMessage"));
        return map;
    }

    private static string? Str(JsonElement obj, string name) =>
        obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static string? Opt(JsonElement obj, string name) => Str(obj, name) is { } v ? Clip(v, 300) : null;

    private static string Clip(string value, int max) => value.Length > max ? value[..max] : value;

    /// <summary>
    /// One line for why a turn ended badly: Claude's own parting message when it left one, and failing
    /// that the hook's error name spelled out — <c>rate_limit</c> is a phrase, not a sentence.
    /// </summary>
    private static string FailureLine(SessionActivityDetail? detail) =>
        detail?.FailureMessage
        ?? detail?.Failure switch
        {
            "rate_limit" => "Hit the rate limit — the turn didn’t finish.",
            null => "The turn ended on an error.",
            var other => $"The turn ended on an error ({other}).",
        };

    private static readonly JsonSerializerOptions PayloadJson = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    // Cut to at most this many UTF-8 bytes, never through a character (a surrogate pair counts as one).
    private static string ClipBytes(string value, int maxBytes)
    {
        if (Encoding.UTF8.GetByteCount(value) <= maxBytes) return value;
        var bytes = 0;
        var end = 0;
        foreach (var rune in value.EnumerateRunes())
        {
            if (bytes + rune.Utf8SequenceLength > maxBytes - 3) break; // room for the ellipsis
            bytes += rune.Utf8SequenceLength;
            end += rune.Utf16SequenceLength;
        }
        return value[..end] + "…";
    }

    /// <param name="node">The peer the session is on; null for one of this node's own.</param>
    private async Task SendToAllAsync(string title, string body, string tag, string sessionId, string? node)
    {
        // Nothing can be signed for anyone: this run is on a stand-in keypair (see VapidKeyStore),
        // which every stored subscription would reject with a 403 — and a 403 isn't a prune, so the
        // only thing sending would achieve is one failed request per device per notification.
        if (_vapid.Ephemeral) return;
        // A push carries about 4 KB, and the default encoder writes every non-ASCII character as a six-byte
        // escape: a long Russian message would come out at three times its size and be refused by the push
        // service, quietly, per device. Written as UTF-8 instead (it never lands in HTML), and the text cut
        // to a byte budget that leaves room for the rest.
        var payload = JsonSerializer.Serialize(
            new { title = ClipBytes(title, 300), body = ClipBytes(body, 2400), tag, sessionId, node }, PayloadJson);
        var vapid = new VapidDetails(_vapid.Keys.Subject, _vapid.Keys.PublicKey, _vapid.Keys.PrivateKey);

        foreach (var entry in _subs.All())
        {
            var sub = new PushSubscription(entry.Endpoint, entry.P256dh, entry.Auth);
            try
            {
                // Each subscriber is sent to in turn, so one push endpoint that never answers would hold up
                // every other device's notification for the client's default 100 s. A push service answers
                // in well under a second; one that hasn't in ten is not going to.
                using var timeout = new CancellationTokenSource(SendTimeout);
                await _client.SendNotificationAsync(sub, payload, vapid, timeout.Token);
            }
            catch (WebPushException ex) when (
                ex.StatusCode == HttpStatusCode.Gone || ex.StatusCode == HttpStatusCode.NotFound)
            {
                // The push service says this subscription is dead (unsubscribed / app removed) — drop it.
                _subs.Remove(entry.Endpoint);
                _log.LogInformation("Pruned dead push subscription ({Status})", (int)ex.StatusCode);
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "Failed to deliver push notification");
            }
        }
    }

    public override void Dispose()
    {
        _mgr.Changed -= Poke;
        _hooks.Changed -= Poke;
        _mesh.Changed -= Poke;
        _notices.Changed -= Poke;
        _client.Dispose();
        base.Dispose();
    }
}
