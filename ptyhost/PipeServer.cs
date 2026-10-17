using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading.Channels;
using ClaudeWeb.Pty;
using ClaudeWeb.PtyHost.Pty;

namespace ClaudeWeb.PtyHost;

/// <summary>
/// Serves a session's <see cref="TerminalChannel"/> over a named pipe. Several clients at once (the
/// web app already fans one session out to several browser tabs, and a redeployed app can connect
/// while the outgoing one is still winding down), each getting a scrollback replay followed by live
/// output, and each able to type back.
/// </summary>
/// <remarks>
/// The one rule that defines this whole feature: <b>the last client disconnecting is not a reason to
/// exit</b>. The host stands down only when its child ends or a client asks it to.
/// </remarks>
public sealed class PipeServer(string pipeName, TerminalChannel terminal)
{
    /// <summary>
    /// Concurrent pipe instances. Well above the handful of browser tabs a session realistically has,
    /// so a client that hasn't been cleaned up yet can't lock a new one out.
    /// </summary>
    private const int MaxInstances = 16;

    private readonly ConcurrentDictionary<Guid, Client> _clients = new();
    private readonly CancellationTokenSource _stopping = new();

    /// <summary>Set when a client sends <c>shutdown</c>, so the host can tell why it's standing down.</summary>
    public bool ShutdownRequested { get; private set; }

    /// <summary>Raised when a client sends <c>shutdown</c>; the host waits on this as well as on the child.</summary>
    public event Action? ShutdownRequestedEvent;

    /// <summary>
    /// The session's watchdog, once the host has built it. Set rather than injected because the
    /// watchdog pushes through <see cref="Broadcast"/> and so needs this server first.
    /// </summary>
    public SessionWatchdog? Watchdog { get; set; }

    /// <summary>Ask the accept loop to stop (the child exited, or a client sent <c>shutdown</c>).</summary>
    public void Stop() => _stopping.Cancel();

    /// <summary>Push a control message to every attached client (rename, color, remote URL, exit).</summary>
    public void Broadcast(PtyControl message)
    {
        var frame = PtyFrame.Pack(PtyFrameType.Control, message.ToPayload());
        foreach (var c in _clients.Values) c.Outbox.Writer.TryWrite(frame);
    }

    /// <summary>
    /// Accept clients until <see cref="Stop"/>. Each connection is handed to its own task so the loop
    /// is immediately back waiting for the next one.
    /// </summary>
    public async Task RunAsync(CancellationToken ct)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, _stopping.Token);
        var security = OperatingSystem.IsWindows() ? BuildSecurity() : null;
        if (!OperatingSystem.IsWindows()) PrepareSocketPath();
        while (!linked.IsCancellationRequested)
        {
            NamedPipeServerStream pipe;
            try
            {
                // Byte mode: we length-prefix our own frames, so a 512 KB replay doesn't have to fit
                // whatever the transport considers one message.
                pipe = OperatingSystem.IsWindows()
                    ? NamedPipeServerStreamAcl.Create(
                        pipeName, PipeDirection.InOut, MaxInstances,
                        PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.WriteThrough,
                        inBufferSize: 64 * 1024, outBufferSize: 64 * 1024, security)
                    // A Unix domain socket has no DACL to name the user in. The equivalent there is
                    // two locks: the socket sits in a 0700 folder (PtyStateStore.SocketDirectory), and
                    // CurrentUserOnly refuses a peer whose uid isn't ours on accept.
                    : new NamedPipeServerStream(
                        pipeName, PipeDirection.InOut, MaxInstances,
                        PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly,
                        inBufferSize: 64 * 1024, outBufferSize: 64 * 1024);
            }
            catch (Exception ex)
            {
                HostLog.Error($"Could not create pipe instance '{pipeName}'", ex);
                // Creating a pipe instance shouldn't fail; if it does, back off rather than spin.
                try { await Task.Delay(1000, linked.Token); } catch (OperationCanceledException) { }
                continue;
            }

            try
            {
                await pipe.WaitForConnectionAsync(linked.Token);
            }
            catch (OperationCanceledException) { await pipe.DisposeAsync(); break; }
            catch (Exception ex)
            {
                HostLog.Debug($"Pipe accept failed: {ex.Message}");
                await pipe.DisposeAsync();
                continue;
            }

            _ = Task.Run(() => ServeClientAsync(pipe, linked.Token), CancellationToken.None);
        }
    }

    /// <summary>
    /// Grant the pipe to this user alone. Explicit rather than inherited: a host spawned by the
    /// Windows service lives in session 0 and a later interactive launch still has to reach it, so
    /// the DACL has to name the account rather than rely on whatever the default is in each context.
    /// </summary>
    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    private static PipeSecurity BuildSecurity()
    {
        var security = new PipeSecurity();
        var user = WindowsIdentity.GetCurrent().User;
        if (user is not null)
            security.AddAccessRule(new PipeAccessRule(user, PipeAccessRights.FullControl, AccessControlType.Allow));
        // SYSTEM too, so a service-hosted app can still reach a host it spawned; nothing else is granted.
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        return security;
    }

    /// <summary>
    /// Clear the way for the socket. Unlike a Windows pipe, a Unix socket outlives its listener as a
    /// file, and binding over one a crashed host left behind fails with "address in use". The path is
    /// this session's alone — nobody else can be listening on it — so whatever is there is ours to remove.
    /// </summary>
    private void PrepareSocketPath()
    {
        try
        {
            PtyStateStore.EnsureSocketDirectory();
            if (Path.IsPathRooted(pipeName)) File.Delete(pipeName);
        }
        catch (Exception ex) { HostLog.Warn($"Could not clear the socket path '{pipeName}': {ex.Message}"); }
    }

    /// <summary>Remove the socket file once nothing listens on it any more (Unix only; a no-op elsewhere).</summary>
    public void RemoveSocketFile()
    {
        if (OperatingSystem.IsWindows() || !Path.IsPathRooted(pipeName)) return;
        try { File.Delete(pipeName); } catch { }
    }

    /// <summary>One attached client: a queue of ready-to-write frames drained by its write loop.</summary>
    private sealed class Client
    {
        // Bounded + DropOldest so a stalled viewer degrades only itself, never the shared reader —
        // the same bargain TerminalChannel's subscribers make. Control frames are rare enough that
        // in practice only output is ever dropped.
        public Channel<byte[]> Outbox { get; } = Channel.CreateBounded<byte[]>(
            new BoundedChannelOptions(4096) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true });
    }

    private async Task ServeClientAsync(NamedPipeServerStream pipe, CancellationToken ct)
    {
        var id = Guid.NewGuid();
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var client = new Client();
        TerminalChannel.Subscription? sub = null;
        try
        {
            // 1) Handshake. A client that doesn't say hello first isn't one of ours.
            var hello = await PtyFrame.ReadAsync(pipe, cts.Token);
            if (hello is not { Type: PtyFrameType.Control } h || PtyControl.Parse(h.Payload) is not { Type: "hello" })
            {
                HostLog.Warn("Client connected without a hello; dropping it.");
                return;
            }

            sub = terminal.Subscribe();
            _clients[id] = client;

            await PtyFrame.WriteAsync(pipe, PtyFrameType.Control, new PtyControl
            {
                Type = "welcome",
                Protocol = PtyFrame.Protocol,
                CanRepaint = true,
                CanSnapshot = true,
                ChildPid = terminal.ProcessId,
                ChildStartTicks = Host.ChildStartTicks,
                Cols = sub.Cols,   // the size the snapshot above was drawn at, not whatever it is now
                Rows = sub.Rows,
                RemoteUrl = terminal.RemoteUrl,
                Exited = Host.ChildExitCode is not null,
                ExitCode = Host.ChildExitCode ?? 0,
            }.ToPayload(), cts.Token);

            // 2) Scrollback, as one frame, before any live output — so the client's screen is current
            //    the moment it attaches. Sent ALWAYS, empty included: the client reads exactly one
            //    frame here, and making it conditional would leave it guessing (and, if it guessed
            //    with a timeout, at risk of cancelling mid-frame and desynchronizing the stream).
            await PtyFrame.WriteAsync(pipe, PtyFrameType.Output, sub.Replay, cts.Token);

            // Only now — the handshake above is a fixed welcome-then-one-output-frame sequence, and
            // slipping a control frame into the middle of it would leave the client reading the
            // scrollback as something else. Seeds the newcomer with the current busy/waiting/watchdog
            // view so it has something truthful to show without waiting out the next state push.
            if (Watchdog is { } w)
                client.Outbox.Writer.TryWrite(PtyFrame.Pack(PtyFrameType.Control, w.CurrentState().ToPayload()));

            // 3) Live output feeds the same outbox the broadcast control frames use, so every write to
            //    this pipe comes from one task and can't interleave mid-frame.
            var pump = Task.Run(async () =>
            {
                try
                {
                    await foreach (var chunk in sub.Reader.ReadAllAsync(cts.Token))
                        client.Outbox.Writer.TryWrite(PtyFrame.Pack(PtyFrameType.Output, chunk));
                }
                catch { /* cancelled, or the terminal completed — the write loop ends with us */ }
                finally { client.Outbox.Writer.TryComplete(); }
            }, CancellationToken.None);

            var writeLoop = Task.Run(async () =>
            {
                try
                {
                    await foreach (var frame in client.Outbox.Reader.ReadAllAsync(cts.Token))
                        await pipe.WriteAsync(frame, cts.Token);
                }
                catch { /* client gone; the read loop below tears down */ }
            }, CancellationToken.None);

            // 4) Read loop: input and control from this client.
            await ReadLoopAsync(pipe, cts.Token);

            cts.Cancel();
            await Task.WhenAll(pump, writeLoop).WaitAsync(TimeSpan.FromSeconds(2), CancellationToken.None);
        }
        catch (OperationCanceledException) { }
        catch (Exception ex) { HostLog.Debug($"Client {id:n} ended: {ex.Message}"); }
        finally
        {
            _clients.TryRemove(id, out _);
            client.Outbox.Writer.TryComplete();
            sub?.Dispose();
            try { if (pipe.IsConnected) pipe.Disconnect(); } catch { }
            await pipe.DisposeAsync();
            // NB: no exit here, however many clients are left. That is the feature.
            HostLog.Debug($"Client {id:n} disconnected; {_clients.Count} still attached.");
        }
    }

    private async Task ReadLoopAsync(NamedPipeServerStream pipe, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            PtyFrameData? frame;
            try { frame = await PtyFrame.ReadAsync(pipe, ct); }
            catch (OperationCanceledException) { return; }
            catch (Exception ex) { HostLog.Debug($"Pipe read ended: {ex.Message}"); return; }
            if (frame is not { } f) return; // clean EOF: the client detached

            switch (f.Type)
            {
                case PtyFrameType.Input:
                    await terminal.WriteAsync(f.Payload, ct);
                    break;

                case PtyFrameType.Control:
                    if (PtyControl.Parse(f.Payload) is { } msg && await HandleControlAsync(pipe, msg, ct))
                        return;
                    break;
            }
        }
    }

    /// <summary>Handle one control message; returns true when this client's loop should end.</summary>
    private async Task<bool> HandleControlAsync(NamedPipeServerStream pipe, PtyControl msg, CancellationToken ct)
    {
        switch (msg.Type)
        {
            case "resize":
                terminal.Resize((short)msg.Cols, (short)msg.Rows);
                return false;

            // A viewer has attached and wants the current screen drawn. Deliberately fire-and-forget:
            // the redraw takes a couple of hundred milliseconds to play out and nothing waits on it,
            // while this loop must stay free to carry the output it produces.
            case "repaint":
                _ = terminal.RepaintAsync();
                return false;

            case "ping":
                await PtyFrame.WriteAsync(pipe, PtyFrameType.Control,
                    new PtyControl { Type = "pong" }.ToPayload(), ct);
                return false;

            case "shutdown":
                HostLog.Info($"Shutdown requested by a client (kill={msg.Kill}).");
                ShutdownRequested = true;
                ShutdownRequestedEvent?.Invoke();
                Stop();
                return true;

            // The per-session watchdog opt-in lives in the web app's sessions.json, so it is pushed
            // down here on every attach as well as whenever the user toggles it.
            case "watchdog":
                Watchdog?.Configure(msg.Enabled, msg.Reset);
                return false;

            default:
                return false;
        }
    }
}
