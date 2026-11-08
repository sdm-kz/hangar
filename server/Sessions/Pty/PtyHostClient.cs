using System.IO.Pipes;
using System.Threading.Channels;
using Hangar.Pty;

namespace Hangar.Server.Sessions.Pty;

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
    private readonly NamedPipeClientStream _pipe;
    private readonly ILogger _log;
    // The screen the child has drawn: seeded from the snapshot the host sent at handshake and kept up
    // to date with everything since, so a browser tab that opens later can be handed the screen as it
    // stands — the host snapshots per CLIENT, not per viewer. (The host keeps its own model; this one
    // exists purely to fan out to several tabs without a round-trip for each.)
    private readonly ScreenModel _screen;
    private readonly Dictionary<Guid, Viewer> _subs = new();
    private readonly object _lock = new();
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private readonly CancellationTokenSource _closing = new();

    private bool _completed;
    private bool _disposed;
    private string? _remoteUrl;
    // Where the pseudoconsole actually is, which outside a repaint is the agreed size below: the
    // nudge parks it one column off on purpose and has to come back to what was agreed, not to
    // wherever it happened to be leaving from.
    private short _cols;
    private short _rows;
    // The size every viewer is drawn at: the grid of the one used last (see AgreeSize).
    private short _wantCols;
    private short _wantRows;

    // Last `state` push from the host. The defaults are the safe reading for a session we have not
    // heard about yet: not busy, not waiting, not compacting, healthy.
    private bool _busy;
    private bool _waiting;
    private bool _compacting;
    private string _watchdogStatus = "healthy";
    private ShellCommandState _command = ShellCommandState.None;

    /// <summary>The session's id, for log lines that have to be readable months later.</summary>
    public string SessionId { get; }

    public int ProcessId { get; }

    /// <summary>The child's start time in UTC ticks, pinning the exact process against PID reuse.</summary>
    public long ProcessStartTicks { get; }

    /// <summary>Whether the host reported the child as already gone when we attached.</summary>
    public bool AlreadyExited { get; }

    public short Cols { get { lock (_lock) return _wantCols; } }
    public short Rows { get { lock (_lock) return _wantRows; } }

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

    public bool AcceptsPaste { get { lock (_lock) return _screen.IsDecModeSet(2004); } }

    // When output last arrived (Environment.TickCount64), for MillisSinceOutput.
    private long _lastOutputTick = Environment.TickCount64;

    public long MillisSinceOutput => Environment.TickCount64 - Volatile.Read(ref _lastOutputTick);

    public string ScreenText() { lock (_lock) return _screen.ScreenText(); }

    public bool HasInputDraft { get { lock (_lock) return ClaudeInputBox.HasDraft(_screen); } }

    public bool ShowsInterrupted { get { lock (_lock) return ClaudeInputBox.Interrupted(_screen); } }

    // The last count the footer showed. Opening Claude's list of its shells hides the box, and reading
    // that as "none left" would tick the session finished while they are still running.
    private int _backgroundTasks;

    public int BackgroundTasks
    {
        get
        {
            lock (_lock)
            {
                if (ClaudeInputBox.BackgroundTasks(_screen) is { } n) _backgroundTasks = n;
                return _backgroundTasks;
            }
        }
    }

    /// <summary>True while Claude is compacting the conversation (auto-compaction or <c>/compact</c>).</summary>
    public bool IsCompacting { get { lock (_lock) return _compacting; } }

    /// <summary>The host watchdog's view of the session: "healthy" | "recovering" | "attention".</summary>
    public string WatchdogStatus { get { lock (_lock) return _watchdogStatus; } }

    /// <summary>
    /// The command running at a shell prompt, and how the last one ended, from the shell's
    /// integration marks. <see cref="ShellCommandState.None"/> for a Claude session, and for a host
    /// built before the marks were read.
    /// </summary>
    public ShellCommandState Command { get { lock (_lock) return _command; } }

    private PtyHostClient(NamedPipeClientStream pipe, string sessionId, PtyControl welcome, byte[] replay, ILogger log)
    {
        _pipe = pipe;
        _log = log;
        SessionId = sessionId;
        ProcessId = welcome.ChildPid;
        ProcessStartTicks = welcome.ChildStartTicks;
        AlreadyExited = welcome.Exited;
        // Absent on a host built before the repaint control existed, which is exactly what it has to
        // mean: fall back to nudging (see RequestRepaint).
        _canRepaint = welcome.CanRepaint;
        _canSnapshot = welcome.CanSnapshot;
        _remoteUrl = welcome.RemoteUrl;
        _cols = _wantCols = (short)Math.Max(1, welcome.Cols);
        _rows = _wantRows = (short)Math.Max(1, welcome.Rows);
        // Seed the model from what the host sent, so a viewer attaching now sees the screen as it
        // stands rather than only what happens to arrive from here on. The seed is VT bytes — a
        // snapshot from a current host, a raw scrollback ring from one built before this existed —
        // and either way the way to take it in is to play it through the terminal.
        _screen = new ScreenModel(_cols, _rows);
        if (replay.Length > 0) _screen.Write(replay);
    }

    /// <summary>
    /// Connect to a host's pipe and complete the handshake. Returns null when nothing answers within
    /// <paramref name="timeoutMs"/> — which is how a stale state file is told from a live host.
    /// </summary>
    public static async Task<PtyHostClient?> ConnectAsync(
        string pipeName, string sessionId, int timeoutMs, ILogger log, CancellationToken ct = default)
    {
        // On Unix, CurrentUserOnly also has the client check that the socket's listener is this user —
        // the far side of the host's own check, and a second lock beside the 0700 socket folder.
        var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut,
            OperatingSystem.IsWindows() ? PipeOptions.Asynchronous : PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
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
                foreach (var v in _subs.Values) v.Writer.TryComplete();
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
        Volatile.Write(ref _lastOutputTick, Environment.TickCount64);
        lock (_lock)
        {
            _screen.Write(chunk);
            foreach (var v in _subs.Values)
            {
                // The queue is bounded and drops its oldest when full, so one viewer that has stopped
                // reading degrades only itself. Note the loss: a hole in a VT stream is not something
                // a terminal recovers from, and the socket repairs it with a fresh snapshot when the
                // viewer starts draining again.
                if (v.Reader.Count >= ViewerQueueDepth) v.Dropped = true;
                v.Writer.TryWrite(chunk);
            }
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

            // The host has moved the pseudoconsole. It arrives in the same stream as the output, so
            // turning the model here puts the turn where the host put it rather than where we asked
            // for it — see the note in Nudge. Only a size the viewers agreed on: the repaint nudge
            // announces the column it passes through on the way back, and the model must not follow
            // it there and lose a column off every row for a width nothing is drawn at.
            case "size" when msg.Cols > 0 && msg.Rows > 0:
                lock (_lock)
                    if (msg.Cols == _wantCols && msg.Rows == _wantRows)
                        _screen.Resize(msg.Cols, msg.Rows);
                break;

            // Pushed on every busy / waiting / watchdog transition, and on a heartbeat besides, so the
            // cache is never more than a few seconds stale even for a session sitting perfectly still.
            case "state":
                bool changed;
                lock (_lock)
                {
                    var status = string.IsNullOrEmpty(msg.WatchdogStatus) ? _watchdogStatus : msg.WatchdogStatus!;
                    var command = new ShellCommandState(
                        msg.ShellIntegration, msg.CommandRunning,
                        msg.CommandStartedAt, msg.CommandEndedAt, msg.CommandExitCode, msg.CommandWaiting);
                    changed = _busy != msg.Busy || _waiting != msg.Waiting
                        || _compacting != msg.Compacting || _watchdogStatus != status
                        || _command != command;
                    _busy = msg.Busy;
                    _waiting = msg.Waiting;
                    _compacting = msg.Compacting;
                    _watchdogStatus = status;
                    _command = command;
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
                    foreach (var v in _subs.Values) v.Writer.TryComplete();
                }
                try { Exited?.Invoke(msg.ExitCode); } catch { }
                break;

            case "pong":
                break;
        }
    }

    /// <summary>One attached viewer: where its output goes, and how big a grid it has to put it in.</summary>
    private sealed class Viewer(Channel<byte[]> channel)
    {
        public ChannelWriter<byte[]> Writer { get; } = channel.Writer;
        public ChannelReader<byte[]> Reader { get; } = channel.Reader;

        /// <summary>Set when this viewer's queue was full and a chunk was dropped (see OnOutput).</summary>
        public bool Dropped;
        // Zero until the viewer has said, and zero again once it says it has stopped looking. An
        // unspoken size joins no minimum — a tab that has attached but not yet measured itself must
        // not shrink the session to whatever it would default to, and neither must a hidden one.
        public short Cols;
        public short Rows;
        public long LastSeen = Environment.TickCount64;
        // When someone last used the session through this viewer — typed, clicked, focused it, opened
        // it, brought it back on screen. Zero until then. The most recent of these decides the size
        // (see AgreeSize); a heartbeat is not use, so this is not touched by one.
        public long LastActive;
        public TerminalSubscription? Handle;
    }

    /// <summary>
    /// How long a viewer can say nothing before it stops counting towards the size. Four missed
    /// heartbeats: the browser probes every 15s, so anything still watching answers well inside this,
    /// and what it catches is the socket that is open but abandoned — the reading end gone without a
    /// close, which would otherwise hold every other viewer down to a screen nobody is looking at.
    /// </summary>
    private const long ViewerQuietMs = 60_000;

    /// <summary>
    /// How many output chunks a viewer may fall behind by before the oldest are dropped. Also the
    /// mark that says a drop has happened, which is what the snapshot repair keys off.
    /// </summary>
    private const int ViewerQueueDepth = 2048;

    /// <summary>Attach a viewer: the current scrollback plus a live stream of subsequent output.</summary>
    public TerminalSubscription Subscribe()
    {
        TerminalSubscription sub;
        lock (_lock)
        {
            // Bounded + DropOldest so a stalled viewer degrades only itself, never the shared reader.
            var ch = Channel.CreateBounded<byte[]>(
                new BoundedChannelOptions(ViewerQueueDepth) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true, SingleWriter = false });
            var id = Guid.NewGuid();
            var viewer = new Viewer(ch);
            _subs[id] = viewer;
            if (_completed) ch.Writer.TryComplete();
            sub = new TerminalSubscription(
                _screen.Snapshot(), ch.Reader,
                unsubscribe: () =>
                {
                    lock (_lock) _subs.Remove(id);
                    ch.Writer.TryComplete();
                    // The viewer that just left may be the one that was holding the size down.
                    AgreeSize(null);
                },
                resize: (cols, rows) =>
                {
                    lock (_lock)
                    {
                        // Zero is a withdrawal, not a size — see TerminalSubscription.Resize.
                        viewer.Cols = cols > 0 ? cols : (short)0;
                        viewer.Rows = rows > 0 ? rows : (short)0;
                        viewer.LastSeen = Environment.TickCount64;
                    }
                    AgreeSize(viewer);
                },
                touch: () =>
                {
                    bool wasQuiet;
                    lock (_lock)
                    {
                        wasQuiet = Environment.TickCount64 - viewer.LastSeen > ViewerQuietMs;
                        viewer.LastSeen = Environment.TickCount64;
                    }
                    // Only worth re-deciding when this changes who is counted: either a viewer has
                    // just come back from being written off, or one of the others may have gone quiet
                    // while this one was talking. The heartbeat is what makes the second case land
                    // without anyone having to do anything.
                    AgreeSize(wasQuiet ? viewer : null);
                },
                claim: () =>
                {
                    lock (_lock)
                    {
                        viewer.LastActive = Environment.TickCount64;
                        viewer.LastSeen = viewer.LastActive;
                    }
                    AgreeSize(viewer);
                },
                takeDropped: () =>
                {
                    lock (_lock)
                    {
                        var dropped = viewer.Dropped;
                        viewer.Dropped = false;
                        return dropped;
                    }
                });
            viewer.Handle = sub;
        }
        // A session started before this build is still served by the host it was started with, and
        // that host can only hand over the old byte tape — which may end mid-frame, leaving the
        // screen this viewer gets short of whatever the child has not redrawn since. The browser no
        // longer asks for a redraw on attach (a snapshot needs none), so ask on its behalf for the
        // hosts that need it. It costs those sessions the width nudge it always cost them; sessions
        // started from here on pay nothing.
        // Nothing to redraw for a child that has already gone, and asking costs one: against an older
        // host the ask is performed as a width nudge, on a screen frozen at the session's last frame.
        bool ended;
        lock (_lock) ended = _completed;
        if (!_canSnapshot && !AlreadyExited && !ended) RequestRepaint();
        return sub;
    }

    /// <summary>
    /// Settle on the size the child is drawn at: the grid of whichever viewer was used last, among the
    /// ones actually watching — one that has hidden its tab or gone quiet is not one of them. tmux's
    /// <c>window-size latest</c>, for the reason tmux moved to it: the same session left open on a
    /// second machine is the normal case, and sizing to the smallest viewer let a screen nobody was
    /// looking at — still visible, still answering heartbeats — hold the one being used down to its
    /// size, letterboxed into a corner of a much bigger window.
    ///
    /// The others adapt rather than the child: a bigger viewer letterboxes, and a smaller one scales
    /// the frame down to fit, until it is used and the size follows it. Nobody is ever sent a grid
    /// narrower than the frame, where each line's last cell spills onto the front of the next row and
    /// stays there. Viewers that never say they were used (a tab still on an older build) fall back to
    /// the old rule, the smallest grid among them, each axis on its own.
    ///
    /// The <paramref name="asker"/> is told the answer even when it did not change it, which is how a
    /// viewer that has just joined — or just asked for more than it can have — learns to letterbox.
    /// </summary>
    private void AgreeSize(Viewer? asker)
    {
        short cols = 0, rows = 0;
        List<TerminalSubscription> tell = [];
        lock (_lock)
        {
            var now = Environment.TickCount64;
            Viewer? latest = null;
            foreach (var v in _subs.Values)
            {
                if (v.Cols <= 0 || v.Rows <= 0) continue;
                if (now - v.LastSeen > ViewerQuietMs) continue; // gone quiet; see ViewerQuietMs
                cols = cols == 0 ? v.Cols : Math.Min(cols, v.Cols);
                rows = rows == 0 ? v.Rows : Math.Min(rows, v.Rows);
                if (v.LastActive > 0 && (latest is null || v.LastActive > latest.LastActive)) latest = v;
            }
            if (latest is not null)
            {
                cols = latest.Cols;
                rows = latest.Rows;
            }
            // Nobody has a grid to fit: the last viewer has gone, or none has measured itself yet.
            // Leave the child at the size it has rather than resize it to nothing on the way out.
            if (cols <= 0 || rows <= 0) return;
            bool changed = cols != _wantCols || rows != _wantRows;
            // Named, when it moves. Every resize of a session that is mid-turn costs it a stale copy
            // of the frame on screen (see TerminalChannel.ApplySize), and the sizes of the viewers
            // that produced this one are what say whether it was a zoom, a pane, or a second device
            // arriving — which is not a thing anyone can reconstruct afterwards. The one being followed
            // is starred.
            if (changed)
                _log.LogInformation(
                    "Session {Id} sized to {Cols}x{Rows} by {Count} viewer(s): {Sizes}.",
                    SessionId, cols, rows, _subs.Count,
                    string.Join(", ", _subs.Values.Select(v =>
                        (v.Cols > 0 ? $"{v.Cols}x{v.Rows}" : "hidden") + (ReferenceEquals(v, latest) ? "*" : ""))));
            _wantCols = cols;
            _wantRows = rows;
            foreach (var v in _subs.Values)
                if (v.Handle is not null && (changed || ReferenceEquals(v, asker))) tell.Add(v.Handle);
        }
        Nudge(cols, rows);
        foreach (var t in tell) t.SizeChanged?.Invoke(cols, rows);
    }

    /// <summary>The screen as it stands (see <see cref="ITerminal.Snapshot"/>).</summary>
    public byte[] Snapshot()
    {
        lock (_lock) return _screen.Snapshot();
    }

    public ValueTask WriteAsync(ReadOnlyMemory<byte> data, CancellationToken ct) =>
        SendAsync(PtyFrameType.Input, data, ct);

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
    private readonly bool _canRepaint;
    // Whether the scrollback this host hands over is a screen snapshot. An older host predates the
    // screen model and can only send the byte tape, which is exactly the case a viewer still needs a
    // redraw for (see Subscribe).
    private readonly bool _canSnapshot;

    public bool IsRepaintingAfterResize =>
        Environment.TickCount64 - Volatile.Read(ref _lastResizeTick) < ResizeRepaintMs;

    /// <summary>
    /// Hand the repaint to the host when it can do one, so the redraw it produces is known to be a
    /// redraw and never counted as work. Against a host from before that existed — and hosts outlive
    /// the app, so after an update there can be dozens — do the old thing from here: nudge the size
    /// and let <see cref="IsRepaintingAfterResize"/> cover for it. Either way the browser just asks.
    /// </summary>
    public void RequestRepaint()
    {
        if (_canRepaint)
        {
            _ = SendControlAsync(new PtyControl { Type = "repaint" });
            return;
        }
        short cols, rows;
        lock (_lock) { cols = _wantCols; rows = _wantRows; }
        if (cols <= 1) return;
        _ = Task.Run(async () =>
        {
            Nudge((short)(cols - 1), rows);
            await Task.Delay(60);
            // Whatever is wanted now, not the size captured before the gap — a resize that landed
            // during it has already gone out, and restoring over it would leave the pseudoconsole
            // wider than the grid it is drawn into, which is how a line's last cell ends up spilled
            // onto the front of the next row with nothing to erase it.
            lock (_lock) { cols = _wantCols; rows = _wantRows; }
            Nudge(cols, rows);
        });
    }

    /// <summary>Move the pseudoconsole. The agreed size is <see cref="AgreeSize"/>'s to set.</summary>
    private void Nudge(short cols, short rows)
    {
        lock (_lock)
        {
            if (cols == _cols && rows == _rows) return;
            _cols = cols;
            _rows = rows;
            // A current host answers with a `size` control once the pseudoconsole has actually moved,
            // and the model turns there — at the same point in the byte stream the host's own model
            // turned at. Moving it here instead would lay everything still in flight, drawn for the
            // old width, into the new grid: wrapped rows, and a copy of each in the history a later
            // viewer is handed. An older host says nothing, so for those the ask is all we have.
            if (!_canSnapshot) _screen.Resize(cols, rows);
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
            foreach (var v in _subs.Values) v.Writer.TryComplete();
            _subs.Clear();
        }
        try { _pipe.Dispose(); } catch { }
        _closing.Dispose();
    }
}

/// <summary>
/// A shell's command state as its pty host reports it: whether the integration marks are coming
/// through at all, whether a command is running, and when the last one started and ended (Unix ms,
/// 0 for never) and with what exit code. <c>Waiting</c>: the running command is one you type into
/// (ssh, a REPL) and has gone quiet, so it is waiting on you rather than working.
/// </summary>
public sealed record ShellCommandState(
    bool Integration, bool Running, long StartedAt, long EndedAt, int? ExitCode, bool Waiting = false)
{
    public static readonly ShellCommandState None = new(false, false, 0, 0, null);
}
