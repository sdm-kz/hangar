// The session list as it crosses the wire. Compiled into both the daemon and the tray, like shared\Pty:
// the daemon serializes these and the tray deserializes the very same records, so the two can't drift.

namespace ClaudeWeb.Contract;

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

/// <summary>
/// A pty host still running for a session this app no longer knows about. Its <c>claude</c> is alive
/// and reachable, but nothing in <c>sessions.json</c> claims it — so the app can neither show it nor
/// adopt it, and it would otherwise sit there until the machine reboots.
/// </summary>
/// <remarks>
/// Two things produce one: <c>POST /api/sessions/{id}/detach</c>, which deliberately forgets a
/// session while leaving it running, and a state file whose session metadata was lost (an edited or
/// deleted <c>sessions.json</c>). Adoption at startup deliberately leaves these alone rather than
/// resurrecting a half-formed session or killing a working one; this is how they are surfaced instead.
/// </remarks>
public sealed record PtyOrphanInfo(
    string SessionId,
    int HostPid,
    int ChildPid,
    string WorkingDirectory,
    DateTimeOffset CreatedAt,
    /// <summary>How long the host has been running, so the UI can lead with the stale ones.</summary>
    double AgeHours);

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
    string? ClaudeSessionId = null,
    /// <summary>
    /// Whether this session's conversation id is known — i.e. it can be forked (<c>--fork-session</c>
    /// needs something to resume from). False for the first seconds of a fresh session, until Claude's
    /// first hook reports its id.
    /// </summary>
    bool CanFork = false,
    /// <summary>
    /// Our id of the session this one was forked from, so the sessions list can nest it under its
    /// parent. Null for an ordinary session.
    /// </summary>
    string? ParentSessionId = null,
    /// <summary>
    /// The parent's display name at fork time — shown in the fork's header even once the parent itself
    /// has been closed and forgotten (in which case there's nothing left to link to).
    /// </summary>
    string? ParentName = null,
    /// <summary>
    /// Whether the app re-attached to this session at startup instead of launching it — i.e. it
    /// survived a restart, process and conversation intact. Always false for a session this app
    /// started itself, and for a Restorable entry.
    /// </summary>
    bool Adopted = false,
    /// <summary>
    /// Whether the user has pinned this session to the top of its folder. Stamped on by the manager
    /// from <c>PinStore</c>, which keys pins by conversation id — so it rides the session list
    /// to every browser instead of each one keeping its own idea of what is pinned.
    /// </summary>
    bool Pinned = false,
    /// <summary>
    /// Revision of this session's saved UI state (see <c>SessionUiStore</c>), or 0 when it has
    /// none. Only the number rides the list: a browser holding an older revision knows to re-fetch the
    /// bag, which is how one browser's tab changes reach the others without the state itself being
    /// broadcast to everyone on every tick.
    /// </summary>
    int UiRev = 0,
    /// <summary>
    /// The virtual folder this session has been filed into (see <see cref="ProjectGroup"/>), or null.
    /// Stamped on by the manager from <c>ProjectStore</c>, which keys memberships by
    /// conversation id — so it survives a reopen and reaches every browser on the session list, like
    /// <see cref="Pinned"/>. It only takes effect inside the project that owns the group; whether it
    /// applies right now is <see cref="ProjectMembership.GroupFor"/>'s question, not this field's.
    /// </summary>
    string? GroupId = null);
