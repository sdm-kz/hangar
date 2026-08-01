namespace ClaudeWeb.Server.Sessions;

/// <summary>Lifecycle state of a launched Claude session.</summary>
public enum SessionState
{
    Running,
    Exited,
    Failed,
    /// <summary>
    /// Persisted from a previous app run: the process is gone (a ConPTY child can't outlive the
    /// host), but its launch metadata is remembered so it can be reopened with <c>--continue</c>.
    /// </summary>
    Restorable
}

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
    /// <summary>Whether the hang watchdog may auto-continue this session. Off by default.</summary>
    bool WatchdogEnabled = false);

/// <summary>
/// On-disk record of a launched session, used to re-attach to still-running Remote Control
/// processes after the app (tray/service) restarts. <see cref="ProcessStartTicks"/> pins the
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
    /// app exited. Used by <c>--resume-sessions</c> to auto-relaunch (with <c>--continue</c>) only the
    /// sessions that were actually running, not stale Restorable leftovers. Legacy state files without
    /// this key load as false. See <see cref="SessionManager.ResumePersisted"/>.
    /// </summary>
    bool WasRunning = false);

/// <summary>Serializable snapshot of a session, sent to the browser.</summary>
public sealed record SessionInfo(
    string Id,
    string Name,
    string WorkingDirectory,
    bool RemoteControl,
    string? Model,
    /// <summary>Permission mode the session launched with (default | auto | acceptEdits | bypassPermissions).</summary>
    string? PermissionMode,
    SessionState State,
    int ProcessId,
    DateTimeOffset CreatedAt,
    /// <summary>claude.ai deep link to this session, sniffed from its terminal; null until printed.</summary>
    string? RemoteUrl = null,
    /// <summary>Whether the hang watchdog may auto-continue this session.</summary>
    bool WatchdogEnabled = true,
    /// <summary>Watchdog view of the session: "healthy" | "recovering" | "attention".</summary>
    string WatchdogStatus = "healthy",
    /// <summary>Session color (a color name set via <c>/color</c>), shown in the sessions list. Null = none.</summary>
    string? Color = null,
    /// <summary>
    /// For a Restorable entry: whether reopening can resume the EXACT conversation (<c>--resume &lt;id&gt;</c>,
    /// because we captured Claude's session id) versus falling back to the folder's most recent
    /// (<c>--continue</c>). Lets the reopen dialog say which it'll do. Always false for live sessions.
    /// </summary>
    bool ResumeExact = false,
    /// <summary>How many "postponed" messages are stashed for this session (0 = none).</summary>
    int PostponedCount = 0,
    /// <summary>
    /// For a Restorable entry: Claude's own session id for its conversation, when we captured one — the
    /// id behind <see cref="ResumeExact"/>. Lets the client relaunch the entry through the New Session
    /// dialog (adjusting the model/prompt first) and still resume that exact conversation. Null for live
    /// sessions, which are opened rather than relaunched.
    /// </summary>
    string? ClaudeSessionId = null);
