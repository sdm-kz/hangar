using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;
using Hangar.Server.Nodes;
using Hangar.Server.Update;

namespace Hangar.Server.Sessions;

/// <summary>
/// Pushes session-list changes to connected browsers over a WebSocket at <c>/hub/events</c>, so the
/// UI no longer has to poll <c>/api/sessions</c> and <c>/api/sessions/activity</c>. A single server
/// loop recomputes the snapshot — the session list plus the set of "busy" ids — and fans it out to
/// every client, but only when it actually differs from what was last sent. It recomputes on a slow
/// tick (to catch poll-only transitions: Claude going busy/idle, a process exiting, the watchdog
/// changing status) and immediately on any explicit change (<see cref="SessionManager.Changed"/>:
/// create/rename/remove/restore/watchdog). Each client is also seeded with the current snapshot the
/// moment it connects. The socket is server → client only, but for the two words a peer node sends on it
/// (see <see cref="ClientKind.Peer"/>); any other client message other than Close is ignored.
///
/// What this node knows of its peers rides along (plans/multi-node.md §5): <c>node</c> is this node, and
/// <c>nodes</c> every peer with its own snapshot as <see cref="NodeMesh"/> holds it. Not for a peer, though:
/// nodes do not mesh further, so what a peer is sent is this node's own picture alone.
/// </summary>
public sealed class SessionHub : BackgroundService
{
    public enum ClientKind
    {
        /// <summary>Someone looking at the app.</summary>
        Browser,

        /// <summary>
        /// A status client — the tray. It holds its socket open for the whole logon but only draws anything
        /// when someone opens its menu, so it doesn't need a browser's tick. See <see cref="NextTick"/>.
        /// </summary>
        Indicator,

        /// <summary>
        /// Another node's <see cref="NodeMesh"/>: connected all day like the tray, so slow too — until it says
        /// <c>fast</c>, which it does while a browser is looking at it, and <c>slow</c> again once none is.
        /// </summary>
        Peer,
    }

    private sealed class Client
    {
        public required WebSocket Socket { get; init; }
        public ClientKind Kind { get; init; }

        /// <summary>Whether it is sent this node's own picture only — see the class remarks.</summary>
        public bool OwnOnly { get; init; }

        /// <summary>A peer that asked for a browser's tick.</summary>
        public volatile bool Fast;

        // Bounded + DropOldest: each message is a full snapshot, so a slow client should just get the
        // latest — never a backlog. One reader (its write loop) drains it.
        public Channel<byte[]> Outbox { get; } = Channel.CreateBounded<byte[]>(
            new BoundedChannelOptions(8) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true });
    }

    // Recompute at least this often to catch transitions that don't flow through Changed.
    private static readonly TimeSpan TickInterval = TimeSpan.FromMilliseconds(1000);

    // ...but not for a tray on its own. It is connected from logon to logoff, which is what stopped the
    // "nobody is listening" shortcut below from ever applying again: the list was rebuilt every second all
    // day, and rebuilding it opens a process handle per running session — fifty sessions, a hundred handle
    // opens a second, with no browser open. A real change still goes out at once (Poke), so the only thing
    // this costs is how soon a poll-only transition reaches a menu nobody is looking at.
    private static readonly TimeSpan IndicatorTickInterval = TimeSpan.FromSeconds(5);

    // Re-send the snapshot at least this often even when nothing changed, as a keepalive: it lets a
    // client detect a half-open socket (silence => dead => reconnect) and self-heals any dropped frame.
    private static readonly TimeSpan KeepAlive = TimeSpan.FromSeconds(4);

    // Match the minimal-API wire format: camelCase properties, enums as their string names.
    private static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter() },
    };

    private readonly SessionManager _mgr;
    private readonly HookEventStore _hooks;
    private readonly UpdateService _updates;
    private readonly Shells.ShellManager _shells;
    private readonly ProjectStore _projects;
    private readonly NodeMesh _mesh;
    private readonly NodeIdentityStore _identity;
    private readonly ILogger<SessionHub> _log;
    private readonly ConcurrentDictionary<Guid, Client> _clients = new();
    // Released by Poke and awaited (with a timeout) by the broadcast loop, so we wake on either an
    // explicit change or the next tick — whichever comes first. Capacity 1 coalesces bursts.
    private readonly SemaphoreSlim _wake = new(0, 1);
    // The last of each picture sent, and when: this node's own (what a peer gets), and the whole one with the
    // peers in it (everyone else). Kept apart, so a peer's change doesn't reach a peer as a change of this node's.
    private readonly Sent _own = new();
    private readonly Sent _full = new();

    private sealed class Sent
    {
        public string? Json;
        public DateTime AtUtc = DateTime.MinValue;
    }

    public SessionHub(SessionManager mgr, HookEventStore hooks, UpdateService updates,
        Shells.ShellManager shells, ProjectStore projects, NodeMesh mesh, NodeIdentityStore identity,
        ILogger<SessionHub> log)
    {
        _mgr = mgr;
        _hooks = hooks;
        _updates = updates;
        _shells = shells;
        _projects = projects;
        _mesh = mesh;
        _identity = identity;
        _log = log;
        _mgr.Changed += Poke;
        // A hook event (busy/idle/waiting transition) should push to the browser at once, not wait
        // for the next periodic tick.
        _hooks.Changed += Poke;
        // A newly staged build should light the "Update available" button up straight away — and the
        // "updating..." state has to reach the browser before the app stops to install it.
        _updates.Changed += Poke;
        // A shell opened or closed anywhere (another browser, a session being stopped) changes the
        // revision below, which is what tells a browser its tab strip is stale.
        _shells.Changed += Poke;
        // ...and a command starting or ending in one of them is what lights its tab and its session's
        // row, so it goes out at once too.
        _shells.ActivityChanged += Poke;
        // A peer's snapshot or status moving is news for every browser here (never a keep-alive: the mesh
        // drops those) — but not about this node, whose own picture is reused rather than rebuilt for it.
        _mesh.Changed += PokePeers;
    }

    /// <summary>Request an immediate recompute + broadcast (coalesced with any pending wake).</summary>
    public void Poke()
    {
        Volatile.Write(ref _ownStale, 1);
        Wake();
    }

    /// <summary>
    /// The same for a change in a peer's picture only. This node's own list isn't rebuilt for it: rebuilding
    /// opens a process handle per session, which the tray's slow tick is there to avoid, and a peer changes
    /// whenever any of its sessions goes busy or idle.
    /// </summary>
    private void PokePeers() => Wake();

    private void Wake()
    {
        try { _wake.Release(); } catch (SemaphoreFullException) { /* a wake is already pending */ }
    }

    // Set by anything that may have changed this node's own picture; a wake without it is a peer's news.
    private int _ownStale = 1;

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        var ticked = true;
        while (!ct.IsCancellationRequested)
        {
            // The tick itself always rebuilds: it is what catches the transitions nothing pokes for.
            var rebuild = Interlocked.Exchange(ref _ownStale, 0) == 1 || ticked;
            try { BroadcastIfChanged(rebuild); }
            catch (Exception ex) { _log.LogDebug(ex, "session broadcast failed"); }

            try { ticked = !await _wake.WaitAsync(NextTick(), ct); }
            catch (OperationCanceledException) { break; }
        }
    }

    /// <summary>
    /// How long to wait before recomputing: what a browser needs while anyone has one open, the slower
    /// tick when the only thing connected is a status client (and either way, no longer than it takes
    /// <see cref="Poke"/> to wake us).
    /// </summary>
    private TimeSpan NextTick() =>
        _clients.Values.Any(c => c.Kind == ClientKind.Browser || (c.Kind == ClientKind.Peer && c.Fast))
            ? TickInterval
            : IndicatorTickInterval;

    private void BroadcastIfChanged(bool rebuild)
    {
        if (_clients.IsEmpty) return; // nobody listening — don't bother recomputing
        var own = rebuild || _own.Json is null ? SerializeOwn() : _own.Json;
        var now = DateTime.UtcNow;
        Send(_own, own, now, own: true);
        if (_clients.Values.Any(c => !c.OwnOnly)) Send(_full, WithNodes(own), now, own: false);
    }

    // Send on any change, or at least every KeepAlive as a liveness ping (so a stalled client can tell a
    // live-but-idle stream from a dead socket).
    private void Send(Sent sent, string json, DateTime now, bool own)
    {
        if (json == sent.Json && now - sent.AtUtc < KeepAlive) return;
        sent.Json = json;
        sent.AtUtc = now;
        var bytes = Encoding.UTF8.GetBytes(json);
        foreach (var c in _clients.Values)
            if (c.OwnOnly == own) c.Outbox.Writer.TryWrite(bytes);
    }

    /// <summary>
    /// This node's picture with its peers' added: <c>node</c> (who this is, so a browser can tell its own
    /// sessions' notifications from a peer's) and <c>nodes</c>, each peer with its snapshot verbatim.
    /// </summary>
    private string WithNodes(string own)
    {
        var me = _identity.Current;
        var extra = JsonSerializer.Serialize(new { node = new { me.Id, me.Name, me.Color, Os = NodePairing.OsName() }, nodes = _mesh.Nodes() }, JsonOpts);
        return $"{own[..^1]},{extra[1..]}";
    }

    private string SerializeOwn() =>
        JsonSerializer.Serialize(
            new
            {
                sessions = _mgr.List(),
                busy = _mgr.BusySessionIds(),
                waiting = _mgr.AwaitingInputIds(),
                compacting = _mgr.CompactingSessionIds(),
                failed = _mgr.FailedSessionIds(),
                // Not an activity: text typed into a session's input box and left there unsent.
                drafts = _mgr.DraftSessionIds(),
                // Only the sessions with something to say are in here, so on a quiet machine it is an
                // empty object and the snapshot is the size it always was.
                activity = _mgr.ActivityDetails(),
                update = _updates.Status,
                // Only the number rides the snapshot, not the shells: a browser holding an older one
                // re-fetches the session's own tabs, and the rest never hear about it. Same trick as
                // SessionInfo.UiRev.
                shellsRev = _shells.Revision,
                // Unlike the shells themselves, what their commands are doing does travel: it is what
                // a sidebar row shows for a session nobody has open. Only shells with a command to
                // report are in it, so on a quiet machine it is an empty object.
                shells = _shells.Activity(),
                // Same again for the projects: only the revision travels, and a browser that sees it
                // move re-reads /api/projects. The server changes them on its own now — a child
                // session joining its host's project — so a browser can no longer assume the list it
                // holds is the one it last asked for.
                projectsRev = _projects.Revision,
            },
            JsonOpts);

    /// <summary>Register a browser socket: seed it with the current snapshot, then pump updates until it closes.</summary>
    /// <param name="kind">What is connecting — see <see cref="ClientKind"/> and <see cref="NextTick"/>.</param>
    /// <param name="ownOnly">Send this node's own picture alone: true for anything that came in with a peer token.</param>
    public async Task ServeAsync(WebSocket ws, ClientKind kind, bool ownOnly, CancellationToken hostCt)
    {
        var id = Guid.NewGuid();
        var client = new Client { Socket = ws, Kind = kind, OwnOnly = ownOnly || kind == ClientKind.Peer };
        _clients[id] = client;
        // A browser arriving wants the faster tick, and the loop only re-reads that when it wakes.
        if (kind == ClientKind.Browser) Wake();
        UpdateMeshPace();
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(hostCt);
        try
        {
            // Seed the newcomer immediately rather than making it wait for the next change — with what was last
            // sent only while that is current. Nothing is sent while nobody is connected, so on a node nobody
            // was watching it is however old the last viewer left it, and a first picture is not one to get
            // wrong: a peer's mesh seeds its alerts from it, and a browser its own, and everything that
            // changed in between would read as having only just happened.
            var now = DateTime.UtcNow;
            var own = _own.Json is { } lastOwn && now - _own.AtUtc < KeepAlive ? lastOwn : SerializeOwn();
            var seed = client.OwnOnly ? own
                : _full.Json is { } lastFull && ReferenceEquals(own, _own.Json) && now - _full.AtUtc < KeepAlive ? lastFull
                : WithNodes(own);
            client.Outbox.Writer.TryWrite(Encoding.UTF8.GetBytes(seed));

            // WRITE loop: queued snapshots → WS. Swallow faults; a dropped socket must tear down only
            // this viewer (the read loop below handles teardown), never surface as an unhandled fault.
            var writeLoop = Task.Run(async () =>
            {
                try
                {
                    await foreach (var msg in client.Outbox.Reader.ReadAllAsync(cts.Token))
                        await ws.SendAsync(msg, WebSocketMessageType.Text, true, cts.Token);
                }
                catch { /* cancelled or socket gone */ }
            }, cts.Token);

            // READ loop: no client → server data but a peer's pace; otherwise just watch for the close handshake.
            var buf = new byte[1024];
            while (!cts.IsCancellationRequested)
            {
                WebSocketReceiveResult r;
                try { r = await ws.ReceiveAsync(buf, cts.Token); }
                catch (OperationCanceledException) { break; }
                catch (WebSocketException) { break; }
                if (r.MessageType == WebSocketMessageType.Close) break;
                if (client.Kind == ClientKind.Peer && r.MessageType == WebSocketMessageType.Text && r.EndOfMessage)
                {
                    var word = Encoding.UTF8.GetString(buf, 0, r.Count);
                    if (word is "fast" or "slow")
                    {
                        client.Fast = word == "fast";
                        Wake(); // the tick is only re-read on a wake
                    }
                }
            }

            cts.Cancel();
            await writeLoop;
        }
        catch (OperationCanceledException) { }
        finally
        {
            _clients.TryRemove(id, out _);
            client.Outbox.Writer.TryComplete();
            UpdateMeshPace();
        }
    }

    /// <summary>Ask the peers for a browser's pace while a browser is here to see it, and the slow one otherwise.</summary>
    private void UpdateMeshPace()
    {
        // Read and set together: a browser leaving as another arrives must not have the first one's "slow"
        // land after the second one's "fast".
        lock (_pace) _mesh.SetFast(_clients.Values.Any(c => c.Kind == ClientKind.Browser));
    }

    private readonly object _pace = new();

    public override void Dispose()
    {
        _mgr.Changed -= Poke;
        _hooks.Changed -= Poke;
        _updates.Changed -= Poke;
        _mesh.Changed -= PokePeers;
        base.Dispose();
    }
}
