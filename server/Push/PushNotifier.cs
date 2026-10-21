using System.Net;
using System.Text.Json;
using Hangar.Server.Nodes;
using Hangar.Server.Sessions;
using WebPush;

namespace Hangar.Server.Push;

/// <summary>
/// Sends a Web Push notification when a session newly needs attention or newly starts waiting on a
/// prompt — the same two transitions the in-page UI surfaces (<c>web/src/App.tsx</c>), but detected
/// server-side so the alert still fires when every tab is closed (the whole point of push).
///
/// It mirrors how <see cref="SessionHub"/> stays current: recompute on a slow tick (to catch
/// poll-only transitions like the watchdog flipping to "attention") and immediately on any explicit
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
    private readonly PushSubscriptionStore _subs;
    private readonly VapidKeyStore _vapid;
    private readonly NodeMesh _mesh;
    private readonly NodeIdentityStore _identity;
    private readonly ILogger<PushNotifier> _log;
    private readonly WebPushClient _client = new();
    private readonly SemaphoreSlim _wake = new(0, 1);

    /// <summary>The marks a node's sessions carried at the last check — the state a transition is measured from.</summary>
    private sealed record Marks(HashSet<string> Attention, HashSet<string> Waiting, HashSet<string> Failed);

    /// <summary>A session as far as an alert needs it, whichever node it is on.</summary>
    private sealed record Row(string Id, string Name, string? WatchdogStatus, bool WatchdogEnabled);

    private Marks? _prev;
    // Per peer, from its first snapshot after it came online: a peer that was away (or this node, starting) doesn't
    // alert for everything that is already waiting there.
    private readonly Dictionary<string, Marks> _prevPeers = new();

    public PushNotifier(SessionManager mgr, HookEventStore hooks, PushSubscriptionStore subs,
        VapidKeyStore vapid, NodeMesh mesh, NodeIdentityStore identity, ILogger<PushNotifier> log)
    {
        _mgr = mgr;
        _hooks = hooks;
        _subs = subs;
        _vapid = vapid;
        _mesh = mesh;
        _identity = identity;
        _log = log;
        _mgr.Changed += Poke;
        _hooks.Changed += Poke;
        _mesh.Changed += Poke;
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
        var attention = sessions.Where(s => s.WatchdogStatus == "attention").Select(s => s.Id).ToHashSet();
        var waiting = _mgr.AwaitingInputIds().ToHashSet();
        var failed = _mgr.FailedSessionIds().ToHashSet();
        // What the waiting/failed sets are about, where the hooks said: a permission dialog names the
        // command it wants to run, and a failed turn names the error it died on. On a phone that detail
        // is most of the value — "Wants to run Bash: git push --force" is a decision you can take from
        // the lock screen; "Waiting on a prompt." only tells you to go and look.
        var details = _mgr.ActivityDetails();

        var prev = _prev;
        var now = new Marks(attention, waiting, failed);
        _prev = now;
        if (prev is null) return; // first tick: seed only

        await AlertAsync(_identity.Current.Id, null, sessions.Select(s => new Row(s.Id, s.Name, s.WatchdogStatus, s.WatchdogEnabled)),
            now, prev, id => details.GetValueOrDefault(id));
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
            var attention = rows.Where(r => r.WatchdogStatus == "attention").Select(r => r.Id).ToHashSet();
            var now = new Marks(attention, Ids(snap, "waiting"), Ids(snap, "failed"));
            var hadPrev = _prevPeers.TryGetValue(node.Id, out var prev);
            _prevPeers[node.Id] = now;
            if (!hadPrev) continue;
            var details = Details(snap);
            await AlertAsync(node.Id, node.Name, rows, now, prev!, id => details.GetValueOrDefault(id));
        }
        // Gone, offline or forgotten: it seeds again when it is back.
        foreach (var id in _prevPeers.Keys.Where(id => !online.Contains(id)).ToList()) _prevPeers.Remove(id);
    }

    /// <param name="nodeName">The peer's name, to put in front of the session's; null for this node's own.</param>
    private async Task AlertAsync(string nodeId, string? nodeName, IEnumerable<Row> sessions, Marks now, Marks prev,
        Func<string, SessionActivityDetail?> detailOf)
    {
        // No subscriptions => nothing to send; the marks above are still kept current, so the first transition
        // after a subscribe doesn't retroactively fire for a pre-existing state.
        if (_subs.All().Count == 0) return;

        foreach (var s in sessions)
        {
            var name = nodeName is null ? s.Name : $"{nodeName} · {s.Name}";
            // Tagged by node as well as session: two machines can mint the same id, and a phone hearing about a
            // session from its own node and from a peer of it should see one notification, not two.
            var key = $"{nodeId}:{s.Id}";
            var peer = nodeName is null ? null : nodeId;
            if (now.Attention.Contains(s.Id) && !prev.Attention.Contains(s.Id))
                await SendToAllAsync(
                    $"{name} — needs attention",
                    "Claude stopped recovering after repeated API errors.",
                    $"watchdog-{key}", s.Id, peer);

            if (now.Waiting.Contains(s.Id) && !prev.Waiting.Contains(s.Id))
                await SendToAllAsync(
                    $"{name} — Claude needs your input",
                    detailOf(s.Id)?.WaitingOn ?? "Waiting on a prompt.",
                    $"waiting-{key}", s.Id, peer);

            // A turn that died on a rate limit stops exactly like one that finished, so nothing else
            // here would ever fire for it — and it is the case where knowing early matters most, since
            // the session sits there doing nothing until someone comes back and retries it.
            //
            // Unless the watchdog has the session, in which case it is about to try the error again
            // and this alert would be telling you about a problem that is already being handled. That
            // one has its own alert for when it gives up, which is the point at which you are needed.
            if (now.Failed.Contains(s.Id) && !prev.Failed.Contains(s.Id) && !s.WatchdogEnabled)
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
            rows.Add(new Row(id, Clip(Str(s, "name") ?? "Session", 120), Str(s, "watchdogStatus"),
                s.TryGetProperty("watchdogEnabled", out var w) && w.ValueKind == JsonValueKind.True));
        }
        return rows;
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

    /// <param name="node">The peer the session is on; null for one of this node's own.</param>
    private async Task SendToAllAsync(string title, string body, string tag, string sessionId, string? node)
    {
        // Nothing can be signed for anyone: this run is on a stand-in keypair (see VapidKeyStore),
        // which every stored subscription would reject with a 403 — and a 403 isn't a prune, so the
        // only thing sending would achieve is one failed request per device per notification.
        if (_vapid.Ephemeral) return;
        var payload = JsonSerializer.Serialize(new { title, body, tag, sessionId, node });
        var vapid = new VapidDetails(_vapid.Keys.Subject, _vapid.Keys.PublicKey, _vapid.Keys.PrivateKey);

        foreach (var entry in _subs.All())
        {
            var sub = new PushSubscription(entry.Endpoint, entry.P256dh, entry.Auth);
            try
            {
                await _client.SendNotificationAsync(sub, payload, vapid);
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
        _client.Dispose();
        base.Dispose();
    }
}
