using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.RegularExpressions;
using ClaudeWeb.Pty;
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

    /// <summary>
    /// Base URL a launched session uses to call back into this app (<c>CLAUDEWEB_URL</c> in its
    /// environment, used by <c>POST /api/self/name</c>). Left empty in config: the host fills it in
    /// from the bound port at startup. Set it explicitly only to override that.
    /// </summary>
    public string SelfUrl { get; set; } = "";
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
    private readonly Pty.PtyHostLauncher _hosts;
    private readonly SessionManagerOptions _options;
    private readonly TokenStore _tokens;
    private readonly HookEventStore _hooks;
    private readonly RecentsStore _recents;
    private readonly PinStore _pins;
    private readonly ProjectStore _projects;
    private readonly SessionUiStore _sessionUi;
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
    // Handed to every pty host at spawn: the watchdog that uses them runs there, not here.
    private readonly WatchdogOptions _watchdog;
    private readonly Pty.PtyHostOptions _ptyHost;

    /// <summary>
    /// Raised whenever the session set or a session's metadata changes (create, rename, remove,
    /// restore, watchdog toggle). Lets a live view (<see cref="SessionHub"/>) push an update
    /// immediately instead of waiting for its next tick. Poll-only transitions (Claude going
    /// busy/idle, a process exiting) are picked up by the hub's periodic recompute, not this event.
    /// </summary>
    public event Action? Changed;

    private void RaiseChanged() => Changed?.Invoke();

    public SessionManager(SessionManagerOptions options, WatchdogOptions watchdog, Pty.PtyHostOptions ptyHost,
        TokenStore tokens, HookEventStore hooks, RecentsStore recents, PinStore pins,
        ProjectStore projects, SessionUiStore sessionUi, ILoggerFactory loggerFactory)
    {
        _options = options;
        _watchdog = watchdog;
        _ptyHost = ptyHost;
        _hosts = new Pty.PtyHostLauncher(ptyHost, loggerFactory.CreateLogger<Pty.PtyHostLauncher>());
        _tokens = tokens;
        _hooks = hooks;
        _recents = recents;
        _pins = pins;
        _projects = projects;
        _sessionUi = sessionUi;
        _hooks.ClaudeSessionIdCaptured += OnClaudeSessionIdCaptured;
        _loggerFactory = loggerFactory;
        _log = loggerFactory.CreateLogger<SessionManager>();
        _exe = ClaudeExecutableResolver.Resolve(options.ClaudeExecutable);
        _log.LogInformation("Resolved claude executable: {File} {Prefix}", _exe.FileName, string.Join(' ', _exe.Prefix));
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
        return _sessions.Values
            .Select(s => s.ToInfo(ConversationId(s)) with
            {
                Pinned = IsPinned(ConversationId(s), s.Id),
                UiRev = UiRev(ConversationId(s), s.Id),
                GroupId = GroupIdOf(ConversationId(s), s.Id),
            })
            .Concat(_restorable.Values.Select(p => ClaudeSession.RestorableInfo(p) with
            {
                Pinned = IsPinned(p.ClaudeSessionId, p.Id),
                UiRev = UiRev(p.ClaudeSessionId, p.Id),
                GroupId = GroupIdOf(p.ClaudeSessionId, p.Id),
            }))
            .OrderBy(i => i.CreatedAt)
            .ToArray();
    }

    /// <summary>
    /// Whether a session is pinned: by its conversation id, or — for one too young to have reported
    /// one — by the fallback key it would have been pinned under. See <see cref="PinStore"/>.
    /// </summary>
    private bool IsPinned(string? conversationId, string sessionId) =>
        _pins.IsPinned(conversationId) || _pins.IsPinned(PinStore.SessionKey(sessionId));

    /// <summary>
    /// The virtual folder a session has been filed into, under whichever key holds the membership —
    /// its conversation, or the fallback a session too young to have reported one was filed under.
    /// See <see cref="ProjectStore"/>.
    /// </summary>
    private string? GroupIdOf(string? conversationId, string sessionId) =>
        _projects.GroupOf(conversationId) ?? _projects.GroupOf(ProjectStore.SessionKey(sessionId));

    /// <summary>Every key a session's membership could be filed under; the first is the one it is written to.</summary>
    private IReadOnlyList<string> GroupKeys(string id)
    {
        string? conversation = null;
        if (_sessions.TryGetValue(id, out var live)) conversation = ConversationId(live);
        else if (_restorable.TryGetValue(id, out var p)) conversation = p.ClaudeSessionId;
        var fallback = ProjectStore.SessionKey(id);
        return conversation is null ? new[] { fallback } : new[] { conversation, fallback };
    }

    /// <summary>
    /// File a session into a virtual folder, or (with a null <paramref name="groupId"/>) take it out
    /// of the one holding it. Keyed by conversation so the grouping survives a reopen, exactly as a
    /// pin does. Returns the updated project list, or null when there is no such session, or the
    /// group is one this session cannot go in.
    ///
    /// <para>The project check is here rather than in the store because it is the manager that knows
    /// where a session runs. It is not a formality: a group only ever applies inside the project that
    /// owns the folder (see <see cref="ProjectStore.GroupFor"/>), so filing a session into some other
    /// project's group would clear the membership it had and write one that can never be read back —
    /// the session would come out ungrouped and the caller would have been told it worked.</para>
    /// </summary>
    public IReadOnlyList<Project>? SetGroup(string id, string? groupId)
    {
        var dir = _sessions.TryGetValue(id, out var live) ? live.WorkingDirectory
            : _restorable.TryGetValue(id, out var restorable) ? restorable.WorkingDirectory
            : null;
        if (dir is null) return null;

        if (groupId is not null)
        {
            var owner = ProjectStore.ForDirectory(_projects.List(), dir);
            if (owner is null || !owner.Groups.Any(g => g.Id == groupId)) return null;
        }

        var list = _projects.SetSessionGroup(GroupKeys(id), groupId);
        // The membership rides the session list (SessionInfo.GroupId), so every browser has to be
        // told the list changed — the project list this returns only reaches the one that asked.
        if (list is not null) RaiseChanged();
        return list;
    }

    /// <summary>
    /// Revision of a session's saved UI state, under whichever key holds it — the conversation, or
    /// the fallback a session too young to have reported one writes under. See
    /// <see cref="SessionUiStore"/>.
    /// </summary>
    private int UiRev(string? conversationId, string sessionId) =>
        Math.Max(_sessionUi.Rev(conversationId), _sessionUi.Rev(SessionUiStore.SessionKey(sessionId)));

    /// <summary>
    /// The key a session's UI state lives under: its conversation, or the <c>session:</c> fallback
    /// while it has no conversation id yet. Null when there is no such session.
    /// </summary>
    private string? UiKey(string id)
    {
        string? conversation = null;
        if (_sessions.TryGetValue(id, out var live)) conversation = ConversationId(live);
        else if (_restorable.TryGetValue(id, out var p)) conversation = p.ClaudeSessionId;
        else return null;
        // Prefer whichever key actually holds state, so a bag written in this session's first seconds
        // is still found in the window before its conversation id arrives and Rekey folds it over.
        if (conversation is not null && _sessionUi.Rev(conversation) > 0) return conversation;
        var fallback = SessionUiStore.SessionKey(id);
        if (_sessionUi.Rev(fallback) > 0) return fallback;
        return conversation ?? fallback;
    }

    /// <summary>How a session was last being looked at, or null when there is no such session.</summary>
    public SessionUiStore.Snapshot? GetUi(string id) =>
        UiKey(id) is { } key ? _sessionUi.Get(key) : null;

    /// <summary>
    /// Merge a browser's UI-state patch into a session's saved bag. Returns the merged bag, or the
    /// current one unchanged when the patch was a no-op; null when there is no such session. A change
    /// that advances the revision raises <see cref="Changed"/>, so the new number reaches every other
    /// browser on the next session-list push — which is what tells them to re-fetch. A
    /// <paramref name="quiet"/> patch (see <see cref="SessionUiStore.Merge"/>) is saved without that.
    /// </summary>
    public SessionUiStore.Snapshot? MergeUi(string id, IReadOnlyDictionary<string, JsonElement>? patch, bool quiet = false)
    {
        if (UiKey(id) is not { } key) return null;
        var before = _sessionUi.Rev(key);
        var merged = _sessionUi.Merge(key, patch, quiet);
        if (merged is null) return _sessionUi.Get(key);
        if (merged.Rev != before) RaiseChanged();
        return merged;
    }

    /// <summary>
    /// Pin or unpin a session, keyed by its conversation so the pin survives a reopen (which mints a
    /// new session id) and reaches every browser through the session list. Returns false when there
    /// is no such session.
    /// </summary>
    public bool SetPinned(string id, bool pinned)
    {
        string? key = null;
        if (_sessions.TryGetValue(id, out var live)) key = ConversationId(live);
        else if (_restorable.TryGetValue(id, out var p)) key = p.ClaudeSessionId;
        else if (!_sessions.ContainsKey(id)) return false;

        // No conversation id yet (a session in its first seconds): pin under the fallback key, which
        // OnClaudeSessionIdCaptured swaps for the real one as soon as the first hook arrives.
        if (_pins.Set(key ?? PinStore.SessionKey(id), pinned)) RaiseChanged();
        // Unpinning has to clear both keys — a pin set before the id arrived may still sit under the
        // fallback if the session never reported one.
        if (!pinned && key is not null && _pins.Set(PinStore.SessionKey(id), false)) RaiseChanged();
        return true;
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
    /// UserPromptSubmit→Stop transitions); falls back to the terminal-output heuristic — computed in
    /// the pty host and pushed to us — for sessions that haven't produced a hook event yet (e.g. hooks
    /// disabled, or the brief window before SessionStart).
    /// </summary>
    private bool IsBusy(ClaudeSession s) =>
        _hooks.TryGetStatus(s.Id, out var st) ? st.Busy : s.Terminal?.IsBusy == true;

    /// <summary>
    /// Ids of live sessions where Claude is compacting its conversation — auto-compaction or an
    /// explicit <c>/compact</c>. Read off the screen in the pty host, with no hook-derived
    /// alternative to prefer: Claude fires <c>PreCompact</c> and then nothing at all when the
    /// compaction ends, so the repainting "Compacting conversation…" spinner is the only signal
    /// that has both edges.
    /// </summary>
    public IReadOnlyCollection<string> CompactingSessionIds() =>
        _sessions.Values
            .Where(s => s.State == SessionState.Running && s.Terminal is { IsCompacting: true })
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
            .Where(s => s.State == SessionState.Running && IsAwaitingInput(s))
            .Select(s => s.Id)
            .ToArray();

    /// <summary>
    /// Whether a session is waiting on the user. Prefers the hook-derived status (a
    /// Notification/PermissionRequest fired with no answer yet); falls back to the on-screen prompt
    /// heuristic for sessions without hook data. That heuristic is evaluated in the pty host, which is
    /// the only process that still sees the screen text, and pushed here.
    /// </summary>
    private bool IsAwaitingInput(ClaudeSession s) =>
        _hooks.TryGetStatus(s.Id, out var st)
            ? st.Waiting
            : s.Terminal is { IsAwaitingInput: true };

    public SessionInfo? Get(string id)
    {
        if (!_sessions.TryGetValue(id, out var s)) return null;
        s.Refresh();
        return s.ToInfo(ConversationId(s));
    }

    /// <summary>Filesystem change counter for a session's working directory (null if unknown).</summary>
    public long? FsVersion(string id) => _sessions.TryGetValue(id, out var s) ? s.FsVersion : null;

    /// <summary>The live terminal stream for a session (null if unknown or no longer running).</summary>
    public Pty.ITerminal? GetTerminal(string id) =>
        _sessions.TryGetValue(id, out var s) ? s.Terminal : null;

    /// <summary>Live sessions, for the watchdog to sweep.</summary>
    internal IEnumerable<ClaudeSession> LiveSessions() => _sessions.Values;

    /// <summary>
    /// Rename a session from the UI (or from the session itself via <c>POST /api/self/name</c>). For a
    /// live session this updates the display name and injects a <c>/rename &lt;name&gt;</c> into its
    /// terminal so Claude renames its own session too; for a Restorable entry it just updates the
    /// persisted name. Returns false if the id is unknown or the name is empty. (A <c>/rename</c> typed
    /// in the terminal is handled directly on the session and doesn't come through here, so there's no
    /// echo loop.)
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

    /// <summary>
    /// Toggle the watchdog for one session; disabling also clears any pending state. The setting is
    /// ours to persist, but the watchdog acting on it lives in the pty host, so this pushes it down.
    /// </summary>
    public async Task<bool> SetWatchdogEnabledAsync(string id, bool enabled)
    {
        if (!_sessions.TryGetValue(id, out var s)) return false;
        await s.SetWatchdogAsync(enabled);
        SavePersisted(); // the opt-in survives a restart, and is re-sent to the host on re-attach
        RaiseChanged();
        return true;
    }

    /// <summary>
    /// Reset a session's watchdog state (e.g. after a manual "Continue"): clears the give-up flag and
    /// the consecutive-attempt counter, host-side, so auto-recovery resumes from a clean slate.
    /// </summary>
    public async Task ResetWatchdogAsync(string id)
    {
        if (!_sessions.TryGetValue(id, out var s)) return;
        await s.SetWatchdogAsync(enabled: null, reset: true);
        RaiseChanged();
    }

    /// <summary>
    /// Launch a new session: spawn its pty host, then attach to it over the host's pipe. Genuinely
    /// asynchronous — there is a process start and a handshake to wait for — so every caller awaits
    /// rather than blocking a thread on it.
    /// </summary>
    public async Task<SessionInfo> CreateAsync(CreateSessionRequest req, CancellationToken ct = default)
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
            _hosts,
            _watchdog,
            _loggerFactory.CreateLogger<ClaudeSession>(),
            _tokens.HookToken,
            _options.SelfUrl);

        // Re-persist and push whenever a persisted field changes (a rename or a `/color` in the
        // terminal), and when the process ends by itself — the saved entry must stop claiming it was
        // running, or the next start would auto-resume a session the user had already let finish.
        Track(session);
        _launchedFrom[session.Id] = PresetOf(req);
        _sessions[session.Id] = session;
        try { await session.StartAsync(ct); }
        catch
        {
            // A session that never started must not linger in the live set claiming to be running.
            _sessions.TryRemove(session.Id, out _);
            _launchedFrom.TryRemove(session.Id, out _);
            throw;
        }
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
    public async Task<SessionInfo?> ForkAsync(string id, string? name, CancellationToken ct = default)
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

        return await CreateAsync(new CreateSessionRequest(
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
            // A pin set before this id existed is keyed by the session; move it onto the conversation
            // so it outlives the session id it was made under.
            _pins.Rekey(PinStore.SessionKey(sessionId), claudeSessionId);
            // Same for the UI state (open file tabs, view mode): written under the session while the
            // conversation had no id, it belongs to the conversation now.
            _sessionUi.Rekey(SessionUiStore.SessionKey(sessionId), claudeSessionId);
            // And for a virtual folder it was dropped into in those same first seconds.
            _projects.Rekey(ProjectStore.SessionKey(sessionId), claudeSessionId);
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
    public async Task<SessionInfo?> RestoreAsync(string id, CancellationToken ct = default)
    {
        if (!_restorable.TryRemove(id, out var p)) return null;
        try
        {
            var info = await CreateAsync(new CreateSessionRequest(
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
                ParentName: p.ParentName), ct);
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
    /// Re-attach to every session whose pty host is still running. <b>This is the payoff of the whole
    /// design</b>, and it must run BEFORE <see cref="ResumePersistedAsync"/>: a session adopted here
    /// is live, with its scrollback and its in-flight conversation intact, and must not then be
    /// relaunched with <c>--resume</c> on top of itself.
    /// </summary>
    /// <remarks>
    /// <para><c>sessions.json</c> stays the source of truth for metadata (name, colour, model, parent,
    /// watchdog). The pty state directory only answers "is it still alive, and where do I reach it?" —
    /// so a state file with no matching persisted entry is an orphan we can't identify and is left for
    /// the user to deal with rather than resurrected half-formed.</para>
    /// <para>A state file whose host doesn't answer is stale (the machine rebooted, or the host was
    /// killed directly). It's deleted, and the session falls through to today's Restorable /
    /// auto-resume behaviour unchanged.</para>
    /// </remarks>
    public async Task AdoptRunningHostsAsync(CancellationToken ct = default)
    {
        var states = PtyStateStore.ReadAll(_hosts.InstanceKey).ToArray();
        if (states.Length == 0) return;

        _log.LogInformation("Found {Count} pty host state file(s) for instance '{Instance}'; checking which are still live.",
            states.Length, _hosts.InstanceKey);

        foreach (var (path, state) in states)
        {
            if (ct.IsCancellationRequested) return;

            if (!PtyStateStore.HostAlive(state))
            {
                _log.LogInformation("Pty host for session {Id} (pid {Pid}) is gone; discarding its stale state file.",
                    state.SessionId, state.HostPid);
                PtyStateStore.Delete(path);
                continue;
            }

            if (!_restorable.TryGetValue(state.SessionId, out var persisted))
            {
                // A live host we have no metadata for. Leave both alone: killing it would take a
                // working claude session down, and adopting it would invent a session out of nothing.
                _log.LogWarning("Pty host pid {Pid} is running for unknown session {Id}; leaving it alone.",
                    state.HostPid, state.SessionId);
                continue;
            }

            ClaudeSession session;
            try { session = Rehydrate(persisted); }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "Could not rebuild session {Id} to adopt its host", state.SessionId);
                continue;
            }

            bool attached;
            try { attached = await session.AttachAsync(state, ct); }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "Could not re-attach to the pty host for session {Id}", state.SessionId);
                attached = false;
            }

            if (!attached)
            {
                // The host is alive but won't talk to us — an incompatible build, or a wedged process.
                // Don't delete its state file: it names a live process, and a later attempt may work.
                _log.LogWarning("Pty host pid {Pid} for session {Id} did not answer; leaving it for the user.",
                    state.HostPid, state.SessionId);
                session.Dispose();
                continue;
            }

            _restorable.TryRemove(state.SessionId, out _);
            Track(session);
            _sessions[session.Id] = session;
        }

        if (!_sessions.IsEmpty)
        {
            SavePersisted();
            RaiseChanged();
        }

        // Anything still running that we couldn't claim is an orphan. Report them once at startup so
        // they aren't invisible, and let the (opt-in) age sweep deal with the stale ones.
        var orphans = ListOrphans();
        if (orphans.Count > 0)
            _log.LogWarning("{Count} orphaned pty host(s) are running for sessions this app doesn't know about. " +
                "They keep running until stopped from the UI or the tray menu.", orphans.Count);
        await SweepAgedOrphansAsync(ct);
    }

    // ---- Orphaned pty hosts ----------------------------------------------------------------------

    /// <summary>
    /// Pty hosts still running for sessions this app doesn't know about. See <see cref="PtyOrphanInfo"/>
    /// for how one comes about; a state file whose host is gone is stale rather than orphaned, and is
    /// cleaned up here as a side effect of looking.
    /// </summary>
    public IReadOnlyCollection<PtyOrphanInfo> ListOrphans()
    {
        var now = DateTimeOffset.Now;
        var orphans = new List<PtyOrphanInfo>();
        foreach (var (path, state) in PtyStateStore.ReadAll(_hosts.InstanceKey))
        {
            if (_sessions.ContainsKey(state.SessionId) || _restorable.ContainsKey(state.SessionId)) continue;
            if (!PtyStateStore.HostAlive(state)) { PtyStateStore.Delete(path); continue; }
            orphans.Add(new PtyOrphanInfo(
                state.SessionId, state.HostPid, state.ChildPid, state.WorkingDirectory, state.CreatedAt,
                Math.Round((now - state.CreatedAt).TotalHours, 2)));
        }
        return orphans.OrderBy(o => o.CreatedAt).ToArray();
    }

    /// <summary>
    /// Stop orphaned hosts and the <c>claude</c> processes under them. With no id, stops every orphan;
    /// with one, just that host. Returns how many were stopped.
    /// </summary>
    /// <remarks>
    /// Destructive and irreversible — each one is a live conversation — so nothing calls this on its
    /// own initiative except the <see cref="Pty.PtyHostOptions.OrphanMaxAgeHours"/> sweep, which is off
    /// by default.
    /// </remarks>
    public async Task<int> StopOrphansAsync(string? sessionId = null, CancellationToken ct = default)
    {
        var targets = ListOrphans();
        if (sessionId is not null)
            targets = targets.Where(o => o.SessionId == sessionId).ToArray();

        var stopped = 0;
        foreach (var o in targets)
        {
            if (ct.IsCancellationRequested) break;
            try
            {
                await _hosts.StopHostAsync(o.SessionId, ClaudeSession.ShutdownGrace, ct);
                _log.LogInformation("Stopped orphaned pty host pid {Pid} (session {Id}, {Cwd}).",
                    o.HostPid, o.SessionId, o.WorkingDirectory);
                stopped++;
            }
            catch (Exception ex) { _log.LogWarning(ex, "Could not stop orphaned pty host for session {Id}", o.SessionId); }
        }
        if (stopped > 0) RaiseChanged();
        return stopped;
    }

    /// <summary>
    /// Optional unattended cleanup: stop orphans older than <c>Pty:OrphanMaxAgeHours</c>. Off unless
    /// that is set, because an orphan is a working session someone may still want.
    /// </summary>
    private async Task SweepAgedOrphansAsync(CancellationToken ct)
    {
        var maxAge = _ptyHost.OrphanMaxAgeHours;
        if (maxAge <= 0) return;
        foreach (var o in ListOrphans().Where(o => o.AgeHours >= maxAge))
        {
            _log.LogInformation("Orphaned pty host pid {Pid} (session {Id}) is {Age:0.0}h old, past Pty:OrphanMaxAgeHours={Max}; stopping it.",
                o.HostPid, o.SessionId, o.AgeHours, maxAge);
            await StopOrphansAsync(o.SessionId, ct);
        }
    }

    /// <summary>
    /// Rebuild a <see cref="ClaudeSession"/> from its persisted entry, keeping its id — every fork
    /// link, hook correlation and postponed message points at that id, so a new one would orphan them.
    /// Used for adoption only; a reopen deliberately gets a fresh id because it is a new process.
    /// </summary>
    private ClaudeSession Rehydrate(PersistedSession p) => new(
        new CreateSessionRequest(
            WorkingDirectory: p.WorkingDirectory,
            Name: p.Name,
            RemoteControl: p.RemoteControl,
            Model: p.Model,
            InitialPrompt: p.InitialPrompt,
            PermissionMode: p.PermissionMode,
            Continue: false,
            ResumeSessionId: p.ClaudeSessionId,
            Color: p.Color,
            WatchdogEnabled: p.WatchdogEnabled,
            ForkSession: false,
            ParentSessionId: p.ParentSessionId,
            ParentName: p.ParentName),
        _exe,
        _hosts,
        _watchdog,
        _loggerFactory.CreateLogger<ClaudeSession>(),
        _tokens.HookToken,
        _options.SelfUrl,
        id: p.Id);

    /// <summary>Subscribe to a session's bookkeeping events (shared by Create and adoption).</summary>
    private void Track(ClaudeSession session)
    {
        session.MetadataChanged += _ => { SavePersisted(); RaiseChanged(); };
        session.ProcessExited += _ => { SavePersisted(); RaiseChanged(); };
        // Busy/waiting/watchdog changes are not persisted — they just need to reach the browser.
        session.StateChanged += _ => RaiseChanged();
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
            // Sessions no longer die with the app — AdoptRunningHostsAsync has already re-attached to
            // every one whose pty host is still up, so anything reaching here should genuinely be gone.
            // This stays as the belt-and-braces check it always was: if the original process is somehow
            // still alive, resuming would put a second claude on the same conversation, so leave it
            // alone and keep the entry Restorable for the user to decide.
            if (OriginalProcessAlive(p))
            {
                _log.LogInformation("Not auto-resuming session {Id} ('{Name}'): its process (pid {Pid}) is still running",
                    p.Id, p.Name, p.ProcessId);
                continue;
            }
            try { await RestoreAsync(p.Id, ct); }
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
    /// Remove a session. <paramref name="stopProcess"/> also ends it — the pty host is asked to shut
    /// down and its claude process goes with it. Without that flag the session is merely <b>detached</b>:
    /// we forget it, but its host keeps running and it can be adopted again later (that is what
    /// <c>POST /api/sessions/{id}/detach</c> is for). Also forgets a Restorable entry from a previous
    /// run (nothing to stop in that case). Either way the session is saved as a launch preset first, so
    /// a removed session lands in the "recent" list instead of disappearing — see
    /// <see cref="RememberAsRecent(ClaudeSession)"/>.
    /// </summary>
    public bool Remove(string id, bool stopProcess)
    {
        if (_sessions.TryRemove(id, out var s))
        {
            RememberAsRecent(s); // before Forget/TryRemove below — it reads the hook + launch bookkeeping
            if (stopProcess) s.Stop();
            else if (s.IsAttached)
                // Detaching now genuinely orphans the host: it used to die with the app on the next
                // restart, and no longer does. Its state file is deliberately left in place so the
                // process can still be found — adoption sees a live host with no metadata and leaves
                // it alone rather than resurrecting or killing it.
                _log.LogInformation("Detached from session {Id} ('{Name}'); its pty host and claude process (pid {Pid}) stay running.",
                    s.Id, s.Name, s.ProcessId);
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

    // ---- Persistence: the metadata behind both re-attaching and reopening -------------------------
    // A session's pseudoconsole lives in its own pty host now, so it usually survives an app restart
    // and AdoptRunningHostsAsync re-attaches to it — this file supplies the name, colour, model, fork
    // links and watchdog setting that the pty state file deliberately doesn't carry. When the host is
    // genuinely gone (a reboot: a ConPTY child can't survive one), the same entry is offered as
    // "Restorable" and reopened with --resume/--continue, exactly as before.

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

    /// <summary>
    /// Shut down the manager <b>without</b> touching the sessions. Each session's Dispose now only
    /// closes its pipe: the pty hosts and their claude processes keep running, and the next start
    /// re-attaches to them via <see cref="AdoptRunningHostsAsync"/>.
    /// </summary>
    /// <remarks>
    /// This used to kill every session, which is what made an update, a redeploy or tray Exit lose
    /// whatever turn was in flight. If you are tempted to "clean up" here: that cleanup is the bug
    /// this whole change exists to remove.
    /// </remarks>
    public void Dispose()
    {
        // Freeze the state file first, so the entries stay marked as running (see _shuttingDown) and
        // are there to be matched against the live hosts on the next start.
        BeginShutdown();
        try { _exitRecheck.Dispose(); } catch { }
        _hooks.ClaudeSessionIdCaptured -= OnClaudeSessionIdCaptured;
        foreach (var s in _sessions.Values) s.Dispose(); // detach only — never Stop()
        _sessions.Clear();
    }
}
