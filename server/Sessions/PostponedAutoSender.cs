namespace Hangar.Server.Sessions;

/// <summary>
/// Auto-send for the postponed pool: with it switched on for a session (the play button on the
/// Postponed bar, stored by <see cref="PostponedStore.SetAutoSend"/>), every time Claude finishes a
/// turn there the next stashed message goes in — a queue that works through itself while nobody is
/// watching. Off by default; the pool otherwise still only sends when someone presses Send.
///
/// <para>It lives here rather than in the browser so it keeps going with every tab closed, which is
/// the point of a queue. The browser only flips the flag and watches the pool shrink.</para>
///
/// <para><b>When a turn counts as finished.</b> The session has to be quiet
/// (<see cref="SessionManager.IsQuiet"/>: no busy, waiting, compacting or failed mark — the same
/// reading behind the sidebar's "finished" tick) and stay quiet for <see cref="Settle"/>, so the gap
/// between two tool calls is not mistaken for the end. After a send it must also have been seen to
/// react — go busy — before quiet means anything, because Claude takes a moment to pick a paste up
/// and in that moment the session still looks idle. A message that never makes it busy (a slash
/// command such as <c>/clear</c>) is let through after <see cref="NoReaction"/>.</para>
///
/// <para>A waiting session is held, never typed into: a paste there would answer a permission dialog
/// nobody read. A failed turn holds the queue too — the next message was written on the assumption
/// that this one worked — until someone picks the session back up.</para>
/// </summary>
public sealed class PostponedAutoSender : BackgroundService
{
    private static readonly TimeSpan Tick = TimeSpan.FromSeconds(1);

    /// <summary>How long a session must stay quiet before the next message goes in.</summary>
    private static readonly TimeSpan Settle = TimeSpan.FromSeconds(3);

    /// <summary>How long a sent message may go without making the session busy before the next one follows anyway.</summary>
    private static readonly TimeSpan NoReaction = TimeSpan.FromSeconds(30);

    /// <summary>Ids remembered per session as already sent — see <see cref="Track.Sent"/>.</summary>
    private const int SentMemory = 100;

    /// <summary>What the loop knows about one live session. Touched only by the loop, so unlocked.</summary>
    private sealed class Track
    {
        /// <summary>When the session last turned quiet, or null while it isn't.</summary>
        public DateTimeOffset? QuietSince;

        public DateTimeOffset? SentAt;

        /// <summary>Whether the session has been seen not-quiet since <see cref="SentAt"/>.</summary>
        public bool Reacted;

        /// <summary>
        /// Messages this loop has already sent. A browser that loaded the pool before a send can still
        /// save its stale copy back over the file, and the message would then come round again; one
        /// found in here is dropped instead of sent twice.
        /// </summary>
        public readonly List<string> Sent = new();
    }

    private readonly Dictionary<string, Track> _tracks = new();
    private readonly SessionManager _sessions;
    private readonly ILogger<PostponedAutoSender> _log;

    public PostponedAutoSender(SessionManager sessions, ILogger<PostponedAutoSender> log)
    {
        _sessions = sessions;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        // Until adoption has run, every session from the last run looks closed: nothing to act on yet.
        try { await _sessions.Settled.WaitAsync(ct); }
        catch (OperationCanceledException) { return; }

        while (!ct.IsCancellationRequested)
        {
            try { await TickAsync(ct); }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (Exception ex) { _log.LogWarning(ex, "Postponed auto-send pass failed"); }

            try { await Task.Delay(Tick, ct); }
            catch (OperationCanceledException) { break; }
        }
    }

    private async Task TickAsync(CancellationToken ct)
    {
        var live = _sessions.RunningSessions();
        // Forget sessions that have ended: a reopen starts its own track, with nothing stale in it.
        foreach (var gone in _tracks.Keys.Except(live.Select(l => l.Id)).ToArray()) _tracks.Remove(gone);

        foreach (var (id, dir) in live)
        {
            if (!_tracks.TryGetValue(id, out var t)) _tracks[id] = t = new Track();
            var now = DateTimeOffset.Now;

            // Tracked whether or not auto-send is on, so pressing play on a session that has been idle
            // all afternoon sends straight away rather than waiting out a settle it already served.
            if (!_sessions.IsQuiet(id))
            {
                t.QuietSince = null;
                t.Reacted = true;
                continue;
            }
            t.QuietSince ??= now;

            if (!PostponedStore.IsAutoSend(dir, id)) continue;
            if (now - t.QuietSince < Settle) continue;
            if (t.SentAt is { } sentAt && !t.Reacted && now - sentAt < NoReaction) continue;

            // Unreadable — most likely caught mid-write by a browser's save. Try again next tick; reading
            // it as empty would switch auto-send off with the queue still full.
            if (PostponedStore.Read(dir, id) is not { } pool) continue;
            var resent = pool.Where(m => t.Sent.Contains(m.Id)).Select(m => m.Id).ToList();
            var next = pool.FirstOrDefault(m => !t.Sent.Contains(m.Id));
            if (next is null)
            {
                // The queue has run dry and its last turn is over: the run is done. Left on, the next
                // thing stashed would be typed in the moment it landed, which is Send, not a queue.
                if (resent.Count > 0) PostponedStore.Remove(dir, id, resent);
                _sessions.SetPostponedAutoSend(id, false);
                _log.LogInformation("Postponed auto-send for session {Id} finished: the pool is empty", id);
                continue;
            }

            if (!await _sessions.SendMessageAsync(id, next.Text, next.ImagePaths, ct))
            {
                // The terminal went between the check and the write. Hold off as if it had been sent,
                // so a session on its way out is not retried every second.
                t.SentAt = now;
                t.Reacted = false;
                continue;
            }

            t.Sent.Add(next.Id);
            if (t.Sent.Count > SentMemory) t.Sent.RemoveAt(0);
            t.SentAt = now;
            t.Reacted = false;
            t.QuietSince = null;
            resent.Add(next.Id);
            if (!PostponedStore.Remove(dir, id, resent))
                _log.LogWarning("Sent a postponed message to session {Id} but could not take it out of the pool", id);
            _log.LogInformation("Auto-sent a postponed message to session {Id}", id);
        }
    }
}
