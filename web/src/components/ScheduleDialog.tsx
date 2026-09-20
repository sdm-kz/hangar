import { useCallback, useEffect, useState } from "react";
import type { ScheduleEntry, ScheduleMode, SessionInfo, SessionTemplate } from "@/types";
import { api, type SchedulePatch } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  CRON_PRESETS,
  MODE_LABELS,
  MODE_NOTES,
  OUTCOME_CLASS,
  describeClock,
  describeNextFire,
  describeWhen,
  isOverdue,
} from "@/lib/schedules";
import { selectClass } from "./LaunchOptions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useConfirm } from "@/components/ui/confirm";
import {
  AlertTriangle,
  CalendarClock,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Pause,
  Play,
  Plus,
  RotateCw,
  Save,
  Trash2,
} from "lucide-react";

/**
 * Schedules: the clock that starts sessions when nobody is at the machine. One dialog holds both the
 * list and the editor — a schedule is a small enough thing that a second dialog on top of a first
 * would be more chrome than content, and the list is where you spend the time (checking that the
 * overnight ones actually ran) rather than the form.
 *
 * The list is the point of the feature as much as the firing is. A schedule that has quietly stopped
 * — a machine that was off, an autologin broken by a policy change — looks exactly like one with
 * nothing to do, so every row leads with when it last ran and when it runs next.
 */
export function ScheduleDialog({
  sessions,
  /** Pre-fill a new schedule that continues this session's conversation (the row's ⋯ menu). */
  initialTarget,
  onClose,
}: {
  sessions: SessionInfo[];
  initialTarget?: { conversationId: string; name: string } | null;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<ScheduleEntry[] | null>(null);
  // Fetched here rather than threaded down, exactly as the New Session dialog fetches them: they are
  // only wanted while this is open, and the sidebar that opens it has no use for them otherwise.
  const [templates, setTemplates] = useState<SessionTemplate[]>([]);
  // "new" carries the target it was opened WITH, rather than reading the prop at render time. The
  // prop is fixed for the life of the dialog, so a plain "new" flag meant every later New schedule
  // arrived pre-filled to poke the session the dialog happened to be opened from — and saving it
  // quietly created a second poker on that session.
  const [editing, setEditing] = useState<
    ScheduleEntry | { target: { conversationId: string; name: string } | null } | null
  >(initialTarget ? { target: initialTarget } : null);
  const [error, setError] = useState<string | null>(null);
  const isNew = editing !== null && !("schedule" in editing);

  // Whether the templates have arrived, as distinct from there being none: the editor has to keep
  // Save disabled and say "loading" rather than "no templates yet", and it must not settle its
  // template field on "" before the list it would have chosen from turns up.
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    const [list, ts] = await Promise.all([api.getSchedules(), api.getTemplates()]);
    setEntries(list);
    setTemplates(ts);
    setLoaded(true);
  }, []);

  useEffect(() => {
    let live = true;
    reload().catch((e) => {
      if (!live) return;
      setError(e instanceof Error ? e.message : "Could not load schedules");
      // Otherwise `entries` stays null and the list spins for ever behind the error.
      setEntries([]);
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [reload]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)_auto] max-h-[calc(100dvh-2rem)] max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarClock className="size-4" />
            {editing ? (isNew ? "New schedule" : "Schedule settings") : "Schedules"}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? "A schedule runs a template on a clock. It lives in the server, so it keeps its clock across a restart or a reboot."
              : "Templates run on a clock, whether or not anyone is at the machine."}
          </DialogDescription>
        </DialogHeader>

        {error && <p className="text-sm text-red-500">{error}</p>}

        {editing ? (
          // Keyed so switching between schedules (or from one to a new one) remounts the editor:
          // its fields are useState initialisers, which would otherwise keep showing the first
          // schedule opened.
          <ScheduleEditor
            key={"schedule" in editing ? editing.schedule.id : "new"}
            entry={"schedule" in editing ? editing : null}
            templates={templates}
            templatesLoaded={loaded}
            sessions={sessions}
            initialTarget={"schedule" in editing ? null : editing.target}
            onSaved={(list) => {
              setEntries(list);
              setEditing(null);
            }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <ScheduleList
            entries={entries}
            templates={templates}
            onChanged={setEntries}
            onReload={reload}
            onError={setError}
            onEdit={setEditing}
            onNew={() => setEditing({ target: null })}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ScheduleList({
  entries,
  templates,
  onChanged,
  onReload,
  onError,
  onEdit,
  onNew,
  onClose,
}: {
  entries: ScheduleEntry[] | null;
  templates: SessionTemplate[];
  onChanged: (list: ScheduleEntry[]) => void;
  onReload: () => Promise<void>;
  onError: (message: string | null) => void;
  onEdit: (entry: ScheduleEntry) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [ran, setRan] = useState<string | null>(null);

  const toggle = async (entry: ScheduleEntry) => {
    setBusyId(entry.schedule.id);
    onError(null);
    try {
      onChanged(await api.updateSchedule(entry.schedule.id, { enabled: !entry.schedule.enabled }));
    } catch (e) {
      // Without this the spinner simply stopped and the row didn't change — the "schedules are
      // switched off on this server" case in particular read as the whole feature being broken.
      onError(e instanceof Error ? e.message : "Could not update the schedule");
    } finally {
      setBusyId(null);
    }
  };

  const runNow = async (entry: ScheduleEntry) => {
    setBusyId(entry.schedule.id);
    onError(null);
    try {
      await api.runSchedule(entry.schedule.id);
      setRan(entry.schedule.id);
      await onReload();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not run the schedule");
    } finally {
      setBusyId(null);
    }
  };

  const refresh = async () => {
    onError(null);
    try {
      await onReload();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not reload the schedules");
    }
  };

  return (
    <>
      <div className="-mx-1 flex min-h-0 flex-col gap-2 overflow-y-auto overscroll-contain px-1">
        {entries === null && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            <Loader2 className="mx-auto size-4 animate-spin" />
          </p>
        )}
        {entries?.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No schedules yet. A schedule needs a template to run — make one on the Templates tab
            first, then give it a clock here.
          </p>
        )}
        {entries?.map((entry) => {
          const s = entry.schedule;
          const template = templates.find((t) => t.id === s.templateId);
          const overdue = isOverdue(entry);
          return (
            <div
              key={s.id}
              className={cn(
                "flex items-start gap-3 rounded-md border p-3 text-sm",
                !s.enabled && "opacity-60"
              )}
            >
              <CalendarClock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  className="block w-full truncate text-left font-medium hover:underline"
                  onClick={() => onEdit(entry)}
                  title="Edit this schedule"
                >
                  {s.name}
                </button>
                <p className="truncate text-xs text-muted-foreground">
                  {MODE_LABELS[s.mode]} · {describeClock(s)}
                  {template ? ` · ${template.name}` : ""}
                </p>
                {/* Lead with when it last ran and when it runs next: silence is the failure mode
                    this feature actually has, and it has to be legible without opening anything. */}
                <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
                  <span className="text-muted-foreground">
                    Last run {describeWhen(s.lastFiredAt) ?? "never"}
                  </span>
                  {entry.blocked ? (
                    // Straight from the server: telling a bad cron from a deleted template needs a
                    // parser, and guessing produced "its template is gone" about a template named on
                    // the line above.
                    <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                      <AlertTriangle className="size-3" />
                      {entry.blockedReason ?? "it cannot run as it stands"}
                    </span>
                  ) : overdue ? (
                    <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                      <AlertTriangle className="size-3" />
                      overdue — was due {describeWhen(entry.nextFireAt)}
                    </span>
                  ) : (
                    describeNextFire(entry) && (
                      <span className="text-muted-foreground">{describeNextFire(entry)}</span>
                    )
                  )}
                </p>
                {s.history[0]?.detail && (
                  <p
                    className={cn(
                      "mt-1 line-clamp-2 text-xs",
                      OUTCOME_CLASS[s.history[0].outcome] ?? "text-muted-foreground"
                    )}
                  >
                    {s.history[0].detail}
                  </p>
                )}
                {ran === s.id && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Started. Refresh to see how it ended.
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  disabled={busyId === s.id}
                  title="Run now, without touching its clock"
                  onClick={() => runNow(entry)}
                >
                  {busyId === s.id ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Play className="size-3.5" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  disabled={busyId === s.id}
                  title={s.enabled ? "Pause this schedule" : "Resume this schedule"}
                  onClick={() => toggle(entry)}
                >
                  {s.enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  title="Edit"
                  onClick={() => onEdit(entry)}
                >
                  <ChevronRight className="size-3.5" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <DialogFooter className="sm:justify-between">
        <Button variant="outline" onClick={onNew} disabled={templates.length === 0}>
          <Plus className="size-4" /> New schedule
        </Button>
        <div className="flex gap-2">
          {/* A run started from here finishes minutes later, and nothing pushes that back to an open
              dialog — so there has to be a way to ask again. */}
          <Button variant="ghost" onClick={refresh} title="Re-read the schedules and their history">
            <RotateCw className="size-4" /> Refresh
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}

function ScheduleEditor({
  entry,
  templates,
  templatesLoaded,
  sessions,
  initialTarget,
  onSaved,
  onCancel,
}: {
  entry: ScheduleEntry | null;
  templates: SessionTemplate[];
  /** False while they are still in flight — see the effect that settles the template field. */
  templatesLoaded: boolean;
  sessions: SessionInfo[];
  initialTarget: { conversationId: string; name: string } | null;
  onSaved: (list: ScheduleEntry[]) => void;
  onCancel: () => void;
}) {
  const confirm = useConfirm();
  const s = entry?.schedule ?? null;

  const [name, setName] = useState(s?.name ?? (initialTarget ? `Keep going: ${initialTarget.name}` : ""));
  const [templateId, setTemplateId] = useState(s?.templateId ?? templates[0]?.id ?? "");
  // Opening from a session's ⋯ menu mounts this editor on the first render, before the templates
  // have arrived — so the field above initialises to "" and, once they land, the controlled <select>
  // matches no option and renders blank with Save stuck disabled. Settle it when they turn up.
  useEffect(() => {
    if (!templatesLoaded || templateId) return;
    if (templates.length > 0) setTemplateId(templates[0].id);
  }, [templatesLoaded, templates, templateId]);
  const [input, setInput] = useState(s?.input ?? "");
  const [mode, setMode] = useState<ScheduleMode>(
    s?.mode ?? (initialTarget ? "ReuseSession" : "NewSession")
  );
  const [cron, setCron] = useState(s?.cron ?? "0 9 * * 1-5");
  const [intervalMinutes, setIntervalMinutes] = useState(s?.intervalMinutes ?? null);
  const [targetConversationId, setTargetConversationId] = useState(
    s?.targetConversationId ?? initialTarget?.conversationId ?? ""
  );
  const [onMissed, setOnMissed] = useState(s?.onMissed ?? "RunOnce");
  const [graceMinutes, setGraceMinutes] = useState(s?.graceMinutes ?? 120);
  const [overlap, setOverlap] = useState(s?.overlap ?? "Skip");
  const [maxRunMinutes, setMaxRunMinutes] = useState(s?.maxRunMinutes ?? 60);
  const [stopWhenDone, setStopWhenDone] = useState(s?.stopWhenDone ?? true);
  const [keepRuns, setKeepRuns] = useState(s?.keepRuns ?? 3);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // An interval only means anything against a session to keep poking — it is "N minutes after the
  // last turn ended", and the other two modes have no last turn to be after.
  const byInterval = mode === "ReuseSession";
  const template = templates.find((t) => t.id === templateId) ?? null;

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const patch: SchedulePatch = {
        name: name.trim(),
        templateId: templateId || "",
        input: input.trim(),
        mode,
        // The two clocks are exclusive, and the server reads an interval in preference to a cron —
        // so the unused one is cleared rather than left to disagree with what the editor shows.
        cron: byInterval ? "" : cron.trim(),
        intervalMinutes: byInterval ? intervalMinutes ?? 10 : 0,
        targetConversationId: byInterval ? targetConversationId : "",
        onMissed,
        graceMinutes,
        overlap,
        maxRunMinutes,
        stopWhenDone,
        keepRuns,
        timeZoneId: s?.timeZoneId ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
      onSaved(s ? await api.updateSchedule(s.id, patch) : await api.createSchedule(patch));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the schedule");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!s) return;
    const ok = await confirm({
      title: `Delete “${s.name}”?`,
      description:
        "The clock goes away. Sessions it already started are left alone — they are real work, and " +
        "deleting the schedule is not a statement about them.",
      confirmLabel: "Delete schedule",
    });
    if (!ok) return;
    setBusy(true);
    try {
      onSaved(await api.deleteSchedule(s.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete the schedule");
      setBusy(false);
    }
  };

  // Only a session whose conversation id is known can be continued later: that id is the handle that
  // survives a reboot, and ours does not (a reopened session comes back under a new one). Filtering
  // on the id itself, not on canFork — they say the same thing, but only the id can be the option's
  // value, and a session that passed the filter without one would render an option that selects "".
  const targets = sessions.filter((x) => !!x.claudeSessionId);

  return (
    <>
      <div className="-mx-1 flex min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain px-1">
        <div className="space-y-2">
          <Label htmlFor="schedule-name">Name</Label>
          <Input
            id="schedule-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Morning PR review"
            autoFocus
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="schedule-template">Template to run</Label>
          <select
            id="schedule-template"
            className={selectClass}
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
          >
            {templates.length === 0 && (
              <option value="">{templatesLoaded ? "No templates yet" : "Loading…"}</option>
            )}
            {templates.map((t) => (
              <option key={t.id} value={t.id} className="bg-popover text-popover-foreground">
                {t.name}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            The template holds the folder, prompt and permission mode. Editing it later changes what
            this runs unattended — there is nothing on screen at 03:00 to say it changed.
          </p>
        </div>

        {template && template.prompt.includes("{input}") && (
          <div className="space-y-2">
            <Label htmlFor="schedule-input">{template.inputHint ?? "Details"}</Label>
            <Textarea
              id="schedule-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={2}
              placeholder="What fills the template's {input} on every run"
            />
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="schedule-mode">What a run does</Label>
          <select
            id="schedule-mode"
            className={selectClass}
            value={mode}
            onChange={(e) => setMode(e.target.value as ScheduleMode)}
          >
            {(Object.keys(MODE_LABELS) as ScheduleMode[]).map((m) => (
              <option key={m} value={m} className="bg-popover text-popover-foreground">
                {MODE_LABELS[m]}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">{MODE_NOTES[mode]}</p>
        </div>

        {byInterval ? (
          <>
            <div className="space-y-2">
              <Label htmlFor="schedule-session">Session to continue</Label>
              <select
                id="schedule-session"
                className={selectClass}
                value={targetConversationId}
                onChange={(e) => setTargetConversationId(e.target.value)}
              >
                <option value="">Pick a session…</option>
                {targets.map((x) => (
                  <option
                    key={x.id}
                    value={x.claudeSessionId!}
                    className="bg-popover text-popover-foreground"
                  >
                    {x.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="schedule-interval">Send again this many minutes after each turn ends</Label>
              <Input
                id="schedule-interval"
                type="number"
                min={1}
                value={intervalMinutes ?? 10}
                onChange={(e) => setIntervalMinutes(Math.max(1, Number(e.target.value) || 1))}
              />
              <p className="text-xs text-muted-foreground">
                Counted from the end of the last turn, not from a wall clock — so a run can never
                land on top of the one before it, and a prompt is never pasted over a permission
                question.
              </p>
            </div>
          </>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="schedule-cron-preset">When</Label>
            <select
              id="schedule-cron-preset"
              aria-label="Schedule preset"
              className={selectClass}
              value={CRON_PRESETS.some((p) => p.cron === cron) ? cron : ""}
              onChange={(e) => e.target.value && setCron(e.target.value)}
            >
              <option value="" className="bg-popover text-popover-foreground">
                Custom…
              </option>
              {CRON_PRESETS.map((p) => (
                <option key={p.cron} value={p.cron} className="bg-popover text-popover-foreground">
                  {p.label}
                </option>
              ))}
            </select>
            <Input
              id="schedule-cron"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              placeholder="0 9 * * 1-5"
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              Five fields: minute, hour, day of month, month, day of week.{" "}
              {entry ? (
                <>
                  Read in <span className="font-medium">{entry.resolvedTimeZoneId}</span>
                  {/* The stored id and the one the server can actually resolve are not always the
                      same — see ScheduleEntry.resolvedTimeZoneId. Saying so beats asserting an hour
                      that isn't the one that will happen. */}
                  {entry.resolvedTimeZoneId !== s?.timeZoneId && s?.timeZoneId && (
                    <> — this server could not resolve “{s.timeZoneId}”, so it uses its own zone</>
                  )}
                  .
                </>
              ) : (
                <>
                  Saved with your browser's zone (
                  {Intl.DateTimeFormat().resolvedOptions().timeZone}); if the server cannot resolve
                  it, it uses its own and will say so here.
                </>
              )}
            </p>
          </div>
        )}

        <button
          type="button"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          What happens around a run
        </button>
        {showAdvanced && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="schedule-missed">If the machine was off</Label>
              <select
                id="schedule-missed"
                className={selectClass}
                value={onMissed}
                onChange={(e) => setOnMissed(e.target.value as "Skip" | "RunOnce")}
              >
                <option value="RunOnce" className="bg-popover text-popover-foreground">
                  Run once on the next start
                </option>
                <option value="Skip" className="bg-popover text-popover-foreground">
                  Skip it
                </option>
              </select>
            </div>
            {onMissed === "RunOnce" && (
              <div className="space-y-2">
                <Label htmlFor="schedule-grace">…but only if less than this late (minutes)</Label>
                <Input
                  id="schedule-grace"
                  type="number"
                  min={0}
                  value={graceMinutes}
                  onChange={(e) => setGraceMinutes(Math.max(0, Number(e.target.value) || 0))}
                />
                <p className="text-xs text-muted-foreground">
                  Past this, the missed run is skipped rather than fired hours out of place. Several
                  missed slots always produce one run, never one each.
                </p>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="schedule-overlap">If the last run is still going</Label>
              <select
                id="schedule-overlap"
                className={selectClass}
                value={overlap}
                onChange={(e) => setOverlap(e.target.value as "Skip" | "Queue")}
              >
                <option value="Skip" className="bg-popover text-popover-foreground">
                  Skip this one
                </option>
                <option value="Queue" className="bg-popover text-popover-foreground">
                  Hold it until the last one ends
                </option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="schedule-maxrun">Give up on a run after (minutes)</Label>
              <Input
                id="schedule-maxrun"
                type="number"
                min={1}
                value={maxRunMinutes}
                onChange={(e) => setMaxRunMinutes(Math.max(1, Number(e.target.value) || 1))}
              />
            </div>
            {/* Both of these are about sessions this schedule OWNS, so they only mean anything for
                the mode that creates one per run. A one-shot leaves no session behind, and a
                schedule continuing an existing session does not own it — offering the controls
                there promised behaviour that never happened. */}
            {mode === "NewSession" && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="schedule-keep">Sessions to keep in the list</Label>
                  <Input
                    id="schedule-keep"
                    type="number"
                    min={0}
                    value={keepRuns}
                    onChange={(e) => setKeepRuns(Math.max(0, Number(e.target.value) || 0))}
                  />
                </div>
                <label className="flex items-start gap-2 text-sm sm:col-span-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={stopWhenDone}
                    onChange={(e) => setStopWhenDone(e.target.checked)}
                  />
                  <span>
                    Stop a session once its turn has finished.
                    <span className="block text-xs text-muted-foreground">
                      Off, every run stays open — thirty daily runs is thirty rows in the sidebar.
                    </span>
                  </span>
                </label>
              </>
            )}
          </div>
        )}

        {s && s.history.length > 0 && (
          <>
            <button
              type="button"
              className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
              onClick={() => setShowHistory((v) => !v)}
            >
              {showHistory ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
              Recent runs ({s.history.length})
            </button>
            {showHistory && (
              <ul className="space-y-1 text-xs">
                {s.history.map((run, i) => (
                  <li key={`${run.at}-${i}`} className="flex gap-2">
                    <span className="shrink-0 text-muted-foreground">
                      {new Date(run.at).toLocaleString()}
                    </span>
                    <span className={cn("shrink-0", OUTCOME_CLASS[run.outcome])}>{run.outcome}</span>
                    {run.detail && <span className="min-w-0 break-words">{run.detail}</span>}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {byInterval && !targetConversationId && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Pick the session to continue. Without one this schedule can never fire — and, being an
            interval, it would not even record an attempt to say so.
          </p>
        )}
        {templatesLoaded && templates.length === 0 && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            There are no templates yet. A schedule runs a template, so make one on the New Session
            dialog's Templates tab first.
          </p>
        )}
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>

      <DialogFooter className="sm:justify-between">
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            <ChevronLeft className="size-4" /> Back
          </Button>
          {s && (
            <Button variant="ghost" onClick={remove} disabled={busy} className="text-red-500">
              <Trash2 className="size-4" /> Delete
            </Button>
          )}
        </div>
        <Button
          onClick={save}
          disabled={busy || !name.trim() || !templateId || (byInterval && !targetConversationId)}
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
          Save
        </Button>
      </DialogFooter>
    </>
  );
}
