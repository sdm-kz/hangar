namespace Hangar.Server.Sessions;

/// <summary>
/// Sessions whose activity the user has paused, persisted to %LocalAppData%\Hangar\activity-paused.json.
/// A paused session still shows what it is doing on its own row, but stays out of everything that
/// sums sessions up: the marks and fractions on the headings above it and on the session it is nested
/// under, the Sessions tab's count, the favicon, and the tray's Activity menu. It is for a session that
/// works on a clock — one that checks a chat every few minutes — whose every run would otherwise read
/// as news. Keyed by conversation like a pin, so it survives the reopen a schedule does.
/// </summary>
public sealed class ActivityPauseStore(ILogger<ActivityPauseStore> log)
    : ConversationFlagStore(log, "activity-paused.json", "sessions", "sessions with paused activity");
