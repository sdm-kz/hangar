using System.Diagnostics;
using ClaudeWeb.Pty;
using ClaudeWeb.Server.Sessions.Pty;

namespace ClaudeWeb.Server.Sessions;

/// <summary>
/// A launched interactive <c>claude</c> session. The process runs attached to a pseudoconsole
/// (ConPTY) — but the pseudoconsole is owned by a per-session <c>ClaudeWeb.PtyHost.exe</c>, not by
/// this app, and we reach it over a named pipe (see <see cref="Terminal"/>). That indirection is the
/// whole point: <b>a session outlives this app</b>. An in-app update, a redeploy, tray Exit or a
/// crash leaves the host and its <c>claude</c> running, and the next start re-attaches to the live
/// session with its scrollback and its conversation intact, rather than relaunching it with
/// <c>--resume</c>. <c>--remote-control</c> still works as an optional secondary control channel.
/// </summary>
/// <remarks>
/// What does <em>not</em> survive is a machine reboot — a ConPTY child cannot — and for that case
/// the persisted <see cref="SessionState.Restorable"/> entry and <c>Sessions:ResumeOnStart</c> work
/// exactly as they always did.
/// </remarks>
public sealed class ClaudeSession : IDisposable
{
    private readonly ExecutableSpec _exe;
    private readonly WatchdogOptions _watchdog; // handed to the pty host, which is where it runs
    private readonly ILogger _log;
    private readonly string? _hookToken; // injected into the child's env so its hooks can authenticate back
    private readonly string? _selfUrl;   // ditto: the base URL the child calls back on (/api/self/*)
    private readonly PtyHostLauncher _hosts;
    private PtyHostClient? _terminal;
    private FileSystemWatcher? _watcher;
    private long _fsVersion;
    private long _processStartTicks; // identifies the exact process, guarding against PID reuse on re-attach

    /// <summary>The live terminal stream (ring buffer + fan-out), or null once the process is gone.</summary>
    public ITerminal? Terminal => _terminal;

    /// <summary>Whether we are attached to a running pty host for this session.</summary>
    public bool IsAttached => _terminal is not null;

    public string Id { get; }
    public string Name { get; private set; }
    /// <summary>Session color (a color name set via <c>/color</c> in the terminal), or null.</summary>
    public string? Color { get; private set; }
    public string WorkingDirectory { get; }
    public bool RemoteControl { get; }
    public string? Model { get; }
    public string? InitialPrompt { get; }
    /// <summary>Normalized permission mode: default | auto | acceptEdits | bypassPermissions.</summary>
    public string PermissionMode { get; }
    public bool Continue { get; }
    /// <summary>When set, reopen resumes this exact Claude conversation (<c>--resume &lt;id&gt;</c>) instead of <c>--continue</c>.</summary>
    public string? ResumeSessionId { get; }
    /// <summary>
    /// Branch the resumed conversation rather than continuing it (<c>--fork-session</c>), so the
    /// original keeps running untouched and this one diverges from its history.
    /// </summary>
    public bool ForkSession { get; }
    /// <summary>Our id of the session this one was forked from; null when it isn't a fork.</summary>
    public string? ParentSessionId { get; internal set; }
    /// <summary>The parent's display name at fork time (kept so a fork can name a parent that's gone).</summary>
    public string? ParentName { get; internal set; }

    /// <summary>
    /// This session's own conversation id as best we know it before any hook has reported one — used as
    /// the fallback for a later reopen/fork. An ordinary resumed session kept the id it resumed; a
    /// <em>fork</em> deliberately got a new one, so its <see cref="ResumeSessionId"/> names the PARENT's
    /// conversation and must never stand in for its own (resuming it would rejoin the parent).
    /// </summary>
    public string? OwnConversationId => ForkSession ? null : ResumeSessionId;
    public SessionState State { get; private set; } = SessionState.Running;

    /// <summary>
    /// True when this app <em>re-attached</em> to an already-running session at startup rather than
    /// launching it. Surfaced in the sidebar so it's visible that the process — and the conversation
    /// in it — is the original one, carried across the restart rather than resumed into a new one.
    /// </summary>
    public bool Adopted { get; private set; }

    public int ProcessId { get; private set; }
    public DateTimeOffset CreatedAt { get; } = DateTimeOffset.Now;

    /// <summary>
    /// When we first observed the process to be gone (UTC), or null while it's alive. Read by
    /// <see cref="SessionManager"/>'s auto-resume bookkeeping, which can't take a fresh exit at face
    /// value: a Windows shutdown kills these children before the app learns it's going down, and those
    /// deaths must not be mistaken for the session ending on its own.
    /// </summary>
    public DateTime? ExitedAt { get; private set; }

    // ---- Watchdog (auto-recover from a hung API/streaming error) -------------------------------
    // The watchdog itself runs in the pty host, so it keeps working while this app is stopped. What
    // stays here is the user's per-session opt-in, which is persisted in sessions.json and pushed down
    // to the host on every attach; the status comes back the other way, on the host's state pushes.

    /// <summary>Whether the hang watchdog may auto-continue this session (user-toggleable). Off by
    /// default; the launch request opts in, and it can be toggled later per session.</summary>
    public bool WatchdogEnabled { get; private set; }

    /// <summary>Current watchdog view of the session: "healthy" | "recovering" | "attention".</summary>
    public string WatchdogStatus => _terminal?.WatchdogStatus ?? "healthy";

    /// <summary>
    /// Turn the watchdog on or off for this session, optionally clearing the host's give-up flag and
    /// attempt counter (after a manual "Continue"). Returns once the host has been told.
    /// </summary>
    public async Task SetWatchdogAsync(bool? enabled, bool reset = false, CancellationToken ct = default)
    {
        if (enabled is { } e) WatchdogEnabled = e;
        if (_terminal is { } t) await t.SetWatchdogAsync(WatchdogEnabled, reset, ct);
    }

    /// <summary>Bumped whenever the working directory changes; the UI polls it to auto-refresh.</summary>
    public long FsVersion => Interlocked.Read(ref _fsVersion);

    /// <summary>Raised when a persisted field (name or color) changes, so the manager can re-persist.</summary>
    public event Action<ClaudeSession>? MetadataChanged;

    /// <summary>
    /// Raised when the host pushes new busy / waiting / watchdog state. Nothing persisted changes, so
    /// this only asks the session hub to re-broadcast.
    /// </summary>
    public event Action<ClaudeSession>? StateChanged;

    /// <summary>
    /// Raised when the claude process ends on its own. The manager re-persists so the session is no
    /// longer marked as running — otherwise auto-resume would relaunch it on the next app start.
    /// </summary>
    public event Action<ClaudeSession>? ProcessExited;

    /// <summary>
    /// Change the session's display name (from a UI rename or a <c>/rename</c> typed in the terminal).
    /// Strips control characters and caps length. Returns false when the name is empty or unchanged.
    /// </summary>
    public bool Rename(string? newName)
    {
        var clean = SanitizeName(newName);
        if (clean.Length == 0 || clean == Name) return false;
        Name = clean;
        MetadataChanged?.Invoke(this);
        return true;
    }

    /// <summary>
    /// Set the session's color (from a <c>/color</c> typed in the terminal). Sanitizes to a short
    /// color name. Returns false when the color is empty or unchanged.
    /// </summary>
    public bool SetColor(string? newColor)
    {
        var clean = SanitizeColor(newColor);
        if (clean is null || clean == Color) return false;
        Color = clean;
        MetadataChanged?.Invoke(this);
        return true;
    }

    /// <summary>Normalize a color token to lowercase letters, capped; null when there's nothing usable.</summary>
    public static string? SanitizeColor(string? color)
    {
        if (string.IsNullOrWhiteSpace(color)) return null;
        var clean = new string(color.Where(char.IsLetter).ToArray()).ToLowerInvariant();
        if (clean.Length == 0) return null;
        return clean.Length > 20 ? clean[..20] : clean;
    }

    /// <summary>Trim, drop control chars (so it's safe to echo/inject as a terminal command), cap length.</summary>
    public static string SanitizeName(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return "";
        var clean = new string(name.Where(c => !char.IsControl(c)).ToArray()).Trim();
        return clean.Length > 100 ? clean[..100] : clean;
    }

    /// <param name="id">
    /// The session's id. Null mints a fresh one; a value is passed only when <b>adopting</b> a session
    /// from a previous run, which must keep its id or every fork link, hook correlation and postponed
    /// message pointing at it would break.
    /// </param>
    public ClaudeSession(CreateSessionRequest req, ExecutableSpec exe, PtyHostLauncher hosts,
        WatchdogOptions watchdog, ILogger log,
        string? hookToken = null, string? selfUrl = null, string? id = null)
    {
        _watchdog = watchdog;
        _hookToken = hookToken;
        _selfUrl = selfUrl;
        _hosts = hosts;
        Id = id ?? Guid.NewGuid().ToString("n");
        WorkingDirectory = req.WorkingDirectory;
        RemoteControl = req.RemoteControl;
        Model = string.IsNullOrWhiteSpace(req.Model) ? null : req.Model;
        InitialPrompt = string.IsNullOrWhiteSpace(req.InitialPrompt) ? null : req.InitialPrompt!.Trim();
        PermissionMode = NormalizeMode(req.PermissionMode);
        Continue = req.Continue;
        ResumeSessionId = string.IsNullOrWhiteSpace(req.ResumeSessionId) ? null : req.ResumeSessionId;
        // Forking only means anything with a conversation to branch from; without one it would silently
        // become an ordinary fresh session, so drop the flag rather than pass a no-op to the CLI.
        ForkSession = req.ForkSession && (ResumeSessionId is not null || req.Continue);
        ParentSessionId = string.IsNullOrWhiteSpace(req.ParentSessionId) ? null : req.ParentSessionId;
        ParentName = string.IsNullOrWhiteSpace(req.ParentName) ? null : SanitizeName(req.ParentName);
        WatchdogEnabled = req.WatchdogEnabled;
        Name = string.IsNullOrWhiteSpace(req.Name)
            ? new DirectoryInfo(req.WorkingDirectory).Name
            : req.Name!.Trim();
        Color = SanitizeColor(req.Color); // carried across a restore; otherwise set later via /color
        _exe = exe;
        _log = log;
    }

    /// <summary>Render a persisted entry as a <see cref="SessionState.Restorable"/> snapshot for the UI.</summary>
    public static SessionInfo RestorableInfo(PersistedSession p) => new(
        p.Id, p.Name, p.WorkingDirectory, p.RemoteControl, p.Model, p.PermissionMode,
        SessionState.Restorable, ProcessId: 0, p.CreatedAt, Color: p.Color,
        ResumeExact: p.ClaudeSessionId is not null,
        PostponedCount: PostponedStore.Count(p.WorkingDirectory, p.Id),
        ClaudeSessionId: p.ClaudeSessionId,
        CanFork: p.ClaudeSessionId is not null,
        ParentSessionId: p.ParentSessionId,
        ParentName: p.ParentName);

    /// <summary>
    /// Snapshot for the UI. <paramref name="claudeSessionId"/> is the conversation id the manager holds
    /// for this session (from hooks, or the id it resumed with) — passed in because only the manager
    /// sees the hook store, and it's what decides whether the session can be forked.
    /// </summary>
    public SessionInfo ToInfo(string? claudeSessionId = null) => new(
        Id, Name, WorkingDirectory, RemoteControl, Model, PermissionMode, State, ProcessId, CreatedAt,
        RemoteUrl: _terminal?.RemoteUrl,
        WatchdogEnabled: WatchdogEnabled,
        WatchdogStatus: WatchdogStatus,
        Color: Color,
        PostponedCount: PostponedStore.Count(WorkingDirectory, Id),
        CanFork: (claudeSessionId ?? OwnConversationId) is not null,
        ParentSessionId: ParentSessionId,
        ParentName: ParentName,
        Adopted: Adopted);

    public PersistedSession ToPersisted() => new(
        Id, Name, WorkingDirectory, RemoteControl, Model, InitialPrompt, PermissionMode, ProcessId, _processStartTicks, CreatedAt, Color,
        // Base value only: the manager overwrites this when it saves, because a process that died
        // seconds ago may well have been killed by a machine shutdown rather than have ended on its
        // own. See SessionManager.ShouldResume.
        WasRunning: State == SessionState.Running,
        WatchdogEnabled: WatchdogEnabled,
        ParentSessionId: ParentSessionId,
        ParentName: ParentName);

    /// <summary>Coerce an incoming/persisted mode string to a known value; anything unknown → "default".</summary>
    public static string NormalizeMode(string? mode) => mode switch
    {
        "auto" => "auto",
        "acceptEdits" => "acceptEdits",
        "bypassPermissions" => "bypassPermissions",
        _ => "default",
    };

    /// <summary>
    /// Launch the session: start a pty host for it, then attach to that host over its pipe. The
    /// process tree that results is <c>ClaudeWeb.PtyHost.exe -&gt; cmd.exe -&gt; claude.exe</c>, and
    /// only the first of those is ours to end.
    /// </summary>
    public async Task StartAsync(CancellationToken ct = default)
    {
        // The child runs attached to a pseudoconsole (ConPTY): it still sees an interactive terminal
        // (so the TUI renders and --remote-control registers), but its VT stream is piped to the host,
        // and from there to us and on to the in-app xterm.js terminal.
        var args = BuildArgs();
        // If claude is the npm .cmd shim we must invoke it via cmd.exe /c; prepend that prefix.
        var launchArgs = new List<string>(_exe.Prefix);
        launchArgs.AddRange(args);

        _log.LogInformation("Launching claude session {Id} in {Cwd}: {Exe} {Args}",
            Id, WorkingDirectory, _exe.FileName, string.Join(' ', launchArgs));

        try
        {
            var client = await _hosts.StartAsync(
                Id, _exe.FileName, launchArgs, WorkingDirectory, BuildEnvironment(), 120, 30,
                _watchdog, WatchdogEnabled, ct: ct);
            Bind(client);
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

    /// <summary>
    /// Re-attach to a session whose pty host is still running — the case this whole design exists for.
    /// Called at startup for each live host found in the pty state directory. Returns false when
    /// nothing answers the pipe, which means the state file is stale and the session falls back to
    /// today's Restorable / auto-resume path.
    /// </summary>
    public async Task<bool> AttachAsync(PtyState state, CancellationToken ct = default)
    {
        var client = await _hosts.AttachAsync(Id, state.PipeName, ct);
        if (client is null) return false;

        Bind(client);
        Adopted = true;
        State = client.AlreadyExited ? SessionState.Exited : SessionState.Running;
        if (client.AlreadyExited) ExitedAt ??= DateTime.UtcNow;
        else StartWatcher();
        _log.LogInformation("Re-attached to session {Id} ('{Name}'): host pid {HostPid}, claude pid {Pid} — no relaunch, no --resume.",
            Id, Name, state.HostPid, client.ProcessId);
        return true;
    }

    /// <summary>Wire a freshly connected client into this session's identity and events.</summary>
    private void Bind(PtyHostClient client)
    {
        _terminal = client;
        // Mirror a `/rename <name>` typed at the Claude prompt into our own name. Claude handles the
        // command natively; the host watches its output for the confirmation and pushes it to us.
        client.RenameCommandDetected += name =>
        {
            if (Rename(name))
                _log.LogInformation("Session {Id} renamed to '{Name}' via terminal /rename", Id, Name);
        };
        // Likewise mirror a `/color <name>` typed at the prompt into the session's color.
        client.ColorCommandDetected += color =>
        {
            if (SetColor(color))
                _log.LogInformation("Session {Id} color set to '{Color}' via terminal /color", Id, Color);
        };
        client.Exited += OnChildExited;
        // A pushed busy/waiting/watchdog change should reach the browser at once rather than waiting
        // for the hub's next tick.
        client.StateChanged += () => StateChanged?.Invoke(this);
        ProcessId = client.ProcessId;
        _processStartTicks = client.ProcessStartTicks;
        // sessions.json is the source of truth for the per-session opt-in, so tell the host what it is
        // — on a fresh launch and, just as importantly, on every re-attach.
        _ = client.SetWatchdogAsync(WatchdogEnabled);
    }

    /// <summary>
    /// The environment the child is launched with. Correlation for Claude's http hooks: the (global)
    /// hook config reads these into the X-Session-Id / X-Hook-Token headers it posts back to
    /// /api/hooks. Built here rather than in the host, which has no idea about any of it.
    /// </summary>
    private Dictionary<string, string> BuildEnvironment()
    {
        var env = new Dictionary<string, string>();
        // The host is launched detached and doesn't pass its own environment on, so the child's block
        // starts from ours — which is what it inherited implicitly when we spawned it in-process.
        foreach (System.Collections.DictionaryEntry kv in Environment.GetEnvironmentVariables())
            env[(string)kv.Key] = kv.Value?.ToString() ?? "";
        env["CLAUDEWEB_SESSION_ID"] = Id;
        if (!string.IsNullOrEmpty(_hookToken))
            env["CLAUDEWEB_HOOK_TOKEN"] = _hookToken;
        // Where the session can reach us: the same pair of correlation headers also authorizes the
        // self-service endpoints (POST /api/self/name), so a command run *inside* the session can
        // rename it with a one-line curl. Loopback — a session always runs on this machine.
        if (!string.IsNullOrEmpty(_selfUrl))
            env["CLAUDEWEB_URL"] = _selfUrl;
        return env;
    }

    private List<string> BuildArgs()
    {
        var args = new List<string>();
        // Reopened session: relaunch resuming its conversation instead of starting fresh. This is now
        // only for a session that genuinely ended — one whose host is still alive is re-attached
        // instead, with no relaunch and no --resume. Prefer --resume <id> to reopen the EXACT
        // conversation — a folder can hold several, and --continue would grab whichever was most
        // recent. Fall back to --continue when we never captured the session id (e.g. a pre-hooks one).
        if (ResumeSessionId is not null)
        {
            args.Add("--resume");
            args.Add(ResumeSessionId);
        }
        else if (Continue)
            args.Add("--continue");
        // A fork replays the resumed conversation into a NEW Claude session id, so the session we
        // branched from keeps its own history and the two diverge from here. Only valid alongside a
        // resume, which the constructor already guarantees.
        if (ForkSession)
            args.Add("--fork-session");
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
        // Skipped when resuming (--continue/--resume) so we don't re-fire the original launch prompt.
        if (InitialPrompt is not null && !Continue && ResumeSessionId is null)
            args.Add(InitialPrompt);
        return args;
    }

    /// <summary>
    /// The session's process ended. Reaches us as an <c>exited</c> push from the pty host — or, if the
    /// pipe simply dropped, from <see cref="PtyHostClient"/> noticing the host is gone (which means the
    /// child is too: the pseudoconsole's job object is kill-on-close, so it dies with its host).
    /// </summary>
    private void OnChildExited(int exitCode)
    {
        // Raised off a pipe-reader thread — any escape here would reach AppDomain.UnhandledException
        // and terminate the whole app, so keep it defensive.
        try
        {
            MarkExited();
            _log.LogInformation("Claude session {Id} (pid {Pid}) exited with code {Code}", Id, ProcessId, exitCode);
            ProcessExited?.Invoke(this);
        }
        catch { /* never let a session's exit notification crash the host */ }
    }

    /// <summary>Move to <see cref="SessionState.Exited"/>, stamping the moment we first noticed.</summary>
    private void MarkExited()
    {
        State = SessionState.Exited;
        ExitedAt ??= DateTime.UtcNow;
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

    /// <summary>
    /// Refresh liveness in case the process died without us catching the event. The pipe is the
    /// primary signal (it carries an explicit <c>exited</c>, and drops if the host itself dies), so
    /// this is only a backstop for the window before that lands.
    /// </summary>
    public void Refresh()
    {
        if (State != SessionState.Running) return;
        if (_terminal is null) { MarkExited(); return; }
        try
        {
            using var p = Process.GetProcessById(ProcessId);
            if (p.HasExited) MarkExited();
        }
        catch { MarkExited(); } // no such process — it's gone
    }

    /// <summary>
    /// End the session for real: ask its pty host to shut down, and kill the host outright if it
    /// doesn't. Killing the host is sufficient and complete — Porta.Pty puts the pseudoconsole's child
    /// in a job object with <c>JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE</c> and job membership is inherited,
    /// so <c>cmd.exe</c> and the <c>claude.exe</c> under it go down with it. There is no process tree
    /// left to hunt.
    /// </summary>
    /// <remarks>
    /// This is the ONLY path that ends a session. <see cref="Dispose"/> deliberately does not — see
    /// its own remarks.
    /// </remarks>
    public void Stop()
    {
        var client = _terminal;
        if (client is not null)
        {
            try
            {
                client.ShutdownAsync(kill: true).Wait(ShutdownGrace);
                // Give the host a moment to take its child down and delete its state file, so a
                // Remove() immediately followed by a restart doesn't find a half-torn-down session.
                _hosts.WaitForHostExit(Id, ShutdownGrace);
            }
            catch (Exception ex) { _log.LogDebug(ex, "Pty host for session {Id} did not acknowledge shutdown", Id); }
        }
        // Backstop for a host that ignored the request. Shared with orphan cleanup, which has no
        // attached client and so has only this half.
        _hosts.KillHost(Id);
        try { client?.Dispose(); } catch { }
        _terminal = null;
        MarkExited();
    }

    /// <summary>How long to let the host stand down gracefully before insisting.</summary>
    internal static readonly TimeSpan ShutdownGrace = TimeSpan.FromSeconds(5);

    /// <summary>
    /// <b>Detach, do not kill.</b> Closes the pipe and drops the filesystem watcher; the pty host and
    /// its <c>claude</c> process carry on running, and the next app start re-attaches to them.
    /// </summary>
    /// <remarks>
    /// This is the inversion the whole feature rests on. Disposing used to end the session — which is
    /// why an update, a redeploy or tray Exit took every session down and left them to be relaunched
    /// with <c>--resume</c>, losing whatever turn was in flight. Anything that wants a session
    /// genuinely ended must call <see cref="Stop"/>.
    /// </remarks>
    public void Dispose()
    {
        try { _watcher?.Dispose(); } catch { }
        _watcher = null;
        try { _terminal?.Dispose(); } catch { }
        _terminal = null;
    }
}
