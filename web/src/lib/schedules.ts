import type { ScheduleEntry, ScheduleMode, SessionSchedule } from "@/types";

/**
 * Helpers for reading a schedule out loud. Cron is a fine thing to *store* and a poor thing to put
 * in front of someone at a glance — "0 9 * * 1-5" answers "when?" only after you have counted the
 * fields — so the list says both: the plain sentence, with the expression itself behind it.
 *
 * Nothing here parses cron in earnest. The server owns the real parser (Cronos) and sends the next
 * fire time down with each entry, which is the number that actually matters; this only recognises
 * the handful of shapes the presets produce and falls back to showing the expression unchanged.
 */

/** The presets the editor offers, in the order it offers them. */
export const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: "Every day at 09:00", cron: "0 9 * * *" },
  { label: "Every weekday at 09:00", cron: "0 9 * * 1-5" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every 15 minutes", cron: "*/15 * * * *" },
  { label: "Every Monday at 09:00", cron: "0 9 * * 1" },
  { label: "First of the month at 09:00", cron: "0 9 1 * *" },
];

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "0 9 * * 1-5" to "every weekday at 09:00". Falls back to the expression itself. */
export function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron.trim();
  const [min, hour, dom, month, dow] = parts;

  const everyN = /^\*\/(\d+)$/.exec(min);
  if (everyN && hour === "*" && dom === "*" && month === "*" && dow === "*")
    return everyN[1] === "1" ? "every minute" : `every ${everyN[1]} minutes`;
  if (min === "0" && hour === "*" && dom === "*" && month === "*" && dow === "*") return "every hour";

  // Everything below is a daily-at-a-time shape, so a non-numeric minute or hour is past what this
  // can claim to read — show the expression rather than describe it wrongly.
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour)) return cron.trim();
  const at = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;

  if (dom === "*" && month === "*") {
    if (dow === "*") return `every day at ${at}`;
    if (dow === "1-5") return `every weekday at ${at}`;
    if (dow === "0,6" || dow === "6,0") return `every weekend day at ${at}`;
    if (/^\d$/.test(dow)) return `every ${DAY_NAMES[Number(dow) % 7]} at ${at}`;
  }
  if (/^\d+$/.test(dom) && month === "*" && dow === "*")
    return `on day ${dom} of each month at ${at}`;

  return cron.trim();
}

/** What a schedule's clock says, whichever kind it is. */
export function describeClock(s: SessionSchedule): string {
  if (s.intervalMinutes) return `${s.intervalMinutes} min after each turn finishes`;
  return s.cron ? describeCron(s.cron) : "no clock set";
}

/**
 * The timing line a row leads with. An interval schedule has no next fire time to show — the server
 * cannot know one until the target's current turn ends — so rather than leave the line blank (which
 * made a dead interval schedule look exactly like a healthy one) it says what the clock is waiting
 * for. See `nextFireAt` being null for intervals in ScheduleStore.NextOccurrence.
 */
export function describeNextFire(entry: ScheduleEntry): string | null {
  const { schedule: s } = entry;
  if (!s.enabled) return "paused";
  if (entry.blocked) return null;
  if (s.intervalMinutes) return `next ${s.intervalMinutes} min after the current turn ends`;
  return entry.nextFireAt ? `next ${describeWhen(entry.nextFireAt)}` : null;
}

/** A short, non-ticking "in 4 hours" / "2 days ago". Null in, null out. */
export function describeWhen(iso: string | null): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const seconds = Math.round((then - Date.now()) / 1000);
  const ahead = seconds >= 0;
  const n = Math.abs(seconds);

  const say = (value: number, unit: string) => {
    const rounded = Math.round(value);
    const plural = `${rounded} ${unit}${rounded === 1 ? "" : "s"}`;
    return ahead ? `in ${plural}` : `${plural} ago`;
  };
  // Each bucket hands over BEFORE its own rounding would spill into the next unit: at 3599 seconds
  // `Math.round(n / 60)` is 60, and "in 60 minutes" where "in 1 hour" was meant reads as a bug.
  if (n < 60) return ahead ? "in under a minute" : "just now";
  if (n < 3570) return say(n / 60, "minute");
  if (n < 85500) return say(n / 3600, "hour");
  return say(n / 86400, "day");
}

/**
 * Whether a schedule has quietly stopped firing. A machine that was off, or an autologin broken by a
 * policy change, looks exactly like a schedule with nothing to do — so the list has to be able to
 * say "this should have run by now" rather than leaving the silence to speak for itself.
 */
export function isOverdue(entry: ScheduleEntry): boolean {
  const { schedule, nextFireAt } = entry;
  if (!schedule.enabled || entry.blocked || !nextFireAt) return false;
  return new Date(nextFireAt).getTime() < Date.now() - 60_000;
}

/** One line under a mode's name in the editor, saying what picking it actually means. */
export const MODE_NOTES: Record<ScheduleMode, string> = {
  Headless:
    "Runs claude once in print mode and exits. Nothing appears in the sessions list and nothing " +
    "accumulates — the right shape for a frequent check. Its output is kept in this schedule's history.",
  NewSession:
    "Starts a full session per run, as if you had filled in the New Session dialog. Best for " +
    "substantial work you want to look at afterwards.",
  ReuseSession:
    "Sends the prompt into a session that is already running, so it keeps the conversation's " +
    "context. That context also grows with every run and will eventually compact and drift — for " +
    "anything that does not truly need the history, a one-shot holds up far better.",
};

export const MODE_LABELS: Record<ScheduleMode, string> = {
  Headless: "One-shot (headless)",
  NewSession: "New session each run",
  ReuseSession: "Continue an existing session",
};

/** How a past run's outcome is coloured in the history list. */
export const OUTCOME_CLASS: Record<string, string> = {
  ok: "text-emerald-600 dark:text-emerald-400",
  failed: "text-red-600 dark:text-red-400",
  blocked: "text-amber-600 dark:text-amber-400",
  postponed: "text-amber-600 dark:text-amber-400",
  skipped: "text-muted-foreground",
};
