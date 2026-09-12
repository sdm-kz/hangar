using System.IO.Pipes;
using System.Text;
using System.Threading.Channels;
using ClaudeWeb.Pty;

namespace ClaudeWeb.Server.Sessions.Pty;

/// <summary>
/// The web app's end of a pty host: an <see cref="ITerminal"/> backed by a named pipe instead of a
/// pseudoconsole this process owns. Output frames arriving from the host are fanned out to viewers
/// exactly as the in-process channel used to do; writes and resizes go back down the pipe.
/// </summary>
/// <remarks>
/// <para><b>Disposing this does not end the session.</b> It closes the pipe and nothing else — the
/// host keeps the child running and holds the scrollback until someone attaches again. That
/// asymmetry is the whole point of the split, so read <see cref="Dispose"/> before changing it.</para>
/// <para>Busy / waiting / compacting / watchdog status are <b>pushed</b> by the host and cached here, never asked
/// for: <c>SessionHub</c> samples them about once a second per session, and a synchronous round-trip
/// over the pipe per sample would be absurd. The host is also the only honest place to compute them,
/// now that the watchdog lives there — it keeps watching, and keeps recovering the session, while no
/// web app is attached at all.</para>
/// </remarks>
public sealed class PtyHostClient : ITerminal
{
    private const int RingCapacity = 512 * 1024; // recent VT bytes kept for reconnect replay

    private readonly NamedPipeClientStream _pipe;
    private readonly ILogger _log;
    // Seeded from the scrollback the host replayed at handshake and grown with everything since, so a
    // browser tab that opens later gets the whole picture — the host replays per CLIENT, not per
    // viewer. (The host keeps its own ring; this one exists purely to fan out to several tabs.)
    private readonly RingBuffer _ring = new(RingCapacity);
    private readonly Dictionary<Guid, ChannelWriter<byte[]>> _subs = new();
    private readonly object _lock = new();
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private readonly CancellationTokenSource _closing = new();

    private bool _completed;
    private bool _disposed;
    private string? _remoteUrl;
    private short _cols;
    private short _rows;

    // Last `state` push from the host. The defaults are the safe reading for a session we have not
    // heard about yet: not busy, not waiting, not compacting, healthy.
    private bool _busy;
    private bool _waiting;
    private bool _compacting;
    private string _watchdogStatus = "healthy";

    /// <summary>The session's id, for log lines that have to be readable months later.</summary>
    public string SessionId { get; }

    public int ProcessId { get; }

    /// <summary>The child's start time in UTC ticks, pinning the exact process against PID reuse.</summary>
    public long ProcessStartTicks { get; }

    /// <summary>Whether the host reported the child as already gone when we attached.</summary>
    public bool AlreadyExited { get; }

    public short Cols { get { lock (_lock) return _cols; } }
    public short Rows { get { lock (_lock) return _rows; } }

    public string? RemoteUrl { get { lock (_lock) return _remoteUrl; } }

    public event Action<string>? RenameCommandDetected;
    public event Action<string>? ColorCommandDetected;
    public event Action<int>? Exited;

    /// <summary>Raised when a pushed <c>state</c> lands, so the UI can be told without waiting for a tick.</summary>
    public event Action? StateChanged;

    /// <summary>True when Claude appears to be actively generating output (not just echoing typing).</summary>
    public bool IsBusy { get { lock (_lock) return _busy; } }

    /// <summary>True when a permission/confirmation prompt appears to be waiting on the user.</summary>
    public bool IsAwaitingInput { get { lock (_lock) return _waiting; } }

    /// <summary>True while Claude is compacting the conversation (auto-compaction or <c>/compact</c>).</summary>
    public bool IsCompacting { get { lock (_lock) return _compacting; } }

    /// <summary>The host watchdog's view of the session: "healthy" | "recovering" | "attention".</summary>
    public string WatchdogStatus { get { lock (_lock) return _watchdogStatus; } }

    private PtyHostClient(NamedPipeClientStream pipe, string sessionId, PtyControl welcome, byte[] replay, ILogger log)
    {
        _pipe = pipe;
        _log = log;
        SessionId = sessionId;
        ProcessId = welcome.ChildPid;
        ProcessStartTicks = welcome.ChildStartTicks;
        AlreadyExited = welcome.Exited;
        _remoteUrl = welcome.RemoteUrl;
        _cols = (short)Math.Max(1, welcome.Cols);
        _rows = (short)Math.Max(1, welcome.Rows);
        // Seed the ring from the replay, so a viewer attaching now sees the screen as it stands rather
        // than only what happens to arrive from here on.
        if (replay.Length > 0) _ring.Append(replay);
    }

    /// <summary>
    /// Connect to a host's pipe and complete the handshake. Returns null when nothing answers within
    /// <paramref name="timeoutMs"/> — which is how a stale state file is told from a live host.
    /// </summary>
    public static async Task<PtyHostClient?> ConnectAsync(
        string pipeName, string sessionId, int timeoutMs, ILogger log, CancellationToken ct = default)
    {
        var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        try
        {
            await pipe.ConnectAsync(timeoutMs, ct);

            await PtyFrame.WriteAsync(pipe, PtyFrameType.Control,
                new PtyControl { Type = "hello", Protocol = PtyFrame.Protocol }.ToPayload(), ct);

            // The host answers with a welcome, then (if there is any) one output frame of scrollback.
            var first = await PtyFrame.ReadAsync(pipe, ct);
            if (first is not { Type: PtyFrameType.Control } w || PtyControl.Parse(w.Payload) is not { Type: "welcome" } welcome)
            {
                log.LogWarning("Pty host on '{Pipe}' did not answer the handshake; treating it as unusable.", pipeName);
                await pipe.DisposeAsync();
                return null;
            }

            // A future host may speak a newer protocol. Ours is additive, so a higher number is fine to
            // talk to; a LOWER one than we require would not be, and there is no such version yet.
            if (welcome.Protocol < PtyFrame.Protocol)
            {
                log.LogWarning("Pty host on '{Pipe}' speaks protocol {Theirs}, we need {Ours}; leaving it alone.",
                    pipeName, welcome.Protocol, PtyFrame.Protocol);
                await pipe.DisposeAsync();
                return null;
            }

            // Exactly one output frame follows the welcome: the scrollback, empty if the session has
            // printed nothing yet. Unconditional on both sides, so there is nothing to time out on and
            // no way to cancel mid-frame and desynchronize the stream.
            var replay = await PtyFrame.ReadAsync(pipe, ct) is { Type: PtyFrameType.Output } r
                ? r.Payload
                : Array.Empty<byte>();

            var client = new PtyHostClient(pipe, sessionId, welcome, replay, log);
            client.StartReadPump();
            log.LogInformation("Attached to pty host for session {Id} on '{Pipe}' (child pid {Pid}, {Bytes} bytes of scrollback).",
                sessionId, pipeName, welcome.ChildPid, replay.Length);
            return client;
        }
        catch (Exception ex) when (ex is TimeoutException or OperationCanceledException or IOException or UnauthorizedAccessException)
        {
            log.LogDebug(ex, "No pty host answered on '{Pipe}'", pipeName);
            await pipe.DisposeAsync();
            return null;
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Could not attach to the pty host on '{Pipe}'", pipeName);
            await pipe.DisposeAsync();
            return null;
        }
    }

    private void StartReadPump() =>
        _ = Task.Run(() => ReadPumpAsync(_closing.Token), CancellationToken.None);

    private async Task ReadPumpAsync(CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested)
            {
                var frame = await PtyFrame.ReadAsync(_pipe, ct);
                if (frame is not { } f) break; // the host closed the pipe
                switch (f.Type)
                {
                    case PtyFrameType.Output:
                        OnOutput(f.Payload);
                        break;
                    case PtyFrameType.Control:
                        if (PtyControl.Parse(f.Payload) is { } msg) OnControl(msg);
                        break;
                }
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            _log.LogDebug(ex, "Pty host pipe read ended for session {Id}", SessionId);
        }
        finally
        {
            // The pipe dropping without an "exited" message means the HOST is gone — and because the
            // pseudoconsole's job object dies with it (kill-on-job-close), so is the child. Either way
            // the session is over, so viewers are completed and the session is told.
            bool notify;
            lock (_lock)
            {
                notify = !_completed;
                _completed = true;
                foreach (var w in _subs.Values) w.TryComplete();
            }
            if (notify && !_disposed)
            {
                _log.LogWarning("Lost the pty host for session {Id}; treating the session as ended.", SessionId);
                try { Exited?.Invoke(-1); } catch { }
            }
        }
    }

    private void OnOutput(byte[] chunk)
    {
        lock (_lock)
        {
            _ring.Append(chunk);
            foreach (var w in _subs.Values) w.TryWrite(chunk);
        }
    }

    private void OnControl(PtyControl msg)
    {
        switch (msg.Type)
        {
            // The sniffers run host-side (they must, or a rename during a web-app restart is lost);
            // we just re-raise what they found as the same events the in-process channel used to.
            case "renamed" when !string.IsNullOrEmpty(msg.Name):
                RenameCommandDetected?.Invoke(msg.Name!);
                break;

            case "color" when !string.IsNullOrEmpty(msg.Color):
                ColorCommandDetected?.Invoke(msg.Color!);
                break;

            case "remoteUrl" when !string.IsNullOrEmpty(msg.RemoteUrl):
                lock (_lock) _remoteUrl = msg.RemoteUrl;
                break;

            // Pushed on every busy / waiting / watchdog transition, and on a heartbeat besides, so the
            // cache is never more than a few seconds stale even for a session sitting perfectly still.
            case "state":
                bool changed;
                lock (_lock)
                {
                    var status = string.IsNullOrEmpty(msg.WatchdogStatus) ? _watchdogStatus : msg.WatchdogStatus!;
                    changed = _busy != msg.Busy || _waiting != msg.Waiting
                        || _compacting != msg.Compacting || _watchdogStatus != status;
                    _busy = msg.Busy;
                    _waiting = msg.Waiting;
                    _compacting = msg.Compacting;
                    _watchdogStatus = status;
                }
                // Only on a real change: the heartbeat exists to keep the cache honest, and waking the
                // session hub every five seconds per session to re-serialize an identical snapshot
                // would be a poor use of it.
                if (changed) StateChanged?.Invoke();
                break;

            case "exited":
                lock (_lock)
                {
                    _completed = true;
                    foreach (var w in _subs.Values) w.TryComplete();
                }
                try { Exited?.Invoke(msg.ExitCode); } catch { }
                break;

            case "pong":
                break;
        }
    }

    /// <summary>Attach a viewer: the current scrollback plus a live stream of subsequent output.</summary>
    public TerminalSubscription Subscribe()
    {
        lock (_lock)
        {
            // Bounded + DropOldest so a stalled viewer degrades only itself, never the shared reader.
            var ch = Channel.CreateBounded<byte[]>(
                new BoundedChannelOptions(2048) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true, SingleWriter = false });
            var id = Guid.NewGuid();
            _subs[id] = ch.Writer;
            if (_completed) ch.Writer.TryComplete();
            return new TerminalSubscription(_ring.Snapshot(), ch.Reader, () =>
            {
                lock (_lock) _subs.Remove(id);
                ch.Writer.TryComplete();
            });
        }
    }

    public ValueTask WriteAsync(ReadOnlyMemory<byte> data, CancellationToken ct) =>
        SendAsync(PtyFrameType.Input, data, ct);

    /// <summary>Type text into the terminal as if the user entered it (used to inject a rename command).</summary>
    public void InjectInput(string text) =>
        _ = WriteAsync(Encoding.UTF8.GetBytes(text), CancellationToken.None);

    // Attaching a viewer nudges the pseudoconsole size on purpose — TerminalPane sends cols-1 and then
    // cols back, so Ink redraws its whole frame rather than leaving the input box unpainted — and a
    // redraw is a burst of output. The host's IsBusy is "output very recently", so without a guard
    // merely opening an idle session reported it working for a beat and then finished again.
    //
    // The host guards this itself, which is the real repair. This one exists because a pty host
    // already running when that shipped keeps the old behaviour for the whole life of its session,
    // and hosts outlive the app: after an update there can be dozens of them still on the old build.
    // This process is the one that updates, so the guard here reaches sessions running right now.
    //
    // Longer than the host's own window: what is read here is a value the host sampled up to a second
    // ago and pushed, so the guard has to outlast the repaint (1.5s of output window) plus that
    // sampling lag, or busy simply flips true the moment it lifts.
    private const long ResizeRepaintMs = 3000;
    private long _lastResizeTick;

    public bool IsRepaintingAfterResize =>
        Environment.TickCount64 - Volatile.Read(ref _lastResizeTick) < ResizeRepaintMs;

    public void Resize(short cols, short rows)
    {
        cols = Math.Max((short)1, cols);
        rows = Math.Max((short)1, rows);
        lock (_lock)
        {
            if (cols == _cols && rows == _rows) return;
            _cols = cols;
            _rows = rows;
        }
        // After the early return, so a viewer that reattaches at the size the terminal already has
        // repaints nothing and blinds nothing.
        Volatile.Write(ref _lastResizeTick, Environment.TickCount64);
        _ = SendControlAsync(new PtyControl { Type = "resize", Cols = cols, Rows = rows });
    }

    /// <summary>
    /// Tell the host whether its watchdog may auto-continue this session, optionally clearing the
    /// give-up flag and the attempt counter. The web app owns this setting — sessions.json is the
    /// source of truth for it — so it is re-sent on every attach, not only when the user toggles it.
    /// </summary>
    public Task SetWatchdogAsync(bool enabled, bool reset = false, CancellationToken ct = default) =>
        SendControlAsync(new PtyControl { Type = "watchdog", Enabled = enabled, Reset = reset }, ct);

    /// <summary>
    /// Ask the host to end the session and stand down. Awaited briefly by <see cref="ClaudeSession.Stop"/>,
    /// which kills the host outright if this doesn't take.
    /// </summary>
    public async Task ShutdownAsync(bool kill, CancellationToken ct = default)
    {
        try { await SendControlAsync(new PtyControl { Type = "shutdown", Kill = kill }, ct); }
        catch (Exception ex) { _log.LogDebug(ex, "Could not send shutdown to the pty host for session {Id}", SessionId); }
    }

    private Task SendControlAsync(PtyControl msg, CancellationToken ct = default) =>
        SendAsync(PtyFrameType.Control, msg.ToPayload(), ct).AsTask();

    private async ValueTask SendAsync(PtyFrameType type, ReadOnlyMemory<byte> payload, CancellationToken ct)
    {
        if (_disposed) return;
        // One frame at a time: an interleaved write would desynchronize the host's reader for good.
        await _writeLock.WaitAsync(ct);
        try { await PtyFrame.WriteAsync(_pipe, type, payload, ct); }
        catch (Exception ex) { _log.LogDebug(ex, "Write to the pty host failed for session {Id}", SessionId); }
        finally { _writeLock.Release(); }
    }

    /// <summary>
    /// Detach: close the pipe and stop reading. <b>The host and its claude process keep running</b> —
    /// that is the point of the whole arrangement, and it is why the app shutting down no longer takes
    /// its sessions with it. To actually end a session use <see cref="ClaudeSession.Stop"/>.
    /// </summary>
    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _closing.Cancel();
        lock (_lock)
        {
            _completed = true;
            foreach (var w in _subs.Values) w.TryComplete();
            _subs.Clear();
        }
        try { _pipe.Dispose(); } catch { }
        _closing.Dispose();
    }
}
