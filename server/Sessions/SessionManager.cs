using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.RegularExpressions;

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
    // Same prompt patterns the watchdog uses to avoid auto-answering a dialog — reused here to
    // surface "Claude is waiting for you" as a first-class signal (a permission/selection prompt on
    // screen while Claude isn't emitting).
    private readonly Regex[] _inputPrompts;

    /// <summary>
    /// Raised whenever the session set or a session's metadata changes (create, rename, remove,
    /// restore, watchdog toggle). Lets a live view (<see cref="SessionHub"/>) push an update
    /// immediately instead of waiting for its next tick. Poll-only transitions (Claude going
    /// busy/idle, a process exiting) are picked up by the hub's periodic recompute, not this event.
    /// </summary>
    public event Action? Changed;

    private void RaiseChanged() => Changed?.Invoke();

    public SessionManager(SessionManagerOptions options, WatchdogOptions watchdog, ILoggerFactory loggerFactory)
    {
        _options = options;
        _loggerFactory = loggerFactory;
        _log = loggerFactory.CreateLogger<SessionManager>();
        _exe = ClaudeExecutableResolver.Resolve(options.ClaudeExecutable);
        _log.LogInformation("Resolved claude executable: {File} {Prefix}", _exe.FileName, string.Join(' ', _exe.Prefix));
        _inputPrompts = CompilePatterns(watchdog.PromptGuardPatterns);

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

    /// <summary>
    /// Ids of live sessions that appear to be waiting on the user — a permission/confirmation dialog
    /// or numbered selection menu is on screen and Claude isn't emitting. Best-effort (keys off the
    /// same on-screen prompt patterns as the watchdog guard); reliable for dialogs, not for
    /// open-ended free-text questions that just idle at the normal input box.
    /// </summary>
    public IReadOnlyCollection<string> AwaitingInputIds() =>
        _sessions.Values
            .Where(s => s.State == SessionState.Running
                     && s.Terminal is { IsBusy: false } t
                     && IsAwaitingInput(t))
            .Select(s => s.Id)
            .ToArray();

    // Shown by Claude Code throughout generation (including the thinking phase, when no PTY output
    // flows and IsBusy can read false) — a reliable "still working, not waiting" signal.
    private static readonly Regex WorkingHint =
        new(@"esc to interrupt", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private bool IsAwaitingInput(Pty.TerminalChannel term)
    {
        // Only the last handful of lines: a live prompt is the most recent output, so once the answer
        // and Claude's reply append after it the menu scrolls out of this window and stops counting.
        // (RecentText is the stripped output stream and RETAINS overwritten menus — Claude Code redraws
        // via cursor moves, which stripping drops — so a wide window keeps matching an already-answered
        // prompt, which flagged sessions as waiting long after the user replied.)
        var text = Tail(term.RecentText, 15);
        if (WorkingHint.IsMatch(text)) return false; // actively generating — not waiting
        return _inputPrompts.Any(r => r.IsMatch(text));
    }

    /// <summary>Return the last <paramref name="maxLines"/> lines of <paramref name="text"/> (whole string if fewer).</summary>
    private static string Tail(string text, int maxLines)
    {
        int newlines = 0;
        for (int i = text.Length - 1; i >= 0; i--)
            if (text[i] == '\n' && ++newlines == maxLines)
                return text[(i + 1)..];
        return text;
    }

    private Regex[] CompilePatterns(IEnumerable<string> patterns)
    {
        var list = new List<Regex>();
        foreach (var p in patterns)
        {
            try { list.Add(new Regex(p, RegexOptions.IgnoreCase | RegexOptions.Compiled | RegexOptions.CultureInvariant)); }
            catch (Exception ex) { _log.LogWarning(ex, "Ignoring invalid input-prompt pattern: {Pattern}", p); }
        }
        return list.ToArray();
    }

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

    /// <summary>
    /// Rename a session from the UI. For a live session this updates the display name and injects a
    /// <c>/rename &lt;name&gt;</c> into its terminal so Claude renames its own session too; for a
    /// Restorable entry it just updates the persisted name. Returns false if the id is unknown or the
    /// name is empty. (A <c>/rename</c> typed in the terminal is handled directly on the session and
    /// doesn't come through here, so there's no echo loop.)
    /// </summary>
    public bool Rename(string id, string newName)
    {
        var clean = ClaudeSession.SanitizeName(newName);
        if (clean.Length == 0) return false;

        if (_sessions.TryGetValue(id, out var s))
        {
            if (s.Rename(clean)) // raises MetadataChanged -> SavePersisted
                s.Terminal?.InjectInput($"/rename {clean}\r");
            return true;
        }
        if (_restorable.TryGetValue(id, out var p))
        {
            if (p.Name != clean)
            {
                _restorable[id] = p with { Name = clean };
                SavePersisted();
                RaiseChanged();
            }
            return true;
        }
        return false;
    }

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
        RaiseChanged();
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
        RaiseChanged();
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

        // Re-persist and push whenever a persisted field changes (a rename or a `/color` in the terminal).
        session.MetadataChanged += _ => { SavePersisted(); RaiseChanged(); };
        _sessions[session.Id] = session;
        session.Start();
        SavePersisted();
        RaiseChanged();
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
                Continue: true,
                Color: p.Color));
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
            RaiseChanged();
            return true;
        }
        if (_restorable.TryRemove(id, out _))
        {
            SavePersisted();
            RaiseChanged();
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
