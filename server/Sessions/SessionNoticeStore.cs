namespace Hangar.Server.Sessions;

/// <summary>A message a session asked to have put in front of you: see <see cref="SessionNoticeStore"/>.</summary>
/// <param name="Title">What the session called it; null to go by the session's name alone.</param>
/// <param name="At">Unix ms.</param>
public sealed record SessionNotice(string Id, string SessionId, string? Title, string Message, long At);

/// <summary>
/// Messages a session sends you on purpose through <c>POST /api/self/notify</c>: Claude saying "the
/// benchmark finished, accuracy held" instead of you finding a quiet session and reading back to see
/// why. Each one is a notification on every device — a Web Push from <see cref="Push.PushNotifier"/>,
/// an OS notification from every open tab.
///
/// <para>Held in memory for a few minutes and no longer: they ride the hub snapshot, which is how an
/// open tab and a peer's push notifier hear of them, and each of those keeps track of the ids it has
/// already shown. A notice nobody was around to see in that window has still gone to the phone; it is
/// not news by the time anyone reconnects.</para>
/// </summary>
public sealed class SessionNoticeStore
{
    private static readonly TimeSpan Keep = TimeSpan.FromMinutes(10);
    private const int MaxKept = 20;

    // Per session: a loop that notifies on every iteration would otherwise buzz the phone until
    // someone noticed. Generous for anything a person asked for, and a 429 tells Claude why. And across
    // all of them, so a runaway that spreads over several sessions is held too.
    private const int MaxPerWindow = 6;
    private const int MaxAllPerWindow = 20;
    private static readonly TimeSpan Window = TimeSpan.FromMinutes(1);

    public const int MaxTitle = 120;
    public const int MaxMessage = 1000;

    private readonly object _lock = new();
    private readonly List<SessionNotice> _notices = [];
    // Who sent when over the last minute, for the limits. Kept apart from _notices, whose cap would
    // otherwise forget a busy session's sends and let it past its limit.
    private readonly List<(string SessionId, long At)> _sent = [];

    /// <summary>Raised after a notice is added, so the hub and the push notifier send it now rather than on their next tick.</summary>
    public event Action? Changed;

    /// <summary>Add one, or null when the session has sent too many in the last minute.</summary>
    public SessionNotice? Add(string sessionId, string? title, string message)
    {
        var now = DateTimeOffset.UtcNow;
        var notice = new SessionNotice(Guid.NewGuid().ToString("N")[..12], sessionId,
            Clip(title?.ReplaceLineEndings(" "), MaxTitle), Clip(message, MaxMessage)!, now.ToUnixTimeMilliseconds());
        lock (_lock)
        {
            Prune(now);
            var since = (now - Window).ToUnixTimeMilliseconds();
            _sent.RemoveAll(s => s.At < since);
            if (_sent.Count >= MaxAllPerWindow || _sent.Count(s => s.SessionId == sessionId) >= MaxPerWindow) return null;
            _sent.Add((sessionId, notice.At));
            _notices.Add(notice);
            if (_notices.Count > MaxKept) _notices.RemoveAt(0);
        }
        Changed?.Invoke();
        return notice;
    }

    /// <summary>The notices of the last few minutes, oldest first.</summary>
    public IReadOnlyList<SessionNotice> Recent()
    {
        lock (_lock)
        {
            Prune(DateTimeOffset.UtcNow);
            return _notices.ToArray();
        }
    }

    private void Prune(DateTimeOffset now)
    {
        var cutoff = (now - Keep).ToUnixTimeMilliseconds();
        _notices.RemoveAll(n => n.At < cutoff);
    }

    // Trimmed and cut to length. Blank comes back as null.
    private static string? Clip(string? value, int max)
    {
        var v = value?.Trim();
        if (string.IsNullOrEmpty(v)) return null;
        return v.Length > max ? v[..max] : v;
    }
}
