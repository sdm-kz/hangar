using System.Diagnostics;
using ClaudeWeb.Server.Sessions.Pty;

namespace ClaudeWeb.Server.Sessions;

/// <summary>
/// A launched interactive <c>claude</c> session. The process runs attached to a pseudoconsole
/// (ConPTY) owned by this app, so its terminal is streamed to an in-app xterm.js terminal over a
/// WebSocket (see <see cref="Terminal"/>). Because the pseudoconsole master is owned by this host,
/// the session's lifetime is tied to the host — like a VS Code integrated terminal, it does not
/// survive an app/host restart. Instead its launch metadata is persisted and offered as a
/// <see cref="SessionState.Restorable"/> entry, reopened with <c>--continue</c> (see <c>Continue</c>).
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
    /// <summary>Normalized permission mode: default | auto | acceptEdits | bypassPermissions.</summary>
    public string PermissionMode { get; }
    public bool Continue { get; }
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
        PermissionMode = NormalizeMode(req.PermissionMode);
        Continue = req.Continue;
        Name = string.IsNullOrWhiteSpace(req.Name)
            ? new DirectoryInfo(req.WorkingDirectory).Name
            : req.Name!.Trim();
        _exe = exe;
        _log = log;
    }

    /// <summary>Render a persisted entry as a <see cref="SessionState.Restorable"/> snapshot for the UI.</summary>
    public static SessionInfo RestorableInfo(PersistedSession p) => new(
        p.Id, p.Name, p.WorkingDirectory, p.RemoteControl, p.Model, p.PermissionMode,
        SessionState.Restorable, ProcessId: 0, p.CreatedAt);

    public SessionInfo ToInfo() => new(
        Id, Name, WorkingDirectory, RemoteControl, Model, PermissionMode, State, ProcessId, CreatedAt,
        RemoteUrl: _terminal?.RemoteUrl);

    public PersistedSession ToPersisted() => new(
        Id, Name, WorkingDirectory, RemoteControl, Model, InitialPrompt, PermissionMode, ProcessId, _processStartTicks, CreatedAt);

    /// <summary>Coerce an incoming/persisted mode string to a known value; anything unknown → "default".</summary>
    public static string NormalizeMode(string? mode) => mode switch
    {
        "auto" => "auto",
        "acceptEdits" => "acceptEdits",
        "bypassPermissions" => "bypassPermissions",
        _ => "default",
    };

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
        // Reopened session: resume the folder's most recent conversation instead of starting fresh.
        // (A ConPTY child dies with the host, so "restore" relaunches the process and continues.)
        if (Continue)
            args.Add("--continue");
        // Permission mode controls how much the session runs unattended (there's no human at the
        // pseudo-terminal to answer prompts). "default" leaves decisions to the interactive Claude
        // Code app. "bypassPermissions" skips ALL checks via --dangerously-skip-permissions; its
        // one-time acceptance screen would block startup, so SessionManager pre-writes
        // skipDangerousModePermissionPrompt=true to ~/.claude/settings.json first (see ClaudeBypassStore).
        switch (PermissionMode)
        {
            case "auto":
            case "acceptEdits":
                args.Add("--permission-mode");
                args.Add(PermissionMode);
                break;
            case "bypassPermissions":
                args.Add("--dangerously-skip-permissions");
                break;
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
        // Skipped when continuing so we don't re-fire the original launch prompt onto the resumed run.
        if (InitialPrompt is not null && !Continue)
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
