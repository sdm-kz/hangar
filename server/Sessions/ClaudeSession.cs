using System.Diagnostics;

namespace ClaudeWeb.Server.Sessions;

/// <summary>
/// A launched interactive <c>claude</c> session with Remote Control enabled. The web app only
/// starts and tracks it — all interaction happens from the Claude Code app over Remote Control.
/// The process runs in its own console (headless when the host is a Windows service).
/// </summary>
public sealed class ClaudeSession : IDisposable
{
    private readonly ExecutableSpec _exe;
    private readonly ILogger _log;
    private Process? _process;
    private FileSystemWatcher? _watcher;
    private long _fsVersion;

    public string Id { get; }
    public string Name { get; }
    public string WorkingDirectory { get; }
    public bool RemoteControl { get; }
    public string? Model { get; }
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
        Name = string.IsNullOrWhiteSpace(req.Name)
            ? new DirectoryInfo(req.WorkingDirectory).Name
            : req.Name!.Trim();
        _exe = exe;
        _log = log;
    }

    public SessionInfo ToInfo() => new(
        Id, Name, WorkingDirectory, RemoteControl, Model, State, ProcessId, CreatedAt);

    public void Start()
    {
        // The pseudo-console wrapper the CLI runs in is just a real console: no stdio redirection,
        // so the interactive TUI detects a terminal and (with --remote-control) registers for
        // control from other Claude Code apps.
        var args = BuildArgs();
        // If claude is the npm .cmd shim we must invoke it via cmd.exe /c; prepend that prefix.
        var launchArgs = new List<string>(_exe.Prefix);
        launchArgs.AddRange(args);

        _log.LogInformation("Launching claude session {Id} in {Cwd}: {Exe} {Args}",
            Id, WorkingDirectory, _exe.FileName, string.Join(' ', launchArgs));

        try
        {
            ProcessId = ConsoleLauncher.Start(_exe.FileName, launchArgs, WorkingDirectory);
            _process = Process.GetProcessById(ProcessId);
            _process.EnableRaisingEvents = true;
            _process.Exited += (_, _) =>
            {
                State = SessionState.Exited;
                _log.LogInformation("Claude session {Id} (pid {Pid}) exited", Id, ProcessId);
            };
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
        // Deliberately no --permission-mode: bypass mode shows a blocking startup prompt and is
        // unsafe; permission decisions are made interactively from the Claude Code app instead.
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
        return args;
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
        try
        {
            if (_process is { HasExited: false })
                _process.Kill(entireProcessTree: true);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Error stopping session {Id}", Id);
        }
        State = SessionState.Exited;
    }

    /// <summary>Release our handle to the process WITHOUT killing it (the RC session keeps running).</summary>
    public void Dispose()
    {
        try { _watcher?.Dispose(); } catch { }
        _watcher = null;
        try { _process?.Dispose(); } catch { }
        _process = null;
    }
}
