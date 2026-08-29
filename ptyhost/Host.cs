using System.Diagnostics;
using ClaudeWeb.Pty;
using ClaudeWeb.PtyHost.Pty;

namespace ClaudeWeb.PtyHost;

/// <summary>
/// One pty host process per session: it owns the pseudoconsole and the <see cref="TerminalChannel"/>
/// around it, and serves them to the web app over a named pipe.
/// </summary>
/// <remarks>
/// <para>The point of the split is that <b>ConPTY handles are not transferable</b>. There is no
/// supported way to hand an <c>HPCON</c> to another process, and the <c>conhost.exe --pty</c> behind
/// it is bound to the process that created it — when that process dies the pipes break and the child
/// gets a console-close. So the only way a session can survive a restart of <c>ClaudeWeb.exe</c> is
/// for the process that owns the pseudoconsole not to be the one that restarts.</para>
/// <para>One host per session rather than one multiplexer: crash isolation is free, the lifecycle is
/// trivial (the host exits when its child exits), and each pseudoconsole spawns its own conhost
/// anyway — so this costs one extra process per session, not two.</para>
/// <para>Lifetime: the host exits when the child exits, or when a client sends <c>shutdown</c>. It
/// does <b>not</b> exit when the last client disconnects — that is the entire feature.</para>
/// </remarks>
public static class Host
{
    /// <summary>The child's start time, so a client can pin the exact process against PID reuse.</summary>
    public static long ChildStartTicks { get; private set; }

    /// <summary>The child's exit code once it has ended; null while it's still running.</summary>
    public static int? ChildExitCode { get; private set; }

    /// <summary>How long to keep serving after the child exits, so an attached client sees the last output.</summary>
    private static readonly TimeSpan LingerAfterExit = TimeSpan.FromSeconds(5);

    public static int Main(string[] args)
    {
        var spawnFile = ArgValue(args, "--spawn");
        if (spawnFile is null)
        {
            Console.Error.WriteLine("ClaudeWeb.PtyHost --spawn <request.json>");
            return 2;
        }

        var request = PtySpawnRequestStore.Read(spawnFile);
        if (request is null)
        {
            Console.Error.WriteLine($"Could not read the spawn request at '{spawnFile}'.");
            return 2;
        }
        // It carried the session's environment (hook token included) and the user's initial prompt;
        // it has done its job, so take it off disk before anything else can read it.
        try { File.Delete(spawnFile); } catch { }

        HostLog.Open(request.LogFile);
        HostLog.Info($"Host starting for session {request.SessionId} (pid {Environment.ProcessId}), pipe '{request.PipeName}'.");

        try
        {
            return Run(request);
        }
        catch (Exception ex)
        {
            HostLog.Error("Host failed", ex);
            // The state file would otherwise advertise a host that isn't there.
            PtyStateStore.Delete(request.StateFile);
            return 1;
        }
    }

    private static int Run(PtySpawnRequest request)
    {
        var terminal = TerminalChannel.Start(
            request.FileName, request.Arguments, request.WorkingDirectory,
            (short)request.Cols, (short)request.Rows, request.Environment);

        ChildStartTicks = StartTicks(terminal.ProcessId);
        HostLog.Info($"Child pid {terminal.ProcessId} started: {request.FileName} {string.Join(' ', request.Arguments)}");

        var state = new PtyState(
            SessionId: request.SessionId,
            HostPid: Environment.ProcessId,
            HostStartTicks: StartTicks(Environment.ProcessId),
            PipeName: request.PipeName,
            ChildPid: terminal.ProcessId,
            ChildStartTicks: ChildStartTicks,
            WorkingDirectory: request.WorkingDirectory,
            Protocol: PtyFrame.Protocol,
            CreatedAt: DateTimeOffset.Now,
            BuildStamp: request.BuildStamp);
        PtyStateStore.Write(request.StateFile, state);

        var server = new PipeServer(request.PipeName, terminal);

        // The watchdog runs here too, and for the same reason as everything else in this process: a
        // session that hangs while the web app is stopped still has to be recovered. It also derives
        // the on-screen busy/waiting signals and pushes them, so the web app never has to ask.
        var watchdog = new SessionWatchdog(
            terminal, request.Watchdog ?? new WatchdogOptions(), request.WatchdogEnabled, server.Broadcast);
        server.Watchdog = watchdog;

        // The sniffers run here (they have to — a web app that restarts must not have missed a
        // rename), so their results are pushed to whoever is attached.
        terminal.RenameCommandDetected += name => server.Broadcast(new PtyControl { Type = "renamed", Name = name });
        terminal.ColorCommandDetected += color => server.Broadcast(new PtyControl { Type = "color", Color = color });
        terminal.RemoteUrlDetected += url => server.Broadcast(new PtyControl { Type = "remoteUrl", RemoteUrl = url });

        // Two independent reasons to stand down, and the host must wake on EITHER: the child ending
        // by itself, or a client asking us to stop. (Waiting on the child alone deadlocks a Stop from
        // the UI — the shutdown arrives, the accept loop closes, and the child runs on untouched.)
        var standDown = new ManualResetEventSlim(false);
        var childExited = new ManualResetEventSlim(false);
        server.ShutdownRequestedEvent += () => standDown.Set();

        var exitReported = 0;
        void OnChildExited(int code)
        {
            // Idempotent: the event and the already-exited poll below can both reach here.
            if (Interlocked.Exchange(ref exitReported, 1) != 0) return;
            ChildExitCode = code;
            HostLog.Info($"Child pid {terminal.ProcessId} exited with code {code}.");
            // Stamp the exit into the state file so a client that connects late can still report how
            // the session ended, rather than finding nothing and calling it a crash.
            try { PtyStateStore.Write(request.StateFile, state with { ExitCode = code }); } catch { }
            server.Broadcast(new PtyControl { Type = "exited", Exited = true, ExitCode = code });
            childExited.Set();
            standDown.Set();
        }

        terminal.Exited += OnChildExited;
        // A child can die before that subscription lands — `claude` rejecting its arguments exits in
        // milliseconds — and the event would then be gone with nothing listening, leaving this host
        // parked forever behind a state file advertising a session that no longer exists. Ask once,
        // now that we are listening.
        if (terminal.HasExited) OnChildExited(terminal.ExitCode);

        using var stopping = new CancellationTokenSource();
        var serving = server.RunAsync(stopping.Token);
        var watching = watchdog.RunAsync(stopping.Token);

        standDown.Wait();

        // The child ended on its own: linger briefly so an attached client receives the final output
        // and the "exited" notice before the pipe drops. A requested shutdown gets no such grace —
        // the user asked for the session to be over.
        if (childExited.IsSet && !server.ShutdownRequested)
        {
            HostLog.Info($"Lingering {LingerAfterExit.TotalSeconds:0}s so attached clients see the exit.");
            Thread.Sleep(LingerAfterExit);
        }

        stopping.Cancel();
        server.Stop();
        try { Task.WaitAll([serving, watching], TimeSpan.FromSeconds(2)); } catch { }

        // Disposing closes the pseudoconsole and the job handle, which terminates the whole child tree
        // if any of it is somehow still up (see PtySession's remarks).
        terminal.Dispose();
        PtyStateStore.Delete(request.StateFile);
        HostLog.Info("Host exiting.");
        return 0;
    }

    /// <summary>
    /// A process's start time in UTC ticks, or 0 when it can't be read. Paired with a PID this
    /// identifies one exact process — PIDs on their own are recycled, heavily so after a reboot.
    /// </summary>
    private static long StartTicks(int pid)
    {
        try
        {
            using var p = Process.GetProcessById(pid);
            return p.StartTime.ToUniversalTime().Ticks;
        }
        catch { return 0; }
    }

    private static string? ArgValue(string[] args, string name)
    {
        for (int i = 0; i < args.Length - 1; i++)
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase))
                return args[i + 1];
        return null;
    }
}
