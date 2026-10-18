using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;
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
/// moment it connects. The socket is server → client only; a client message other than Close is ignored.
/// </summary>
public sealed class SessionHub : BackgroundService
{
    private sealed class Client
    {
        public required WebSocket Socket { get; init; }

        /// <summary>
        /// A status client — the tray — rather than a browser looking at the app. It holds its socket
        /// open for the whole logon but only draws anything when someone opens its menu, so it doesn't
        /// need a browser's tick. See <see cref="NextTick"/>.
        /// </summary>
        public bool Indicator { get; init; }

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
    private DateTime _lastSentUtc = DateTime.MinValue;

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
    private readonly ILogger<SessionHub> _log;
    private readonly ConcurrentDictionary<Guid, Client> _clients = new();
    // Released by Poke and awaited (with a timeout) by the broadcast loop, so we wake on either an
    // explicit change or the next tick — whichever comes first. Capacity 1 coalesces bursts.
    private readonly SemaphoreSlim _wake = new(0, 1);
    private string? _last;

    public SessionHub(SessionManager mgr, HookEventStore hooks, UpdateService updates,
        Shells.ShellManager shells, ProjectStore projects, ILogger<SessionHub> log)
    {
        _mgr = mgr;
        _hooks = hooks;
        _updates = updates;
        _shells = shells;
        _projects = projects;
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
    }

    /// <summary>Request an immediate recompute + broadcast (coalesced with any pending wake).</summary>
    public void Poke()
    {
        try { _wake.Release(); } catch (SemaphoreFullException) { /* a wake is already pending */ }
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { BroadcastIfChanged(); }
            catch (Exception ex) { _log.LogDebug(ex, "session broadcast failed"); }

            try { await _wake.WaitAsync(NextTick(), ct); }
            catch (OperationCanceledException) { break; }
        }
    }

    /// <summary>
    /// How long to wait before recomputing: what a browser needs while anyone has one open, the slower
    /// tick when the only thing connected is a status client (and either way, no longer than it takes
    /// <see cref="Poke"/> to wake us).
    /// </summary>
    private TimeSpan NextTick() =>
        _clients.Values.Any(c => !c.Indicator) ? TickInterval : IndicatorTickInterval;

    private void BroadcastIfChanged()
    {
        if (_clients.IsEmpty) return; // nobody listening — don't bother recomputing
        var json = Serialize();
        var now = DateTime.UtcNow;
        // Send on any change, or at least every KeepAlive as a liveness ping (so a stalled client can
        // tell a live-but-idle stream from a dead socket).
        if (json == _last && now - _lastSentUtc < KeepAlive) return;
        _last = json;
        _lastSentUtc = now;
        var bytes = Encoding.UTF8.GetBytes(json);
        foreach (var c in _clients.Values)
            c.Outbox.Writer.TryWrite(bytes);
    }

    private string Serialize() =>
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
    /// <param name="indicator">
    /// Whether this is a status client (<c>?client=tray</c>) rather than a browser — see <see cref="NextTick"/>.
    /// </param>
    public async Task ServeAsync(WebSocket ws, bool indicator, CancellationToken hostCt)
    {
        var id = Guid.NewGuid();
        var client = new Client { Socket = ws, Indicator = indicator };
        _clients[id] = client;
        // A browser arriving wants the faster tick, and the loop only re-reads that when it wakes.
        if (!indicator) Poke();
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(hostCt);
        try
        {
            // Seed the newcomer immediately rather than making it wait for the next change.
            client.Outbox.Writer.TryWrite(Encoding.UTF8.GetBytes(_last ?? Serialize()));

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

            // READ loop: we expect no client → server data; just watch for the close handshake.
            var buf = new byte[1024];
            while (!cts.IsCancellationRequested)
            {
                WebSocketReceiveResult r;
                try { r = await ws.ReceiveAsync(buf, cts.Token); }
                catch (OperationCanceledException) { break; }
                catch (WebSocketException) { break; }
                if (r.MessageType == WebSocketMessageType.Close) break;
            }

            cts.Cancel();
            await writeLoop;
        }
        catch (OperationCanceledException) { }
        finally
        {
            _clients.TryRemove(id, out _);
            client.Outbox.Writer.TryComplete();
        }
    }

    public override void Dispose()
    {
        _mgr.Changed -= Poke;
        _hooks.Changed -= Poke;
        _updates.Changed -= Poke;
        base.Dispose();
    }
}
