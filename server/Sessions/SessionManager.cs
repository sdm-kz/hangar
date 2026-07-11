using System.Collections.Concurrent;
using System.Text.Json;

namespace ClaudeWeb.Server.Sessions;

public sealed class SessionManagerOptions
{
    /// <summary>Path or command name used to launch Claude Code.</summary>
    public string ClaudeExecutable { get; set; } = "claude";

    /// <summary>
    /// Pre-accept Claude's workspace-trust prompt for the session's folder (writes
    /// hasTrustDialogAccepted into ~/.claude.json) so headless launches don't block on it.
    /// </summary>
    public bool AutoTrustFolders { get; set; } = true;

    /// <summary>
    /// Where launched sessions are persisted so they can be re-attached after the app restarts.
    /// Defaults to %LocalAppData%\ClaudeWeb\sessions.json when null/empty.
    /// </summary>
    public string? StateFile { get; set; }
}

/// <summary>Launches and tracks Remote-Control Claude sessions.</summary>
public sealed class SessionManager : IDisposable
{
    private readonly ConcurrentDictionary<string, ClaudeSession> _sessions = new();
    // Sessions from a previous app run whose process is gone: shown as Restorable and reopened
    // (relaunched with --continue) on demand. Kept in the state file until restored or forgotten.
    private readonly ConcurrentDictionary<string, PersistedSession> _restorable = new();
    private readonly ILoggerFactory _loggerFactory;
    private readonly ILogger<SessionManager> _log;
    private readonly ExecutableSpec _exe;
    private readonly SessionManagerOptions _options;
    private readonly string _stateFile;
    private readonly object _saveLock = new();

    public SessionManager(SessionManagerOptions options, ILoggerFactory loggerFactory)
    {
        _options = options;
        _loggerFactory = loggerFactory;
        _log = loggerFactory.CreateLogger<SessionManager>();
        _exe = ClaudeExecutableResolver.Resolve(options.ClaudeExecutable);
        _log.LogInformation("Resolved claude executable: {File} {Prefix}", _exe.FileName, string.Join(' ', _exe.Prefix));

        _stateFile = string.IsNullOrWhiteSpace(options.StateFile)
            ? Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "ClaudeWeb", "sessions.json")
            : options.StateFile;

        LoadPersisted();
    }

    public IReadOnlyCollection<SessionInfo> List()
    {
        foreach (var s in _sessions.Values) s.Refresh();
        return _sessions.Values.Select(s => s.ToInfo())
            .Concat(_restorable.Values.Select(ClaudeSession.RestorableInfo))
            .OrderBy(i => i.CreatedAt)
            .ToArray();
    }

    /// <summary>Ids of live sessions where Claude is currently generating output (for the "active" dot).</summary>
    public IReadOnlyCollection<string> BusySessionIds() =>
        _sessions.Values
            .Where(s => s.State == SessionState.Running && s.Terminal?.IsBusy == true)
            .Select(s => s.Id)
            .ToArray();

    public SessionInfo? Get(string id)
    {
        if (!_sessions.TryGetValue(id, out var s)) return null;
        s.Refresh();
        return s.ToInfo();
    }

    /// <summary>Filesystem change counter for a session's working directory (null if unknown).</summary>
    public long? FsVersion(string id) => _sessions.TryGetValue(id, out var s) ? s.FsVersion : null;

    /// <summary>The live terminal stream for a session (null if unknown or no longer running).</summary>
    public Pty.TerminalChannel? GetTerminal(string id) =>
        _sessions.TryGetValue(id, out var s) ? s.Terminal : null;

    /// <summary>Live sessions, for the watchdog to sweep.</summary>
    internal IEnumerable<ClaudeSession> LiveSessions() => _sessions.Values;

    /// <summary>Toggle the watchdog for one session; disabling also clears any pending state.</summary>
    public bool SetWatchdogEnabled(string id, bool enabled)
    {
        if (!_sessions.TryGetValue(id, out var s)) return false;
        s.WatchdogEnabled = enabled;
        if (!enabled)
        {
            s.WatchdogStatus = "healthy";
            s.WatchdogConsecutive = 0;
        }
        return true;
    }

    /// <summary>
    /// Reset a session's watchdog state (e.g. after a manual "Continue"): clears the give-up flag and
    /// the consecutive-attempt counter so auto-recovery can resume from a clean slate.
    /// </summary>
    public void ResetWatchdog(string id)
    {
        if (!_sessions.TryGetValue(id, out var s)) return;
        s.WatchdogStatus = "healthy";
        s.WatchdogConsecutive = 0;
        s.WatchdogLastContinueTick = 0;
    }

    public SessionInfo Create(CreateSessionRequest req)
    {
        var dir = (req.WorkingDirectory ?? "").Trim();
        if (string.IsNullOrWhiteSpace(dir) || !Directory.Exists(dir))
            throw new DirectoryNotFoundException($"Working directory does not exist: {dir}");

        var fullDir = Path.GetFullPath(dir);

        // Pre-accept the workspace-trust prompt so the interactive session starts unattended.
        if (_options.AutoTrustFolders)
            ClaudeTrustStore.EnsureTrusted(fullDir, _log);

        // Bypass mode launches with --dangerously-skip-permissions; pre-accept the one-time bypass
        // warning so the headless session doesn't block on its acceptance screen.
        if (ClaudeSession.NormalizeMode(req.PermissionMode) == "bypassPermissions")
            ClaudeBypassStore.EnsurePromptSuppressed(_log);

        var session = new ClaudeSession(
            req with { WorkingDirectory = fullDir },
            _exe,
            _loggerFactory.CreateLogger<ClaudeSession>());

        _sessions[session.Id] = session;
        session.Start();
        SavePersisted();
        return session.ToInfo();
    }

    /// <summary>
    /// Reopen a Restorable session from a previous run: relaunch a fresh process in the same folder
    /// with <c>--continue</c> so it resumes the folder's most recent conversation. Returns null if
    /// the id isn't a known restorable entry.
    /// </summary>
    public SessionInfo? Restore(string id)
    {
        if (!_restorable.TryRemove(id, out var p)) return null;
        try
        {
            return Create(new CreateSessionRequest(
                WorkingDirectory: p.WorkingDirectory,
                Name: p.Name,
                RemoteControl: p.RemoteControl,
                Model: p.Model,
                InitialPrompt: null, // resumed via --continue; don't re-fire the old launch prompt
                PermissionMode: p.PermissionMode,
                Continue: true));
        }
        catch
        {
            _restorable[id] = p; // launch failed — keep it restorable
            SavePersisted();
            throw;
        }
    }

    /// <summary>
    /// Remove a session. <paramref name="stopProcess"/> also kills the claude process. Also forgets
    /// a Restorable entry from a previous run (nothing to stop in that case).
    /// </summary>
    public bool Remove(string id, bool stopProcess)
    {
        if (_sessions.TryRemove(id, out var s))
        {
            if (stopProcess) s.Stop();
            s.Dispose();
            SavePersisted();
            return true;
        }
        if (_restorable.TryRemove(id, out _))
        {
            SavePersisted();
            return true;
        }
        return false;
    }

    // ---- Persistence: remember launched sessions so they can be reopened across app restarts -----
    // A ConPTY child dies with the host, so we can't re-attach to the live process. Instead we keep
    // each session's launch metadata and offer it as "Restorable" — reopened with --continue, which
    // relaunches a fresh process that resumes the folder's most recent conversation.

    private void LoadPersisted()
    {
        List<PersistedSession>? saved = null;
        try
        {
            if (File.Exists(_stateFile))
                saved = JsonSerializer.Deserialize<List<PersistedSession>>(File.ReadAllText(_stateFile));
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not read persisted sessions from {File}", _stateFile);
        }
        if (saved is null || saved.Count == 0) return;

        foreach (var p in saved)
            _restorable[p.Id] = p;
        _log.LogInformation("Loaded {Count} restorable session(s) from a previous run", _restorable.Count);
    }

    private void SavePersisted()
    {
        lock (_saveLock)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_stateFile)!);
                // Persist live sessions plus any still-unrestored entries from prior runs, so they
                // survive further restarts. Live entries win if an id somehow appears in both.
                var live = _sessions.Values.Select(s => s.ToPersisted());
                var liveIds = _sessions.Keys.ToHashSet();
                var pending = _restorable.Values.Where(p => !liveIds.Contains(p.Id));
                var list = live.Concat(pending).OrderBy(p => p.CreatedAt).ToList();
                File.WriteAllText(_stateFile, JsonSerializer.Serialize(list, new JsonSerializerOptions { WriteIndented = true }));
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "Could not persist sessions to {File}", _stateFile);
            }
        }
    }

    public void Dispose()
    {
        // A ConPTY child can't outlive the host, so disposing ends each claude process. Their launch
        // metadata is already on disk (written on create), so they come back as Restorable next start.
        foreach (var s in _sessions.Values) s.Dispose();
        _sessions.Clear();
    }
}
