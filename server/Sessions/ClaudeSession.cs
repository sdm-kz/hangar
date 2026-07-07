using System.Diagnostics;
using ClaudeWeb.Server.Sessions.Pty;

namespace ClaudeWeb.Server.Sessions;

/// <summary>
/// A launched interactive <c>claude</c> session. The process runs attached to a pseudoconsole
/// (ConPTY) owned by this app, so its terminal is streamed to an in-app xterm.js terminal over a
/// WebSocket (see <see cref="Terminal"/>). Because the pseudoconsole master is owned by this host,
/// the session's lifetime is tied to the host — like a VS Code integrated terminal, it does not
/// survive an app/host restart (so <see cref="TryReattach"/> no longer re-adopts sessions).
/// <c>--remote-control</c> still works as an optional secondary control channel while alive.
/// </summary>
public sealed class ClaudeSession : IDisposable
{
    private readonly ExecutableSpec _exe;
    private readonly ILogger _log;
    private Process? _process;
    private TerminalChannel? _terminal;
    private FileSystemWatcher? _watcher;
    private long _fsVersion;
    private long _processStartTicks; // identifies the exact process, guarding against PID reuse on re-attach

    /// <summary>The live terminal stream (ring buffer + fan-out), or null once the process is gone.</summary>
    public TerminalChannel? Terminal => _terminal;

    public string Id { get; }
    public string Name { get; }
    public string WorkingDirectory { get; }
    public bool RemoteControl { get; }
    public string? Model { get; }
    public string? InitialPrompt { get; }
    public bool AutoAccept { get; }
    public SessionState State { get; private set; } = SessionState.Running;
    public int ProcessId { get; private set; }
    public DateTimeOffset CreatedAt { get; } = DateTimeOffset.Now;

    /// <summary>Bumped whenever the working directory changes; the UI polls it to auto-refresh.</summary>
    public long FsVersion => Interlocked.Read(ref _fsVersion);

    public ClaudeSession(CreateSessionRequest req, ExecutableSpec exe, ILogger log)
    {
        Id = Guid.NewGuid().ToString("n");
        WorkingDirectory = req.WorkingDirectory;
        RemoteControl = req.RemoteControl;
        Model = string.IsNullOrWhiteSpace(req.Model) ? null : req.Model;
        InitialPrompt = string.IsNullOrWhiteSpace(req.InitialPrompt) ? null : req.InitialPrompt!.Trim();
        AutoAccept = req.AutoAccept;
        Name = string.IsNullOrWhiteSpace(req.Name)
            ? new DirectoryInfo(req.WorkingDirectory).Name
            : req.Name!.Trim();
        _exe = exe;
        _log = log;
    }

    /// <summary>Rehydrate a session from disk (does not launch a process — see <see cref="TryReattach"/>).</summary>
    private ClaudeSession(PersistedSession p, ExecutableSpec exe, ILogger log)
    {
        Id = p.Id;
        WorkingDirectory = p.WorkingDirectory;
        RemoteControl = p.RemoteControl;
        Model = p.Model;
        InitialPrompt = p.InitialPrompt;
        AutoAccept = p.AutoAccept;
        Name = p.Name;
        CreatedAt = p.CreatedAt;
        ProcessId = p.ProcessId;
        _processStartTicks = p.ProcessStartTicks;
        _exe = exe;
        _log = log;
    }

    public static ClaudeSession FromPersisted(PersistedSession p, ExecutableSpec exe, ILogger log) => new(p, exe, log);

    public SessionInfo ToInfo() => new(
        Id, Name, WorkingDirectory, RemoteControl, Model, AutoAccept, State, ProcessId, CreatedAt);

    public PersistedSession ToPersisted() => new(
        Id, Name, WorkingDirectory, RemoteControl, Model, InitialPrompt, AutoAccept, ProcessId, _processStartTicks, CreatedAt);

    /// <summary>
    /// Re-attach is not possible for a ConPTY session: the pseudoconsole master is owned by this
    /// host, so when the host restarts the child's terminal is destroyed and the process is gone.
    /// Always returns false, so persisted sessions are dropped on startup.
    /// </summary>
    public bool TryReattach() => false;

    public void Start()
    {
        // The child runs attached to a pseudoconsole (ConPTY): it still sees an interactive terminal
        // (so the TUI renders and --remote-control registers), but its VT stream is piped to us and
        // broadcast to the in-app xterm.js terminal via TerminalChannel.
        var args = BuildArgs();
        // If claude is the npm .cmd shim we must invoke it via cmd.exe /c; prepend that prefix.
        var launchArgs = new List<string>(_exe.Prefix);
        launchArgs.AddRange(args);

        _log.LogInformation("Launching claude session {Id} in {Cwd}: {Exe} {Args}",
            Id, WorkingDirectory, _exe.FileName, string.Join(' ', launchArgs));

        try
        {
            _terminal = TerminalChannel.Start(_exe.FileName, launchArgs, WorkingDirectory, _log);
            ProcessId = _terminal.ProcessId;
            _process = Process.GetProcessById(ProcessId);
            try { _processStartTicks = _process.StartTime.ToUniversalTime().Ticks; } catch { }
            AttachExitHandler();
            State = SessionState.Running;
            StartWatcher();
        }
        catch (Exception ex)
        {
            State = SessionState.Failed;
            _log.LogError(ex, "Failed to launch claude session {Id}", Id);
            throw;
        }
    }

    private List<string> BuildArgs()
    {
        var args = new List<string>();
        // We avoid the unsafe bypassPermissions mode (blocking startup prompt); permission
        // decisions otherwise happen interactively from the Claude Code app. Auto mode opts into
        // acceptEdits, which auto-accepts file edits without a startup prompt (the Shift+Tab mode).
        if (AutoAccept)
        {
            args.Add("--permission-mode");
            args.Add("acceptEdits");
        }
        if (RemoteControl)
        {
            args.Add("--remote-control");
            args.Add(Name); // names the Remote Control session shown in the app
        }
        // Also set the display name shown in the session picker / terminal title.
        args.Add("--name");
        args.Add(Name);
        if (Model is not null)
        {
            args.Add("--model");
            args.Add(Model);
        }
        // The initial prompt is a positional argument and MUST come last, after all flags.
        // Claude submits it on startup and stays interactive (works alongside --remote-control).
        if (InitialPrompt is not null)
            args.Add(InitialPrompt);
        return args;
    }

    private void AttachExitHandler()
    {
        if (_process is null) return;
        _process.EnableRaisingEvents = true;
        _process.Exited += (_, _) =>
        {
            State = SessionState.Exited;
            _log.LogInformation("Claude session {Id} (pid {Pid}) exited", Id, ProcessId);
        };
    }

    // Watch the working directory so the browser can auto-refresh when files change.
    private void StartWatcher()
    {
        try
        {
            var w = new FileSystemWatcher(WorkingDirectory)
            {
                IncludeSubdirectories = true,
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite | NotifyFilters.Size,
                InternalBufferSize = 64 * 1024,
            };
            void Bump(object? _, FileSystemEventArgs __) => Interlocked.Increment(ref _fsVersion);
            w.Changed += Bump;
            w.Created += Bump;
            w.Deleted += Bump;
            w.Renamed += (_, __) => Interlocked.Increment(ref _fsVersion);
            w.Error += (_, __) => Interlocked.Increment(ref _fsVersion);
            w.EnableRaisingEvents = true;
            _watcher = w;
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not watch {Cwd} for session {Id}", WorkingDirectory, Id);
        }
    }

    /// <summary>Refresh liveness in case the process died without us catching the event.</summary>
    public void Refresh()
    {
        if (State != SessionState.Running) return;
        try
        {
            if (_process is null || _process.HasExited) State = SessionState.Exited;
        }
        catch { State = SessionState.Exited; }
    }

    public void Stop()
    {
        // Killing the Job Object tears down the whole cmd.exe -> node tree in one shot.
        try { _terminal?.Kill(); }
        catch (Exception ex) { _log.LogWarning(ex, "Error stopping session {Id}", Id); }
        State = SessionState.Exited;
    }

    /// <summary>
    /// Dispose the pseudoconsole and job. Unlike the old detached-console model, this ends the child:
    /// a ConPTY child cannot outlive the host that owns its pseudoconsole master.
    /// </summary>
    public void Dispose()
    {
        try { _watcher?.Dispose(); } catch { }
        _watcher = null;
        try { _terminal?.Dispose(); } catch { }
        _terminal = null;
        try { _process?.Dispose(); } catch { }
        _process = null;
    }
}
