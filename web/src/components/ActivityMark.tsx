// The activity marks: what a session (or a heading over several) is doing, drawn as a dot, a ring, a
// tick or a cross. Shared by the sessions list and the session's own Terminal tab, so the two can't
// drift apart on what amber means.

import type { LucideIcon } from "lucide-react";
import { Check, X } from "lucide-react";
import type { SessionInfo } from "@/types";
import { failureLine, type ActivityIds } from "@/lib/sessionActivity";
import { cn } from "@/lib/utils";

/**
 * The mark a heading wears for the most urgent thing happening inside it — or, when nothing is,
 * for the work that finished there — pinned to the corner of the heading's own icon: the folder,
 * the box, the project. So what is busy is said by the thing that is busy, the way a badge sits on
 * an app's icon.
 *
 * Out of the flow rather than in the line: a heading's line starts with its chevron, so an inline
 * dot would either hold a gutter open on every idle heading or shove the name sideways the moment
 * something inside woke up. Here it costs nothing and shifts nothing. Out of the flow it also takes
 * no pointer events — the same trade the dot on a session row already makes.
 *
 * The badge is the glyph and nothing else: no padding, so the page background behind it stops at the
 * glyph's own box instead of ringing it. A ring reads as a second shape at this size — a white halo
 * around a 8px tick — and the offsets below are what keep the two apart, not a gap drawn around it.
 * They carry the 2px the padding used to add, so the glyph itself sits exactly where it always did.
 *
 * Expects a positioned parent: wrap the icon, not the row.
 */
export function HeadingActivityMark({
  activity,
  label,
  className,
}: {
  activity: Activity | null;
  label?: string;
  /** For a heading on a surface of its own: the badge's background, so it is cut out of that instead. */
  className?: string;
}) {
  if (!activity) return null;
  return (
    <span className={cn("pointer-events-none absolute -left-0.5 -top-0.5 rounded-full bg-background leading-none", className)}>
      <ActivityMark activity={activity} label={label} />
    </span>
  );
}

/**
 * The glyph an activity is drawn as. Live states are a coloured dot — the smallest thing that can
 * still say "something is happening here" — but "finished, unseen" is not a live state, and drawn
 * as a sixth dot it would be one more colour to learn on a list that is mostly quiet. A tick reads
 * as past tense at a glance and needs no legend, so it is the one activity with a shape of its own.
 *
 * One element, used both in a row's corner and on a heading's icon, so the two can't drift apart.
 *
 * `nested` is a parent row's corner showing what a session under it is doing rather than what it
 * is doing itself: the same colour and the same pulse, drawn as a ring instead of a dot -- filled is
 * "this one", hollow is "something in here". Only the dots change. The tick and the cross keep their
 * shapes: at 8px there is no room for a second style of either, and both are past tense anyway, so
 * which row they came from matters less than for a live state.
 */
export function ActivityMark({
  activity,
  label: detail,
  nested = false,
}: {
  activity: Activity;
  label?: string;
  nested?: boolean;
}) {
  const { className, hollowClassName, label: generic, Icon } = ACTIVITY_MARK[activity];
  const label = detail ?? generic;
  if (nested && hollowClassName && !Icon)
    // A size up from the dot: a 6px ring has no hole left in it to read as one.
    return <span className={cn("block size-2 rounded-full border-2", hollowClassName)} aria-label={label} />;
  return Icon ? (
    // 8px with a heavy stroke, not the 14px these icons are usually drawn at. Bigger reads better in
    // isolation and worse here: the badge is opaque, so every pixel it gains is taken out of the
    // session name behind it on a row, and off the folder glyph it is pinned to on a heading. At
    // lucide's default weight a tick this small thins out to a smudge, hence the stroke.
    <Icon className={cn("block size-2", className)} strokeWidth={4} aria-label={label} />
  ) : (
    <span className={cn("block size-1.5 rounded-full", className)} aria-label={label} />
  );
}

/**
 * What an activity mark can say, and how it looks — one definition, so a session row and the folder
 * header above it can never disagree about what amber means.
 */
export type Activity =
  | "busy"
  | "compacting"
  | "background"
  | "waiting"
  | "failed"
  | "attention"
  | "recovering"
  | "done";
export const ACTIVITY_MARK: Record<
  Activity,
  {
    className: string;
    label: string;
    Icon?: LucideIcon;
    // The dot as a ring, for a parent's corner showing its branch rather than itself (ActivityMark's
    // `nested`): the same colour and motion, drawn as a border.
    hollowClassName?: string;
  }
> = {
  busy: {
    className: "bg-emerald-500 animate-pulse",
    hollowClassName: "border-emerald-500 animate-pulse",
    label: "Claude is working",
  },
  // A flavour of busy, so it stays in the working family — a slower pulse and a cooler green, because
  // "still here, but not on your task" is the useful thing to read off it from across the room.
  compacting: {
    className: "bg-teal-400 animate-pulse [animation-duration:2s]",
    hollowClassName: "border-teal-400 animate-pulse [animation-duration:2s]",
    label: "Claude is compacting the conversation",
  },
  // Still working, but not Claude: its turn is over and what it left running isn't. Out of the green
  // family so it doesn't read as "Claude is generating", and on the slowest pulse of all, because
  // what it says is "come back later" — a benchmark that takes a quarter of an hour.
  background: {
    className: "bg-sky-500 animate-pulse [animation-duration:3s]",
    hollowClassName: "border-sky-500 animate-pulse [animation-duration:3s]",
    label: "Claude’s turn is over, but shells it started are still running",
  },
  waiting: {
    className: "bg-amber-400 animate-pulse ring-2 ring-amber-400/40",
    // The halo stays on the ring too: it is what tells waiting (the most urgent mark) apart from
    // the near-identical amber of recovering.
    hollowClassName: "border-amber-400 animate-pulse ring-2 ring-amber-400/40",
    label: "Claude is waiting for your input",
  },
  // The tick's opposite number, and drawn like it for the same reason: a turn that died is over, not
  // happening, and a seventh dot would be one more colour to learn. A cross says "this stopped, and
  // not well" with no legend — the session is sitting there waiting to be picked back up.
  failed: {
    className: "text-red-500",
    label: "Claude’s last turn ended on an error",
    Icon: X,
  },
  attention: { className: "bg-red-500", hollowClassName: "border-red-500", label: "Session needs attention" },
  recovering: {
    className: "bg-amber-500 animate-pulse",
    hollowClassName: "border-amber-500 animate-pulse",
    label: "Watchdog is auto-recovering this session",
  },
  // The green pulse's own past tense, so the two read as one story: the same green, no longer
  // moving. It is the only activity you can clear by looking at it — see useDoneSessions.
  done: {
    className: "text-emerald-500",
    label: "Claude finished here — you haven’t looked yet",
    Icon: Check,
  },
};

/** A session's own mark: what it is doing right now — or, failing that, what it just finished. */
export function sessionActivity(s: SessionInfo, ids: ActivityIds): Activity | null {
  // Ahead of plain busy: it's the more specific reading of the same "working" state, and it explains
  // a session that has gone quiet for a minute or two without having stalled.
  if (ids.compacting.has(s.id)) return "compacting";
  if (ids.busy.has(s.id)) return "busy";
  if (ids.waiting.has(s.id)) return "waiting";
  if (s.watchdogStatus === "attention") return "attention";
  // Above the failed turn it is presumably retrying: the watchdog having the session in hand is the
  // newer fact, and the one that says whether you have to do anything about the error yourself.
  if (s.watchdogStatus === "recovering") return "recovering";
  if (ids.failed.has(s.id)) return "failed";
  // Ahead of the tick: the turn finished, but the work it started hasn't, and that is what you are
  // waiting on. useDoneSessions holds the tick back until the shells end anyway.
  if (ids.background.has(s.id)) return "background";
  // Last, because it is the only one in past tense: anything the session is doing *now* is the more
  // useful thing to say about it, and a finished turn keeps its tick until you go and look.
  if (ids.done.has(s.id)) return "done";
  return null;
}

/**
 * What a mark is actually about, where the hooks said more than the state itself does: which command
 * a permission dialog is asking to run, or what a failed turn died on. Null for the states that have
 * nothing to add — their one-line label in ACTIVITY_MARK is the whole story.
 *
 * It rides the row's tooltip rather than the row itself. There is nowhere on a row to put a sentence
 * that isn't taken by the session's name, and a line of it appearing under half the rows in a busy
 * sidebar would reflow the list every time a permission dialog opened.
 */
export function activityDetail(activity: Activity, id: string, ids: ActivityIds): string | null {
  if (activity === "background") {
    const n = ids.background.get(id) ?? 0;
    return `Claude’s turn is over; ${n} shell${n === 1 ? "" : "s"} it started ${n === 1 ? "is" : "are"} still running`;
  }
  const detail = ids.detail[id];
  if (!detail) return null;
  if (activity === "waiting") return detail.waitingOn ?? null;
  if (activity === "failed") return failureLine(detail);
  return null;
}
