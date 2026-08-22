using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.RegularExpressions;
using ClaudeWeb.Server.Auth;

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

    /// <summary>
    /// Relaunch every session that was running when the app last closed (PC shutdown, redeploy, tray
    /// Exit) as soon as the app starts again, resuming each conversation. On by default; set false to
    /// have them wait as manual "Reopen" entries instead.
    /// </summary>
    public bool ResumeOnStart { get; set; } = true;

    /// <summary>
    /// How long to wait after startup before auto-resuming. Gives the machine a moment after a boot
    /// (networking, credential store) so the relaunched sessions don't come up to a dead API.
    /// </summary>
    public int ResumeDelayMs { get; set; } = 5000;

    /// <summary>Pause between consecutive auto-resumed launches, so a large working set starts gently.</summary>
    public int ResumeStaggerMs { get; set; } = 2000;
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
    private readonly TokenStore _tokens;
    private readonly HookEventStore _hooks;
    private readonly RecentsStore _recents;
    // The launch preset each live session came from, so the Claude conversation id can be stamped back
    // onto the matching "recent" entry once a hook reports it (see OnClaudeSessionIdCaptured).
    private readonly ConcurrentDictionary<string, RecentSession> _launchedFrom = new();
    private readonly string _stateFile;
    private readonly object _saveLock = new();
    // Set once the host is tearing down. Disposing kills every session's process, which fires their
    // exit handlers — without this, those handlers would rewrite the state file with WasRunning=false
    // and the sessions that were running at exit would never auto-resume. The last save before
    // shutdown already holds the truth, so freeze the file here.
    private volatile bool _shuttingDown;
    // How long after a session's process dies we keep persisting it as "was running".
    //
    // A Windows shutdown terminates the claude children first and can take this app down before it
    // ever learns it's shutting down, so _shuttingDown alone doesn't cover it: each of those deaths
    // fires ProcessExited, which used to persist WasRunning=false and quietly opt the session out of
    // the next start's auto-resume. That is exactly what happened — nine sessions died within ~2s of
    // a shutdown and only the one whose exit handler never ran came back. Inside this window a save
    // still records the session as running; a scheduled re-save just past it corrects the record for a
    // session that genuinely ended on its own, so only a shutdown lands in the window.
    private static readonly TimeSpan ExitGrace = TimeSpan.FromSeconds(30);
    // One-shot timer for that corrective re-save; created idle and rescheduled (never stacked), so a
    // burst of exits costs a single timer.
    private readonly System.Threading.Timer _exitRecheck;
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

    public SessionManager(SessionManagerOptions options, WatchdogOptions watchdog, TokenStore tokens, HookEventStore hooks, RecentsStore recents, ILoggerFactory loggerFactory)
    {
        _options = options;
        _tokens = tokens;
        _hooks = hooks;
        _recents = recents;
        _hooks.ClaudeSessionIdCaptured += OnClaudeSessionIdCaptured;
        _loggerFactory = loggerFactory;
        _log = loggerFactory.CreateLogger<SessionManager>();
        _exe = ClaudeExecutableResolver.Resolve(options.ClaudeExecutable);
        _log.LogInformation("Resolved claude executable: {File} {Prefix}", _exe.FileName, string.Join(' ', _exe.Prefix));
        _inputPrompts = CompilePatterns(watchdog.PromptGuardPatterns);
        // Idle until a session exit books it; see ScheduleExitRecheck.
        _exitRecheck = new System.Threading.Timer(_ => OnExitRecheck(), null, Timeout.Infinite, Timeout.Infinite);

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
        return _sessions.Values.Select(s => s.ToInfo(ConversationId(s)))
            .Concat(_restorable.Values.Select(ClaudeSession.RestorableInfo))
            .OrderBy(i => i.CreatedAt)
            .ToArray();
    }

    /// <summary>
    /// Claude's own conversation id for a live session: the one its hooks reported, or — for a session
    /// that resumed an existing conversation and hasn't produced a hook yet — the id it resumed. Null
    /// while a fresh (or freshly forked) session is still starting up. This is what a reopen resumes
    /// and what a fork branches from.
    /// </summary>
    private string? ConversationId(ClaudeSession s) => _hooks.ClaudeSessionId(s.Id) ?? s.OwnConversationId;

    /// <summary>Ids of live sessions where Claude is currently generating output (for the "active" dot).</summary>
    public IReadOnlyCollection<string> BusySessionIds() =>
        _sessions.Values
            .Where(s => s.State == SessionState.Running && IsBusy(s))
            .Select(s => s.Id)
            .ToArray();

    /// <summary>
    /// Whether Claude is generating in a session. Prefers the authoritative hook-derived status (exact
    /// UserPromptSubmit→Stop transitions); falls back to the terminal-output heuristic for sessions that
    /// haven't produced a hook event yet (e.g. hooks disabled, or the brief window before SessionStart).
    /// </summary>
    private bool IsBusy(ClaudeSession s) =>
        _hooks.TryGetStatus(s.Id, out var st) ? st.Busy : s.Terminal?.IsBusy == true;

    /// <summary>
    /// Ids of live sessions that appear to be waiting on the user — a permission/confirmation dialog
    /// or numbered selection menu is on screen and Claude isn't emitting. Best-effort (keys off the
    /// same on-screen prompt patterns as the watchdog guard); reliable for dialogs, not for
    /// open-ended free-text questions that just idle at the normal input box.
    /// </summary>
    public IReadOnlyCollection<string> AwaitingInputIds() =>
        _sessions.Values
            .Where(s => s.State == SessionState.Running && IsAwaitingInput(s))
            .Select(s => s.Id)
            .ToArray();

    /// <summary>
    /// Whether a session is waiting on the user. Prefers the hook-derived status (a
    /// Notification/PermissionRequest fired with no answer yet); falls back to the on-screen prompt
    /// heuristic for sessions without hook data.
    /// </summary>
    private bool IsAwaitingInput(ClaudeSession s) =>
        _hooks.TryGetStatus(s.Id, out var st)
            ? st.Waiting
            : s.Terminal is { IsBusy: false } t && IsAwaitingInput(t);

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
        return s.ToInfo(ConversationId(s));
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
            _loggerFactory.CreateLogger<ClaudeSession>(),
            _tokens.HookToken);

        // Re-persist and push whenever a persisted field changes (a rename or a `/color` in the terminal).
        session.MetadataChanged += _ => { SavePersisted(); RaiseChanged(); };
        // Same when the process ends by itself: the saved entry must stop claiming it was running, or
        // the next start would auto-resume a session the user had already let finish.
        session.ProcessExited += _ => { SavePersisted(); RaiseChanged(); };
        _launchedFrom[session.Id] = PresetOf(req);
        _sessions[session.Id] = session;
        session.Start();
        SavePersisted();
        RaiseChanged();
        return session.ToInfo(ConversationId(session));
    }

    /// <summary>
    /// Branch a session's conversation into a new one: relaunch <c>claude</c> in the same folder with
    /// the same settings, resuming the session's conversation under <c>--fork-session</c> so Claude
    /// replays its history into a fresh conversation id. The original is left running and untouched;
    /// the fork records its parent so the UI can nest it underneath.
    /// Works for a live session and for a Restorable entry from a previous run. Returns null when the
    /// id is unknown; throws when we don't (yet) know a conversation id to branch from.
    /// </summary>
    public SessionInfo? Fork(string id, string? name)
    {
        string workingDirectory, parentName, conversationId, permissionMode;
        bool remoteControl;
        string? model;
        bool watchdogEnabled;

        if (_sessions.TryGetValue(id, out var live))
        {
            conversationId = ConversationId(live)
                ?? throw new InvalidOperationException(
                    "This session hasn't reported its conversation id yet — give it a moment and try again.");
            workingDirectory = live.WorkingDirectory;
            parentName = live.Name;
            remoteControl = live.RemoteControl;
            model = live.Model;
            permissionMode = live.PermissionMode;
            watchdogEnabled = live.WatchdogEnabled;
        }
        else if (_restorable.TryGetValue(id, out var p))
        {
            conversationId = p.ClaudeSessionId
                ?? throw new InvalidOperationException(
                    "This session's conversation id was never captured, so there's nothing to fork from.");
            workingDirectory = p.WorkingDirectory;
            parentName = p.Name;
            remoteControl = p.RemoteControl;
            model = p.Model;
            permissionMode = p.PermissionMode ?? "";
            watchdogEnabled = p.WatchdogEnabled;
        }
        else return null;

        var forkName = ClaudeSession.SanitizeName(name);
        if (forkName.Length == 0) forkName = DefaultForkName(parentName);

        return Create(new CreateSessionRequest(
            WorkingDirectory: workingDirectory,
            Name: forkName,
            RemoteControl: remoteControl,
            Model: model,
            InitialPrompt: null, // the fork inherits the conversation; there's no fresh prompt to fire
            PermissionMode: permissionMode,
            Continue: false,
            ResumeSessionId: conversationId,
            Color: null, // a distinct branch — let it get its own /color rather than mirroring the parent
            WatchdogEnabled: watchdogEnabled,
            ForkSession: true,
            ParentSessionId: id,
            ParentName: parentName));
    }

    /// <summary>
    /// A "(fork)" / "(fork 3)" suffix this scheme added earlier, stripped before naming the next one so
    /// forking a fork numbers off the original ("a (fork 2)") instead of stacking suffixes.
    /// </summary>
    private static readonly Regex ForkSuffix =
        new(@"\s*\(fork(?:\s+\d+)?\)\s*$", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>Name used when the fork dialog's name field is left blank: "parent (fork)", "… (fork 2)", …</summary>
    private string DefaultForkName(string parentName)
    {
        var taken = _sessions.Values.Select(s => s.Name)
            .Concat(_restorable.Values.Select(p => p.Name))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        // Fall back to the full name if it's nothing *but* a suffix, so we never name a session "(fork)".
        var stripped = ForkSuffix.Replace(parentName, "").Trim();
        var b = stripped.Length == 0 ? parentName : stripped;
        var candidate = ClaudeSession.SanitizeName($"{b} (fork)");
        for (int n = 2; taken.Contains(candidate); n++)
            candidate = ClaudeSession.SanitizeName($"{b} (fork {n})");
        return candidate;
    }

    /// <summary>
    /// The "recent" launch preset a request corresponds to. Built from the raw request fields — the New
    /// Session dialog posts the very same values to /api/recents/sessions right after launching — so the
    /// two agree on the preset's identity without any fuzzy matching.
    /// </summary>
    private static RecentSession PresetOf(CreateSessionRequest req) => new(
        (req.WorkingDirectory ?? "").Trim(),
        req.Name ?? "",
        req.InitialPrompt ?? "",
        req.Model ?? "",
        req.RemoteControl,
        req.PermissionMode ?? "");

    /// <summary>
    /// A hook reported Claude's own session id for one of our sessions. Persist it right away (both in
    /// the session state file, for a Restorable reopen, and on the launch preset it came from, so
    /// reusing that preset with "continue" resumes this exact conversation).
    /// </summary>
    private void OnClaudeSessionIdCaptured(string sessionId, string claudeSessionId)
    {
        try
        {
            if (!_sessions.ContainsKey(sessionId)) return;
            SavePersisted();
            if (_launchedFrom.TryGetValue(sessionId, out var preset))
                _recents.SetClaudeSessionId(preset, claudeSessionId);
        }
        catch (Exception ex)
        {
            // Runs on the hook request's thread — never let a bookkeeping failure fail the callback.
            _log.LogWarning(ex, "Could not record Claude session id for {Id}", sessionId);
        }
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
            var info = Create(new CreateSessionRequest(
                WorkingDirectory: p.WorkingDirectory,
                Name: p.Name,
                RemoteControl: p.RemoteControl,
                Model: p.Model,
                InitialPrompt: null, // resumed; don't re-fire the old launch prompt
                PermissionMode: p.PermissionMode,
                Continue: true, // fallback when we never captured the Claude session id
                ResumeSessionId: p.ClaudeSessionId, // reopen the EXACT conversation when known
                Color: p.Color,
                WatchdogEnabled: p.WatchdogEnabled,
                // Reopening resumes the conversation as-is — it is NOT a fork, whatever this entry once
                // was — but it keeps its place in the fork tree.
                ForkSession: false,
                ParentSessionId: p.ParentSessionId,
                ParentName: p.ParentName));
            // The reopened session has a brand-new id, so anything forked from the old one would be
            // orphaned. Move those links over to the replacement.
            Reparent(id, info.Id);
            return info;
        }
        catch
        {
            _restorable[id] = p; // launch failed — keep it restorable
            SavePersisted();
            throw;
        }
    }

    /// <summary>
    /// Point every fork of <paramref name="oldParentId"/> at <paramref name="newParentId"/> — the session
    /// that replaced it after a reopen. Without this the fork tree would flatten out on every restore
    /// (and on the auto-resume that runs at startup), since a relaunch always gets a fresh id.
    /// </summary>
    private void Reparent(string oldParentId, string newParentId)
    {
        var changed = false;
        foreach (var s in _sessions.Values)
        {
            if (s.ParentSessionId != oldParentId || s.Id == newParentId) continue;
            s.ParentSessionId = newParentId;
            changed = true;
        }
        foreach (var (key, p) in _restorable)
        {
            if (p.ParentSessionId != oldParentId) continue;
            _restorable[key] = p with { ParentSessionId = newParentId };
            changed = true;
        }
        if (!changed) return;
        SavePersisted();
        RaiseChanged();
    }

    /// <summary>
    /// Relaunch every persisted session that was running at the previous exit
    /// (<see cref="PersistedSession.WasRunning"/>), resuming each conversation with
    /// <c>--resume &lt;id&gt;</c> (or <c>--continue</c>). Called once at startup unless
    /// <see cref="SessionManagerOptions.ResumeOnStart"/> is off, so a PC shutdown/boot, a redeploy or a
    /// tray Exit brings the working set back by itself instead of leaving manual "Reopen" entries.
    /// Best-effort: a session whose folder is gone or that fails to launch simply stays Restorable.
    /// Launches are staggered, so run this off the startup path.
    /// </summary>
    public async Task ResumePersistedAsync(CancellationToken ct = default)
    {
        // Oldest first, so the relaunched sessions keep the order the user had them in.
        var pending = _restorable.Values.Where(p => p.WasRunning).OrderBy(p => p.CreatedAt).ToArray();
        if (pending.Length == 0) return;

        _log.LogInformation("Auto-resuming {Count} session(s) that were running at the last exit", pending.Length);
        if (_options.ResumeDelayMs > 0)
            await Task.Delay(_options.ResumeDelayMs, ct);

        for (int i = 0; i < pending.Length; i++)
        {
            if (ct.IsCancellationRequested) return;
            var p = pending[i];
            // The app usually takes its sessions down with it (a ConPTY child can't outlive its host),
            // but a crash — or a service restart — can leave the original alive. Resuming then would put
            // a second claude on the same conversation, so leave that one alone and keep the entry
            // Restorable for the user to decide.
            if (OriginalProcessAlive(p))
            {
                _log.LogInformation("Not auto-resuming session {Id} ('{Name}'): its process (pid {Pid}) is still running",
                    p.Id, p.Name, p.ProcessId);
                continue;
            }
            try { Restore(p.Id); }
            catch (Exception ex) { _log.LogWarning(ex, "Could not auto-resume session {Id} ('{Name}')", p.Id, p.Name); }
            if (i < pending.Length - 1 && _options.ResumeStaggerMs > 0)
                await Task.Delay(_options.ResumeStaggerMs, ct);
        }
    }

    /// <summary>
    /// Whether the exact process a persisted entry was launched as is still alive. PIDs are recycled
    /// (heavily so after a reboot), so a match only counts when the start time matches too; an entry
    /// with no recorded start time is treated as gone rather than risk skipping a legitimate resume.
    /// </summary>
    private static bool OriginalProcessAlive(PersistedSession p)
    {
        if (p.ProcessId <= 0 || p.ProcessStartTicks == 0) return false;
        try
        {
            using var proc = System.Diagnostics.Process.GetProcessById(p.ProcessId);
            return !proc.HasExited && proc.StartTime.ToUniversalTime().Ticks == p.ProcessStartTicks;
        }
        catch
        {
            return false; // no such process (or we can't inspect it) — treat as gone
        }
    }

    /// <summary>
    /// Remove a session. <paramref name="stopProcess"/> also kills the claude process. Also forgets
    /// a Restorable entry from a previous run (nothing to stop in that case). Either way the session
    /// is saved as a launch preset first, so a removed session lands in the "recent" list instead of
    /// disappearing — see <see cref="RememberAsRecent(ClaudeSession)"/>.
    /// </summary>
    public bool Remove(string id, bool stopProcess)
    {
        if (_sessions.TryRemove(id, out var s))
        {
            RememberAsRecent(s); // before Forget/TryRemove below — it reads the hook + launch bookkeeping
            if (stopProcess) s.Stop();
            s.Dispose();
            _hooks.Forget(id);
            _launchedFrom.TryRemove(id, out _);
            SavePersisted();
            RaiseChanged();
            return true;
        }
        if (_restorable.TryRemove(id, out var p))
        {
            RememberAsRecent(p);
            SavePersisted();
            RaiseChanged();
            return true;
        }
        return false;
    }

    /// <summary>
    /// Save a session being removed as a "recent" launch preset, so it stays one click from relaunching.
    /// Usually the preset it was launched from is already stored and this just moves it back to the front;
    /// it genuinely adds an entry when the preset was never saved, aged out of the cap, or was removed.
    /// </summary>
    private void RememberAsRecent(ClaudeSession s)
    {
        _launchedFrom.TryGetValue(s.Id, out var launchedFrom);
        RememberAsRecent(new RecentSession(
            s.WorkingDirectory,
            PresetName(s.Name, s.WorkingDirectory),
            s.InitialPrompt ?? "",
            s.Model ?? "",
            s.RemoteControl,
            s.PermissionMode,
            // Stamp the conversation id so reusing the preset resumes this exact conversation.
            ConversationId(s)), launchedFrom);
    }

    /// <summary>Same, for a Restorable entry from a previous run (no live process or hook state).</summary>
    private void RememberAsRecent(PersistedSession p) => RememberAsRecent(new RecentSession(
        p.WorkingDirectory,
        PresetName(p.Name, p.WorkingDirectory),
        p.InitialPrompt ?? "",
        p.Model ?? "",
        p.RemoteControl,
        p.PermissionMode ?? "",
        p.ClaudeSessionId), null);

    private void RememberAsRecent(RecentSession preset, RecentSession? launchedFrom)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(preset.WorkingDirectory)) return;
            // A session renamed after launch no longer matches the preset it came from; drop that stale
            // entry so the list keeps one entry per session, under the name the user last saw.
            if (launchedFrom is not null && !RecentsStore.SameSession(launchedFrom, preset))
                _recents.RemoveSession(launchedFrom);
            _recents.AddSession(preset);
        }
        catch (Exception ex)
        {
            // Best-effort bookkeeping — never let it fail the removal itself.
            _log.LogWarning(ex, "Could not save removed session as a recent preset");
        }
    }

    /// <summary>
    /// The name to store on a preset. A session launched without a name is given its folder's name, and
    /// a preset with a blank name means exactly that — so blank it out again rather than let the resolved
    /// name become a second, identical-looking entry.
    /// </summary>
    private static string PresetName(string name, string workingDirectory)
    {
        try
        {
            return name == new DirectoryInfo(workingDirectory).Name ? "" : name;
        }
        catch
        {
            return name;
        }
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

    /// <summary>
    /// Whether auto-resume should bring this session back on the next start: its process is alive, or
    /// died recently enough that a machine shutdown is the likelier explanation (see <see cref="ExitGrace"/>).
    /// </summary>
    private static bool ShouldResume(ClaudeSession s) =>
        s.State == SessionState.Running
        || (s.ExitedAt is { } at && DateTime.UtcNow - at < ExitGrace);

    /// <summary>Longest grace still to run across exited-but-not-yet-removed sessions; zero when none.</summary>
    private TimeSpan GraceRemaining()
    {
        var now = DateTime.UtcNow;
        var longest = TimeSpan.Zero;
        foreach (var s in _sessions.Values)
        {
            if (s.ExitedAt is not { } at) continue;
            var left = ExitGrace - (now - at);
            if (left > longest) longest = left;
        }
        return longest;
    }

    /// <summary>
    /// Arrange a re-save once every recently-exited session has aged out of its grace, so a session
    /// that really did end on its own stops being recorded as running. Called after each save, which
    /// makes the correction self-healing: any save that writes an in-grace session as running also
    /// books the follow-up that will write it as exited.
    /// </summary>
    private void ScheduleExitRecheck()
    {
        var due = GraceRemaining();
        if (due <= TimeSpan.Zero || _shuttingDown) return;
        try { _exitRecheck.Change(due + TimeSpan.FromSeconds(1), Timeout.InfiniteTimeSpan); }
        catch (ObjectDisposedException) { /* shutting down — the frozen file is already correct */ }
    }

    private void OnExitRecheck()
    {
        // Re-arms itself through SavePersisted -> ScheduleExitRecheck while anything is still in grace.
        try { SavePersisted(); }
        catch (Exception ex)
        {
            // Runs on a threadpool thread — never let bookkeeping take the host down.
            _log.LogWarning(ex, "Could not re-check exited sessions");
        }
    }

    /// <summary>
    /// Freeze the state file: the last save already holds the truth, and anything that happens from
    /// here (the OS killing our claude children, our own Dispose doing it) would only overwrite it with
    /// "nothing was running". Called on every shutdown signal we get — the host stopping, and the
    /// Windows session ending — as well as from <see cref="Dispose"/>.
    /// </summary>
    public void BeginShutdown() => _shuttingDown = true;

    private void SavePersisted()
    {
        if (_shuttingDown) return;
        lock (_saveLock)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_stateFile)!);
                // Persist live sessions plus any still-unrestored entries from prior runs, so they
                // survive further restarts. Live entries win if an id somehow appears in both.
                // Stamp each with Claude's own session id (from hooks, or the id we resumed with) so a
                // future reopen can --resume the exact conversation. Refresh liveness first: WasRunning
                // drives auto-resume, so it has to reflect the process as it is at this moment — via
                // ShouldResume, which also holds a just-exited session as running for its grace window.
                var live = _sessions.Values.Select(s =>
                {
                    s.Refresh();
                    return s.ToPersisted() with
                    {
                        ClaudeSessionId = ConversationId(s),
                        WasRunning = ShouldResume(s),
                    };
                });
                var liveIds = _sessions.Keys.ToHashSet();
                // Carried-over Restorable entries were NOT running this run, so clear WasRunning — only
                // sessions live at the last save auto-resume, not stale leftovers from earlier runs.
                var pending = _restorable.Values.Where(p => !liveIds.Contains(p.Id)).Select(p => p with { WasRunning = false });
                var list = live.Concat(pending).OrderBy(p => p.CreatedAt).ToList();
                File.WriteAllText(_stateFile, JsonSerializer.Serialize(list, new JsonSerializerOptions { WriteIndented = true }));
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "Could not persist sessions to {File}", _stateFile);
            }
        }
        // Outside the lock: book the follow-up save that ages any just-exited session out of its grace.
        ScheduleExitRecheck();
    }

    public void Dispose()
    {
        // Freeze the state file BEFORE killing anything, so the entries stay marked as running and come
        // back on the next start (see _shuttingDown).
        BeginShutdown();
        try { _exitRecheck.Dispose(); } catch { }
        _hooks.ClaudeSessionIdCaptured -= OnClaudeSessionIdCaptured;
        // A ConPTY child can't outlive the host, so disposing ends each claude process. Their launch
        // metadata is already on disk (written on create), so they come back as Restorable next start.
        foreach (var s in _sessions.Values) s.Dispose();
        _sessions.Clear();
    }
}
