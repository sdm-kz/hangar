using System.Text.Json;
using Cronos;

namespace ClaudeWeb.Server.Sessions;

/// <summary>How a schedule's fire turns into work.</summary>
public enum ScheduleMode
{
    /// <summary>
    /// A one-shot <c>claude -p</c> with no pseudoconsole and no session row. The right shape for the
    /// frequent stateless check ("is the deploy green?"): nothing accumulates, it exits by itself,
    /// and its output is captured into the run history instead of scrolling past in a terminal.
    /// </summary>
    Headless,

    /// <summary>A full interactive session per fire, as if you had filled in the New Session dialog.</summary>
    NewSession,

    /// <summary>
    /// Send the prompt into a session that is already running, continuing one conversation. The only
    /// mode that keeps context between fires, and the only one that can drift: see the note on
    /// <see cref="SessionSchedule.IntervalMinutes"/>.
    /// </summary>
    ReuseSession,
}

/// <summary>What to do about a fire the machine was off (or asleep) for.</summary>
public enum MissedPolicy
{
    /// <summary>Nothing. The next ordinary occurrence is the next run.</summary>
    Skip,

    /// <summary>
    /// Run once on the next start, if the missed slot is less than <see cref="SessionSchedule.GraceMinutes"/>
    /// old. Several missed slots still produce one run, not one each — a laptop opened after a week
    /// should catch up, not stampede.
    /// </summary>
    RunOnce,
}

/// <summary>What to do when the previous run of a schedule hasn't finished.</summary>
public enum OverlapPolicy
{
    /// <summary>Drop this fire and record it as skipped. Right for a poll.</summary>
    Skip,

    /// <summary>Hold it until the running one finishes, then fire once. At most one is ever held.</summary>
    Queue,
}

/// <summary>One past fire, kept so a schedule that runs while you sleep still leaves a trace.</summary>
public sealed record ScheduleRun(
    DateTimeOffset At,
    /// <summary>Our id of the session it launched or poked; null for a headless run.</summary>
    string? SessionId,
    /// <summary>ok | blocked | failed | skipped | postponed.</summary>
    string Outcome,
    /// <summary>A sentence about the outcome — the error, or why it was skipped. Null when unremarkable.</summary>
    string? Detail,
    int? DurationSeconds = null);

/// <summary>
/// A <em>schedule</em>: a <see cref="SessionTemplate"/> plus a clock. The template already carries
/// everything a launch needs — folder, prompt, model, permission mode — so a schedule adds only when
/// to fire it, what to do if the moment was missed, and what to do with the result.
///
/// <para><see cref="TemplateId"/> is a soft reference, the same deal <see cref="SessionTemplate.ProjectId"/>
/// gets: a schedule whose template has been deleted is kept and reports itself blocked rather than
/// firing something half-formed. The cost of referencing rather than copying is worth naming: editing
/// a template changes what runs unattended at 03:00, with nothing on screen to say so.</para>
///
/// <para><see cref="TargetConversationId"/> is Claude's own conversation id, not one of ours, because
/// ours does not survive: a resumed session comes back under a new id (see
/// <see cref="SessionManager.ResumePersistedAsync"/>). The conversation id is the stable handle, and
/// the one <see cref="PinStore"/> and <see cref="SessionUiStore"/> already key on.</para>
/// </summary>
public sealed record SessionSchedule(
    string Id,
    string Name,
    bool Enabled,

    /// <summary>The template this runs. Null (or deleted) leaves the schedule blocked.</summary>
    string? TemplateId,
    /// <summary>What fills the template's <c>{input}</c> on every fire. Null when it has no placeholder.</summary>
    string? Input,
    ScheduleMode Mode,

    /// <summary>A 5-field cron expression, in <see cref="TimeZoneId"/>. Empty when driven by an interval.</summary>
    string Cron,
    /// <summary>
    /// The zone <see cref="Cron"/> is read in. Stored rather than assumed because this is edited from
    /// a phone, which may be somewhere else — and because "09:00" has to survive a DST change meaning
    /// the same wall-clock hour.
    /// </summary>
    string TimeZoneId,
    /// <summary>
    /// Set INSTEAD of <see cref="Cron"/>: fire this many minutes after the last turn <em>finished</em>,
    /// not on a wall clock. A different trigger rule, not different syntax — see
    /// <c>ScheduleService</c>. Only meaningful for <see cref="ScheduleMode.ReuseSession"/>.
    /// </summary>
    int? IntervalMinutes,

    MissedPolicy OnMissed,
    int GraceMinutes,
    OverlapPolicy Overlap,
    /// <summary>A run still going after this long is abandoned, so one wedged run can't stop the schedule forever.</summary>
    int MaxRunMinutes,
    /// <summary>Stop the schedule after this many successful runs. Null = no limit.</summary>
    int? MaxRuns,
    /// <summary>Stop a launched session once its turn has finished, instead of leaving it open.</summary>
    bool StopWhenDone,
    /// <summary>How many finished runs to leave in the sessions list; older ones are removed.</summary>
    int KeepRuns,

    /// <summary>The conversation <see cref="ScheduleMode.ReuseSession"/> pokes. Null in the other modes.</summary>
    string? TargetConversationId,

    DateTimeOffset? LastFiredAt,
    /// <summary>How many times this has fired in total — which is what <see cref="MaxRuns"/> counts.</summary>
    int RunCount,
    /// <summary>Most recent first, capped at <see cref="ScheduleStore.MaxHistory"/>.</summary>
    IReadOnlyList<ScheduleRun> History)
{
    /// <summary>
    /// When this should next fire, or null when it never will (disabled, out of runs, or driven by an
    /// interval — an interval's next fire is known only once the last turn ends, so it is the
    /// service's business rather than the record's).
    /// </summary>
    public DateTimeOffset? NextOccurrence(DateTimeOffset after)
    {
        if (!Enabled) return null;
        if (MaxRuns is { } max && RunCount >= max) return null;
        if (IntervalMinutes is not null) return null;
        if (ParseCron(Cron) is not { } expr) return null;
        return expr.GetNextOccurrence(after, ResolveZone(TimeZoneId));
    }

    /// <summary>The expression, or null when it doesn't parse — a blocked schedule, not a crash.</summary>
    public static CronExpression? ParseCron(string? cron)
    {
        if (string.IsNullOrWhiteSpace(cron)) return null;
        try { return CronExpression.Parse(cron.Trim()); }
        catch (CronFormatException) { return null; }
    }

    /// <summary>
    /// The zone by id, falling back to the machine's own. The fallback is not defensive padding: the
    /// server is built with <c>InvariantGlobalization</c>, so an IANA id ("Europe/Berlin") saved by a
    /// browser that reports one cannot be resolved on Windows, where the registry only knows
    /// ("W. Europe Standard Time"). Running an hour out beats not running.
    /// </summary>
    public static TimeZoneInfo ResolveZone(string? id)
    {
        if (string.IsNullOrWhiteSpace(id)) return TimeZoneInfo.Local;
        try { return TimeZoneInfo.FindSystemTimeZoneById(id); }
        catch (TimeZoneNotFoundException) { return TimeZoneInfo.Local; }
        catch (InvalidTimeZoneException) { return TimeZoneInfo.Local; }
    }
}

/// <summary>
/// The fields of a schedule, as a create or an update. On an update a null field means "leave that
/// one alone" — the same convention <see cref="SessionTemplatePatch"/> and <c>ProjectRequest</c> use.
/// </summary>
public sealed record SessionSchedulePatch(
    string? Name = null,
    bool? Enabled = null,
    string? TemplateId = null,
    string? Input = null,
    string? Mode = null,
    string? Cron = null,
    string? TimeZoneId = null,
    int? IntervalMinutes = null,
    string? OnMissed = null,
    int? GraceMinutes = null,
    string? Overlap = null,
    int? MaxRunMinutes = null,
    int? MaxRuns = null,
    bool? StopWhenDone = null,
    int? KeepRuns = null,
    string? TargetConversationId = null);

/// <summary>
/// Server-side store for schedules, persisted to <c>%LocalAppData%\ClaudeWeb\schedules.json</c> so
/// they follow the user across devices — like <see cref="TemplateStore"/> and <see cref="ProjectStore"/>,
/// and unlike anything kept per-browser.
///
/// Every mutation returns the full list, so a caller can replace its state from the response instead
/// of patching it and hoping the two agree.
/// </summary>
public sealed class ScheduleStore
{
    public const int MaxHistory = 20;

    private const int MaxSchedules = 200;
    private const int MaxNameLength = 80;
    private const int MaxShortLength = 64;
    private const int MaxInputLength = 8000;
    private const int MaxDetailLength = 500;

    private readonly string _file;
    private readonly ILogger<ScheduleStore> _log;
    private readonly object _lock = new();
    private List<SessionSchedule> _schedules = new();

    /// <summary>Raised on any change, so the service re-plans and the hub pushes the new list.</summary>
    public event Action? Changed;

    public ScheduleStore(ILogger<ScheduleStore> log)
    {
        _log = log;
        _file = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ClaudeWeb", "schedules.json");
        Load();
    }

    public IReadOnlyList<SessionSchedule> List()
    {
        lock (_lock) return Snapshot();
    }

    public SessionSchedule? Get(string id)
    {
        lock (_lock) return _schedules.FirstOrDefault(s => s.Id == id);
    }

    /// <summary>Create a schedule. Null when the name is blank or the store is at capacity.</summary>
    public IReadOnlyList<SessionSchedule>? Create(SessionSchedulePatch p)
    {
        var name = CleanName(p.Name);
        if (name is null) return null;

        lock (_lock)
        {
            if (_schedules.Count >= MaxSchedules) return null;
            _schedules.Add(new SessionSchedule(
                Guid.NewGuid().ToString("n"),
                name,
                p.Enabled ?? true,
                Blank(p.TemplateId) ? null : Clip(p.TemplateId!.Trim(), MaxShortLength),
                Blank(p.Input) ? null : Clip(p.Input!, MaxInputLength),
                ParseEnum(p.Mode, ScheduleMode.NewSession),
                Clip((p.Cron ?? "").Trim(), MaxShortLength),
                Blank(p.TimeZoneId) ? TimeZoneInfo.Local.Id : Clip(p.TimeZoneId!.Trim(), MaxShortLength),
                CleanInterval(p.IntervalMinutes),
                ParseEnum(p.OnMissed, MissedPolicy.RunOnce),
                Clamp(p.GraceMinutes ?? 120, 0, 7 * 24 * 60),
                ParseEnum(p.Overlap, OverlapPolicy.Skip),
                Clamp(p.MaxRunMinutes ?? 60, 1, 24 * 60),
                CleanMaxRuns(p.MaxRuns),
                p.StopWhenDone ?? true,
                Clamp(p.KeepRuns ?? 3, 0, 50),
                Blank(p.TargetConversationId) ? null : Clip(p.TargetConversationId!.Trim(), MaxShortLength),
                LastFiredAt: null,
                RunCount: 0,
                History: Array.Empty<ScheduleRun>()));
            return SaveAndSnapshot();
        }
    }

    /// <summary>Apply a patch. Null when the id is unknown or the patch would blank the name.</summary>
    public IReadOnlyList<SessionSchedule>? Update(string id, SessionSchedulePatch p)
    {
        lock (_lock)
        {
            var i = _schedules.FindIndex(s => s.Id == id);
            if (i < 0) return null;
            var s = _schedules[i];

            string? name = s.Name;
            if (p.Name is not null)
            {
                name = CleanName(p.Name);
                if (name is null) return null;
            }

            _schedules[i] = s with
            {
                Name = name,
                Enabled = p.Enabled ?? s.Enabled,
                TemplateId = p.TemplateId is null ? s.TemplateId
                    : Blank(p.TemplateId) ? null : Clip(p.TemplateId.Trim(), MaxShortLength),
                Input = p.Input is null ? s.Input
                    : Blank(p.Input) ? null : Clip(p.Input, MaxInputLength),
                Mode = p.Mode is null ? s.Mode : ParseEnum(p.Mode, s.Mode),
                Cron = p.Cron is null ? s.Cron : Clip(p.Cron.Trim(), MaxShortLength),
                TimeZoneId = Blank(p.TimeZoneId) ? s.TimeZoneId : Clip(p.TimeZoneId!.Trim(), MaxShortLength),
                IntervalMinutes = p.IntervalMinutes is null ? s.IntervalMinutes : CleanInterval(p.IntervalMinutes),
                OnMissed = p.OnMissed is null ? s.OnMissed : ParseEnum(p.OnMissed, s.OnMissed),
                GraceMinutes = p.GraceMinutes is null ? s.GraceMinutes : Clamp(p.GraceMinutes.Value, 0, 7 * 24 * 60),
                Overlap = p.Overlap is null ? s.Overlap : ParseEnum(p.Overlap, s.Overlap),
                MaxRunMinutes = p.MaxRunMinutes is null ? s.MaxRunMinutes : Clamp(p.MaxRunMinutes.Value, 1, 24 * 60),
                MaxRuns = p.MaxRuns is null ? s.MaxRuns : CleanMaxRuns(p.MaxRuns),
                StopWhenDone = p.StopWhenDone ?? s.StopWhenDone,
                KeepRuns = p.KeepRuns is null ? s.KeepRuns : Clamp(p.KeepRuns.Value, 0, 50),
                TargetConversationId = p.TargetConversationId is null ? s.TargetConversationId
                    : Blank(p.TargetConversationId) ? null : Clip(p.TargetConversationId.Trim(), MaxShortLength),
            };
            return SaveAndSnapshot();
        }
    }

    public IReadOnlyList<SessionSchedule>? Delete(string id)
    {
        lock (_lock)
        {
            if (_schedules.RemoveAll(s => s.Id == id) == 0) return null;
            return SaveAndSnapshot();
        }
    }

    /// <summary>
    /// Record a fire: stamp <c>LastFiredAt</c>, count it where it counts, and push the outcome onto
    /// the history. Called twice for a run that takes a while — once when it starts (so a crash
    /// mid-launch cannot double-fire on the next start) and once when it ends, which is what
    /// <paramref name="replaceLast"/> is for.
    /// </summary>
    public void RecordRun(string id, ScheduleRun run, bool replaceLast = false)
    {
        lock (_lock)
        {
            var i = _schedules.FindIndex(s => s.Id == id);
            if (i < 0) return;
            var s = _schedules[i];

            var history = s.History.ToList();
            // Replace the entry this run opened, found by its fire time rather than by position.
            // "The newest one" is not the same thing: a run that takes an hour can have a skip or a
            // held fire recorded above it in the meantime, and updating index 0 would then overwrite
            // that record with this run's result — losing the skip and leaving the history out of
            // order. Not finding it (aged past MaxHistory) means this run's slot is gone; a fresh
            // entry would jump the queue, so the result is dropped rather than misfiled.
            var at = replaceLast ? history.FindIndex(h => h.At == run.At) : -1;
            if (replaceLast && at < 0) return;
            if (at >= 0) history[at] = Clean(run);
            else history.Insert(0, Clean(run));
            if (history.Count > MaxHistory) history.RemoveRange(MaxHistory, history.Count - MaxHistory);

            _schedules[i] = s with
            {
                // The moment moves even for an outcome that never ran anything, and deliberately: it
                // is what stops the next tick offering the same cron slot again, a second later, for
                // as long as the schedule stays blocked.
                LastFiredAt = replaceLast ? s.LastFiredAt : run.At,
                // MaxRuns counts runs, though. A fire that was skipped or blocked did no work, and
                // counting it would let a schedule whose template was deleted quietly exhaust its
                // own limit and then report that it had finished.
                RunCount = replaceLast || !CountsAsRun(run.Outcome) ? s.RunCount : s.RunCount + 1,
                History = history,
            };
            Save();
        }
        Changed?.Invoke();
    }

    /// <summary>Whether an outcome means work was actually attempted — see <c>MaxRuns</c> above.</summary>
    private static bool CountsAsRun(string outcome) => outcome is not ("skipped" or "blocked");

    private static ScheduleRun Clean(ScheduleRun r) =>
        r with { Detail = r.Detail is null ? null : Clip(r.Detail, MaxDetailLength) };

    // ---- plumbing ---------------------------------------------------------------------------

    private IReadOnlyList<SessionSchedule> SaveAndSnapshot()
    {
        Save();
        var snapshot = Snapshot();
        // Outside the lock would be safer against a re-entrant handler, but every handler here only
        // pokes a semaphore; keeping it inside means a caller never sees a list the service hasn't
        // been told about.
        Changed?.Invoke();
        return snapshot;
    }

    private List<SessionSchedule> Snapshot() => new(_schedules);

    private sealed record Persisted(List<SessionSchedule>? Schedules);

    /// <summary>Set when the file is there but unreadable, which makes <see cref="Save"/> stand down.</summary>
    private bool _unreadable;

    private void Load()
    {
        try
        {
            if (!File.Exists(_file)) return;
            var p = JsonSerializer.Deserialize<Persisted>(File.ReadAllText(_file), JsonOpts);
            if (p?.Schedules is null) return;

            var seen = new HashSet<string>(StringComparer.Ordinal);
            _schedules = p.Schedules
                // Not paranoia: a hand-edited or truncated file can hold a null entry. Throwing here is
                // caught below as content we can't load; skipping the bad one keeps the rest.
                .Where(s => s is not null && !Blank(s.Id) && CleanName(s.Name) is not null && seen.Add(s.Id))
                .Take(MaxSchedules)
                .Select(s => s with
                {
                    Name = CleanName(s.Name)!,
                    TemplateId = Blank(s.TemplateId) ? null : Clip(s.TemplateId!.Trim(), MaxShortLength),
                    Input = Blank(s.Input) ? null : Clip(s.Input!, MaxInputLength),
                    Cron = Clip((s.Cron ?? "").Trim(), MaxShortLength),
                    TimeZoneId = Blank(s.TimeZoneId) ? TimeZoneInfo.Local.Id : Clip(s.TimeZoneId!.Trim(), MaxShortLength),
                    IntervalMinutes = CleanInterval(s.IntervalMinutes),
                    GraceMinutes = Clamp(s.GraceMinutes, 0, 7 * 24 * 60),
                    MaxRunMinutes = Clamp(s.MaxRunMinutes, 1, 24 * 60),
                    MaxRuns = CleanMaxRuns(s.MaxRuns),
                    KeepRuns = Clamp(s.KeepRuns, 0, 50),
                    TargetConversationId = Blank(s.TargetConversationId)
                        ? null : Clip(s.TargetConversationId!.Trim(), MaxShortLength),
                    History = (s.History ?? Array.Empty<ScheduleRun>()).Take(MaxHistory).ToList(),
                })
                .ToList();
            if (_schedules.Count > 0)
                _log.LogInformation("Loaded {Count} schedule(s)", _schedules.Count);
        }
        // A failed read leaves the store empty, and the next save would write that emptiness back over
        // the file. Which repair that calls for turns on why the read failed — see StateFile.
        catch (Exception ex) when (StateFile.IsAccessFailure(ex))
        {
            _log.LogWarning(ex, "Could not read schedules from {File}; it will not be written this run", _file);
            _schedules.Clear();
            _unreadable = true;
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not load schedules from {File}; setting it aside", _file);
            _schedules.Clear();
            _unreadable = !StateFile.SetAside(_file, _log, "schedules");
        }
    }

    private void Save()
    {
        if (_unreadable)
        {
            // Debug, not a warning: Load() already said this once, loudly, and this runs on every save.
            _log.LogDebug("Not writing schedules: {File} could not be read at startup", _file);
            return;
        }
        try { StateFile.Write(_file, JsonSerializer.Serialize(new Persisted(_schedules), JsonOpts)); }
        catch (Exception ex) { _log.LogWarning(ex, "Could not persist schedules to {File}", _file); }
    }

    private static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() },
    };

    private static bool Blank(string? s) => string.IsNullOrWhiteSpace(s);

    private static string Clip(string s, int max) => s.Length <= max ? s : s[..max];

    private static string? CleanName(string? name)
    {
        if (Blank(name)) return null;
        return Clip(name!.Trim(), MaxNameLength);
    }

    private static int Clamp(int v, int lo, int hi) => v < lo ? lo : v > hi ? hi : v;

    /// <summary>A minute is the floor — anything faster is a busy-loop with a cron face on it.</summary>
    private static int? CleanInterval(int? minutes) =>
        minutes is null or <= 0 ? null : Clamp(minutes.Value, 1, 7 * 24 * 60);

    private static int? CleanMaxRuns(int? runs) => runs is null or <= 0 ? null : runs;

    private static T ParseEnum<T>(string? value, T fallback) where T : struct, Enum =>
        Enum.TryParse<T>(value, ignoreCase: true, out var parsed) ? parsed : fallback;
}
