using System.Net;
using System.Text.Json;
using ClaudeWeb.Server.Sessions;
using WebPush;

namespace ClaudeWeb.Server.Push;

/// <summary>
/// Sends a Web Push notification when a session newly needs attention or newly starts waiting on a
/// prompt — the same two transitions the in-page UI surfaces (<c>web/src/App.tsx</c>), but detected
/// server-side so the alert still fires when every tab is closed (the whole point of push).
///
/// It mirrors how <see cref="SessionHub"/> stays current: recompute on a slow tick (to catch
/// poll-only transitions like the watchdog flipping to "attention") and immediately on any explicit
/// <see cref="SessionManager.Changed"/> / hook change. Transitions are diffed against the previous
/// snapshot, seeded on the first tick so a session already stuck/waiting at startup doesn't alert.
///
/// De-dup with the in-page notification is handled per-device in the service worker (it suppresses the
/// OS notification when an app window is focused) plus the shared notification <c>tag</c>; we do NOT
/// gate sending on "any client connected", since that would silence the phone whenever a desktop tab
/// happens to be open.
/// </summary>
public sealed class PushNotifier : BackgroundService
{
    // Match SessionHub's tick so we notice poll-only transitions about as fast as the UI does.
    private static readonly TimeSpan TickInterval = TimeSpan.FromMilliseconds(1000);

    private readonly SessionManager _mgr;
    private readonly HookEventStore _hooks;
    private readonly PushSubscriptionStore _subs;
    private readonly VapidKeyStore _vapid;
    private readonly ILogger<PushNotifier> _log;
    private readonly WebPushClient _client = new();
    private readonly SemaphoreSlim _wake = new(0, 1);

    private HashSet<string>? _prevAttention;
    private HashSet<string>? _prevWaiting;
    private HashSet<string>? _prevFailed;

    public PushNotifier(SessionManager mgr, HookEventStore hooks, PushSubscriptionStore subs,
        VapidKeyStore vapid, ILogger<PushNotifier> log)
    {
        _mgr = mgr;
        _hooks = hooks;
        _subs = subs;
        _vapid = vapid;
        _log = log;
        _mgr.Changed += Poke;
        _hooks.Changed += Poke;
    }

    private void Poke()
    {
        try { _wake.Release(); } catch (SemaphoreFullException) { /* already pending */ }
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await CheckAsync(); }
            catch (Exception ex) { _log.LogDebug(ex, "push transition check failed"); }

            try { await _wake.WaitAsync(TickInterval, ct); }
            catch (OperationCanceledException) { break; }
        }
    }

    private async Task CheckAsync()
    {
        var sessions = _mgr.List();
        var attention = sessions.Where(s => s.WatchdogStatus == "attention").Select(s => s.Id).ToHashSet();
        var waiting = _mgr.AwaitingInputIds().ToHashSet();
        var failed = _mgr.FailedSessionIds().ToHashSet();
        // What the waiting/failed sets are about, where the hooks said: a permission dialog names the
        // command it wants to run, and a failed turn names the error it died on. On a phone that detail
        // is most of the value — "Wants to run Bash: git push --force" is a decision you can take from
        // the lock screen; "Waiting on a prompt." only tells you to go and look.
        var details = _mgr.ActivityDetails();

        var prevAttention = _prevAttention;
        var prevWaiting = _prevWaiting;
        var prevFailed = _prevFailed;
        _prevAttention = attention;
        _prevWaiting = waiting;
        _prevFailed = failed;
        if (prevAttention is null || prevWaiting is null || prevFailed is null) return; // first tick: seed only

        // No subscriptions => nothing to send; still keep the snapshots current above so the first
        // transition after a subscribe doesn't retroactively fire for a pre-existing state.
        if (_subs.All().Count == 0) return;

        foreach (var s in sessions)
        {
            if (attention.Contains(s.Id) && !prevAttention.Contains(s.Id))
                await SendToAllAsync(
                    $"{s.Name} — needs attention",
                    "Claude stopped recovering after repeated API errors.",
                    $"watchdog-{s.Id}", s.Id);

            if (waiting.Contains(s.Id) && !prevWaiting.Contains(s.Id))
                await SendToAllAsync(
                    $"{s.Name} — Claude needs your input",
                    details.GetValueOrDefault(s.Id)?.WaitingOn ?? "Waiting on a prompt.",
                    $"waiting-{s.Id}", s.Id);

            // A turn that died on a rate limit stops exactly like one that finished, so nothing else
            // here would ever fire for it — and it is the case where knowing early matters most, since
            // the session sits there doing nothing until someone comes back and retries it.
            //
            // Unless the watchdog has the session, in which case it is about to try the error again
            // and this alert would be telling you about a problem that is already being handled. That
            // one has its own alert for when it gives up, which is the point at which you are needed.
            if (failed.Contains(s.Id) && !prevFailed.Contains(s.Id) && !s.WatchdogEnabled)
                await SendToAllAsync(
                    $"{s.Name} — Claude stopped early",
                    FailureLine(details.GetValueOrDefault(s.Id)),
                    $"failed-{s.Id}", s.Id);
        }
    }

    /// <summary>
    /// One line for why a turn ended badly: Claude's own parting message when it left one, and failing
    /// that the hook's error name spelled out — <c>rate_limit</c> is a phrase, not a sentence.
    /// </summary>
    private static string FailureLine(SessionActivityDetail? detail) =>
        detail?.FailureMessage
        ?? detail?.Failure switch
        {
            "rate_limit" => "Hit the rate limit — the turn didn’t finish.",
            null => "The turn ended on an error.",
            var other => $"The turn ended on an error ({other}).",
        };

    private async Task SendToAllAsync(string title, string body, string tag, string sessionId)
    {
        var payload = JsonSerializer.Serialize(new { title, body, tag, sessionId });
        var vapid = new VapidDetails(_vapid.Keys.Subject, _vapid.Keys.PublicKey, _vapid.Keys.PrivateKey);

        foreach (var entry in _subs.All())
        {
            var sub = new PushSubscription(entry.Endpoint, entry.P256dh, entry.Auth);
            try
            {
                await _client.SendNotificationAsync(sub, payload, vapid);
            }
            catch (WebPushException ex) when (
                ex.StatusCode == HttpStatusCode.Gone || ex.StatusCode == HttpStatusCode.NotFound)
            {
                // The push service says this subscription is dead (unsubscribed / app removed) — drop it.
                _subs.Remove(entry.Endpoint);
                _log.LogInformation("Pruned dead push subscription ({Status})", (int)ex.StatusCode);
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "Failed to deliver push notification");
            }
        }
    }

    public override void Dispose()
    {
        _mgr.Changed -= Poke;
        _hooks.Changed -= Poke;
        _client.Dispose();
        base.Dispose();
    }
}
