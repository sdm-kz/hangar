using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Hangar.Pty;
using Hangar.Server.Auth;

namespace Hangar.Server.Sessions;

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
    /// Defaults to %LocalAppData%\Hangar\sessions.json when null/empty.
    /// </summary>
    public string? StateFile { get; set; }

    /// <summary>
    /// Relaunch every session that was running when the app last closed (PC shutdown, redeploy, a
    /// daemon stop) as soon as the app starts again, resuming each conversation. On by default; set false to
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
    /// Base URL a launched session uses to call back into this app (<c>HANGAR_URL</c> in its
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
    private readonly ActivityPauseStore _activityPaused;
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
    // The same moment, for the work that waits on it: a launch prompt still waiting to be typed in
    // (TypeInitialPromptAsync) is stashed rather than lost. Never disposed — cancelled at most once,
    // from BeginShutdown, which can be reached again from Dispose.
    private readonly CancellationTokenSource _stopping = new();
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
        ActivityPauseStore activityPaused, ProjectStore projects, SessionUiStore sessionUi, ILoggerFactory loggerFactory)
    {
        _options = options;
        _watchdog = watchdog;
        _ptyHost = ptyHost;
        _hosts = new Pty.PtyHostLauncher(ptyHost, loggerFactory.CreateLogger<Pty.PtyHostLauncher>());
        _tokens = tokens;
        _hooks = hooks;
        _recents = recents;
        _pins = pins;
        _activityPaused = activityPaused;
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
            ? AppDataFolder.PathFor("sessions.json")
            : options.StateFile;

        LoadPersisted();
    }

    public IReadOnlyCollection<SessionInfo> List()
    {
        foreach (var s in _sessions.Values) s.Refresh();
        var projects = _projects.List();
        return _sessions.Values
            .Select(s => s.ToInfo(ConversationId(s)) with
            {
                Pinned = IsPinned(ConversationId(s), s.Id),
                ActivityPaused = IsActivityPaused(ConversationId(s), s.Id),
                UiRev = UiRev(ConversationId(s), s.Id),
                GroupId = GroupIdOf(ConversationId(s), s.Id),
                ScheduleId = ScheduleOf(ConversationId(s), s.Id)?.Id,
                ScheduleLabel = ScheduleOf(ConversationId(s), s.Id)?.Label,
            })
            .Concat(_restorable.Values.Select(p => ClaudeSession.RestorableInfo(p) with
            {
                Pinned = IsPinned(p.ClaudeSessionId, p.Id),
                ActivityPaused = IsActivityPaused(p.ClaudeSessionId, p.Id),
                UiRev = UiRev(p.ClaudeSessionId, p.Id),
                GroupId = GroupIdOf(p.ClaudeSessionId, p.Id),
                ScheduleId = ScheduleOf(p.ClaudeSessionId, p.Id)?.Id,
                ScheduleLabel = ScheduleOf(p.ClaudeSessionId, p.Id)?.Label,
            }))
            .Select(i => i with { ProjectId = ProjectMembership.ForDirectory(projects, i.WorkingDirectory)?.Id })
            .OrderBy(i => i.CreatedAt)
            .ToArray();
    }

    /// <summary>
    /// Which schedule a session belongs to, and what its clock says. Keyed by conversation first so
    /// the mark survives a reopen the way a pin and a virtual folder do — a schedule that pokes a
    /// session every ten minutes must still own it after the reboot that gave it a new id — with the
    /// session id as the fallback key for one too young to have reported a conversation.
    /// </summary>
    private readonly ConcurrentDictionary<string, (string Id, string Label)> _scheduled = new();

    private (string Id, string Label)? ScheduleOf(string? conversationId, string sessionId)
    {
        if (conversationId is not null && _scheduled.TryGetValue(conversationId, out var byConvo)) return byConvo;
        return _scheduled.TryGetValue(sessionId, out var bySession) ? bySession : null;
    }

    /// <summary>
    /// Record that a schedule owns this session, so its row is marked as one a clock started. Written
    /// under the conversation id when there is one, and under the session id until there is.
    /// </summary>
    public void MarkScheduled(string id, string scheduleId, string label)
    {
        var conversation = _sessions.TryGetValue(id, out var s) ? ConversationId(s)
            : _restorable.TryGetValue(id, out var p) ? p.ClaudeSessionId
            : null;
        _scheduled[conversation ?? id] = (scheduleId, label);
        RaiseChanged();
    }

    /// <summary>Forget a schedule's claim on every session it had marked (the schedule was deleted).</summary>
    public void ForgetSchedule(string scheduleId)
    {
        foreach (var (key, value) in _scheduled)
            if (value.Id == scheduleId) _scheduled.TryRemove(key, out _);
        RaiseChanged();
    }

    /// <summary>
    /// The session running a given Claude conversation — live or Restorable — or null when none is.
    /// The scheduler works in conversation ids rather than ours precisely because ours do not survive
    /// a reopen; this is the lookup that bridges the two.
    /// </summary>
    public SessionInfo? FindByConversation(string conversationId)
    {
        if (string.IsNullOrWhiteSpace(conversationId)) return null;
        foreach (var s in _sessions.Values)
            if (string.Equals(ConversationId(s), conversationId, StringComparison.OrdinalIgnoreCase))
                return s.ToInfo(ConversationId(s));
        foreach (var p in _restorable.Values)
            if (string.Equals(p.ClaudeSessionId, conversationId, StringComparison.OrdinalIgnoreCase))
                return ClaudeSession.RestorableInfo(p);
        return null;
    }

    /// <summary>
    /// Whether a session is pinned: by its conversation id, or — for one too young to have reported
    /// one — by the fallback key it would have been pinned under. See <see cref="PinStore"/>.
    /// </summary>
    private bool IsPinned(string? conversationId, string sessionId) =>
        _pins.IsPinned(conversationId) || _pins.IsPinned(PinStore.SessionKey(sessionId));

    /// <summary>Whether a session's activity is paused, keyed as a pin is. See <see cref="ActivityPauseStore"/>.</summary>
    private bool IsActivityPaused(string? conversationId, string sessionId) =>
        _activityPaused.Has(conversationId) || _activityPaused.Has(ActivityPauseStore.SessionKey(sessionId));

    /// <summary>
    /// The virtual folder a session has been filed into, under whichever key holds the membership —
    /// its conversation, or the fallback a session too young to have reported one was filed under.
    /// See <see cref="ProjectStore"/>.
    /// </summary>
    private string? GroupIdOf(string? conversationId, string sessionId) =>
        _projects.GroupOf(conversationId) ?? _projects.GroupOf(ProjectStore.SessionKey(sessionId));

    /// <summary>
    /// The virtual folder a session is filed in, asked by id alone — live or Restorable, and under
    /// whichever of its keys holds the membership. What a new session launched from an existing one
    /// (a fork, a child session) inherits.
    /// </summary>
    private string? GroupIdOf(string id)
    {
        foreach (var key in GroupKeys(id))
            if (_projects.GroupOf(key) is { } g) return g;
        return null;
    }

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
    /// File sessions into a virtual folder, or (with a null <paramref name="groupId"/>) take them out
    /// of the ones holding them. Keyed by conversation so the grouping survives a reopen, exactly as a
    /// pin does. Returns the updated project list, or null when not one of the ids turned out to be a
    /// session that could take the group.
    ///
    /// <para>Several at once because a branch is filed as a unit — see
    /// <see cref="ProjectStore.SetSessionGroup"/>. An id is skipped, not refused, when it names no
    /// session we know or names one this group is not open to: the caller is moving a row and the
    /// branch hanging off it, and the rows that can go where it is going should go there.</para>
    ///
    /// <para>The project check is here rather than in the store because it is the manager that knows
    /// where a session runs. It is not a formality: a group only ever applies inside the project that
    /// owns the folder (see <see cref="ProjectMembership.GroupFor"/>), so filing a session into some other
    /// project's group would clear the membership it had and write one that can never be read back —
    /// the session would come out ungrouped and the caller would have been told it worked. Skipping
    /// writes nothing for that session, so it simply stays in the box it was already in.</para>
    ///
    /// <para>Skipped rather than refused because a branch is not required to live in one project. A
    /// session put under another by hand brings its own folder, and that folder can belong somewhere
    /// else entirely — which is the ordinary shape of "look into this other repo from here", not a
    /// mistake. Failing the whole call over that one row meant the menu's own group did nothing at
    /// all, silently, for every other row in the branch.</para>
    /// </summary>
    public IReadOnlyList<Project>? SetGroup(IReadOnlyList<string> ids, string? groupId)
    {
        var keys = new List<IReadOnlyList<string>>(ids.Count);
        // Deduplicated: the same id twice would write the same membership key twice into the group.
        foreach (var id in ids.Distinct(StringComparer.Ordinal))
        {
            var dir = _sessions.TryGetValue(id, out var live) ? live.WorkingDirectory
                : _restorable.TryGetValue(id, out var restorable) ? restorable.WorkingDirectory
                : null;
            if (dir is null) continue;

            if (groupId is not null)
            {
                var owner = ProjectMembership.ForDirectory(_projects.List(), dir);
                if (owner is null || !owner.Groups.Any(g => g.Id == groupId)) continue;
            }

            keys.Add(GroupKeys(id));
        }
        if (keys.Count == 0) return null;

        var list = _projects.SetSessionGroup(keys, groupId);
        // The membership rides the session list (SessionInfo.GroupId), so every browser has to be
        // told the list changed — the project list this returns only reaches the one that asked.
        if (list is not null) RaiseChanged();
        return list;
    }

    /// <summary>
    /// The session a row is drawn under, live or Restorable: where it was put by hand, and otherwise
    /// the session it was forked from. Null when it sits at the top level, or is unknown.
    /// </summary>
    private string? ParentOf(string id) =>
        _sessions.TryGetValue(id, out var live) ? live.NestedUnderId ?? live.ParentSessionId
            : _restorable.TryGetValue(id, out var p) ? p.NestedUnderId ?? p.ParentSessionId
            : null;

    /// <summary>Whether a session exists at all, live or Restorable.</summary>
    public bool Exists(string id) => _sessions.ContainsKey(id) || _restorable.ContainsKey(id);

    /// <summary>
    /// Everything drawn under a session, live or Restorable, at any depth — each with the session it
    /// sits directly under and how far down it is (a direct child is depth 1). Parents come before
    /// their children; the root itself is not included. "Under" is what the list draws: the hand-made
    /// nesting first, the fork link otherwise (see <see cref="ParentOf"/>).
    /// </summary>
    public IReadOnlyList<(string Id, string ParentId, int Depth)> Subtree(string rootId)
    {
        var children = _sessions.Keys.Concat(_restorable.Keys)
            .Distinct(StringComparer.Ordinal)
            .Select(id => (Id: id, Parent: ParentOf(id)))
            .Where(x => x.Parent is not null)
            .ToLookup(x => x.Parent!, x => x.Id, StringComparer.Ordinal);

        var result = new List<(string, string, int)>();
        // Guarded against a loop rather than trusting SetParent kept them out: a bad sessions.json
        // edit must not hang a request.
        var seen = new HashSet<string>(StringComparer.Ordinal) { rootId };
        var queue = new Queue<(string Id, int Depth)>([(rootId, 0)]);
        while (queue.TryDequeue(out var at))
            foreach (var child in children[at.Id].Where(seen.Add))
            {
                result.Add((child, at.Id, at.Depth + 1));
                queue.Enqueue((child, at.Depth + 1));
            }
        return result;
    }

    /// <summary>
    /// The working directory of a session, live or Restorable; null when there is no such session.
    ///
    /// <see cref="Get"/> answers only for live ones, which is right for anything that needs a process
    /// behind it. What a closed session leaves behind in its folder is a different question: the
    /// postponed pool is a file there, and reading a note you left yourself should not require
    /// relaunching the session that took it.
    /// </summary>
    public string? FolderOf(string id) =>
        _sessions.TryGetValue(id, out var live) ? live.WorkingDirectory
            : _restorable.TryGetValue(id, out var stored) ? stored.WorkingDirectory
            : null;

    /// <summary>
    /// Put a session under another in the list — or, with a null <paramref name="parentId"/>, leave it
    /// where forking left it (under the session it branched from, or at the top level).
    ///
    /// <para>Written beside the fork link rather than over it. A fork says the conversation came from
    /// its parent; dragging a row onto another says only where it is drawn. Keeping them apart is what
    /// lets a fork be moved without the move rewriting its history, and what lets moving it back out
    /// mean something — it goes home to the session it was forked from.</para>
    ///
    /// <para>Nesting is arrangement, so it is deliberately free: any session under any other, to any
    /// depth, across folders. The one rule is that the result has to be a tree — a session put under
    /// its own descendant would close a loop, and neither row could then be drawn.</para>
    ///
    /// <para>Returns false when either id names no session we know; throws when the move itself is the
    /// problem, so the caller can say which it was.</para>
    /// </summary>
    public bool SetParent(string id, string? parentId)
    {
        var live = _sessions.TryGetValue(id, out var s) ? s : null;
        var stored = _restorable.TryGetValue(id, out var p) ? p : null;
        if (live is null && stored is null) return false;

        if (parentId is not null)
        {
            if (parentId == id) throw new InvalidOperationException("A session cannot go under itself.");
            if (!Exists(parentId)) return false;
            // Walk up from the new parent: meeting this session means the move would close a loop. The
            // walk is guarded against one that is already there rather than trusting it isn't — this
            // is the check that keeps loops out, so it cannot assume its own work was done.
            var seen = new HashSet<string>(StringComparer.Ordinal) { parentId };
            for (var up = ParentOf(parentId); up is not null; up = ParentOf(up))
            {
                if (up == id) throw new InvalidOperationException("That session is already under this one.");
                if (!seen.Add(up)) break;
            }
        }

        if (live is not null) live.NestedUnderId = parentId;
        if (stored is not null) _restorable[id] = stored with { NestedUnderId = parentId };

        SavePersisted();
        // The link rides the session list (SessionInfo.NestedUnderId), so every browser has to be told
        // the list changed — this is a move in the list, and the list is what draws it.
        RaiseChanged();
        return true;
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
    /// The UI-bag field naming the worktree whose branch a session's header shows: the folder of
    /// another worktree of its repo, or "" for its own working directory. A session that starts a
    /// task in a fresh worktree is still running in the main folder, so without it the header would
    /// go on naming the folder's branch rather than the one the work is on.
    /// </summary>
    public const string GitWorktreeField = "gitWorktree";

    /// <summary>
    /// Point a session's header at a worktree of its repo (see <see cref="GitWorktreeField"/>); ""
    /// goes back to its own folder. Kept in the UI bag, so it survives a reopen and reaches every
    /// browser on the next list push. Null when there is no such session.
    /// </summary>
    public SessionUiStore.Snapshot? SetGitWorktree(string id, string folder) =>
        MergeUi(id, new Dictionary<string, JsonElement>(StringComparer.Ordinal)
        {
            [GitWorktreeField] = JsonSerializer.SerializeToElement(folder),
        });

    /// <summary>
    /// How many file tabs a session may hold. The panel itself has no limit — a person closes tabs —
    /// but this endpoint can be called in a loop, and a bag that grows past
    /// <see cref="SessionUiStore"/>'s per-entry cap stops being persisted at all. Past the limit the
    /// oldest tabs give way, which is what a person would have done to make room.
    /// </summary>
    private const int MaxFileTabs = 50;

    /// <summary>
    /// Open a file as a tab in a session's Files panel, exactly as clicking it in the tree does: the
    /// tab model lives in the saved UI bag (see <see cref="SessionUiStore"/>), so this writes the same
    /// fields the browser writes and every device picks the new tab up on the next list push.
    ///
    /// <para><paramref name="paths"/> are relative to the session's working directory and are assumed
    /// already resolved against it (see <c>SessionFileBrowser.RelativeFile</c>). The last one becomes
    /// the active tab. <paramref name="pin"/> false opens the file in the single transient "preview"
    /// slot that a single click reuses; true gives it a tab of its own.</para>
    ///
    /// <para>Returns the merged bag, or null when there is no such session.</para>
    /// </summary>
    public SessionUiStore.Snapshot? OpenFileTabs(string id, IReadOnlyList<string> paths, bool pin)
    {
        if (GetUi(id) is not { } ui || paths.Count == 0) return null;

        var files = ui.State.TryGetValue("files", out var f) && f.ValueKind == JsonValueKind.Array
            ? f.EnumerateArray().Where(e => e.ValueKind == JsonValueKind.String)
                .Select(e => e.GetString()!).ToList()
            : new List<string>();
        var preview = ui.State.TryGetValue("preview", out var p) && p.ValueKind == JsonValueKind.String
            ? p.GetString() ?? ""
            : "";

        foreach (var path in paths)
        {
            // The three cases the panel has (useFileTabs.open), in the same order.
            var slot = pin || preview.Length == 0 ? -1 : files.IndexOf(preview);
            if (files.Contains(path, StringComparer.Ordinal))
            {
                if (pin && preview == path) preview = ""; // promote the preview tab to a pinned one
            }
            else if (slot < 0)
            {
                files.Add(path);                          // a tab of its own, or the first preview tab
                if (!pin) preview = path;
            }
            else
            {
                files[slot] = path;                       // reuse the preview slot in place
                preview = path;
            }
        }

        var active = paths[^1];
        if (files.Count > MaxFileTabs)
        {
            var drop = files.Count - MaxFileTabs;
            files = files.Where((t, i) => i >= drop || t == active || t == preview).ToList();
        }

        return MergeUi(id, new Dictionary<string, JsonElement>(StringComparer.Ordinal)
        {
            ["files"] = JsonSerializer.SerializeToElement(files),
            ["file"] = JsonSerializer.SerializeToElement(active),
            ["preview"] = JsonSerializer.SerializeToElement(preview),
            // The panel can be pointed at another worktree or a linked folder, where these paths would
            // resolve somewhere else entirely. They were resolved against the session's own working
            // directory, so that is the root they belong to.
            ["worktree"] = JsonSerializer.SerializeToElement(""),
        });
    }

    /// <summary>
    /// How many pull requests a session may have open as tabs — the cap the browser keeps
    /// (MAX_PULLS in lib/sessionPulls.ts), so a tab opened here and one opened from the picker make
    /// way for each other the same way.
    /// </summary>
    private const int MaxPullTabs = 8;

    /// <summary>
    /// Open a pull request as a tab in a session's tab bar, exactly as picking it from a group's PR
    /// picker does: the same fields of the saved UI bag the browser writes (lib/sessionPulls.ts), so
    /// every device picks the tab up on the next list push.
    ///
    /// <para><paramref name="repo"/> is null for the session folder's own repo, which is how the
    /// browser stores those tabs too — the key of a review is then its number alone, and opening one
    /// already on the bar goes back to it. Re-opening takes the new title, since the PR may have been
    /// renamed. The PR becomes the active review either way.</para>
    ///
    /// <para>Returns the key the tab is stored under, or null when there is no such session.</para>
    /// </summary>
    public string? OpenPullTab(string id, string? repo, int number, string title)
    {
        if (GetUi(id) is not { } ui) return null;

        var pulls = ui.State.TryGetValue("pulls", out var p) && p.ValueKind == JsonValueKind.Array
            ? p.EnumerateArray().Where(e => e.ValueKind == JsonValueKind.Object).ToList()
            : new List<JsonElement>();

        string KeyOf(JsonElement e)
        {
            var r = e.TryGetProperty("repo", out var rv) && rv.ValueKind == JsonValueKind.String ? rv.GetString() : null;
            var n = e.TryGetProperty("number", out var nv) && nv.TryGetInt32(out var i) ? i : 0;
            return string.IsNullOrEmpty(r) ? n.ToString() : $"{r}#{n}";
        }

        // GitHub reads a repo's name in any case, so "CLI/cli" here and "cli/cli" from the picker are
        // one review — and the tab already open keeps its spelling, which is what its folds and its
        // place in the pane are keyed by.
        var key = repo is null ? number.ToString() : $"{repo}#{number}";
        var at = pulls.FindIndex(e => string.Equals(KeyOf(e), key, StringComparison.OrdinalIgnoreCase));
        if (at >= 0 && repo is not null)
        {
            key = KeyOf(pulls[at]);
            repo = key[..key.LastIndexOf('#')];
        }

        var tab = JsonSerializer.SerializeToElement(repo is null
            ? new Dictionary<string, object> { ["number"] = number, ["title"] = title }
            : new Dictionary<string, object> { ["number"] = number, ["title"] = title, ["repo"] = repo });

        if (at >= 0) pulls[at] = tab;
        else pulls.Add(tab);
        if (pulls.Count > MaxPullTabs) pulls = pulls.Skip(pulls.Count - MaxPullTabs).ToList();

        var patch = new Dictionary<string, JsonElement>(StringComparer.Ordinal)
        {
            ["pulls"] = JsonSerializer.SerializeToElement(pulls),
            ["pull"] = JsonSerializer.SerializeToElement(key),
        };

        // A tab pushed off the end takes how far through it the reader had got with it, as the
        // browser's own writes do (`pruned` in lib/sessionPulls.ts): the bag is capped, and these
        // would otherwise grow with every review the session has ever opened.
        var open = pulls.Select(KeyOf).ToHashSet(StringComparer.Ordinal);
        foreach (var field in new[] { "pullFolds", "pullScroll" })
        {
            if (!ui.State.TryGetValue(field, out var v) || v.ValueKind != JsonValueKind.Object) continue;
            var props = v.EnumerateObject().ToList();
            if (props.All(x => open.Contains(x.Name))) continue;
            patch[field] = JsonSerializer.SerializeToElement(
                props.Where(x => open.Contains(x.Name)).ToDictionary(x => x.Name, x => x.Value));
        }

        return MergeUi(id, patch) is null ? null : key;
    }

    /// <summary>
    /// Pin or unpin a session, keyed by its conversation so the pin survives a reopen (which mints a
    /// new session id) and reaches every browser through the session list. Returns false when there
    /// is no such session.
    /// </summary>
    public bool SetPinned(string id, bool pinned) => SetFlag(_pins, id, pinned);

    /// <summary>
    /// Pause or resume a session's activity — whether it counts in the marks and totals above it (see
    /// <see cref="ActivityPauseStore"/>). Keyed by conversation, as a pin is. Returns false when there
    /// is no such session.
    /// </summary>
    public bool SetActivityPaused(string id, bool paused) => SetFlag(_activityPaused, id, paused);

    private bool SetFlag(ConversationFlagStore store, string id, bool on)
    {
        string? key = null;
        if (_sessions.TryGetValue(id, out var live)) key = ConversationId(live);
        else if (_restorable.TryGetValue(id, out var p)) key = p.ClaudeSessionId;
        else if (!_sessions.ContainsKey(id)) return false;

        // No conversation id yet (a session in its first seconds): set it under the fallback key, which
        // OnClaudeSessionIdCaptured swaps for the real one as soon as the first hook arrives.
        if (store.Set(key ?? ConversationFlagStore.SessionKey(id), on)) RaiseChanged();
        // Clearing has to clear both keys — a mark set before the id arrived may still sit under the
        // fallback if the session never reported one.
        if (!on && key is not null && store.Set(ConversationFlagStore.SessionKey(id), false)) RaiseChanged();
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
    public IReadOnlyCollection<string> BusySessionIds()
    {
        foreach (var s in _sessions.Values) EndInterruptedTurn(s);
        return _sessions.Values
            .Where(s => s.State == SessionState.Running && IsBusy(s))
            .Select(s => s.Id)
            .ToArray();
    }

    /// <summary>
    /// Settle a turn you cut short with Esc. The hooks say working until a <c>Stop</c>, and none comes
    /// for an interrupt, so without this the session kept its working mark (and its share of the
    /// activity count) until the next prompt. The screen is the only witness: the notice Claude leaves
    /// above its input box, read once the terminal has gone quiet and no hook has arrived for a moment.
    /// Run where the marks are read (the hub's snapshot) and when the terminal goes quiet, so it holds
    /// whether or not a browser is watching — the schedules read the hook status directly.
    /// </summary>
    private void EndInterruptedTurn(ClaudeSession s, bool lookAgain = false)
    {
        if (s.State != SessionState.Running || s.Terminal is not { IsBusy: false } term) return;
        if (!_hooks.TryGetStatus(s.Id, out var st) || !(st.Busy || st.Waiting)) return;
        // A hook this fresh is newer news than anything on screen: a prompt just sent, a tool starting.
        var settle = InterruptSettle - (DateTimeOffset.Now - st.LastEventAt);
        if (settle > TimeSpan.Zero)
        {
            // The terminal going quiet is the one edge there is. Esc soon after a hook lands here, and
            // with nobody reading the marks nothing would ever look again — so look once that hook has aged.
            if (lookAgain) _ = Task.Delay(settle).ContinueWith(_ => EndInterruptedTurn(s), TaskScheduler.Default);
            return;
        }
        if (term.ShowsInterrupted) _hooks.EndInterruptedTurn(s.Id, st.LastEventAt);
    }

    private static readonly TimeSpan InterruptSettle = TimeSpan.FromSeconds(2);

    /// <summary>
    /// Whether Claude is generating in a session. Prefers the authoritative hook-derived status (exact
    /// UserPromptSubmit→Stop transitions); falls back to the terminal-output heuristic — computed in
    /// the pty host and pushed to us — for sessions that haven't produced a hook event yet (e.g. hooks
    /// disabled, or the brief window before SessionStart).
    /// </summary>
    /// <remarks>
    /// The fallback is load-bearing far more often than "hooks disabled" suggests: the hook store is
    /// in memory, so a restart drops every session's status, and an idle session emits no hook to
    /// rebuild it — after an update, every session that survived it is on the heuristic until you
    /// next type in one. That is exactly when a repaint must not read as a turn, hence the guard —
    /// and, for a session that has yet to say a word, when its opening paint must not either: see
    /// <see cref="StillStartingUp"/>.
    /// </remarks>
    private bool IsBusy(ClaudeSession s) =>
        _hooks.TryGetStatus(s.Id, out var st)
            ? st.Busy
            : !StillStartingUp(s) && s.Terminal is { IsBusy: true, IsRepaintingAfterResize: false };

    /// <summary>
    /// How long a launched session's terminal is discounted while it waits for its first hook — a
    /// backstop, not the mechanism. <c>SessionStart</c> normally ends the wait within seconds of
    /// claude drawing itself; this is only what keeps a session whose hooks never arrive from staying
    /// dark for ever, whether because they are switched off (<c>Hooks:Enabled=false</c>), because
    /// another live instance owns the registration, or because one simply never lands.
    ///
    /// <para>One length for all three, because the thing being sat out is the same either way: the
    /// opening paint, whose length has nothing to do with whether anyone is listening for hooks. Long
    /// enough for the case that needs it — sixty sessions resuming at once after a restart, where a
    /// single <c>claude --resume</c> took a minute and a half to reach its prompt — and no longer,
    /// since an instance that hears no hooks is blind for the whole of it.</para>
    /// </summary>
    private static readonly TimeSpan StartupGrace = TimeSpan.FromMinutes(2);

    /// <summary>
    /// Whether a session we launched is still <em>coming up</em>: claude has not reported in yet, so
    /// everything on its terminal is the TUI drawing itself for the first time — with <c>--resume</c>,
    /// an entire conversation being replayed onto the screen — rather than a turn.
    /// </summary>
    /// <remarks>
    /// The distinction earns its keep downstream, where the sidebar reads a session <em>leaving</em> the
    /// working set as a turn that just finished. Without this, every session brought back by a restart
    /// flickers busy while it paints and then settles under a green "Claude finished here" tick that
    /// nobody asked for — dozens of them at once, on the one screen where the tick is meant to mean
    /// something. It is the same rule as the resize guard one line up: output we caused is not work.
    ///
    /// <para>Any hook at all ends it, not just a status-bearing one: the point is that claude is up and
    /// talking, after which the hook store is the authority and the heuristic is only ever the
    /// gap-filler it was always meant to be.</para>
    /// </remarks>
    private bool StillStartingUp(ClaudeSession s) =>
        // Adopted: it was running long before we attached, so whatever is on its screen is its own.
        !s.Adopted
        && s.SinceLaunch is { } age && age < StartupGrace
        && !_hooks.TryGetStatus(s.Id, out _);

    /// <summary>
    /// Ids of live sessions where Claude is compacting its conversation — auto-compaction or an
    /// explicit <c>/compact</c>. Read off the screen in the pty host, with no hook-derived
    /// alternative to prefer: Claude fires <c>PreCompact</c> and then nothing at all when the
    /// compaction ends, so the repainting "Compacting conversation…" spinner is the only signal
    /// that has both edges.
    /// </summary>
    /// <remarks>
    /// Skipped for a session that hasn't started yet, for the same reason as busy — and with an extra
    /// one of its own: a <c>--resume</c> replays the conversation onto the screen, spinner line and
    /// all, and a compaction that happened yesterday must not be read off it as one happening now.
    /// </remarks>
    public IReadOnlyCollection<string> CompactingSessionIds() =>
        _sessions.Values
            .Where(s => s.State == SessionState.Running && !StillStartingUp(s)
                        && s.Terminal is { IsCompacting: true })
            .Select(s => s.Id)
            .ToArray();

    /// <summary>
    /// Ids of live sessions with something typed into Claude's input box and not sent. Not an activity
    /// — nothing is happening there — but a thing left behind, which is easy to lose track of once you
    /// have moved to another session. Read off the screen; see <see cref="Pty.ClaudeInputBox"/>.
    /// </summary>
    public IReadOnlyCollection<string> DraftSessionIds() =>
        _sessions.Values
            .Where(s => s.State == SessionState.Running && s.Terminal is { HasInputDraft: true })
            .Select(s => s.Id)
            .ToArray();

    /// <summary>
    /// Live sessions whose footer counts shells Claude left running — a benchmark, a dev server — with
    /// how many. Its turn may be over, but the work it started isn't, so it shouldn't read as finished.
    /// Read off the screen; see <see cref="Pty.ClaudeInputBox"/>. Skipped while starting up, like
    /// compacting: a <c>--resume</c> replays an old screen.
    /// </summary>
    public IReadOnlyDictionary<string, int> BackgroundTaskCounts()
    {
        var counts = new Dictionary<string, int>();
        foreach (var s in _sessions.Values)
            if (s.State == SessionState.Running && !StillStartingUp(s) && s.Terminal is { BackgroundTasks: > 0 and var n })
                counts[s.Id] = n;
        return counts;
    }

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

    /// <summary>
    /// Whether a live session is somewhere a message can be typed without interrupting anything: not
    /// working, not compacting, not blocked on a prompt, not sitting on a turn that died, and past its
    /// opening paint. Each of those is the reading the hub sends the browser, so "quiet" here is
    /// exactly a row with no activity mark on it.
    /// </summary>
    public bool IsQuiet(string id) =>
        _sessions.TryGetValue(id, out var s)
        && s.State == SessionState.Running
        && !StillStartingUp(s)
        && !IsBusy(s)
        && !IsAwaitingInput(s)
        && s.Terminal is { IsCompacting: false }
        && !(_hooks.TryGetStatus(s.Id, out var st) && st.Failure is not null);

    /// <summary>Id and folder of every live session — what a loop over them needs, without a full snapshot.</summary>
    public IReadOnlyList<(string Id, string WorkingDirectory)> RunningSessions() =>
        _sessions.Values
            .Where(s => s.State == SessionState.Running)
            .Select(s => (s.Id, s.WorkingDirectory))
            .ToArray();

    /// <summary>
    /// Switch a session's postponed pool to auto-send or back (see <see cref="PostponedAutoSender"/>).
    /// On only for a live session: a reopen is a new session with a pool of its own, so a closed one
    /// has no queue left to run. Off for either. False if that leaves nothing to do it to, or the flag
    /// could not be stored.
    /// </summary>
    public bool SetPostponedAutoSend(string id, bool on)
    {
        var dir = on
            ? _sessions.TryGetValue(id, out var s) && s.State == SessionState.Running ? s.WorkingDirectory : null
            : FolderOf(id);
        if (dir is null) return false;
        if (!PostponedStore.SetAutoSend(dir, id, on)) return false;
        RaiseChanged();
        return true;
    }

    /// <summary>
    /// Ids of live sessions whose last turn ended on an API error — a rate limit, an overload — rather
    /// than on an answer. Hook-derived only, with no heuristic fallback: a failed turn and a finished
    /// one look identical on screen (both stop printing), which is the whole reason this is worth
    /// surfacing. Cleared by the next prompt, so it says "this one needs picking back up", not "this
    /// one errored at some point today".
    /// </summary>
    public IReadOnlyCollection<string> FailedSessionIds() =>
        _sessions.Values
            .Where(s => s.State == SessionState.Running
                        && _hooks.TryGetStatus(s.Id, out var st) && st.Failure is not null)
            .Select(s => s.Id)
            .ToArray();

    /// <summary>
    /// The words behind the activity marks, for the sessions that have any: what a waiting session is
    /// blocked on, and why a failed one stopped. Keyed by session id and sent alongside the id sets in
    /// the hub snapshot — a dot can only say <em>that</em> something is happening, and on a phone in
    /// another room the useful half is <em>what</em>.
    /// </summary>
    public IReadOnlyDictionary<string, SessionActivityDetail> ActivityDetails()
    {
        var details = new Dictionary<string, SessionActivityDetail>();
        foreach (var s in _sessions.Values)
        {
            if (s.State != SessionState.Running) continue;
            if (!_hooks.TryGetStatus(s.Id, out var st)) continue;
            if (st.WaitingOn is null && st.Failure is null) continue;
            details[s.Id] = new SessionActivityDetail(st.WaitingOn, st.Failure, st.FailureMessage);
        }
        return details;
    }

    public SessionInfo? Get(string id)
    {
        if (!_sessions.TryGetValue(id, out var s)) return null;
        s.Refresh();
        return s.ToInfo(ConversationId(s));
    }

    /// <summary>
    /// The same lookup, widened to a closed session from a previous run. What every read of a
    /// session's <em>folder</em> asks with — its files, its git status, the repo's pull requests —
    /// because none of that needs a process: the work is on disk and stays there once the session
    /// that did it has gone. <see cref="Get"/> stays the narrower question, for the things that do
    /// need something alive to talk to.
    /// </summary>
    public SessionInfo? GetAny(string id) =>
        Get(id) ?? (_restorable.TryGetValue(id, out var p) ? ClaudeSession.RestorableInfo(p) : null);

    /// <summary>Filesystem change counter for a session's working directory (null if unknown).</summary>
    public long? FsVersion(string id) => _sessions.TryGetValue(id, out var s) ? s.FsVersion : null;

    /// <summary>
    /// Completes once the startup work that decides what is actually running has finished — adopting
    /// the pty hosts that outlived the last run, then auto-resuming what they did not cover.
    ///
    /// <para>Until then the session list is a lie of omission: every session from the previous run is
    /// sitting in <c>_restorable</c>, looking dead, while its pty host is alive and about to be
    /// re-attached. Anything that would ACT on a session being dead has to wait for this, or it acts
    /// on the gap. The scheduler learned that the expensive way — it fired in the ~50 ms before
    /// adoption, found its target "Restorable", relaunched it, and left the original host orphaned;
    /// one more duplicate claude per restart.</para>
    /// </summary>
    public Task Settled => _settled.Task;

    private readonly TaskCompletionSource _settled = new(TaskCreationOptions.RunContinuationsAsynchronously);

    /// <summary>
    /// Say that startup is done and the list can be trusted. Called once, whether the adoption pass
    /// succeeded or threw — a failed adoption still ends the window, and leaving it open for ever
    /// would silently stop every schedule on the machine.
    /// </summary>
    public void MarkSettled() => _settled.TrySetResult();

    /// <summary>
    /// Whether the process a closed session was last launched as is somehow still alive — a session
    /// whose host outlived us and has not been adopted (yet, or at all). Reopening one of these
    /// relaunches a conversation that is already running, so the answer is "don't".
    /// PIDs are recycled, so the start time has to match too; see <see cref="OriginalProcessAlive"/>.
    /// </summary>
    public bool ClosedSessionStillAlive(string id) =>
        _restorable.TryGetValue(id, out var p) && OriginalProcessAlive(p);

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
            // Sent as a message (paste, then a separate Enter), never "/rename X\r" in one write: Claude
            // Code takes that chunk as typed text, the \r becomes a newline in the box, and the command
            // sits there unsent — mid-turn especially, which is when a session renames itself.
            if (s.Rename(clean)) // raises MetadataChanged -> SavePersisted
                _ = SendMessageAsync(id, $"/rename {clean}");
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
    /// The gap the TUI needs between two submits. Back-to-back Enters are coalesced into one message
    /// by Claude Code's input box, so a caller sending several in a row must space them out; the
    /// browser's "send all" flush has used the same 150 ms since it shipped
    /// (<c>web/src/components/PostponedPool.tsx</c>).
    /// </summary>
    public static readonly TimeSpan SendGap = TimeSpan.FromMilliseconds(150);

    /// <summary>
    /// Send one message to a live session's Claude, exactly as typing it into the terminal would:
    /// the text as a <em>bracketed paste</em> — so newlines inside it stay literal instead of
    /// submitting a line at a time — followed by a single <c>\r</c> as the one submit.
    ///
    /// <para>This used to exist only in the browser (<c>TerminalPane.sendMessage</c>), which meant
    /// nothing server-side could talk to a session: the scheduler needs to, and so does anything
    /// driving a session from a script. The transport underneath is the one the watchdog has always
    /// used — <see cref="Pty.ITerminal.WriteAsync"/>.</para>
    ///
    /// <para>Returns false when the id is unknown, the session isn't running, or its terminal has
    /// gone — never throws for those, because every caller here is reacting to a timer rather than
    /// to a person, and a session that ended is an outcome to record, not an error to propagate.</para>
    /// </summary>
    public Task<bool> SendMessageAsync(string id, string text, CancellationToken ct = default) =>
        SendMessageAsync(id, text, [], ct);

    /// <summary>
    /// The same, with images: each path is pasted after the text as its own bracketed paste — which
    /// is how Claude Code takes an image dropped on it — and the submit waits for them to be taken in.
    /// What the browser's <c>TerminalPane.sendMessage</c> does with an image from the composer.
    /// </summary>
    public async Task<bool> SendMessageAsync(
        string id, string text, IReadOnlyList<string> imagePaths, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(text) && imagePaths.Count == 0) return false;
        if (!_sessions.TryGetValue(id, out var s) || s.State != SessionState.Running) return false;
        if (s.Terminal is not { } term) return false;

        // \x1b[200~ … \x1b[201~ is the paste; the \r after it is deliberately a separate write and a
        // separate byte — inside the brackets it would be pasted text, not a submit.
        // Control characters other than newline and tab are dropped from what goes inside: an ESC in
        // there could close the paste early ("\x1b[201~") and turn the rest into keystrokes, and a
        // message read off disk with nobody watching (auto-send, a schedule) must not be able to.
        static byte[] Paste(string t) => Encoding.UTF8.GetBytes(
            $"\x1b[200~{new string(t.Replace("\r\n", "\n").Where(c => !char.IsControl(c) || c is '\n' or '\t').ToArray())}\x1b[201~");
        try
        {
            if (!string.IsNullOrWhiteSpace(text)) await term.WriteAsync(Paste(text), ct);
            foreach (var path in imagePaths) await term.WriteAsync(Paste(path), ct);
            // Claude Code reads a pasted image in the background and swaps in an "[Image #N]" chip; an
            // Enter that arrives before that is swallowed, and the message sits unsent in the box.
            if (imagePaths.Count > 0) await Task.Delay(ImageSettle, ct);
            await term.WriteAsync(Cr, ct);
            _log.LogInformation("Sent a {Length}-char message to session {Id} ('{Name}')", text.Length, id, s.Name);
            return true;
        }
        catch (Exception ex)
        {
            // The host can go between the checks above and the write; that is a delivery failure like
            // any other and the caller decides what to do about it.
            _log.LogWarning(ex, "Could not send a message to session {Id}", id);
            return false;
        }
    }

    private static readonly ReadOnlyMemory<byte> Cr = new(new[] { (byte)'\r' });

    /// <summary>The browser's <c>IMAGE_SETTLE_MS</c>: how long a pasted image takes to be taken in.</summary>
    private static readonly TimeSpan ImageSettle = TimeSpan.FromMilliseconds(600);

    /// <summary>
    /// How long a launch prompt waits for claude's input before going to the postponed pool. Long,
    /// because what it is usually waiting on is a person: a first-run dialog has to be answered, and
    /// the prompt should go in the moment it is, not be filed away while they read it.
    /// </summary>
    private static readonly TimeSpan PromptReadyTimeout = TimeSpan.FromMinutes(10);

    /// <summary>
    /// The input box, as Claude Code draws it with nothing in front of it: its prompt character at the
    /// very start of a line (<c>❯</c>, or <c>&gt;</c> in older versions, optionally inside a <c>│</c>
    /// border), and not a numbered choice. The gap after it is a no-break space in current versions.
    /// </summary>
    private static readonly Regex InputBoxLine = new(@"(?m)^(?:│ ?)?[❯>][  ](?!\d+[.)])", RegexOptions.Compiled);

    /// <summary>
    /// Something in front of the input box that a paste and its Enter would answer instead: a numbered
    /// choice with its cursor (the trust, theme or upsell dialogs — drawn indented, unlike the input
    /// line), or the footer those dialogs carry.
    /// </summary>
    private static readonly Regex DialogOnScreen = new(
        @"(?m)^\s*❯\s*\d+[.)]\s|Enter to confirm|Enter to select|Esc to cancel", RegexOptions.Compiled);

    /// <summary>
    /// Whether claude's screen shows its input box and nothing in front of it. Read off the screen on
    /// purpose, beside the hooks: the first-run dialogs claude puts up before the input box (a new
    /// renderer, the Chrome extension) are not permission prompts, and no hook says they are there.
    /// Unknown screens read as not ready — a prompt that waits and is stashed is recoverable, one typed
    /// into a dialog is not.
    /// </summary>
    internal static bool InputBoxReady(string screen) =>
        InputBoxLine.IsMatch(screen) && !DialogOnScreen.IsMatch(screen);

    /// <summary>How quiet claude's opening paint must have gone before the prompt is typed in.</summary>
    private const long PromptQuietMs = 1000;

    /// <summary>
    /// How long after claude's input comes up the prompt goes in anyway, quiet or not — a spinner on
    /// the screen (Remote Control connecting, say) must not hold it back for good.
    /// </summary>
    private static readonly TimeSpan PromptMaxSettle = TimeSpan.FromSeconds(10);

    /// <summary>
    /// Type a launch prompt in once claude can take it — the Linux and macOS half of what the command
    /// line does on Windows (see <c>ClaudeSession.PromptOnCommandLine</c>, and why it isn't used there).
    /// </summary>
    /// <remarks>
    /// <para><b>Ready</b> means: claude's TUI has switched bracketed paste on, which it does as it mounts
    /// (<see cref="Pty.ITerminal.AcceptsPaste"/>); the screen shows the input box with nothing in front
    /// of it (<see cref="InputBoxReady"/>) and no permission prompt is waiting — a paste into a dialog
    /// would answer it, which is how a first-run "try the new renderer?" once took the Enter meant for
    /// the prompt; and the opening paint has gone quiet for <see cref="PromptQuietMs"/>, or the input
    /// box has been up for <see cref="PromptMaxSettle"/>. Then it goes in the way any message does,
    /// through <see cref="SendMessageAsync(string, string, CancellationToken)"/>.</para>
    /// <para>A prompt that can't be delivered — claude never got there inside
    /// <see cref="PromptReadyTimeout"/>, or this app began shutting down first — is put in the
    /// session's postponed messages rather than dropped, as a schedule's undeliverable prompt is: the
    /// badge then says something is waiting, and it is one click from being sent.</para>
    /// </remarks>
    private async Task TypeInitialPromptAsync(ClaudeSession s, string prompt)
    {
        var waited = System.Diagnostics.Stopwatch.StartNew();
        TimeSpan? inputUpAt = null;
        try
        {
            while (waited.Elapsed < PromptReadyTimeout)
            {
                await Task.Delay(250, _stopping.Token);
                if (s.State != SessionState.Running || s.Terminal is not { } term)
                {
                    // Ended before it got there: a reopen is a new session with a pool of its own, so
                    // there is nowhere left to put the prompt.
                    _log.LogWarning("Session {Id} ended before its launch prompt could be typed in.", s.Id);
                    return;
                }
                if (!term.AcceptsPaste) continue;
                if (IsAwaitingInput(s) || !InputBoxReady(term.ScreenText())) { inputUpAt = null; continue; }
                inputUpAt ??= waited.Elapsed;
                if (term.MillisSinceOutput < PromptQuietMs && waited.Elapsed - inputUpAt < PromptMaxSettle) continue;

                if (await SendMessageAsync(s.Id, prompt, _stopping.Token)) return;
                break; // the terminal went between the checks and the write
            }
        }
        catch (OperationCanceledException) { /* shutting down: stash it below */ }
        catch (Exception ex) { _log.LogWarning(ex, "Typing the launch prompt into session {Id} failed", s.Id); }

        var stashed = PostponedStore.Append(s.WorkingDirectory, s.Id, prompt, []);
        if (stashed == PostponedStore.AppendResult.Added)
        {
            _log.LogWarning("Could not type the launch prompt into session {Id}; it is in the session's postponed messages.", s.Id);
            RaiseChanged();
        }
        else
            _log.LogError("Could not type the launch prompt into session {Id}, nor stash it ({Result}).", s.Id, stashed);
    }

    /// <summary>
    /// The project a launch should link its folder into (null when none, or when the folder is already
    /// there) and the group to file it in, from <see cref="CreateSessionRequest.ProjectId"/> and
    /// <see cref="CreateSessionRequest.GroupId"/>. Throws, with a message for the person, when they
    /// can't both be honoured: an unknown project, a folder another project already has, or a group
    /// that isn't in the project the session would end up in.
    /// </summary>
    private (Project? LinkTo, string? GroupId) Placement(CreateSessionRequest req, string fullDir)
    {
        var wantProject = string.IsNullOrWhiteSpace(req.ProjectId) ? null : req.ProjectId.Trim();
        var wantGroup = string.IsNullOrWhiteSpace(req.GroupId) ? null : req.GroupId.Trim();
        if (wantProject is null && wantGroup is null) return (null, null);

        var projects = _projects.List();
        var owner = ProjectMembership.ForDirectory(projects, fullDir);
        var target = owner;
        Project? linkTo = null;
        if (wantProject is not null)
        {
            var chosen = projects.FirstOrDefault(p => p.Id == wantProject)
                ?? throw new ArgumentException("That project no longer exists.");
            if (owner is not null && owner.Id != chosen.Id)
                throw new ArgumentException(
                    $"That folder belongs to the project \"{owner.Name}\". Choose that project, or another folder.");
            if (owner is null) linkTo = chosen;
            target = chosen;
        }
        if (wantGroup is not null && (target is null || !target.Groups.Any(g => g.Id == wantGroup)))
            throw new ArgumentException("That group isn't in the session's project.");
        return (linkTo, wantGroup);
    }

    /// <summary>
    /// Launch a new session: spawn its pty host, then attach to it over the host's pipe. Genuinely
    /// asynchronous — there is a process start and a handshake to wait for — so every caller awaits
    /// rather than blocking a thread on it.
    /// </summary>
    /// <param name="adopt">
    /// Whether a session launched under another (<see cref="CreateSessionRequest.NestedUnderId"/>)
    /// should have its folder linked into its host's project. True for a launch, which is someone
    /// asking for the two to be drawn together; false for <see cref="RestoreAsync"/>, which relaunches
    /// an old session with the same host and must not re-claim a folder the user has since taken out
    /// of that project.
    ///
    /// <para>Only the project link. The virtual folder inside it is filed either way — see below: a
    /// reopen needs it as much as a launch does, and the guard there already leaves alone a session
    /// that has a box of its own.</para>
    /// </param>
    public async Task<SessionInfo> CreateAsync(
        CreateSessionRequest req, bool adopt = true, CancellationToken ct = default)
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

        // Where it was asked to be filed, settled before anything is launched: a request that can't be
        // honoured is refused whole rather than leaving a session running somewhere it wasn't wanted.
        var (linkTo, groupId) = Placement(req, fullDir);

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
        if (session.PromptToType is { } prompt) _ = TypeInitialPromptAsync(session, prompt);

        var info = session.ToInfo(ConversationId(session));
        if (linkTo is not null && _projects.AddFolder(linkTo.Id, fullDir) is not null)
            RaiseChanged(); // the projects don't ride the session list; see the same move below
        if (groupId is not null && SetGroup(new[] { session.Id }, groupId) is not null)
            info = info with { GroupId = groupId };
        // A session launched under another — hgr-new-session.ps1 -Child posts NestedUnderId — is
        // drawn under it, and a row is only ever drawn under something in its own list: placed
        // anywhere its host is not, it comes out at the top level of that other list and the nesting
        // the caller asked for is simply gone. So it takes its host's place in the list, for the same
        // reason a fork does — see ForkAsync — which is two things: the project, and the box inside it.
        if (req.NestedUnderId is { } host)
        {
            // The project first, because a virtual folder only applies inside the project that owns it
            // (see ProjectMembership.GroupFor), so filing the session anywhere is pointless until this
            // is settled. Which project a session is in follows the folder it runs in and nothing else,
            // and a child need not run in its host's folder — look into another repo from the session
            // that sent you there and the two are in different folders by design. Linking that folder
            // is the only way to say "this project" about it at all, and it is exactly the move the
            // row menu's "Move to project" makes by hand.
            //
            // Only a folder no project claims. One that is already in a project stays there: a link is
            // a statement about the folder rather than about this session, so taking it would re-file
            // every other session that runs there — including ones this launch has nothing to do with.
            //
            // Not on a reopen (see `adopt`): that relaunches a session that has been sitting closed,
            // and a folder someone has taken out of this project since is not ours to take back.
            if (adopt
                && ProjectMembership.ForDirectory(_projects.List(), fullDir) is null
                && FolderOf(host) is { } hostDir
                && ProjectMembership.ForDirectory(_projects.List(), hostDir) is { } hostProject)
            {
                _projects.AddFolder(hostProject.Id, fullDir);
                // The projects don't ride the session list, so nothing above would tell a browser this
                // happened — it reads the revision off the hub's next snapshot and re-fetches them.
                RaiseChanged();
            }

            // Then the box, if the host is in one — and only when this session isn't already filed
            // somewhere itself. That is not hypothetical: a session that resumes a conversation knows
            // its id from the start, and a conversation filed by hand stays filed under that id, so a
            // child that reopens it belongs in the box it is already in.
            //
            // Unlike the project link above, this runs on a reopen too. The membership of a session
            // that never reported a conversation id was written under its session id, and a reopen
            // mints a new one — so there is nothing to inherit and nothing that says "moved out",
            // and skipping this would drop the reopened child out of its host's box and, with it,
            // out from under the host entirely (a row is only drawn under something in its own list).
            if (GroupIdOf(ConversationId(session), session.Id) is null
                && GroupIdOf(host) is { } hostGroup
                && SetGroup(new[] { session.Id }, hostGroup) is not null)
                info = info with { GroupId = hostGroup };
        }
        return info;
    }

    /// <summary>
    /// Branch a session's conversation into a new one: relaunch <c>claude</c> in the same folder with
    /// the same settings, resuming the session's conversation under <c>--fork-session</c> so Claude
    /// replays its history into a fresh conversation id. The original is left running and untouched;
    /// the fork records its parent so the UI can nest it underneath, and joins the virtual folder the
    /// parent was filed into so the branch stays where the user put it.
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

        // Where the parent is filed by hand, before anything is launched: the fork joins it below.
        var groupId = GroupIdOf(id);

        var forkName = ClaudeSession.SanitizeName(name);
        if (forkName.Length == 0) forkName = DefaultForkName(parentName);

        var fork = await CreateAsync(new CreateSessionRequest(
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

        if (groupId is null) return fork;

        // A fork belongs where its parent belongs. The project comes for free — it is decided by the
        // working directory, which the fork inherits — but a virtual folder is filed by hand and keyed
        // per conversation, and a fork's conversation is brand new. Unfiled, a branch of a filed
        // session would be drawn outside its parent's box, which is a different list: the nesting that
        // makes it a fork at all would come apart in the same move. Filed under the `session:` fallback
        // key and folded into the real one once the fork reports its conversation id, exactly as a
        // grouping set by hand in those first seconds is (see OnClaudeSessionIdCaptured).
        //
        // A group that has since stopped applying to the folder files nothing, and the fork simply
        // shows under its folder — SetGroup refuses it rather than writing a membership nothing reads.
        return SetGroup(new[] { fork.Id }, groupId) is null ? fork : fork with { GroupId = groupId };
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
            _activityPaused.Rekey(ActivityPauseStore.SessionKey(sessionId), claudeSessionId);
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
                ParentName: p.ParentName,
                NestedUnderId: p.NestedUnderId),
                // Reopening is not a launch: a folder taken out of this project since is left where
                // the user put it. The box still follows — see the parameter's remarks.
                adopt: false, ct);
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
    /// Point everything drawn under <paramref name="oldParentId"/> at <paramref name="newParentId"/> —
    /// the session that replaced it after a reopen. Without this the tree would flatten out on every
    /// restore (and on the auto-resume that runs at startup), since a relaunch always gets a fresh id.
    ///
    /// <para>Both links move: the fork one, and the one a row was put under by hand. They are separate
    /// facts (see <see cref="SetParent"/>) but a reopen invalidates an id, which is neither of them.</para>
    /// </summary>
    private void Reparent(string oldParentId, string newParentId)
    {
        var changed = false;
        foreach (var s in _sessions.Values)
        {
            if (s.Id == newParentId) continue;
            if (s.ParentSessionId == oldParentId)
            {
                s.ParentSessionId = newParentId;
                changed = true;
            }
            if (s.NestedUnderId == oldParentId)
            {
                s.NestedUnderId = newParentId;
                changed = true;
            }
        }
        foreach (var (key, p) in _restorable)
        {
            if (p.ParentSessionId != oldParentId && p.NestedUnderId != oldParentId) continue;
            _restorable[key] = p with
            {
                ParentSessionId = p.ParentSessionId == oldParentId ? newParentId : p.ParentSessionId,
                NestedUnderId = p.NestedUnderId == oldParentId ? newParentId : p.NestedUnderId,
            };
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
                PtyStateStore.Forget(path, state);
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
            if (!PtyStateStore.HostAlive(state)) { PtyStateStore.Forget(path, state); continue; }
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
            ParentName: p.ParentName,
            NestedUnderId: p.NestedUnderId),
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
        session.StateChanged += s => { EndInterruptedTurn(s, lookAgain: true); RaiseChanged(); };
    }

    /// <summary>
    /// Relaunch every persisted session that was running at the previous exit
    /// (<see cref="PersistedSession.WasRunning"/>), resuming each conversation with
    /// <c>--resume &lt;id&gt;</c> (or <c>--continue</c>). Called once at startup unless
    /// <see cref="SessionManagerOptions.ResumeOnStart"/> is off, so a PC shutdown/boot, a redeploy or a
    /// daemon stop brings the working set back by itself instead of leaving manual "Reopen" entries.
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
            return !proc.HasExited && PtyStateStore.StartedAt(proc, p.ProcessStartTicks);
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
            // The same bookkeeping the live branch above does. It used to be unreachable here — a
            // Restorable entry was always a leftover from a previous run, with no hook state and no
            // launch preset in this process — but a stopped session is now one of these too, and it
            // has both. Without this each stop-then-remove leaves a record behind for the life of
            // the daemon, and a hook arriving late for the dead session recreates one nothing clears.
            _hooks.Forget(id);
            _launchedFrom.TryRemove(id, out _);
            SavePersisted();
            RaiseChanged();
            return true;
        }
        return false;
    }

    /// <summary>
    /// End a session's process but <b>keep the session</b>: it becomes the same Restorable entry a
    /// restart would have left behind, which is to say it stays in the list, in its project and its
    /// virtual folder, under its own name and colour, and can be reopened on the spot.
    /// </summary>
    /// <remarks>
    /// <para>This is what closing a session now means, and the difference from <see cref="Remove"/> is
    /// the whole point: stopping is about the process, not about the row. A session you have finished
    /// with for today is still the place that work happened, and it used to vanish from the folder it
    /// belonged to the moment you stopped it — recoverable only from the flat "recent" list, stripped
    /// of everything but its launch settings. Removing it is now a second, deliberate step, taken from
    /// the row itself once it is sitting there inactive.</para>
    /// <para>Nothing is remembered as a recent preset here — that belongs to <see cref="Remove"/>, when
    /// the row actually leaves the list. The entry keeps its id, so every membership keyed by it (pins,
    /// virtual folders, per-session UI state, postponed messages) and every link pointing at it (forks,
    /// hand-nested rows) still names the same session. Reopening is the point at which some of that is
    /// spent: <see cref="RestoreAsync"/> launches a new process under a new id, and only what is keyed
    /// by the <em>conversation</em> follows it there.</para>
    /// </remarks>
    /// <returns>The session as it now appears in the list, or null when there is no such live session.</returns>
    public SessionInfo? Stop(string id)
    {
        if (!_sessions.TryRemove(id, out var s)) return null;
        // Snapshot before stopping, and force WasRunning off: this session is not coming back by
        // itself on the next start. Auto-resume is for sessions that were running when the app went
        // down, and one you stopped by hand is the opposite of that.
        var persisted = s.ToPersisted() with { WasRunning = false, ClaudeSessionId = ConversationId(s) };
        // Publish the closed row FIRST, then take the process down — not the other way round. Stopping
        // blocks for as long as the host takes to go (up to two five-second graces), and for all of it
        // the session would otherwise be in neither collection: the hub recomputes the list every
        // second, so the row would blink out of its folder, browsers would move their selection off
        // it, a Remove or a Reopen landing in the window would 404, and a save triggered by any other
        // session would write this one out of sessions.json altogether.
        _restorable[id] = persisted;
        SavePersisted();
        RaiseChanged();
        s.Stop();
        s.Dispose();
        _hooks.Forget(id);
        // A queue being worked through stops with the session: a reopen is a new session, with a pool
        // of its own, and nothing should be left switched on for it to find.
        PostponedStore.SetAutoSend(s.WorkingDirectory, id, false);
        // _launchedFrom is deliberately left alone: the preset this session was launched from is still
        // what it should be remembered as when the row is finally closed. See RememberAsRecent.
        _log.LogInformation("Stopped session {Id} ('{Name}'); it stays in the list as a closed session.", id, s.Name);
        return ClaudeSession.RestorableInfo(persisted) with
        {
            Pinned = IsPinned(persisted.ClaudeSessionId, persisted.Id),
            ActivityPaused = IsActivityPaused(persisted.ClaudeSessionId, persisted.Id),
            UiRev = UiRev(persisted.ClaudeSessionId, persisted.Id),
            GroupId = GroupIdOf(persisted.ClaudeSessionId, persisted.Id),
        };
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
    private void RememberAsRecent(PersistedSession p)
    {
        // Same lookup as the live overload above: an entry that was stopped rather than closed is
        // still this run's session, and the preset it launched from is still on file under its id —
        // without which closing it afterwards would add a second, near-identical recent entry.
        _launchedFrom.TryGetValue(p.Id, out var launchedFrom);
        RememberAsRecent(new RecentSession(
            p.WorkingDirectory,
            PresetName(p.Name, p.WorkingDirectory),
            p.InitialPrompt ?? "",
            p.Model ?? "",
            p.RemoteControl,
            p.PermissionMode ?? "",
            p.ClaudeSessionId), launchedFrom);
    }

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

    // Set when the state file is there but couldn't be read, which makes SavePersisted stand down for
    // the rest of the run — see LoadPersisted.
    private bool _stateUnreadable;

    private void LoadPersisted()
    {
        try
        {
            if (!File.Exists(_stateFile)) return;
            var saved = JsonSerializer.Deserialize<List<PersistedSession>>(File.ReadAllText(_stateFile));
            if (saved is null) return;
            // Inside the try, not after it: a null entry or one with no id throws here, and that is a
            // statement about the file — it belongs in the repair below rather than out of the
            // constructor, where it would stop the app from starting at all.
            foreach (var p in saved)
                if (p is not null && !string.IsNullOrWhiteSpace(p.Id)) _restorable[p.Id] = p;
            if (!_restorable.IsEmpty)
                _log.LogInformation("Loaded {Count} restorable session(s) from a previous run", _restorable.Count);
        }
        // A failed read leaves _restorable empty, and the first save of the run would then write that
        // emptiness back: every session from the previous run gone from the file, and with it the name,
        // colour, fork links and conversation id that make a live pty host identifiable at all. The
        // sessions themselves keep running — adoption just can't name them any more, so they surface as
        // orphans. Which repair that calls for turns on why the read failed — see StateFile.
        catch (Exception ex) when (StateFile.IsAccessFailure(ex))
        {
            // Couldn't get at the file — locked, or permissions. What is in it is presumably good, so
            // it stays untouched and nothing is written over it this run. That costs this run's
            // sessions their entry (they come back as orphans after the next restart, recoverable from
            // the orphan list); overwriting would cost every session from every previous run outright.
            _log.LogWarning(ex, "Could not read persisted sessions from {File}; it will not be written this run", _stateFile);
            _restorable.Clear();
            _stateUnreadable = true;
        }
        catch (Exception ex)
        {
            // Could not make sense of it — truncated by a shutdown mid-write, or edited by hand into
            // something that won't load. The names, fork links and conversation ids in it are worth a
            // manual rescue, so it is kept beside the new one; if it can't even be moved, then it must
            // not be written over either.
            _log.LogWarning(ex, "Could not load persisted sessions from {File}; setting it aside", _stateFile);
            _restorable.Clear();
            _stateUnreadable = !StateFile.SetAside(_stateFile, _log, "sessions");
        }
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
    public void BeginShutdown()
    {
        _shuttingDown = true;
        if (!_stopping.IsCancellationRequested) _stopping.Cancel();
    }

    private void SavePersisted()
    {
        if (_shuttingDown) return;
        if (_stateUnreadable)
        {
            // Debug, not a warning: LoadPersisted already said this once, loudly, and this runs on
            // every rename, colour change and exit.
            _log.LogDebug("Not writing sessions: {File} could not be read at startup", _stateFile);
            return;
        }
        lock (_saveLock)
        {
            try
            {
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
                // Written on every metadata change and on the way out of a Windows shutdown, which is
                // exactly when a truncate-then-fill write gets interrupted — and a half-written
                // sessions.json is how a machine comes back with every session orphaned. Hence the
                // swap-it-in write; see StateFile.
                StateFile.Write(_stateFile, JsonSerializer.Serialize(list, new JsonSerializerOptions { WriteIndented = true }));
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
