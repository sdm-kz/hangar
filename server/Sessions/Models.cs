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
    bool Continue = false);

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
    DateTimeOffset CreatedAt);

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
    string WatchdogStatus = "healthy");
