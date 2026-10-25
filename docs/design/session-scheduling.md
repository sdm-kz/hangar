# Scheduled sessions: put the clock in the daemon

**Goal.** A session can be told to run *on its own*, repeatedly, and keep doing so across a reboot:
"every weekday at 09:00, review yesterday's PRs", "every 10 minutes, check whether the deploy went
green". The schedule is a server-side record you can see, pause and edit from any device — not
state trapped inside a process that dies.

**Non-goal.** Cluster scheduling, dependencies between jobs, retries with backoff. This is cron for
one machine's sessions, not an orchestrator. Also not a goal: making an unattended run *safe* —
that is what the permission mode on the schedule is for, and it is the user's call.

---

## 1. Why the clock lives in `Hangar.exe`

The daemon is already the always-on process. It has three `BackgroundService`s
(`SessionHub`, `PushNotifier`, `UpdateService`), a settled convention for server-side JSON stores
under `%LocalAppData%\Hangar\`, and `Sessions:ResumeOnStart`
(`SessionManager.ResumePersistedAsync`, `SessionManager.cs:1167`) already rebuilds the working set
after a reboot. A scheduler is a fourth background service and a fifth store. Nothing new.

The alternatives lose more than they save:

| | Why not |
| --- | --- |
| **Windows Task Scheduler** launching `claude` | Schedules *outside* the thing that manages sessions: no session row, no terminal, no hooks, no file browser, no phone. |
| **Claude Code's `/loop` inside the session** | The loop lives in the `claude` process and dies with it — silently, and unobservably from outside. That is precisely the failure this feature exists to fix. |
| **One prompt that says "poll forever"** | Burns context continuously, one crash ends it, and there is no pause button. |

### Durability ceiling

Scheduling is exactly as durable as the daemon's own autostart. On Windows that is the per-user Run
key (`scripts/register-autostart.ps1`) plus **autologin**, which is the setup this is designed for:
the daemon then runs as the user, with the user's profile, `claude` login and PATH. A Windows
service would start without a login but costs session 0 (no browser for a `claude` re-auth) and
mapped drives; with autologin configured it buys nothing. On Linux/macOS the equivalent is a user
systemd unit with `loginctl enable-linger`, or a launchd agent with `RunAtLoad`, and neither needs
a login at all.

**The residual risk is silence.** Autologin can be broken by a policy change or a BitLocker PIN
prompt, and a schedule that has quietly not fired for a week looks exactly like one that had
nothing to do. So `LastFiredAt` is a first-class, always-visible field, and a schedule overdue by
more than one interval is drawn as a problem rather than as "idle".

---

## 2. Three task shapes, three mechanisms

There is no single right level for "do X every N minutes". The task decides:

| Shape | Example | Mechanism | Session row? |
| --- | --- | --- | --- |
| **Stateless check**, frequent | "is the deploy green?" | headless one-shot: `claude -p "<prompt>"` | no |
| **Needs the conversation**, frequent | "keep working through this backlog" | poke a living session | reuses one |
| **Substantial work**, infrequent | "review yesterday's PRs" | fresh full session | one per run |

The first row deserves the weight. Most "every N minutes" jobs are stateless checks, and for those
a headless one-shot is *strictly better* than poking a living session: no context accumulation, no
racing a TUI, it exits by itself so there is nothing to clean up, and its stdout is capturable. It
costs a process start and buys every durability property for free.

`Mode` on the schedule picks between the three. `Headless` and `NewSession` are the ones to build
first; `ReuseSession` is the one with the interesting failure modes (§5).

---

## 3. The record

A schedule is **a template plus a clock**. `SessionTemplate` (`server/Sessions/TemplateStore.cs`)
already holds precisely the launch payload a fired run needs — project, folder, prompt with its
`{input}` placeholder, model, remote control, permission mode, watchdog. Do not duplicate those
fields.

```csharp
public enum ScheduleMode { Headless, NewSession, ReuseSession }
public enum MissedPolicy { Skip, RunOnce }
public enum OverlapPolicy { Skip, Queue }

public sealed record SessionSchedule(
    string Id,
    string Name,
    bool Enabled,

    // --- what to run -------------------------------------------------------
    string? TemplateId,          // soft reference, like SessionTemplate.ProjectId
    string? Input,               // fills {input} on every fire
    ScheduleMode Mode,

    // --- when --------------------------------------------------------------
    string Cron,                 // "0 9 * * 1-5"
    string TimeZoneId,           // store it: you edit this from a phone in another zone
    int? IntervalMinutes,        // set INSTEAD of Cron for the after-the-last-turn rule (§5)

    // --- how it behaves ----------------------------------------------------
    MissedPolicy OnMissed,
    int GraceMinutes,
    OverlapPolicy Overlap,
    int MaxRunMinutes,
    int? MaxRuns,
    bool StopWhenDone,
    int KeepRuns,

    // --- where (ReuseSession only) -----------------------------------------
    string? TargetConversationId,

    // --- observed state ----------------------------------------------------
    DateTimeOffset? LastFiredAt,
    IReadOnlyList<ScheduleRun> History);

public sealed record ScheduleRun(
    DateTimeOffset At,
    string? SessionId,
    string Outcome,              // ok | blocked | failed | skipped | postponed
    string? Detail,
    int? DurationSeconds);
```

Three choices worth defending:

- **Reference the template, don't copy it.** Same soft-reference convention `ProjectId` already
  uses. A template that has been deleted puts the schedule into a `Blocked` state rather than
  firing something wrong. The counter-argument is real and should be in the UI copy: editing a
  template silently changes what runs unattended at 03:00.
- **`TargetConversationId`, not our session id.** Our ids change on every restore — the README says
  so plainly ("a relaunched session gets a new id"). Claude's conversation id is the stable handle,
  and it is already what `PinStore` and `SessionUiStore` key on.
- **`History` in the record, capped at ~20.** A schedule that fires while you sleep is only useful
  if it leaves a trace. Same file, same save; no second store.

Persisted to `%LocalAppData%\Hangar\schedules.json` via `ScheduleStore`, shaped like
`TemplateStore`: every mutation returns the full list.

### Cron

Use **Cronos** (NuGet, no dependencies). `GetNextOccurrence(from, TimeZoneInfo)` handles DST's
skipped and repeated hour correctly. Do not hand-roll this; the twice-a-year bug is not worth it.

---

## 4. The engine

`ScheduleService : BackgroundService`, shaped like `UpdateService`: a `SemaphoreSlim _wake`
released on any edit, and `await _wake.WaitAsync(untilNextDue)` so it sleeps until the next due
moment instead of polling every second.

Two things that are easy to get wrong:

1. **Always re-evaluate against wall-clock `DateTimeOffset.Now`; never `Task.Delay` until the fire
   time.** A laptop that sleeps for three hours wakes with the delay still pending. Subscribe to
   `SystemEvents.PowerModeChanged` and `SystemEvents.TimeChanged` — `Microsoft.Win32.SystemEvents`
   is already a package reference for the logoff hook — and recompute on both.
2. **Persist `LastFiredAt` before launching, not after.** A crash between the two double-fires on
   the next start.

Firing is **in-process** (`SessionManager.CreateAsync`, `SessionManager.cs:677`), not an HTTP call
to `/api/external/sessions`. No auth dance, no self-URL, no loopback binding assumption.

A global concurrency cap (`Schedules:MaxConcurrentRuns`, default 4) sits above the per-schedule
`Overlap` policy. Without it one misconfigured every-minute schedule spawns processes until the
machine dies.

---

## 5. Delivering a prompt to a living session

### 5.1 The missing server-side primitive

The logic for "send one message to Claude" exists today only in the **browser**
(`web/src/components/TerminalPane.tsx:354`): bracketed paste `\x1b[200~…\x1b[201~` so embedded
newlines stay literal, then a *separate* `\r` as the one submit. The plumbing it rides on is
server-side already and proven — the watchdog writes `continue\r` through
`SessionManager.GetTerminal(id).WriteAsync` (`server/Program.cs:693`).

Lift it to `SessionManager.SendMessageAsync(id, text, ct)` and expose `POST
/api/sessions/{id}/message` (plus the `/api/external/` twin). This has standalone value for
scripting, the scheduler calls it, and `TerminalPane` can then delegate to it instead of keeping a
second copy of the escape sequences.

Copy `SEND_GAP_MS = 150` from `PostponedPool.tsx:22` for consecutive sends: back-to-back submits
merge into one message in Claude Code's TUI otherwise.

### 5.2 Anchor on turn completion, not the wall clock

"Every 2 minutes" almost never means "every 2 minutes regardless". It means *2 minutes after the
last one finished*. Anchoring there makes overlap impossible by construction instead of something
an `Overlap` policy has to arbitrate after the fact:

```
Stop hook arrives for session X   (POST /api/hooks, Program.cs:386)
        -> HookEventStore marks X idle
        -> ScheduleService arms a one-shot timer for +IntervalMinutes
        -> on fire: SendMessageAsync, unless Waiting, or a newer turn already started
```

Every piece exists: the hook endpoint, `HANGAR_SESSION_ID`, and `HookStatus.Busy` / `.Waiting`.
**The `Waiting` gate is load-bearing** — it is what stops a paste landing on a permission prompt.

This is why `IntervalMinutes` is a separate field from `Cron` rather than sugar over it: they are
different trigger rules, not different syntaxes for one.

### 5.3 After a reboot

`ClaudeSession.cs:447` deliberately suppresses the initial prompt when resuming, so
`claude --resume <id> "<prompt>"` is not available in one shot. A `ReuseSession` schedule whose
target is `Restorable` must therefore: `RestoreAsync`, wait for the terminal to accept input, then
`SendMessageAsync`. Keep the two-step — relaxing the guard would make every restore capable of
re-firing a prompt, which is the bug that guard exists to prevent.

### 5.4 When it cannot be delivered: the postponed pool

`PostponedPool.tsx:36` states the app's existing stance outright: *"Nothing sends automatically —
when the session goes idle the bar just highlights as a nudge."* A scheduler typing into a live
terminal is a deliberate exception to that, and it should behave like one.

So when a poke cannot be delivered — the session has been busy past `MaxRunMinutes`, is `Waiting`
on a prompt, or has been stopped — **write it into that session's postponed pool instead of
dropping it** (`.hangar/postponed/<id>.json`, `PostponedStore.RelPathFor`). It is a JSON write,
and it buys the badge, the composer and the read/discard UI for free. Nothing is silently lost, and
a count of six says a schedule has been blocked all afternoon. The run is recorded as
`Outcome = "postponed"`.

### 5.5 The limit worth stating in the UI

A session poked every 2 minutes for a day is ~720 turns. It will auto-compact repeatedly and drift.
`MaxRuns`, an end time, and an optional "send `/clear` every K runs" are mitigations, not fixes. The
real answer is that a task needing 720 turns of shared context usually does not, and belongs in the
`Headless` tier. Say so where the mode is chosen.

---

## 6. Missed runs and sleep

| Situation | Behaviour |
| --- | --- |
| Machine off at the fire time | `OnMissed = RunOnce` fires once on the next start if less than `GraceMinutes` late; `Skip` does nothing. **Coalesce** — waking a laptop after a week fires one run, not seven. |
| Asleep at the fire time | Same path: the tick re-evaluates against wall clock on wake (§4). |
| Daemon restarted by an update | `LastFiredAt` was persisted before the launch, so no re-fire. |
| Two daemons | Already impossible — one instance per port. |

**Optional, later:** a real wake timer (`SetWaitableTimer` with `fResume = true`) so a sleeping
desktop wakes for an 09:00 job. It is the one thing Task Scheduler does that a plain
`BackgroundService` cannot. Phase 5, not now.

---

## 7. What happens to a finished run

This is what makes or breaks `NewSession` mode: thirty daily runs is thirty rows. All three are
needed.

- **`StopWhenDone`** — `HookEventStore` gives the Stop transition; stop the session once it has
  been idle N seconds. `SessionManager.Stop` (`SessionManager.cs:1284`) already forces
  `WasRunning = false`, so a stopped run is correctly *not* auto-resumed by
  `ShouldResume` (`SessionManager.cs:1442`). But it stays in the list as a `Restorable` row forever,
  which is why the next item exists.
- **`KeepRuns`** — `Remove(id, stopProcess: false)` anything past the last N for this schedule.
- **`MaxRunMinutes`** — without it, one wedged run plus `Overlap = Skip` silently kills the schedule
  forever. This is the failure that looks like "scheduling doesn't work".

Filing runs into a virtual folder is **optional**, and deliberately deferred. The row marker (§8)
makes runs recognisable wherever they sit; add the folder only if real use makes the list noisy.

---

## 8. UI

### 8.1 The row marker

The sidebar already has three marker slots with three distinct meanings, and the code argues for
each:

| Slot | Means | Today |
| --- | --- | --- |
| Corner badge (`absolute -left-0.5 -top-0.5`) | **live activity** | busy/waiting/failed dots, the "done" tick |
| Before the name | **provenance** | `GitFork` (`SessionSidebar.tsx:2363`) |
| After the name | **standing property** | `Radio`, `Pin` |

"Scheduled" is provenance, so it goes **before the name**, beside `GitFork`, at the same
`size-3 text-muted-foreground`, with the tooltip carrying the detail exactly as the fork mark
carries its parent's name rather than spending row width on it:

```tsx
{s.scheduleId && (
  <span className="flex shrink-0 items-center text-muted-foreground"
        title={`Scheduled: ${s.scheduleLabel} — next ${s.nextFireLabel}`}>
    <CalendarClock className="size-3" aria-label="scheduled session" />
  </span>
)}
```

- **`CalendarClock`**, not `Clock` — `Clock` is already in `GROUP_ICONS`, and a glyph that means one
  thing on a row and another on a folder heading is the drift the `ActivityMark` comment
  (`SessionSidebar.tsx:181`) is guarding against.
- **Not in the activity corner.** That same comment makes the case: "drawn as a sixth dot it would
  be one more colour to learn on a list that is mostly quiet." Scheduled is not a live state.
- **One icon, not two.** A cron fire and an interval poke are both "a clock started this"; the
  tooltip says which clock.
- A session *launched by* a schedule and a living session *a schedule pokes* share the icon and
  differ in tooltip. A **paused** schedule draws it at `opacity-50` — reads as off, needs no second
  glyph.

`SessionInfo` gains `ScheduleId` and a display label; the tray shows sessions too, and gets the
label in its menu text since it has no room for a glyph.

### 8.2 Where schedules are edited

A **Schedules** tab beside Templates in `NewSessionDialog`, and a "Schedule…" item in a session's
⋯ menu that pre-fills `ReuseSession` against that conversation. Schedules also list in project
settings beside that project's templates, since that is where the template they reference lives.

The editor shows, always: the mode (with the §5.5 caveat next to `ReuseSession`), the permission
mode as a deliberate visible field, the next fire time *in the stored zone*, and `LastFiredAt`.

### 8.3 Permissions, and the safety net you already have

An unattended run that hits a permission prompt just sits there — the watchdog will not answer it
(`PromptGuardPatterns` is explicit about that). So the schedule's permission mode is a deliberate,
visible choice, realistically `acceptEdits` or `bypassPermissions`.

The upside is free: `PushNotifier` already pushes on "newly waiting on a prompt", so a 03:00 run
that blocks wakes your phone with no new code.

---

## 9. Phasing

1. **`SendMessageAsync` + `POST /api/sessions/{id}/message`** — standalone value, no scheduling yet.
   `TerminalPane` delegates to it.
2. **`ScheduleStore` + `ScheduleService`**, `Headless` and `NewSession` modes: cron, timezone,
   missed-run policy, run history, concurrency cap. Fires via `CreateAsync` in-process.
3. **Lifecycle**: `StopWhenDone`, `KeepRuns`, `MaxRunMinutes`.
4. **`ReuseSession`**: the Stop-hook anchor, the `Waiting` gate, the restore-then-send path, the
   postponed-pool fallback.
5. **Optional**: wake timers; a virtual folder per schedule, if the list actually gets noisy.

UI lands with the phase it describes: the row marker with 2, the Schedules tab with 2, the ⋯-menu
entry with 4.

---

## 10. Deliberately out of scope

- **Retries.** A failed run is recorded and the next fire happens on schedule. Retry-with-backoff is
  a different feature and mostly wants the headless tier anyway.
- **Chaining.** No "run B after A".
- **Cloud routines.** Claude's own scheduled agents run in the cloud, against neither this machine's
  folders nor these sessions. Different tool, not a competitor to this one.
- **Second-granularity schedules.** Cron's minute is the floor; `IntervalMinutes` is minutes.
