namespace Hangar.Server.Sessions;

// SessionState, SessionInfo and PtyOrphanInfo cross the wire to the tray as well as the browser, so they
// live in shared\Contract\Sessions.cs, compiled into both processes.

/// <summary>Request payload for launching a new session.</summary>
public sealed record CreateSessionRequest(
    string WorkingDirectory,
    string? Name = null,
    bool RemoteControl = true,
    string? Model = null,
    string? InitialPrompt = null,
    /// <summary>Permission mode: default | auto | acceptEdits | bypassPermissions (null = default).</summary>
    string? PermissionMode = null,
    /// <summary>Resume the folder's most recent conversation (<c>claude --continue</c>).</summary>
    bool Continue = false,
    /// <summary>
    /// Resume a specific Claude conversation by its session id (<c>claude --resume &lt;id&gt;</c>). Preferred
    /// over <see cref="Continue"/> when known, since a folder can hold several sessions. Null = not used.
    /// </summary>
    string? ResumeSessionId = null,
    /// <summary>Session color (a color name set via <c>/color</c>); carried across a restore. Null = none.</summary>
    string? Color = null,
    /// <summary>
    /// Branch the resumed conversation instead of continuing it (<c>--fork-session</c>): Claude replays
    /// <see cref="ResumeSessionId"/>'s history into a NEW conversation id, so the original is untouched
    /// and the two diverge from that point. Only meaningful together with a resume.
    /// </summary>
    bool ForkSession = false,
    /// <summary>
    /// Our id of the session this one was forked from, so the UI can nest it under its parent. Null for
    /// an ordinary session.
    /// </summary>
    string? ParentSessionId = null,
    /// <summary>
    /// The parent's display name at fork time. Kept alongside the id so a fork can still say where it
    /// came from after the parent is closed and forgotten.
    /// </summary>
    string? ParentName = null,
    /// <summary>
    /// The session this one was put under by hand, which is where the list draws it instead of under
    /// the fork parent above. See <see cref="SessionInfo.NestedUnderId"/>.
    /// </summary>
    string? NestedUnderId = null,
    /// <summary>
    /// The project to start in. Which project a session is in follows its folder, so this links a
    /// folder no project claims into it; a folder another project already has is refused rather than
    /// taken, since a link is a statement about every session that runs there. Null = wherever the
    /// folder already is.
    /// </summary>
    string? ProjectId = null,
    /// <summary>The virtual folder to file the session in: one of the groups of the project it ends up in.</summary>
    string? GroupId = null);

/// <summary>
/// On-disk record of a launched session, used to re-attach to still-running Remote Control
/// processes after the daemon restarts. <see cref="ProcessStartTicks"/> pins the
/// exact process so a reused PID isn't mistaken for the original session.
/// </summary>
public sealed record PersistedSession(
    string Id,
    string Name,
    string WorkingDirectory,
    bool RemoteControl,
    string? Model,
    string? InitialPrompt,
    string? PermissionMode,
    int ProcessId,
    long ProcessStartTicks,
    DateTimeOffset CreatedAt,
    /// <summary>Session color (a color name set via <c>/color</c>); null when never set.</summary>
    string? Color = null,
    /// <summary>
    /// Claude Code's own session id (captured from hook callbacks), so a reopen resumes the exact
    /// conversation with <c>--resume</c> rather than the folder's most-recent one. Null if never seen.
    /// </summary>
    string? ClaudeSessionId = null,
    /// <summary>
    /// Whether this session was live (running) at the most recent save — i.e. it was running when the
    /// app exited. Auto-resume (on by default) relaunches only these, not stale Restorable leftovers
    /// or sessions that had already exited. Legacy state files without this key load as false.
    /// See <see cref="SessionManager.ResumePersistedAsync"/>.
    /// </summary>
    bool WasRunning = false,
    /// <summary>Our id of the session this one was forked from (null when not a fork).</summary>
    string? ParentSessionId = null,
    /// <summary>The parent's display name at fork time, so the link survives the parent's removal.</summary>
    string? ParentName = null,
    /// <summary>The session this one was put under by hand; null leaves it under the fork link above.</summary>
    string? NestedUnderId = null);

/// <summary>
/// What one session's activity mark is about, where there is anything to say beyond the mark itself.
/// Rides the hub snapshot next to the id sets (busy / waiting / failed), not on <c>SessionInfo</c>:
/// what Claude is doing changes several times a minute and belongs with the rest of the fast-moving
/// state, while the session record is metadata that mostly doesn't move.
/// </summary>
public sealed record SessionActivityDetail(
    /// <summary>What a waiting session is blocked on ("Wants to run Bash: git push"). Null unless waiting.</summary>
    string? WaitingOn,
    /// <summary>Why a failed turn stopped, as the hook names it ("rate_limit"). Null unless it failed.</summary>
    string? Failure,
    /// <summary>The failed turn's parting message, where it had one.</summary>
    string? FailureMessage);
