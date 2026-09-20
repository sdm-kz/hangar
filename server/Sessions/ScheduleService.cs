using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using ClaudeWeb.Server.FileSystem;
using Microsoft.Win32;

namespace ClaudeWeb.Server.Sessions;

public sealed class ScheduleOptions
{
    /// <summary>Master switch. Off means no schedule ever fires, whatever the store says.</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>
    /// The most runs that may be in flight across every schedule at once. Without a cap, one
    /// misconfigured every-minute schedule launches processes until the machine stops responding.
    /// </summary>
    public int MaxConcurrentRuns { get; set; } = 4;

    /// <summary>
    /// How long a launched session must have been idle before <c>StopWhenDone</c> stops it. Long
    /// enough that a pause between two tool calls isn't mistaken for the end of the turn.
    /// </summary>
    public int DoneAfterIdleSeconds { get; set; } = 20;

    /// <summary>How long to wait for a restored session's terminal before giving up on poking it.</summary>
    public int RestoreWaitSeconds { get; set; } = 45;
}

/// <summary>
/// The clock. Fires schedules (<see cref="ScheduleStore"/>) by launching sessions or poking live
/// ones, and watches what it launched so a finished run gets stopped and an old one gets cleared
/// out of the sessions list.
///
/// <para>Shaped like <see cref="Update.UpdateService"/>: one loop, woken either by its own next-due
/// moment or by a <see cref="SemaphoreSlim"/> that any edit releases. It does <em>not</em> poll once
/// a second — a schedule due in nine hours should cost nine hours of sleeping, not 32,000 wake-ups.</para>
///
/// <para><b>Two rules that are easy to get wrong and expensive to debug.</b> First, everything is
/// re-evaluated against the wall clock on every pass; nothing is ever a <c>Task.Delay</c> until a
/// fire time, because a laptop that sleeps through 09:00 wakes with that delay still pending and
/// fires at noon. Second, a fire is recorded <em>before</em> the launch it triggers, so a crash
/// between the two loses a run rather than repeating one on the next start.</para>
/// </summary>
public sealed class ScheduleService : BackgroundService
{
    /// <summary>Longest the loop will sleep with nothing due — a heartbeat, so a missed wake-up self-heals.</summary>
    private static readonly TimeSpan MaxSleep = TimeSpan.FromMinutes(5);

    /// <summary>Shortest, so a burst of edits coalesces instead of spinning the loop.</summary>
    private static readonly TimeSpan MinSleep = TimeSpan.FromSeconds(1);

    /// <summary>
    /// How late a due slot may be and still count as an ordinary fire rather than one the machine was
    /// off for. Generous enough to cover a slow sweep and a loop that woke a beat late; far short of
    /// the minutes a sleep or a shutdown costs.
    /// </summary>
    private static readonly TimeSpan MissedAfter = TimeSpan.FromMinutes(2);

    /// <summary>Bound on the walk over missed slots, so a per-minute cron can't spin there.</summary>
    private const int MaxCatchUpSteps = 10_000;

    private readonly ScheduleOptions _options;
    private readonly ScheduleStore _store;
    private readonly TemplateStore _templates;
    private readonly SessionManager _sessions;
    private readonly HookEventStore _hooks;
    private readonly SessionManagerOptions _sessionOptions;
    private readonly ILogger<ScheduleService> _log;

    private readonly SemaphoreSlim _wake = new(0, 1);

    /// <summary>
    /// What each schedule currently has in flight, keyed by schedule id. Its presence is what
    /// <see cref="OverlapPolicy"/> is decided against, and what the done/timeout sweep walks.
    /// </summary>
    private sealed class Run
    {
        public required string ScheduleId { get; init; }
        public required DateTimeOffset StartedAt { get; init; }

        /// <summary>The session this run is, once there is one. Null for a headless run, which has none.</summary>
        public string? SessionId;

        /// <summary>
        /// True while a background task owns this run and will clear it itself — a headless process,
        /// or a poke that is reopening a session. The sweep leaves those alone: it decides a run is
        /// over by looking at a session, and these either have none or do not have one yet.
        /// </summary>
        public bool SelfManaged;

        public bool SawBusy;
        public DateTimeOffset? IdleSince;
    }

    private readonly ConcurrentDictionary<string, Run> _running = new();

    /// <summary>Schedule ids whose fire was held by <see cref="OverlapPolicy.Queue"/>. At most one each.</summary>
    private readonly ConcurrentDictionary<string, byte> _queued = new();

    /// <summary>
    /// Sessions this service launched, oldest first per schedule, so <c>KeepRuns</c> can drop the ones
    /// that have aged out. Rebuilt from nothing on a restart — a run from a previous boot is left
    /// alone rather than reaped by a service that no longer knows what it was.
    /// </summary>
    private readonly ConcurrentDictionary<string, List<string>> _launched = new();

    /// <summary>
    /// When an interval-driven schedule's target last went idle. The trigger for
    /// <see cref="ScheduleMode.ReuseSession"/> is "N minutes after the turn ended", not a wall clock,
    /// which is what makes overlap impossible rather than merely handled.
    /// </summary>
    private readonly ConcurrentDictionary<string, DateTimeOffset> _idleSince = new();

    public ScheduleService(
        ScheduleOptions options,
        ScheduleStore store,
        TemplateStore templates,
        SessionManager sessions,
        HookEventStore hooks,
        SessionManagerOptions sessionOptions,
        ILogger<ScheduleService> log)
    {
        _options = options;
        _store = store;
        _templates = templates;
        _sessions = sessions;
        _hooks = hooks;
        _sessionOptions = sessionOptions;
        _log = log;
        _store.Changed += Poke;
    }

    /// <summary>Wake the loop now rather than at its next due moment. Coalesces — capacity is 1.</summary>
    public void Poke()
    {
        // ObjectDisposedException as well as the full-semaphore case: this is wired to the store's
        // Changed event, and a run finishing during shutdown raises it after Dispose has run.
        try { _wake.Release(); }
        catch (SemaphoreFullException) { }
        catch (ObjectDisposedException) { }
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        if (!_options.Enabled)
        {
            _log.LogInformation("Schedules are disabled (Schedules:Enabled=false); no schedule will fire");
            return;
        }

        // Nothing may fire until the session list means what it says. For the first moments of a run
        // every session from the previous one is sitting in the restorable set, looking dead, while
        // its pty host is alive and queued for adoption — and a ReuseSession schedule that fires into
        // that gap relaunches a conversation that is already running, orphaning the original host.
        // That is exactly what happened: one duplicate claude per restart, and the app's own
        // "untracked sessions" warning right behind it.
        try { await _sessions.Settled.WaitAsync(ct); }
        catch (OperationCanceledException) { return; }
        _log.LogInformation("Sessions have settled; the schedule clock is running");

        // A machine waking from sleep, or a clock corrected by NTP, both move every due time this loop
        // computed. Neither produces any other signal, so the loop would sit on a stale sleep.
        //
        // Guarded on the platform the way Program.Main guards its own SessionEnding hook: this project
        // targets plain net10.0, so SystemEvents is Windows-only code in an assembly that isn't. The
        // loop still self-heals without these — MaxSleep caps how long it can stay wrong — they just
        // make it immediate.
        var systemEvents = OperatingSystem.IsWindows() ? SubscribeSystemEvents() : null;

        while (!ct.IsCancellationRequested)
        {
            DateTimeOffset nextDue;
            try { nextDue = await TickAsync(ct); }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (Exception ex)
            {
                // A schedule that throws must not take the loop down with it — every other schedule
                // on this machine would stop silently.
                _log.LogError(ex, "Schedule tick failed; carrying on");
                nextDue = DateTimeOffset.Now + MaxSleep;
            }

            var sleep = nextDue - DateTimeOffset.Now;
            if (sleep > MaxSleep) sleep = MaxSleep;
            if (sleep < MinSleep) sleep = MinSleep;
            try { await _wake.WaitAsync(sleep, ct); }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
        }

        systemEvents?.Dispose();
    }

    /// <summary>
    /// Fire a schedule now, on demand, without disturbing its clock — the way to find out whether it
    /// does what you meant before leaving it to run at 03:00. Returns null on success, or a sentence
    /// saying why not.
    /// </summary>
    public async Task<string?> RunNowAsync(string id, CancellationToken ct = default)
    {
        if (!_options.Enabled) return "Schedules are switched off on this server.";
        if (_store.Get(id) is not { } s) return "No such schedule.";
        if (Resolve(s) is null) return s.TemplateId is null ? "It has no template." : "Its template no longer exists.";

        // Deliberately ignores Enabled: running a paused schedule by hand is exactly how you test one
        // before letting it loose. Overlap and the concurrency cap still apply — those are about not
        // flooding the machine, which a manual run can do just as well as a timer.
        var outcome = await FireAsync(s, DateTimeOffset.Now, ct);
        Poke();
        // "" is success. Anything else is the reason nothing ran, and it has to reach the caller:
        // reporting a blocked or skipped fire as a successful test is exactly the wrong answer to
        // "does this schedule work?".
        return outcome.Length == 0 ? null : outcome;
    }

    /// <summary>
    /// Ask Windows to wake the loop on a resume or a clock change, and hand back the way to stop
    /// asking. A whole method rather than two lambdas because the platform attribute has to sit
    /// somewhere the handler bodies are inside of — a check around the subscription does not make the
    /// callbacks themselves Windows-only as far as the analyser is concerned.
    /// </summary>
    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    private IDisposable SubscribeSystemEvents()
    {
        PowerModeChangedEventHandler onPower = (_, e) => { if (e.Mode == PowerModes.Resume) Poke(); };
        EventHandler onTimeChanged = (_, _) => Poke();
        try { SystemEvents.PowerModeChanged += onPower; SystemEvents.TimeChanged += onTimeChanged; }
        catch (Exception ex) { _log.LogDebug(ex, "Could not subscribe to power/time events"); }

        return new Unsubscriber(() =>
        {
            try { SystemEvents.PowerModeChanged -= onPower; SystemEvents.TimeChanged -= onTimeChanged; }
            catch { /* shutting down; nothing to repair */ }
        });
    }

    private sealed class Unsubscriber(Action undo) : IDisposable
    {
        public void Dispose() => undo();
    }

    /// <summary>One pass: sweep what is running, fire what is due, and say when to come back.</summary>
    private async Task<DateTimeOffset> TickAsync(CancellationToken ct)
    {
        var now = DateTimeOffset.Now;
        await SweepRunsAsync(now, ct);

        var next = now + MaxSleep;
        foreach (var s in _store.List())
        {
            if (!s.Enabled) continue;

            if (s.IntervalMinutes is { } minutes)
            {
                // Interval schedules are driven by the target going idle, not by the clock, so their
                // due moment is only knowable from the hook state — see IntervalDueAt.
                if (IntervalDueAt(s, minutes, now) is { } due)
                {
                    if (due <= now) _ = await FireAsync(s, now, ct);
                    else if (due < next) next = due;
                }
                else if (now + TimeSpan.FromSeconds(5) < next)
                {
                    // Busy right now: re-check soon, since the turn can end at any moment and nothing
                    // else will wake us when it does.
                    next = now + TimeSpan.FromSeconds(5);
                }
                continue;
            }

            // A cron schedule's clock starts from the last fire, so a slot is never counted twice.
            var from = s.LastFiredAt ?? now.AddSeconds(-1);
            if (from > now) from = now;
            if (s.NextOccurrence(from) is not { } occurrence) continue;

            if (occurrence > now)
            {
                if (occurrence < next) next = occurrence;
                continue;
            }

            // Due — but how late decides whether it is an ordinary fire or one the machine was off
            // for, and the two are not the same event. Ordinary lateness is a second or two (the loop
            // woke, swept, and got here); anything beyond that is a slot nobody was around for, and
            // OnMissed is the user's answer to it. This is deliberately the ONLY place that decision
            // is made: it used to be made once at startup and then contradicted here on the very next
            // tick, which made OnMissed and GraceMinutes dead letters for any schedule that had ever
            // fired.
            var lateness = now - occurrence;
            if (lateness <= MissedAfter)
            {
                _ = await FireAsync(s, now, ct);
                continue;
            }

            // Coalesce: several slots may have passed, and a laptop opened after a week owes one run,
            // not one per slot. Walk to the most recent and judge the schedule against that.
            var latest = occurrence;
            for (var i = 0; i < MaxCatchUpSteps; i++)
            {
                if (s.NextOccurrence(latest) is not { } step || step > now) break;
                latest = step;
            }

            if (s.OnMissed == MissedPolicy.RunOnce && now - latest <= TimeSpan.FromMinutes(s.GraceMinutes))
            {
                _log.LogInformation("Schedule '{Name}' missed {Slot:g}; running it once now", s.Name, latest);
                _ = await FireAsync(s, now, ct);
                continue;
            }

            // Not running it — but the clock still has to move past the slots, or every tick from here
            // to the next occurrence rediscovers them and says so again.
            _log.LogInformation(
                "Schedule '{Name}' missed {Slot:g} ({Policy}, {Grace} min grace); skipping to the next slot",
                s.Name, latest, s.OnMissed, s.GraceMinutes);
            _store.RecordRun(s.Id, new ScheduleRun(now, null, "skipped",
                $"Missed {latest:g} — the machine was not running"));
        }

        // A held fire goes as soon as its schedule's slot is free.
        foreach (var id in _queued.Keys)
        {
            if (_running.ContainsKey(id)) continue;
            _queued.TryRemove(id, out _);
            if (_store.Get(id) is { Enabled: true } s) _ = await FireAsync(s, DateTimeOffset.Now, ct, queued: true);
        }

        return next;
    }

    /// <summary>
    /// When an interval schedule is next due: its target's turn ended, plus the interval. Null while
    /// the target is busy, waiting on a prompt, or gone — none of which are a moment to interrupt.
    /// </summary>
    private DateTimeOffset? IntervalDueAt(SessionSchedule s, int minutes, DateTimeOffset now)
    {
        if (s.TargetConversationId is null) return null;
        if (ResolveTarget(s.TargetConversationId) is not { } target) return null;

        // A Restorable target has no live turn to be between: it is due now, and firing restores it.
        // `now` is the tick's own clock and not a fresh reading, deliberately — the caller compares
        // `due <= now`, and a reading taken here is always a hair later than the one it is compared
        // against, so the schedule would read as "due in the future" forever and never fire.
        if (target.State != SessionState.Running) return now;

        if (_hooks.TryGetStatus(target.Id, out var status))
        {
            // Waiting on a permission prompt is the one state a paste must never land in — it would
            // answer a dialog nobody read. Hold, and let 5.4's postponed fallback take it if it lasts.
            if (status.Busy || status.Waiting)
            {
                _idleSince.TryRemove(s.Id, out _);
                return null;
            }
        }
        else if (_sessions.GetTerminal(target.Id) is { IsBusy: true })
        {
            // No hooks yet (a session launched before they were wired, or one that hasn't reported):
            // the terminal's own busy heuristic is what SessionManager falls back to as well.
            _idleSince.TryRemove(s.Id, out _);
            return null;
        }

        var idleSince = _idleSince.GetOrAdd(s.Id, _ => DateTimeOffset.Now);
        return idleSince.AddMinutes(minutes);
    }

    // ---- firing -----------------------------------------------------------------------------

    private async Task<string> FireAsync(SessionSchedule s, DateTimeOffset now, CancellationToken ct, bool queued = false)
    {
        if (s.MaxRuns is { } max && s.RunCount >= max)
        {
            _log.LogInformation("Schedule '{Name}' has reached its run limit ({Max}); disabling it", s.Name, max);
            _store.Update(s.Id, new SessionSchedulePatch(Enabled: false));
            return "It has reached its run limit.";
        }

        // Claim the slot FIRST, and atomically. Everything below is the fire; this is the one place
        // that decides whether this caller owns it. A ContainsKey-then-assign would let the tick loop
        // and an HTTP "Run now" both pass the check and both write, and the loser's session would
        // then be watched by nobody — never stopped when done, never abandoned when it overran.
        var run = new Run { ScheduleId = s.Id, StartedAt = DateTimeOffset.Now, SelfManaged = true };
        if (!_running.TryAdd(s.Id, run))
        {
            if (queued) return "The previous run is still going.";
            // Record it once per blocked episode, not once per tick. An interval schedule's due-ness
            // is not moved by a skip (it is read from the target's idle time, not from LastFiredAt),
            // so an unconditional record here fed Changed -> Poke -> re-tick -> record, spinning at
            // full speed: within a second the whole 20-entry history was "skipped", the real trace
            // was gone, and MaxRuns had tripped.
            if (MarkBlocked(s.Id))
            {
                if (s.Overlap == OverlapPolicy.Queue)
                {
                    _queued.TryAdd(s.Id, 0);
                    _store.RecordRun(s.Id, new ScheduleRun(now, null, "skipped", "Held until the previous run finishes"));
                }
                else
                {
                    _store.RecordRun(s.Id, new ScheduleRun(now, null, "skipped", "The previous run is still going"));
                }
            }
            else if (s.Overlap == OverlapPolicy.Queue)
            {
                _queued.TryAdd(s.Id, 0);
            }
            // Push the interval out too, so the next pass isn't instantly due again on the same
            // still-running turn.
            if (s.IntervalMinutes is not null) _idleSince[s.Id] = DateTimeOffset.Now;
            return "The previous run is still going.";
        }

        // Past the claim, every exit has to give it back. `handedOff` is set only once the fire is
        // genuinely someone else's to finish — the sweep's, or the background task's — so every other
        // way out of this block, including the blocked ones below and any throw, releases the slot.
        // Leaving it held would make a schedule with (say) a deleted template report "the previous
        // run is still going" for ever, and never recover.
        var handedOff = false;
        try
        {
            if (_running.Count > _options.MaxConcurrentRuns)
            {
                _store.RecordRun(s.Id, new ScheduleRun(now, null, "skipped",
                    $"{_options.MaxConcurrentRuns} runs already in flight"));
                if (s.IntervalMinutes is not null) _idleSince[s.Id] = DateTimeOffset.Now;
                return $"{_options.MaxConcurrentRuns} runs are already in flight.";
            }

            if (Resolve(s) is not { } resolved)
            {
                _store.RecordRun(s.Id, new ScheduleRun(now, null, "blocked",
                    s.TemplateId is null ? "No template" : "Its template no longer exists"));
                return s.TemplateId is null ? "It has no template." : "Its template no longer exists.";
            }
            var (template, prompt) = resolved;
            if (string.IsNullOrWhiteSpace(template.WorkingDirectory) || !Directory.Exists(template.WorkingDirectory))
            {
                _store.RecordRun(s.Id, new ScheduleRun(now, null, "blocked",
                    $"Folder not found: {template.WorkingDirectory}"));
                return $"Its folder does not exist: {template.WorkingDirectory}";
            }
            if (s.Mode == ScheduleMode.ReuseSession && s.TargetConversationId is null)
            {
                _store.RecordRun(s.Id, new ScheduleRun(now, null, "blocked", "No session to continue"));
                return "It has no session to continue.";
            }

            ClearBlocked(s.Id);
            // Re-arm the interval HERE, not when the send finally lands. Recording the fire raises
            // Changed -> Poke -> an immediate re-tick, and the poke itself runs on a background task:
            // for the milliseconds in between, the schedule was still due on the same idle time and
            // the re-tick recorded a bogus "the previous run is still going". Every fire came with a
            // matching junk skip, which is most of what the history held.
            if (s.IntervalMinutes is not null) _idleSince[s.Id] = DateTimeOffset.Now;
            var outcome = await DispatchAsync(s, template, prompt, now, run, ct);
            handedOff = true;
            return outcome;
        }
        finally
        {
            if (!handedOff) _running.TryRemove(s.Id, out _);
        }
    }

    /// <summary>
    /// Run the fire itself, the slot already claimed. Returns null on success, or a sentence for a
    /// caller that wants to say what happened (the "Run now" button).
    /// </summary>
    private async Task<string> DispatchAsync(
        SessionSchedule s, SessionTemplate template, string prompt, DateTimeOffset now, Run run, CancellationToken ct)
    {
        // Before the launch, not after: a crash in between must lose this run, never repeat it.
        _store.RecordRun(s.Id, new ScheduleRun(now, null, "ok", null));

        if (s.Mode == ScheduleMode.NewSession)
        {
            // Quick enough to do inline — a process start and a pipe handshake — and the sweep needs
            // the session id before it can watch anything.
            try
            {
                await LaunchAsync(s, template, prompt, now, run, ct);
                run.SelfManaged = false;
            }
            catch (Exception ex)
            {
                _log.LogError(ex, "Schedule '{Name}' failed to fire", s.Name);
                _store.RecordRun(s.Id, new ScheduleRun(now, null, "failed", ex.Message), replaceLast: true);
                _running.TryRemove(s.Id, out _);
                return ex.Message;
            }
            return "";
        }

        // A headless run lasts as long as the work does, and a poke can spend a minute reopening a
        // session first. Neither may be awaited here: the tick loop is the clock for every OTHER
        // schedule on this machine, and blocking it stops all of them.
        //
        // Started WITHOUT the token: a Task.Run whose token is already cancelled never runs its body,
        // so the finally below would never run either and the slot claimed above would be held for
        // the life of the process — that schedule permanently "overlapped", recording nothing but
        // skips. The body observes `ct` itself, which is where cancellation belongs.
        _ = Task.Run(async () =>
        {
            try
            {
                if (s.Mode == ScheduleMode.Headless) await RunHeadlessAsync(s, template, prompt, now, ct);
                else await PokeAsync(s, prompt, now, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { /* shutting down */ }
            catch (Exception ex)
            {
                _log.LogError(ex, "Schedule '{Name}' failed to fire", s.Name);
                _store.RecordRun(s.Id, new ScheduleRun(now, null, "failed", ex.Message), replaceLast: true);
            }
            finally
            {
                _running.TryRemove(s.Id, out _);
                Poke(); // a held fire (OverlapPolicy.Queue) can go now
            }
        });
        return "";
    }

    /// <summary>
    /// Whether this is the first fire of a blocked episode — an overlap that has not already been
    /// written to the history. Keeps a schedule that is blocked for an hour to one record of it
    /// rather than one per tick; <see cref="ClearBlocked"/> ends the episode.
    /// </summary>
    private readonly ConcurrentDictionary<string, byte> _blockedEpisode = new();

    private bool MarkBlocked(string id) => _blockedEpisode.TryAdd(id, 0);

    private void ClearBlocked(string id) => _blockedEpisode.TryRemove(id, out _);

    /// <summary>The template a schedule runs and the prompt for this fire, or null when it is blocked.</summary>
    private (SessionTemplate Template, string Prompt)? Resolve(SessionSchedule s)
    {
        if (s.TemplateId is null) return null;
        var template = _templates.List().FirstOrDefault(t => t.Id == s.TemplateId);
        if (template is null) return null;
        return (template, ApplyInput(template.Prompt, s.Input));
    }

    /// <summary>
    /// Fill a template's prompt for this run. Mirrors what the New Session dialog does with the box it
    /// shows under a picked template: <c>{input}</c> is replaced where it appears, and a prompt without
    /// the placeholder gets the detail appended as its own paragraph.
    /// </summary>
    public static string ApplyInput(string prompt, string? input)
    {
        prompt = (prompt ?? "").Trim();
        input = (input ?? "").Trim();
        if (input.Length == 0) return prompt.Replace("{input}", "").Trim();
        if (prompt.Contains("{input}", StringComparison.Ordinal)) return prompt.Replace("{input}", input);
        return prompt.Length == 0 ? input : $"{prompt}\n\n{input}";
    }

    private async Task LaunchAsync(
        SessionSchedule s, SessionTemplate t, string prompt, DateTimeOffset now, Run run, CancellationToken ct)
    {
        var info = await _sessions.CreateAsync(new CreateSessionRequest(
            WorkingDirectory: t.WorkingDirectory,
            Name: RunName(s, now),
            RemoteControl: t.RemoteControl,
            Model: string.IsNullOrWhiteSpace(t.Model) ? null : t.Model,
            InitialPrompt: prompt,
            PermissionMode: t.PermissionMode,
            WatchdogEnabled: t.WatchdogEnabled), ct: ct);

        run.SessionId = info.Id;
        var launched = _launched.GetOrAdd(s.Id, _ => new List<string>());
        lock (launched) launched.Add(info.Id);
        _sessions.MarkScheduled(info.Id, s.Id, ScheduleLabel(s));
        _store.RecordRun(s.Id, new ScheduleRun(now, info.Id, "ok", null), replaceLast: true);
        _log.LogInformation("Schedule '{Name}' launched session {Id}", s.Name, info.Id);
    }

    private async Task PokeAsync(SessionSchedule s, string prompt, DateTimeOffset now, CancellationToken ct)
    {
        if (s.TargetConversationId is null || ResolveTarget(s.TargetConversationId) is not { } target)
        {
            _store.RecordRun(s.Id, new ScheduleRun(now, null, "blocked",
                "Its session is gone — nothing left to continue"), replaceLast: true);
            return;
        }

        var id = target.Id;
        if (target.State != SessionState.Running)
        {
            // A reboot leaves the conversation as a Restorable row. Reopening it is the whole reason a
            // schedule survives one, so do that first — claude --resume deliberately refuses to carry a
            // prompt (ClaudeSession.cs), which is why this is two steps and not one.
            // Belt and braces behind the settle above: a host can also be un-adopted because adoption
            // could not reach it, and reopening then starts a second claude on the same conversation.
            // Cheap to ask, and the answer is never wrong in the dangerous direction.
            if (_sessions.ClosedSessionStillAlive(id))
            {
                _store.RecordRun(s.Id, new ScheduleRun(now, id, "skipped",
                    "Its session is closed but still running; not reopening it"), replaceLast: true);
                if (s.IntervalMinutes is not null) _idleSince[s.Id] = DateTimeOffset.Now;
                return;
            }

            var restored = await _sessions.RestoreAsync(id, ct);
            if (restored is null)
            {
                _store.RecordRun(s.Id, new ScheduleRun(now, id, "failed", "Could not reopen the session"), replaceLast: true);
                return;
            }
            id = restored.Id;
            if (!await WaitForTerminalAsync(id, ct))
            {
                _store.RecordRun(s.Id, new ScheduleRun(now, id, "failed",
                    "Reopened, but its terminal never came up"), replaceLast: true);
                return;
            }
        }

        // The gate that keeps a paste off a permission prompt. It lives HERE and not only in the
        // interval's due-ness test, because that test is not on every path into this method: "Run
        // now" comes straight in, and so does a cron-driven ReuseSession schedule. Answering a
        // permission dialog with a scheduled prompt is the one failure this whole feature must not
        // have. It is also what makes the stash below reachable at all.
        if (_hooks.TryGetStatus(id, out var status) && (status.Busy || status.Waiting))
        {
            var held = Postpone(id, prompt);
            _store.RecordRun(s.Id, new ScheduleRun(now, id, held ? "postponed" : "skipped",
                status.Waiting
                    ? "It is waiting on a prompt; the message was stashed rather than typed over it"
                    : "It was still working; the message was stashed"), replaceLast: true);
            if (s.IntervalMinutes is not null) _idleSince[s.Id] = DateTimeOffset.Now;
            return;
        }

        if (await _sessions.SendMessageAsync(id, prompt, ct))
        {
            // Re-arm from NOW, not from when it last went idle. Claude takes a moment to register the
            // paste and go busy, and in that window the session still reads as idle — left alone, the
            // next tick would see an idle-since older than the interval and fire again immediately.
            _idleSince[s.Id] = DateTimeOffset.Now;
            _sessions.MarkScheduled(id, s.Id, ScheduleLabel(s));
            _store.RecordRun(s.Id, new ScheduleRun(now, id, "ok", null), replaceLast: true);
            return;
        }

        // Undeliverable. The app's standing rule is that nothing sends itself into a terminal
        // (PostponedPool), so rather than drop the message it goes into the pool the session already
        // has — the badge then says a schedule has been blocked, instead of the silence saying nothing.
        var stashed = Postpone(id, prompt);
        _store.RecordRun(s.Id, new ScheduleRun(now, id, stashed ? "postponed" : "failed",
            stashed ? "Could not be delivered; stashed in the session's postponed messages"
                    : "Could not be delivered"), replaceLast: true);
    }

    private async Task RunHeadlessAsync(
        SessionSchedule s, SessionTemplate t, string prompt, DateTimeOffset now, CancellationToken ct)
    {
        var spec = ClaudeExecutableResolver.Resolve(_sessionOptions.ClaudeExecutable);
        var psi = new ProcessStartInfo
        {
            FileName = spec.FileName,
            WorkingDirectory = t.WorkingDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var a in spec.Prefix) psi.ArgumentList.Add(a);
        psi.ArgumentList.Add("-p");
        if (!string.IsNullOrWhiteSpace(t.Model))
        {
            psi.ArgumentList.Add("--model");
            psi.ArgumentList.Add(t.Model);
        }
        switch (t.PermissionMode)
        {
            case "auto":
            case "acceptEdits":
                psi.ArgumentList.Add("--permission-mode");
                psi.ArgumentList.Add(t.PermissionMode);
                break;
            case "bypassPermissions":
                psi.ArgumentList.Add("--dangerously-skip-permissions");
                break;
        }
        psi.ArgumentList.Add(prompt); // positional, last, as in ClaudeSession

        var started = Stopwatch.StartNew();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromMinutes(s.MaxRunMinutes));

        using var proc = Process.Start(psi)
            ?? throw new InvalidOperationException($"Could not start {spec.FileName}");
        // Both pipes are drained before the wait, not after: a process that fills one of them blocks
        // forever otherwise. They are started on the process's OWN lifetime rather than the timeout,
        // so the timeout path can still await them once the process has been killed — a read cancelled
        // out from under us would fault a task nobody is left to observe.
        var stdout = proc.StandardOutput.ReadToEndAsync();
        var stderr = proc.StandardError.ReadToEndAsync();
        try
        {
            try
            {
                await proc.WaitForExitAsync(timeout.Token);
            }
            catch (OperationCanceledException)
            {
                // Either it overran, or the app is going down. Both want the child dead — a headless
                // run is ours, and leaving one behind outlives the daemon that started it.
                TryKill(proc);
                await Drain(stdout, stderr);
                if (ct.IsCancellationRequested) throw;
                _store.RecordRun(s.Id, new ScheduleRun(now, null, "failed",
                    $"Gave up after {s.MaxRunMinutes} min", (int)started.Elapsed.TotalSeconds), replaceLast: true);
                return;
            }

            var output = (await stdout).Trim();
            var error = (await stderr).Trim();
            var ok = proc.ExitCode == 0;
            _store.RecordRun(s.Id, new ScheduleRun(
                now, null,
                ok ? "ok" : "failed",
                // The output IS the result of a headless run — there is no terminal it scrolled past in.
                Summarize(ok ? output : (error.Length > 0 ? error : output)),
                (int)started.Elapsed.TotalSeconds), replaceLast: true);
            _log.LogInformation("Schedule '{Name}' ran headless: exit {Code} in {Seconds}s",
                s.Name, proc.ExitCode, (int)started.Elapsed.TotalSeconds);
        }
        catch
        {
            TryKill(proc);
            await Drain(stdout, stderr);
            throw;
        }
    }

    /// <summary>
    /// Await two reads we no longer care about, swallowing whatever they end with. Their only purpose
    /// here is to be observed: a faulted <see cref="Task"/> nobody awaits surfaces later as an
    /// unobserved exception, from a stack that says nothing about where it came from.
    /// </summary>
    private static async Task Drain(params Task<string>[] reads)
    {
        foreach (var r in reads)
        {
            try { await r; } catch { /* the process is gone; the output was not the point any more */ }
        }
    }

    // ---- watching what was launched -----------------------------------------------------------

    /// <summary>
    /// Stop a run that has finished its turn, abandon one that has overrun, and trim the runs that
    /// have aged past <c>KeepRuns</c>. Without the first two, thirty daily runs is thirty open
    /// sessions and one wedged run stops its schedule for good.
    /// </summary>
    private async Task SweepRunsAsync(DateTimeOffset now, CancellationToken ct)
    {
        foreach (var run in _running.Values)
        {
            var s = _store.Get(run.ScheduleId);
            if (s is null) { _running.TryRemove(run.ScheduleId, out _); continue; }

            // A headless process, or a poke still reopening its session: its own task ends it. Deciding
            // here that it has finished — on the strength of a session id it does not have — would clear
            // the slot while the work is still going.
            if (run.SelfManaged || run.SessionId is null) continue;

            var info = _sessions.Get(run.SessionId);
            if (info is null || info.State != SessionState.Running)
            {
                // Ended on its own, which is the ordinary end of a run.
                _running.TryRemove(run.ScheduleId, out _);
                Trim(s);
                Poke();
                continue;
            }

            if (now - run.StartedAt > TimeSpan.FromMinutes(s.MaxRunMinutes))
            {
                _log.LogWarning("Schedule '{Name}': run {Id} passed {Max} min; letting go of it",
                    s.Name, run.SessionId, s.MaxRunMinutes);
                _running.TryRemove(run.ScheduleId, out _);
                _store.RecordRun(s.Id, new ScheduleRun(run.StartedAt, run.SessionId, "failed",
                    $"Still going after {s.MaxRunMinutes} min", (int)(now - run.StartedAt).TotalSeconds),
                    replaceLast: true);
                // Deliberately not killed: it may be most of the way through real work, and a schedule
                // giving up on watching it is not a reason to throw that away.
                continue;
            }

            if (!s.StopWhenDone) continue;

            var busy = _hooks.TryGetStatus(run.SessionId, out var status)
                ? status.Busy || status.Waiting
                : _sessions.GetTerminal(run.SessionId) is { IsBusy: true };
            if (busy)
            {
                run.SawBusy = true;
                run.IdleSince = null;
                continue;
            }
            // Only after it has actually started working: a session is idle for the second between
            // launching and Claude picking the prompt up, and stopping it there would kill every run.
            if (!run.SawBusy) continue;

            run.IdleSince ??= now;
            if (now - run.IdleSince < TimeSpan.FromSeconds(_options.DoneAfterIdleSeconds)) continue;

            _log.LogInformation("Schedule '{Name}': run {Id} finished; stopping it", s.Name, run.SessionId);
            _sessions.Stop(run.SessionId);
            _running.TryRemove(run.ScheduleId, out _);
            _store.RecordRun(s.Id, new ScheduleRun(run.StartedAt, run.SessionId, "ok", null,
                (int)(now - run.StartedAt).TotalSeconds), replaceLast: true);
            Trim(s);
        }
    }

    /// <summary>Drop this schedule's finished runs past <c>KeepRuns</c>, oldest first.</summary>
    private void Trim(SessionSchedule s)
    {
        if (!_launched.TryGetValue(s.Id, out var ids)) return;
        lock (ids)
        {
            // A row the user removed themselves is already gone; drop it from the ledger too.
            ids.RemoveAll(id => !_sessions.Exists(id));
            // Walk from the oldest, dropping only what has actually finished. A run still Running is
            // kept in the ledger and skipped: the sweep lets an over-long run go on purpose ("it may
            // be most of the way through real work"), which takes it out of _running — so a liveness
            // test against _running alone would have had this kill exactly the run the sweep spared.
            var keep = new List<string>();
            var over = ids.Count - s.KeepRuns;
            foreach (var id in ids)
            {
                if (over <= 0) { keep.Add(id); continue; }

                // Removed by hand already: drop it from the ledger, nothing to do.
                if (!_sessions.Exists(id)) { over--; continue; }

                // Still going: keep it, and keep counting it. Detaching a live session would leave
                // its pty host orphaned, and stopping it would kill work the sweep deliberately let
                // run on (see the over-MaxRunMinutes branch there). An old run that is somehow still
                // alive is not the one to reap.
                if (_sessions.Get(id)?.State == SessionState.Running) { keep.Add(id); continue; }

                // Finished, and past KeepRuns: it is a closed row, so this only forgets it.
                _sessions.Remove(id, stopProcess: false);
                over--;
            }
            ids.Clear();
            ids.AddRange(keep);
        }
    }

    // ---- helpers --------------------------------------------------------------------------------

    /// <summary>
    /// The session running a conversation, live or Restorable. Keyed by Claude's conversation id
    /// because ours changes every time a session is reopened.
    /// </summary>
    private SessionInfo? ResolveTarget(string conversationId) => _sessions.FindByConversation(conversationId);

    private async Task<bool> WaitForTerminalAsync(string id, CancellationToken ct)
    {
        var deadline = DateTimeOffset.Now.AddSeconds(_options.RestoreWaitSeconds);
        while (DateTimeOffset.Now < deadline && !ct.IsCancellationRequested)
        {
            if (_sessions.Get(id)?.State == SessionState.Running && _sessions.GetTerminal(id) is not null)
            {
                // Claude's own startup has to get as far as drawing an input box, and there is no event
                // for that — a short settle is the honest way to wait for it.
                await Task.Delay(TimeSpan.FromSeconds(3), ct);
                return true;
            }
            await Task.Delay(TimeSpan.FromSeconds(1), ct);
        }
        return false;
    }

    /// <summary>
    /// Stash an undeliverable message in the session's postponed pool, the same file the composer
    /// under the terminal reads (<see cref="PostponedStore.RelPathFor"/>). Best-effort: a pool that
    /// cannot be written is reported as a plain delivery failure.
    /// </summary>
    private bool Postpone(string sessionId, string text)
    {
        try
        {
            var dir = _sessions.FolderOf(sessionId);
            if (dir is null) return false;
            var rel = PostponedStore.RelPathFor(sessionId);

            var existing = SessionFileBrowser.ReadTextSafe(dir, rel);
            using var doc = System.Text.Json.JsonDocument.Parse(
                string.IsNullOrWhiteSpace(existing) ? "[]" : existing);
            if (doc.RootElement.ValueKind != System.Text.Json.JsonValueKind.Array) return false;

            var messages = doc.RootElement.EnumerateArray().Select(e => e.Clone()).ToList();
            var entry = System.Text.Json.JsonSerializer.SerializeToElement(new
            {
                id = Guid.NewGuid().ToString("n"),
                text,
                images = Array.Empty<object>(),
                createdAt = DateTimeOffset.Now.ToUnixTimeMilliseconds(),
            }, new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web));
            messages.Add(entry);

            var json = System.Text.Json.JsonSerializer.Serialize(messages,
                new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web));
            return SessionFileBrowser.WriteBytes(dir, rel, Encoding.UTF8.GetBytes(json)) is not null;
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not stash a scheduled message for session {Id}", sessionId);
            return false;
        }
    }

    private static void TryKill(Process p)
    {
        try { if (!p.HasExited) p.Kill(entireProcessTree: true); } catch { /* already gone */ }
    }

    /// <summary>The name a launched run wears, with the moment in it so a month of runs stays legible.</summary>
    private static string RunName(SessionSchedule s, DateTimeOffset now) =>
        $"{s.Name} · {now.ToLocalTime():dd MMM HH:mm}";

    /// <summary>The one-liner the sessions list puts in a scheduled row's tooltip.</summary>
    private static string ScheduleLabel(SessionSchedule s) =>
        s.IntervalMinutes is { } m ? $"every {m} min" : s.Cron;

    /// <summary>The tail of a headless run's output — the end is where the answer is.</summary>
    private static string? Summarize(string output)
    {
        output = output.Trim();
        if (output.Length == 0) return null;
        const int max = 400;
        return output.Length <= max ? output : "…" + output[^max..];
    }

    public override void Dispose()
    {
        _store.Changed -= Poke;
        _wake.Dispose();
        base.Dispose();
    }
}
