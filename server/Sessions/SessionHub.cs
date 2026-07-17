using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;

namespace ClaudeWeb.Server.Sessions;

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

        // Bounded + DropOldest: each message is a full snapshot, so a slow client should just get the
        // latest — never a backlog. One reader (its write loop) drains it.
        public Channel<byte[]> Outbox { get; } = Channel.CreateBounded<byte[]>(
            new BoundedChannelOptions(8) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true });
    }

    // Recompute at least this often to catch transitions that don't flow through Changed.
    private static readonly TimeSpan TickInterval = TimeSpan.FromMilliseconds(1000);

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
    private readonly ILogger<SessionHub> _log;
    private readonly ConcurrentDictionary<Guid, Client> _clients = new();
    // Released by Poke and awaited (with a timeout) by the broadcast loop, so we wake on either an
    // explicit change or the next tick — whichever comes first. Capacity 1 coalesces bursts.
    private readonly SemaphoreSlim _wake = new(0, 1);
    private string? _last;

    public SessionHub(SessionManager mgr, HookEventStore hooks, ILogger<SessionHub> log)
    {
        _mgr = mgr;
        _hooks = hooks;
        _log = log;
        _mgr.Changed += Poke;
        // A hook event (busy/idle/waiting transition) should push to the browser at once, not wait
        // for the next periodic tick.
        _hooks.Changed += Poke;
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

            try { await _wake.WaitAsync(TickInterval, ct); }
            catch (OperationCanceledException) { break; }
        }
    }

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
            new { sessions = _mgr.List(), busy = _mgr.BusySessionIds(), waiting = _mgr.AwaitingInputIds() },
            JsonOpts);

    /// <summary>Register a browser socket: seed it with the current snapshot, then pump updates until it closes.</summary>
    public async Task ServeAsync(WebSocket ws, CancellationToken hostCt)
    {
        var id = Guid.NewGuid();
        var client = new Client { Socket = ws };
        _clients[id] = client;
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
        base.Dispose();
    }
}
