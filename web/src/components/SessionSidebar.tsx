import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import type { Project, ProjectGroup, SessionInfo } from "@/types";
import { sessionColor } from "@/lib/sessionColors";
import { forkDescendants, forkTree, parentOf, type ForkNode } from "@/lib/sessionTree";
import {
  groupForSession,
  groupIdsAfterMove,
  isUnder,
  mergesFolderHeader,
  projectForDir,
  sameFolder,
  sectionsByProject,
  sortedByName,
  type ProjectSection,
} from "@/lib/projects";
import { groupIcon } from "@/lib/groupIcons";
import { api } from "@/lib/api";
import { ProjectDialog } from "./ProjectDialog";
import { GroupDialog } from "./GroupDialog";
import { useConfirm } from "@/components/ui/confirm";
import {
  dirKey,
  loadSessionOrder,
  move,
  pinAfterMove,
  saveSessionOrder,
  sortFolderSessions,
  sortPinnedFirst,
  type SessionOrder,
} from "@/lib/sessionOrder";
import { useDragReorder } from "@/lib/useDragReorder";
import { failureLine, type ActivityIds } from "@/lib/sessionActivity";
import { recentLabel, type RecentSession } from "@/lib/recentSessions";
import { sessionUrl } from "@/lib/urlState";
import { RenameField } from "./RenameField";
import { PostponedDialog } from "./PostponedDialog";
import { ProjectGlyph } from "./ProjectGlyph";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { ThemeToggle } from "./ThemeToggle";
import { NotificationToggle } from "./NotificationToggle";
import { OrphanBar } from "./OrphanBar";
import { cn } from "@/lib/utils";
import { useDismissable } from "@/lib/useDismissable";
import { navRowProps, useTreeKeyNav } from "@/lib/useTreeKeyNav";
import { writeToClipboard } from "@/lib/clipboard";
import {
  type LucideIcon,
  Check,
  CheckCheck,
  CalendarClock,
  Copy,
  CornerLeftUp,
  Activity as ActivityIcon,
  Filter,
  FolderPlus,
  FolderSearch,
  Minus,
  MoreVertical,
  GitFork,
  Inbox,
  Play,
  Plus,
  Settings,
  Radio,
  RotateCcw,
  Search,
  Square,
  X,
  LogOut,
  Pencil,
  Pin,
  PinOff,
  Terminal,
  Trash2,
  FolderTree,
  List,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
} from "lucide-react";

// The two lists the session sidebar can show: live sessions, or recent launch presets.
export type SessionListTab = "sessions" | "recent";

/**
 * One virtual folder ready to draw: the group itself, the sessions filed into it, and the same fork
 * tree and drag list a folder group carries — so the rows inside a box you filled by hand and a box
 * a path filled are drawn by exactly the same code.
 */
type VirtualGroup = {
  group: ProjectGroup;
  /** Order/collapse key, prefixed so it can't collide with a folder's path or a flat section's. */
  key: string;
  count: number;
  items: SessionInfo[];
  nodes: ForkNode[];
  rootIds: string[];
};

// Grouped-vs-flat is a per-browser view preference, kept client-side like the session order.
const GROUPED_KEY = "claudeweb.sessionsGrouped";
function loadGrouped(): boolean {
  try {
    return localStorage.getItem(GROUPED_KEY) === "1";
  } catch {
    return false;
  }
}
function saveGrouped(v: boolean) {
  try {
    localStorage.setItem(GROUPED_KEY, v ? "1" : "0");
  } catch {
    /* storage disabled — preference is best-effort */
  }
}

// Session-state filter: "active" shows only running sessions, "activity" only the ones carrying an
// activity mark (working, waiting, failed, finished-but-unseen…), "all" shows everything
// (exited/closed too). Per-browser preference, remembered across refreshes like the grouped toggle.
type SessionFilter = "active" | "activity" | "all";
const FILTER_KEY = "claudeweb.sessionsFilter";
function loadFilter(): SessionFilter {
  try {
    const v = localStorage.getItem(FILTER_KEY);
    return v === "active" || v === "activity" ? v : "all";
  } catch {
    return "all";
  }
}
function saveFilter(v: SessionFilter) {
  try {
    localStorage.setItem(FILTER_KEY, v);
  } catch {
    /* storage disabled — preference is best-effort */
  }
}

/** Last path segment of a working directory, for a compact group header. */
function folderLabel(dir: string): string {
  const parts = dir.split(/[/\\]+/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

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
function HeadingActivityMark({ activity }: { activity: Activity | null }) {
  if (!activity) return null;
  return (
    <span className="pointer-events-none absolute -left-0.5 -top-0.5 rounded-full bg-background leading-none">
      <ActivityMark activity={activity} />
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
function ActivityMark({
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
 * Group items by working directory. Groups are sorted by their folder label (the header text),
 * case-insensitively; each item keeps its flat-list index so drag-to-reorder keeps working unchanged.
 */
function groupByFolder<T extends { workingDirectory: string }>(items: T[]) {
  const groups: { dir: string; items: { item: T; index: number }[] }[] = [];
  const byDir = new Map<string, { dir: string; items: { item: T; index: number }[] }>();
  items.forEach((item, index) => {
    const key = dirKey(item.workingDirectory);
    let g = byDir.get(key);
    if (!g) {
      // Keep the first-seen original path for the header, so its casing stays readable.
      g = { dir: item.workingDirectory, items: [] };
      byDir.set(key, g);
      groups.push(g);
    }
    g.items.push({ item, index });
  });
  groups.sort((a, b) =>
    folderLabel(a.dir).localeCompare(folderLabel(b.dir), undefined, { sensitivity: "base" })
  );
  return groups;
}

/**
 * What an activity mark can say, and how it looks — one definition, so a session row and the folder
 * header above it can never disagree about what amber means.
 */
type Activity = "busy" | "compacting" | "waiting" | "failed" | "attention" | "recovering" | "done";
const ACTIVITY_MARK: Record<
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
function sessionActivity(s: SessionInfo, ids: ActivityIds): Activity | null {
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
function activityDetail(activity: Activity, id: string, ids: ActivityIds): string | null {
  const detail = ids.detail[id];
  if (!detail) return null;
  if (activity === "waiting") return detail.waitingOn ?? null;
  if (activity === "failed") return failureLine(detail);
  return null;
}

/**
 * A folder's mark: the most urgent thing inside it, which is a different question from what any one
 * session is doing. Waiting-on-you outranks merely working, so a collapsed folder can't hide a
 * prompt behind a session that happens to be generating — the whole point of surfacing it up here.
 */
const FOLDER_URGENCY: Record<Activity, number> = {
  waiting: 6,
  attention: 5,
  recovering: 4,
  // Above the working states, unlike the tick below them: a finished turn resolves itself the moment
  // you look at it, while a turn that died on an error stays dead until someone retries it. A folder
  // must not hide that behind a session that happens to be generating.
  failed: 3,
  compacting: 2,
  busy: 1,
  // Bottom of the pile, which is exactly the rule asked of it: a heading only ticks once nothing
  // inside it is still going. A folder with one session finished and another still working has
  // more to say than "something finished" — and the tick will be there when the work stops.
  done: 0,
};
/**
 * Postponed messages waiting across a set of sessions. Closed sessions count: their pool is still
 * stashed and still there to come back to, which is not true of anything folderActivity reports.
 */
function folderPostponed(items: SessionInfo[]): number {
  return items.reduce((n, s) => n + s.postponedCount, 0);
}

/**
 * How far a heading's batch has got: how many of the sessions under it have finished, out of the
 * ones that are up to anything at all.
 *
 * The heading's dot says what the most urgent thing inside is; it cannot say how many sessions that
 * is, or how much of the work is over, and on a collapsed box that is the thing you are actually
 * waiting to know. Sessions with no mark are left out of both halves -- an idle session was never
 * part of this run, and counting it would make a finished batch read as unfinished for as long as it
 * sat there.
 */
export function folderProgress(items: SessionInfo[], ids: ActivityIds): { done: number; active: number } {
  let done = 0;
  let active = 0;
  for (const s of items) {
    if (s.state === "Restorable") continue; // a closed session isn't part of anything running
    const a = sessionActivity(s, ids);
    if (!a) continue;
    active++;
    if (a === "done") done++;
  }
  return { done, active };
}

/**
 * The fraction, shown wherever anything under the heading is up to something -- including "0/2",
 * before any of it has finished. The dot says a batch is running; how big it is, and how much of it
 * is left, is the thing you are waiting on, and it is worth reading off a heading whose sessions may
 * be folded away underneath it.
 */
export function HeadingProgress({ done, active }: { done: number; active: number }) {
  if (active <= 0) return null;
  return (
    <span
      className={cn(
        "shrink-0 font-mono text-[10px] tabular-nums",
        // The tick's colour once there are ticks to count, and the same past tense -- nothing here is
        // moving, so nothing about it pulses. Grey until then: a green "0/2" would be claiming
        // something has landed when nothing has.
        done > 0 ? "text-emerald-600 dark:text-emerald-500" : "text-muted-foreground"
      )}
      title={
        done === 0
          ? `Nothing finished yet — ${active} still going`
          : done === active
            ? `${done} finished, nothing still going`
            : `${done} of ${active} finished — ${active - done} still going`
      }
    >
      {done}/{active}
    </span>
  );
}

const MIDDLE_TRUNCATE_HEAD = 10;

/**
 * A name cut in the middle when it doesn't fit: the first few characters stay, the ellipsis goes
 * after them, and the tail is kept for as much as there is room.
 *
 * A fork's name starts with its parent's, so cutting the tail would leave every row in a branch
 * looking identical -- but cutting the head alone, as these rows used to, leaves a line that starts
 * mid-word and no longer says which session it came from. Keeping both ends answers both. CSS has
 * no middle ellipsis, so the name is split in two: the head never shrinks, and the tail is laid out
 * right-to-left so its ellipsis lands on the left, next to the head; the bdi keeps the text itself
 * reading left-to-right. When the name fits, the two halves just sit side by side.
 */
function MiddleTruncated({ text }: { text: string }) {
  // By code point, so an emoji or other astral character is never split between the halves.
  const chars = Array.from(text);
  if (chars.length <= MIDDLE_TRUNCATE_HEAD) return <span className="truncate">{text}</span>;
  return (
    <>
      {/* whitespace-pre on both: a space on either side of the split would otherwise be dropped at
          the edge of its box, gluing the two words together. */}
      <span className="shrink-0 whitespace-pre">{chars.slice(0, MIDDLE_TRUNCATE_HEAD).join("")}</span>
      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-pre text-left [direction:rtl]">
        <bdi dir="ltr">{chars.slice(MIDDLE_TRUNCATE_HEAD).join("")}</bdi>
      </span>
    </>
  );
}

function folderActivity(items: SessionInfo[], ids: ActivityIds): Activity | null {
  let top: Activity | null = null;
  for (const s of items) {
    if (s.state === "Restorable") continue; // a closed session isn't doing anything
    const a = sessionActivity(s, ids);
    if (a && (!top || FOLDER_URGENCY[a] > FOLDER_URGENCY[top])) top = a;
  }
  return top;
}

/** Whether a row is showing an activity mark. A closed session isn't, whatever the sets say. */
function hasMark(s: SessionInfo, ids: ActivityIds): boolean {
  return s.state !== "Restorable" && sessionActivity(s, ids) !== null;
}

/**
 * The activity filter's list: every session carrying a mark, plus what it takes to read them.
 *
 * - Their ancestors, so a nested session stays drawn under the session it belongs to rather than
 *   surfacing as a stray root — the parent is the context the mark is about.
 * - The session on screen. Looking at a finished one clears its tick a few seconds in, and the row
 *   you are reading vanishing from under the pointer is not what "seen" should do.
 *
 * Order is kept, so the folder sort and the drag lists see the same sequence they always do.
 */
function withActivity(
  sessions: SessionInfo[],
  ids: ActivityIds,
  keepId: string | null
): SessionInfo[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const keep = new Set<string>();
  for (const s of sessions) {
    if (!hasMark(s, ids) && s.id !== keepId) continue;
    // Walk up until the chain leaves the list or meets a row already kept (which covers a cycle).
    for (let cur: SessionInfo | undefined = s; cur && !keep.has(cur.id); ) {
      keep.add(cur.id);
      const parent = parentOf(cur);
      cur = parent ? byId.get(parent) : undefined;
    }
  }
  return sessions.filter((s) => keep.has(s.id));
}

/**
 * Props that stop a drag from starting inside a menu.
 *
 * These menus are absolutely positioned inside the row they belong to, and the row is a drag source
 * -- so a press-and-move on "Rename" picks the session up and offers to drop it somewhere, which is
 * never what a menu is for. `draggable={false}` does not help: the browser walks up from whatever
 * was pressed to the nearest *draggable* ancestor, and a false on the way past only means "not this
 * one" -- the walk carries on and finds the row. Claiming the drag instead makes the menu itself the
 * source, and cancelling it there ends the gesture before it starts.
 */
const cancelDrag = {
  draggable: true,
  onDragStart: (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  },
} as const;

/**
 * A row that opens a submenu, and the header that comes back from one.
 *
 * The submenu replaces the menu's contents rather than flying out beside it. A fly-out would have
 * to escape the sidebar's scroll container to be seen at all, and the sidebar can be dragged down to
 * 220px — narrower than the menu itself — so there is frequently no side to fly out to. Drilling in
 * keeps every entry at the width it already has, and works the same under a finger as under a
 * pointer, which a hover-opened fly-out does not.
 */
function SubmenuRow({
  label,
  icon,
  value,
  onOpen,
}: {
  label: string;
  icon: ReactNode;
  /** What is currently chosen, shown greyed after the label so the menu answers before it is opened. */
  value?: string | null;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
    >
      {icon}
      <span className="shrink-0">{label}</span>
      {value && (
        <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">{value}</span>
      )}
      <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground", !value && "ml-auto")} />
    </button>
  );
}

function SubmenuHeader({
  title,
  hint,
  onBack,
}: {
  title: string;
  /** The longer phrasing there was no room for on the row that opened this. */
  hint?: string;
  onBack: () => void;
}) {
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onBack();
        }}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-sm font-medium hover:bg-accent"
      >
        <ChevronLeft className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{title}</span>
      </button>
      {hint && <p className="px-3 pb-1 text-[10px] text-muted-foreground">{hint}</p>}
      <div className="my-1 border-t" />
    </>
  );
}

/**
 * Where a row or header popup opens, and how tall it may be.
 *
 * The lists scroll, and a popup positioned inside a scrolling box is clipped by that box — so the
 * room a menu has to grow into is the list's, not the window's, and measuring the window is what
 * once left a tall menu with its first few items cut off above the fold. The list marks itself with
 * `data-menu-bounds`; without one the document stands in, which is the right answer for a menu that
 * isn't inside anything scrollable.
 *
 * Flipping upwards only happens when there is genuinely more room up there: a menu too tall for
 * either direction is better left pointing down and scrolling than flipped into even less space.
 */
function useMenuPlacement(minHeight = 160) {
  const [dropUp, setDropUp] = useState(false);
  const [maxHeight, setMaxHeight] = useState<number | undefined>();
  const place = (el: HTMLElement, wanted: number) => {
    const box = el.getBoundingClientRect();
    const bounds = (el.closest("[data-menu-bounds]") ?? document.documentElement).getBoundingClientRect();
    const above = box.top - bounds.top;
    const below = bounds.bottom - box.bottom;
    const up = below < wanted && above > below;
    setDropUp(up);
    setMaxHeight(Math.max(minHeight, (up ? above : below) - 8));
  };
  return { dropUp, maxHeight, place };
}

/** Collapsible folder header shared by the grouped session and recent lists. */
/**
 * "Mark seen": clears the finished tick without opening anything — on a heading, every session under
 * it; on a session row, that one row. For the afternoon you already know how those runs went, where
 * opening each session just to dismiss a tick is busywork. Offered only while there is something to
 * clear, so its appearing is itself the signal, and it leads the hover actions, where the eye already
 * is after reading the tick.
 *
 * The hover class is looked up rather than built: each heading reveals its actions under its own
 * named group (a row uses the unnamed one it already has), and Tailwind only generates classes it
 * can find spelled out in the source.
 */
const MARK_SEEN_REVEAL = {
  ph: "group-hover/ph:inline-flex",
  vf: "group-hover/vf:inline-flex",
  gh: "group-hover/gh:inline-flex",
  row: "group-hover:inline-flex",
} as const;

function MarkSeenButton({
  count,
  onMarkSeen,
  reveal,
  label,
}: {
  count: number;
  onMarkSeen?: () => void;
  reveal: keyof typeof MARK_SEEN_REVEAL;
  /** Tooltip, where "n finished sessions" isn't what the button is about — a single row's tick. */
  label?: string;
}) {
  if (!onMarkSeen || count <= 0) return null;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onMarkSeen();
      }}
      title={label ?? `Mark ${count} finished session${count === 1 ? "" : "s"} as seen`}
      className={cn(
        "hidden shrink-0 text-emerald-600 hover:text-emerald-500 dark:text-emerald-500 [@media(hover:none)]:inline-flex",
        MARK_SEEN_REVEAL[reveal]
      )}
    >
      <CheckCheck className="size-3.5" />
    </button>
  );
}

function GroupHeader({
  dir,
  count,
  collapsed,
  onToggle,
  onNewSession,
  onRemove,
  activity,
  projects,
  projectId,
  onMoveToProject,
  onNewProject,
  dragProps,
  navProps,
  doneCount = 0,
  activeCount = 0,
  onMarkSeen,
}: {
  dir: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  // When provided (sessions view only), shows a plus button to start a session in this folder.
  onNewSession?: () => void;
  // When provided (sessions view only), adds a bulk-remove entry to the folder's actions menu.
  onRemove?: () => void;
  // The most urgent thing happening in this folder, shown as a dot — so a collapsed folder still
  // says that something inside wants you. Sessions view only; a recent preset has no state.
  activity?: Activity | null;
  // The projects this folder can be moved between, and the one it is in (null = none). The menu is
  // the non-drag way to do it — the only way at all on touch, where HTML5 drag never fires.
  projects: readonly Project[];
  projectId: string | null;
  onMoveToProject: (projectId: string | null) => void;
  onNewProject: () => void;
  // Makes the header the drag source for "drop this folder on a project".
  dragProps?: Record<string, unknown>;
  /**
   * Marks this header as a row of the sessions tree's keyboard navigation (see useTreeKeyNav).
   * Absent on the recents list, which has no arrow navigation of its own.
   */
  navProps?: Record<string, unknown>;
  // Finished-but-unseen sessions in this folder, and the way to clear them all. Sessions view only.
  doneCount?: number;
  /** Sessions in here doing anything at all — the other half of the done/active count. */
  activeCount?: number;
  onMarkSeen?: () => void;
}) {
  return (
    <div
      {...dragProps}
      {...navProps}
      title={dragProps ? "Drag onto a project to move this folder into it" : undefined}
      className="group/gh flex w-full items-center gap-1 rounded px-1 py-1 text-muted-foreground"
    >
      <button
        type="button"
        onClick={onToggle}
        title={dir}
        className="flex min-w-0 flex-1 items-center gap-1 text-left hover:text-foreground"
      >
        {collapsed ? (
          <ChevronRight className="size-3.5 shrink-0" />
        ) : (
          <ChevronDown className="size-3.5 shrink-0" />
        )}
        <span className="relative inline-flex shrink-0">
          <FolderTree className="size-3.5" />
          <HeadingActivityMark activity={activity ?? null} />
        </span>
        <span className="truncate font-mono text-xs font-medium">{folderLabel(dir)}</span>
        {/* Session count, right after the name rather than pinned to the row's edge: it reads as
            part of the folder's label, and never drifts away from it on a wide sidebar. */}
        <span className="shrink-0 font-mono text-xs tabular-nums">({count})</span>
      </button>
      <HeadingProgress done={doneCount} active={activeCount} />
      <MarkSeenButton count={doneCount} onMarkSeen={onMarkSeen} reveal="gh" />
      {onNewSession && (
        <button
          type="button"
          onClick={onNewSession}
          title="New session in this folder"
          className="hidden shrink-0 hover:text-foreground group-hover/gh:inline-flex"
        >
          <Plus className="size-3.5" />
        </button>
      )}
      <FolderMenu
        dir={dir}
        onRemove={onRemove}
        projects={projects}
        projectId={projectId}
        onMoveToProject={onMoveToProject}
        onNewProject={onNewProject}
      />
    </div>
  );
}

/**
 * Three-dots menu on a folder header. Holds the folder's own actions — copying its path, moving it
 * between projects, and (on the sessions list, where a bulk remove makes sense) removing the sessions
 * it contains. Destructive removal lives here rather than in the header strip so it can't be hit by a
 * stray click.
 */
function FolderMenu({
  dir,
  onRemove,
  projects,
  projectId,
  onMoveToProject,
  onNewProject,
}: {
  dir: string;
  onRemove?: () => void;
  projects: readonly Project[];
  projectId: string | null;
  onMoveToProject: (projectId: string | null) => void;
  onNewProject: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // Which level is showing; reset on close so reopening starts at the top.
  const [view, setView] = useState<"root" | "project">("root");
  const { dropUp, maxHeight, place } = useMenuPlacement();
  const shut = useCallback(() => {
    setOpen(false);
    setView("root");
  }, []);
  const ref = useDismissable<HTMLSpanElement>(open, shut);

  const project = projects.find((p) => p.id === projectId) ?? null;

  // Headers near the bottom of the list would push the menu past it, so flip it upwards. The root
  // level is three entries whatever the number of projects, now that the list is behind a submenu.
  const toggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    place(e.currentTarget, 180);
    setOpen((o) => !o);
  };

  const pick = (e: React.MouseEvent, run: () => void) => {
    e.stopPropagation();
    shut();
    run();
  };

  const copyPath = async () => {
    await writeToClipboard(dir);
    // Keep the menu open just long enough to show the copy landed.
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
      shut();
    }, 900);
  };

  return (
    <span
      ref={ref}
      // Marks the whole menu — trigger included, since that is what holds focus while it is open —
      // so the sessions tree's arrow keys leave it alone rather than roving off the row it stands on.
      data-menu-open={open ? "1" : undefined}
      // Hidden rather than transparent while idle, so it takes no width and the count next to it
      // sits flush right. Touch devices never fire hover, so the menu's only entry point has to
      // stay on screen there.
      className={cn(
        "relative items-center",
        open ? "flex" : "hidden group-hover/gh:flex [@media(hover:none)]:flex"
      )}
      onClick={(e) => e.stopPropagation()}
      {...cancelDrag}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        title="Folder actions"
        className={cn("shrink-0 rounded hover:text-foreground", open && "text-foreground")}
      >
        <MoreVertical className="size-3.5" />
      </button>
      {open && (
        <div
          style={{ maxHeight }}
          className={cn(
            "absolute right-0 z-50 w-52 overflow-y-auto rounded-md popover-edge bg-popover py-1 text-popover-foreground shadow-md",
            dropUp ? "bottom-full mb-1" : "top-full mt-1"
          )}
        >
          {view === "project" ? (
            <>
              <SubmenuHeader
                title="Move to project"
                hint={`Moves the folder — ${folderLabel(dir)}`}
                onBack={() => setView("root")}
              />
              {sortedByName(projects).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={(e) => pick(e, () => onMoveToProject(p.id))}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <ProjectGlyph project={p} className="size-3.5 shrink-0" />
                  <span className="truncate">{p.name}</span>
                  {projectId === p.id && (
                    <Check className="ml-auto size-3.5 shrink-0 text-emerald-500" />
                  )}
                </button>
              ))}
              {projectId && (
                <button
                  type="button"
                  onClick={(e) => pick(e, () => onMoveToProject(null))}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <Minus className="size-3.5 shrink-0" />
                  No project
                </button>
              )}
              <div className="my-1 border-t" />
              <button
                type="button"
                onClick={(e) => pick(e, onNewProject)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
              >
                <FolderPlus className="size-3.5" />
                New project…
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void copyPath();
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
              >
                {copied ? (
                  <Check className="size-3.5 text-emerald-500" />
                ) : (
                  <Copy className="size-3.5" />
                )}
                {copied ? "Copied!" : "Copy path"}
              </button>

              {/* The project list lives one level in, as it does on a session row: a dozen projects
                  inline turned a three-entry menu into a scrolling column. */}
              <SubmenuRow
                label="Move to project"
                icon={
                  <ProjectGlyph project={project} className="size-3.5 shrink-0" />
                }
                value={project?.name ?? "None"}
                onOpen={() => setView("project")}
              />

              {onRemove && (
                <button
                  type="button"
                  onClick={(e) => pick(e, onRemove)}
                  className="mt-1 flex w-full items-center gap-2 border-t px-3 py-1.5 pt-2 text-left text-sm text-destructive hover:bg-accent"
                >
                  <Trash2 className="size-3.5" />
                  Remove sessions…
                </button>
              )}
            </>
          )}

        </div>
      )}
    </span>
  );
}

/**
 * A virtual folder's header: the row that collects the sessions filed into it by hand. Deliberately
 * unlike the folder header above — a proportional name rather than a monospace path, and the icon
 * the user chose rather than a folder tree — because the two say different things about the rows
 * underneath, and a box you made yourself should be findable at a glance.
 *
 * Renaming is a double-click on the name, as on a session row. Colour and icon live in the project's
 * settings, behind the pencil: they are chosen once and then not touched, and a popup crowded onto a
 * sidebar header would be the wrong place to choose them.
 */
function VirtualFolderHeader({
  group,
  count,
  collapsed,
  onToggle,
  activity,
  onEdit,
  navProps,
  dragProps,
  doneCount = 0,
  activeCount = 0,
  onMarkSeen,
}: {
  group: ProjectGroup;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  activity?: Activity | null;
  onEdit: () => void;
  /** Makes the header the grab end of "drag this box to another place in the project". */
  dragProps?: Record<string, unknown>;
  /**
   * Marks this header as a row of the sessions tree's keyboard navigation (see useTreeKeyNav).
   * Absent on the recents list, which has no arrow navigation of its own.
   */
  navProps?: Record<string, unknown>;
  // Finished-but-unseen sessions filed in here, and the way to clear them all — see MarkSeenButton.
  doneCount?: number;
  onMarkSeen?: () => void;
  /** Sessions in here doing anything at all — the other half of the done/active count. */
  activeCount?: number;
}) {
  const Icon = groupIcon(group.icon);
  const accent = sessionColor(group.color);
  return (
    <div
      {...navProps}
      {...dragProps}
      className="group/vf flex w-full items-center gap-1 rounded px-1 py-1 text-muted-foreground"
    >
      <button
        type="button"
        onClick={onToggle}
        title={
          `${group.name} — a virtual folder; drag sessions onto it to file them here` +
          (dragProps ? ", or drag this header to move the box up or down the project" : "")
        }
        className="flex min-w-0 flex-1 items-center gap-1 text-left hover:text-foreground"
      >
        {collapsed ? (
          <ChevronRight className="size-3.5 shrink-0" />
        ) : (
          <ChevronDown className="size-3.5 shrink-0" />
        )}
        {/* Same deal as the project heading: the colour rides the icon, not the label, so a tinted
            name doesn't fight the session names below it. */}
        <span className="relative inline-flex shrink-0">
          <Icon className="size-3.5" style={accent ? { color: accent } : undefined} />
          <HeadingActivityMark activity={activity ?? null} />
        </span>
        {/* Not renameable in place, unlike a session row. A rename box here would have to live
            inside the fold button — an input nested in a button, and two stray folds fired by the
            double-click that opens it — and the name, the colour and the icon are one decision
            anyway. All three are behind the pencil, in the project's settings. */}
        <span className="truncate text-xs font-medium">{group.name}</span>
        <span className="shrink-0 font-mono text-xs tabular-nums">({count})</span>
      </button>
      {/* Outside the fold button and before the hover actions, so it sits at the heading's right
          edge -- away from the name and its count, which say what is filed here rather than how it
          is getting on. */}
      <HeadingProgress done={doneCount} active={activeCount} />
      <MarkSeenButton count={doneCount} onMarkSeen={onMarkSeen} reveal="vf" />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onEdit();
        }}
        title="Rename this group, or change its colour and icon"
        // Touch devices never fire hover, so the entry point has to stay on screen there.
        className="hidden shrink-0 hover:text-foreground group-hover/vf:inline-flex [@media(hover:none)]:inline-flex"
      >
        <Pencil className="size-3.5" />
      </button>
    </div>
  );
}

/**
 * A project's heading: the row that collects the folder groups linked to it. `project` is null for
 * the trailing "No project" section, which exists only once there is at least one project — as a
 * label for what is left over, and as the place to drag a folder to take it back out of a project.
 */
function ProjectHeader({
  project,
  count,
  collapsed,
  onToggle,
  onSettings,
  onNewSession,
  activity,
  navProps,
  postponed = 0,
  doneCount = 0,
  activeCount = 0,
  onMarkSeen,
}: {
  project: Project | null;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  // Sessions and recents both open the settings popup; absent on the "No project" section.
  onSettings?: () => void;
  // Start a session in this project (sessions view only) — the create dialog opens with the
  // project's folders offered as picks. Mirrors the plus on a folder header.
  onNewSession?: () => void;
  activity?: Activity | null;
  /**
   * Marks this header as a row of the sessions tree's keyboard navigation (see useTreeKeyNav).
   * Absent on the recents list, which has no arrow navigation of its own.
   */
  navProps?: Record<string, unknown>;
  // Postponed messages stashed across the whole project, so a collapsed one still says they are
  // there — the per-session badges it is a total of are hidden inside it.
  postponed?: number;
  // Sessions in here that finished while you were away, and the way to acknowledge all of them at
  // once. Only offered while there is at least one, so the button is itself the "there's something
  // to clear" signal rather than a control that is usually inert.
  doneCount?: number;
  /** Sessions in here doing anything at all — the other half of the done/active count. */
  activeCount?: number;
  onMarkSeen?: () => void;
}) {
  return (
    <div
      {...navProps}
      className="group/ph flex w-full items-center gap-1 rounded px-1 py-1 text-muted-foreground"
    >
      <button
        type="button"
        onClick={onToggle}
        title={project ? project.name : "Folders that aren’t in a project"}
        className="flex min-w-0 flex-1 items-center gap-1 text-left hover:text-foreground"
      >
        {collapsed ? (
          <ChevronRight className="size-3.5 shrink-0" />
        ) : (
          <ChevronDown className="size-3.5 shrink-0" />
        )}
        <span className="relative inline-flex shrink-0">
          {project ? (
            // The colour rides on the icon rather than the text: a tinted label fights the folder
            // names underneath it for attention, and at this size a solid glyph reads better anyway.
            <ProjectGlyph project={project} className="size-3.5" />
          ) : (
            <Minus className="size-3.5" />
          )}
          <HeadingActivityMark activity={activity ?? null} />
        </span>
        <span
          className={cn(
            "truncate text-xs font-semibold",
            project ? "text-foreground" : "font-medium italic"
          )}
        >
          {project ? project.name : "No project"}
        </span>
        <span className="shrink-0 font-mono text-xs tabular-nums">({count})</span>
        {/* Kept with the count rather than pinned to the row's edge, for the reason the count is:
            both say what is inside, and on a wide sidebar an edge-pinned number drifts away from
            the name it belongs to. Smaller than the badge on a row so the heading keeps its height. */}
        {postponed > 0 && (
          <Badge
            variant="secondary"
            className="gap-0.5 px-1 py-0 text-[10px]"
            title={`${postponed} postponed message${postponed === 1 ? "" : "s"} in this project`}
          >
            <Inbox className="size-2.5" />
            {postponed}
          </Badge>
        )}
      </button>
      {/* Outside the fold button and before the hover actions, so it sits at the heading's right
          edge -- away from the name and its count, which say what is in the project rather than how
          it is getting on. */}
      <HeadingProgress done={doneCount} active={activeCount} />
      <MarkSeenButton count={doneCount} onMarkSeen={onMarkSeen} reveal="ph" />
      {onNewSession && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onNewSession();
          }}
          title="New session in this project"
          className="hidden shrink-0 hover:text-foreground group-hover/ph:inline-flex [@media(hover:none)]:inline-flex"
        >
          <Plus className="size-3.5" />
        </button>
      )}
      {onSettings && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSettings();
          }}
          title="Project settings"
          // Touch devices never fire hover, so the settings entry point has to stay on screen there.
          className="hidden shrink-0 hover:text-foreground group-hover/ph:inline-flex [@media(hover:none)]:inline-flex"
        >
          <Settings className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/**
 * A list under its project headings: one section per project (even an empty one — it has to be there
 * to drop a folder onto), then a section for whatever is left over. Shared by all three lists, which
 * differ only in what sits under a heading: folder groups in the grouped sessions and recents lists,
 * the sessions themselves in the flat one.
 *
 * With no projects at all this draws nothing of its own: the caller renders its list as it always
 * did, so the feature is invisible until it is used.
 */
function ProjectSections<T>({
  sections,
  collapsed,
  onToggle,
  onSettings,
  onNewSession,
  dnd,
  sessionDrop,
  before,
  renderItems,
  bodyClassName,
  navRow,
  countOf,
  activityOf,
  postponedOf,
  doneOf,
  activeOf,
  onMarkSeen,
}: {
  sections: ProjectSection<T>[];
  /** Collapsed project ids ("" for the "No project" section). */
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onSettings: (project: Project) => void;
  /** Sessions view only: start a session in this project (absent on the recents list). */
  onNewSession?: (project: Project) => void;
  /**
   * Folder drag-and-drop, where the list has folder headers to drag. The flat list has none — a
   * session row is not a folder — so it passes nothing and its sections are simply not drop targets.
   */
  dnd?: ReturnType<typeof useFolderDrag>;
  /**
   * Makes the section itself the place a session is dragged to when it is leaving a virtual folder —
   * "out of the box, back into the project". Sessions view only; there is nothing to file on the
   * recents list.
   */
  sessionDrop?: (project: Project | null) => { props: Record<string, unknown>; over: boolean };
  /**
   * The project's virtual folders, drawn above its own items — the hand-made grouping first, then
   * whatever the paths still say. Returns null when there are none to draw, which is what lets the
   * empty-section placeholder below know it is still the only thing in here.
   */
  before?: (project: Project | null) => ReactNode;
  /**
   * Draws a section's contents; takes the whole set so the flat list can build one fork tree, and
   * the section's project so it can drop what the heading already says.
   */
  renderItems: (items: T[], project: Project | null) => ReactNode;
  /**
   * Layout of a section's contents: the spacing between whatever renderItems draws, and how far it
   * is indented under the heading. Folder groups sit further apart than rows, and rows have to carry
   * the indent a folder header would otherwise have given them.
   */
  bodyClassName?: string;
  /**
   * Keyboard-navigation props for a project heading (see useTreeKeyNav). Passed by the sessions
   * list, whose headings are rows of its tree; the recents list has no arrow navigation and passes
   * nothing, so its headings stay plain.
   */
  navRow?: (project: Project | null) => Record<string, unknown> | undefined;
  /**
   * What the number after the project name counts. Defaults to the number of items — anything that
   * also draws virtual folders has to add those in itself, since their sessions are not in `items`.
   */
  countOf?: (items: T[], project: Project | null) => number;
  activityOf?: (items: T[], project: Project | null) => Activity | null;
  /** Postponed messages stashed inside the section. Sessions view only; a recent preset has none. */
  postponedOf?: (items: T[], project: Project | null) => number;
  /** Finished-but-unseen sessions inside the section, for its "mark all seen". Sessions view only. */
  doneOf?: (items: T[], project: Project | null) => string[];
  /** Sessions inside the section doing anything at all, for the heading's done/active count. */
  activeOf?: (items: T[], project: Project | null) => number;
  onMarkSeen?: (ids: string[]) => void;
}) {
  return (
    <div className="space-y-2">
      {sections.map(({ project, items }) => {
        const key = project?.id ?? "";
        const isCollapsed = collapsed.has(key);
        const drop = sessionDrop?.(project);
        const groups = before?.(project) ?? null;
        const over = (dnd?.isOver(project?.id ?? null) ?? false) || (drop?.over ?? false);
        const done = doneOf?.(items, project) ?? [];
        return (
          <div
            key={key}
            {...mergeProps(dnd?.sectionProps(project?.id ?? null), drop?.props)}
            className={cn(
              "rounded-md transition-colors",
              // Where the folder (or the session leaving a virtual folder) would land. A tint on the
              // whole section rather than a line: it joins the project, it doesn't take a position in it.
              over && "bg-accent ring-1 ring-primary"
            )}
          >
            <ProjectHeader
              project={project}
              count={countOf ? countOf(items, project) : items.length}
              collapsed={isCollapsed}
              onToggle={() => onToggle(key)}
              onSettings={project ? () => onSettings(project) : undefined}
              onNewSession={project && onNewSession ? () => onNewSession(project) : undefined}
              activity={activityOf?.(items, project) ?? null}
              navProps={navRow?.(project)}
              postponed={postponedOf?.(items, project) ?? 0}
              doneCount={done.length}
              activeCount={activeOf?.(items, project) ?? 0}
              onMarkSeen={onMarkSeen && done.length > 0 ? () => onMarkSeen(done) : undefined}
            />
            {!isCollapsed && groups && (
              // The virtual folders sit at the project's own indent in both views, not the body's:
              // the flat list pulls its rows further in (they carry the indent a folder header would
              // have given them), and a box is not a row.
              <div className="mt-0.5 space-y-2 pl-[18px]">{groups}</div>
            )}
            {!isCollapsed && (
              // Far enough in that what a project holds reads as held by it: a heading carries a
              // chevron and an icon before its name, and contents that start under the chevron look
              // like the next thing in the list rather than the inside of this one. Everything a
              // section draws steps in by the same amount, so the columns within it are unchanged.
              //
              // Under a virtual folder the gap does the work a heading would: the flat list draws its
              // rows at exactly the indent a box's rows sit at, so without a break the first loose
              // row reads as the last row of the box above it.
              <div className={cn(groups ? "mt-2" : "mt-0.5", bodyClassName ?? "space-y-2 pl-[18px]")}>
                {items.length > 0 ? (
                  renderItems(items, project)
                ) : groups ? null : dnd ? (
                  // Empty, in a list you can drop on: the placeholder is what says a folder can go
                  // here, and is the target worth aiming at. Where nothing can be dropped (the flat
                  // list) it says nothing the heading's own "(0)" doesn't, so it isn't drawn — an
                  // empty project is then one quiet line rather than a box of text.
                  <p className="rounded border border-dashed px-2 py-2 text-center text-[10px] text-muted-foreground">
                    {project?.folders.length
                      ? "No sessions in this project’s folders yet"
                      : "No folders yet — link one in its settings, or drag a folder group here"}
                  </p>
                ) : null}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Combine two sets of DOM props, calling both handlers where each side defines one. The sidebar has
 * three drags in flight over the same elements — reorder a row, move a folder, file a session — and
 * a project section is a drop target for two of them, so spreading one set over the other would
 * silently drop half the listeners.
 */
function mergeProps(
  ...sets: (Record<string, unknown> | undefined)[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const set of sets) {
    if (!set) continue;
    for (const [key, value] of Object.entries(set)) {
      const prev = out[key];
      out[key] =
        typeof prev === "function" && typeof value === "function"
          ? (...args: unknown[]) => {
              (prev as (...a: unknown[]) => void)(...args);
              (value as (...a: unknown[]) => void)(...args);
            }
          : value;
    }
  }
  return out;
}

/**
 * Drag a session row into a virtual folder — and out of one, onto the project section around it. The
 * dragged session rides in a ref for the same reason the folder drag's path does: a folder header
 * being dragged past a virtual folder must not read as a session, and a ref answers "is a session in
 * flight?" without inspecting dataTransfer mid-drag.
 *
 * Two predicates, not one, and the difference between them is what stops the gesture from eating
 * itself. A virtual folder sits inside the project section, and the section is a target for the very
 * same drag — it means "take this out of its box". So a box has to *claim* every drag it is the
 * innermost target for, including the ones that would change nothing, and swallow the event even
 * then: letting a drop bubble out of the box it landed in is how reordering two rows inside a box
 * would quietly unfile the row instead.
 *
 * - `claims` — is this drag any of this target's business? (a box: only its own project's rows; a
 *   project heading: every row, since one it does not own is one it can adopt)
 * - `changes` — would dropping here actually alter anything? Only then does the target take the drop
 *   and light up; otherwise it stays quiet and the browser shows the "no" cursor.
 * - `perform` — what the drop means here. It differs per target, not per drag, which is why it is
 *   passed with the target rather than held by the hook.
 */
function useSessionDrag() {
  const dragged = useRef<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  // Whether a session is in flight — state, unlike the ref above, because the row targets are drawn
  // only while one is: an overlay that sat on every row permanently would swallow the clicks meant
  // for the row underneath it. One render at each end of a drag, which is what the ref avoids
  // paying per dragover.
  const [active, setActive] = useState(false);

  const end = () => {
    dragged.current = null;
    setActive(false);
    setOver(null);
  };

  return {
    active,
    rowProps: (id: string) => ({
      draggable: true,
      onDragStart: () => {
        dragged.current = id;
        setActive(true);
      },
      onDragEnd: end,
    }),
    isOver: (key: string) => over === key,
    targetProps: (
      key: string,
      claims: (sessionId: string) => boolean,
      changes: (sessionId: string) => boolean,
      perform: (sessionId: string) => void
    ) => ({
      onDragOver: (e: React.DragEvent) => {
        const id = dragged.current;
        if (!id || !claims(id)) return;
        e.stopPropagation();
        if (!changes(id)) return; // in scope, but there is nothing here to do
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(key);
      },
      onDragLeave: (e: React.DragEvent) => {
        // See the folder drag's dragleave: crossing between a target's own children fires this too.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setOver((cur) => (cur === key ? null : cur));
      },
      onDrop: (e: React.DragEvent) => {
        const id = dragged.current;
        if (!id || !claims(id)) return;
        // Swallowed whether or not it does anything — a row dropped inside its own box got here
        // through the row's reorder handler, and the section outside must not also read it as
        // "dropped on the project", which would take the row out of the box the user was arranging.
        e.stopPropagation();
        if (!changes(id)) return;
        e.preventDefault();
        end();
        perform(id);
      },
    }),
  };
}

/**
 * Drag a folder group onto a project to link it (and onto "No project" to take it back out). Returns
 * props for the two ends: `folderProps` on a folder header, `sectionProps` on a project section.
 *
 * The dragged path rides in a ref rather than the drag payload for the same reason the row reorder
 * does it: a session row being dragged past a project section must not read as a droppable folder,
 * and a ref answers "is a folder in flight?" without having to inspect dataTransfer mid-drag.
 */
function useFolderDrag(onDropFolder: (dir: string, projectId: string | null) => void) {
  const dragged = useRef<string | null>(null);
  // Key of the section a folder is hovering: a project id, or "" for the "No project" section.
  const [over, setOver] = useState<string | null>(null);

  const end = () => {
    dragged.current = null;
    setOver(null);
  };

  return {
    folderProps: (dir: string) => ({
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        dragged.current = dir;
        e.dataTransfer.effectAllowed = "move";
        // A folder header sits inside a project section, which is itself a drop target — let the
        // section see the drag, but don't let a parent list claim it as its own drag source.
        e.stopPropagation();
      },
      onDragEnd: end,
    }),
    isOver: (projectId: string | null) => over === (projectId ?? ""),
    sectionProps: (projectId: string | null) => ({
      onDragOver: (e: React.DragEvent) => {
        if (!dragged.current) return; // not a folder in flight (a session row, or something else)
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(projectId ?? "");
      },
      onDragLeave: (e: React.DragEvent) => {
        // dragleave also fires when the pointer crosses between the section's own children, which
        // would blink the highlight off and on for a drag that never left. Only a move to something
        // outside the section counts. (Leaving for *another* section is already handled: that one's
        // dragover has claimed `over` by then, and the guard below leaves it alone.)
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setOver((cur) => (cur === (projectId ?? "") ? null : cur));
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const dir = dragged.current;
        end();
        if (dir) onDropFolder(dir, projectId);
      },
    }),
  };
}

// Which folder groups are collapsed is a per-browser preference, remembered across refreshes (like
// the grouped-vs-flat toggle). Stored as the list of collapsed dir paths; anything absent is expanded.
const COLLAPSED_KEY = "claudeweb.sessionsCollapsedGroups";
function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}
function saveCollapsed(set: Set<string>) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]));
  } catch {
    /* storage disabled — preference is best-effort */
  }
}

// Which projects are folded away, by project id — the same kind of per-browser preference as the
// folder collapse above, in its own key so the two can't collide (a project id is not a path).
const COLLAPSED_PROJECTS_KEY = "claudeweb.collapsedProjects";
function loadCollapsedProjects(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_PROJECTS_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}
function saveCollapsedProjects(set: Set<string>) {
  try {
    localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...set]));
  } catch {
    /* storage disabled — preference is best-effort */
  }
}

/**
 * Shared collapse-set state hook for grouped lists; persists the set so it survives a page refresh.
 * Used twice over: once for folder groups (keyed by path) and once for projects (keyed by id).
 */
function useCollapsedSet(load: () => Set<string>, save: (set: Set<string>) => void) {
  const [collapsed, setCollapsed] = useState<Set<string>>(load);
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      save(next);
      return next;
    });
  // Fold or unfold every given key, leaving the rest of the set alone. Only the keys on screen are
  // passed in, and the button must not reach past them: the flat list's fold-all would otherwise
  // quietly unfold every folder group the grouped list had folded away, since both live in this set.
  const setAll = (keys: string[], collapse: boolean) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      for (const key of keys) {
        if (collapse) next.add(key);
        else next.delete(key);
      }
      save(next);
      return next;
    });
  return { collapsed, toggle, setAll };
}

// Which sessions have their forks folded away. Per-browser like the folder-group collapse, but keyed
// by session id — and ids are minted fresh on every reopen/auto-resume, so the set is pruned against
// the live list on each write to stop it accumulating entries for sessions that no longer exist.
const COLLAPSED_FORKS_KEY = "claudeweb.collapsedForks";
/**
 * How a row of the sessions tree names itself to the keyboard navigation. Which fold a → or ← acts
 * on can't be read off the row — a project heading, a folder header and a session each keep their
 * collapsed state in a different set — so the kind rides in the key alongside the id.
 *
 * A folder's key is a path, which on Windows has a colon of its own, so the split below takes the
 * first one only.
 */
const navKey = {
  project: (id: string) => `project:${id}`,
  /** A folder header or a virtual folder: both fold out of the same set, keyed the same way. */
  fold: (key: string) => `fold:${key}`,
  session: (id: string) => `session:${id}`,
};

function parseNavKey(key: string): { kind: string; id: string } {
  const at = key.indexOf(":");
  return { kind: key.slice(0, at), id: key.slice(at + 1) };
}

function loadCollapsedForks(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_FORKS_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}
function saveCollapsedForks(set: Set<string>) {
  try {
    localStorage.setItem(COLLAPSED_FORKS_KEY, JSON.stringify([...set]));
  } catch {
    /* storage disabled — preference is best-effort */
  }
}

export function SessionSidebar({
  sessions,
  activityIds,
  onMarkSeen,
  activeId,
  onSelect,
  onNewInFolder,
  onRevealFolder,
  onNewInProject,
  onStop,
  onRemove,
  onClone,
  onFork,
  onRestore,
  onRename,
  onRemoveSessions,
  onLogout,
  recents,
  onReuse,
  onRemoveRecent,
  onReorderRecent,
  onSearch,
  onSchedules,
  tab,
  onTabChange,
  projects,
  onProjectsChange,
}: {
  sessions: SessionInfo[];
  // Who is busy / waiting on you / compacting / finished-but-unseen, in one bag — see ActivityIds.
  activityIds: ActivityIds;
  // Clear the finished-but-unseen tick on these sessions without opening them (a heading's
  // "mark all seen"). Owned by App with the set itself, so both sidebar mounts agree.
  onMarkSeen: (ids: Iterable<string>) => void;
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewInFolder: (dir: string) => void; // start a session in a folder (hover action on group headers)
  onRevealFolder: (dir: string) => void; // show a folder in the whole-server Files tree
  // Start a session in a project: the create dialog opens with its linked folders offered as picks.
  onNewInProject: (project: Project) => void;
  // End a running session's process, leaving the row in the list as a closed session.
  onStop: (id: string) => void;
  // Take a session out of the list for good; it lands in the Recent tab as a launch preset.
  onRemove: (id: string) => void;
  onClone: (s: SessionInfo) => void;
  onFork: (s: SessionInfo) => void; // branch this session's conversation into a new one
  onRestore: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onRemoveSessions: (ids: string[]) => void;
  onLogout: () => void;
  recents: RecentSession[];
  onReuse: (r: RecentSession) => void;
  onRemoveRecent: (r: RecentSession) => void;
  onReorderRecent: (from: number, to: number) => void;
  // Open the search popup (sessions + recents). Owned by App: the popup is also opened by a global
  // hotkey, which must work with the sidebar collapsed, and the sidebar is mounted twice (desktop
  // column + mobile drawer) so it can't own the dialog without mounting two copies.
  onSearch: () => void;
  // Open the schedules popup — the clocks that start sessions with nobody at the machine. Owned by
  // App like the search one above, and for the same reason: this component is mounted twice. Called
  // with a session to pre-fill a schedule that continues that conversation, or with nothing to open
  // the list.
  onSchedules: (target?: { conversationId: string; name: string }) => void;
  // Sessions/Recent list tab. Owned by App so creating a session can pull the sidebar back to the
  // list, and so the desktop sidebar and the mobile drawer stay on the same tab.
  tab: SessionListTab;
  onTabChange: (tab: SessionListTab) => void;
  // Projects, and the setter for the full list every mutation answers with. Owned by App for the
  // same reason the tab is: the sidebar is mounted twice (desktop column + mobile drawer), and both
  // copies have to show the same projects the moment one of them changes them.
  projects: Project[];
  onProjectsChange: (projects: Project[]) => void;
}) {
  const setTab = onTabChange;
  const confirm = useConfirm();
  const [grouped, setGrouped] = useState<boolean>(loadGrouped);
  const [filter, setFilter] = useState<SessionFilter>(loadFilter);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Folder whose bulk-remove popup is open (its normalized dirKey), or null.
  const [removeDir, setRemoveDir] = useState<string | null>(null);
  // Session whose postponed pool is being read, or null. Held by id rather than by the row object,
  // so the dialog follows the session through the list's next refresh instead of showing a copy of
  // a row that has since changed -- or outliving one that has gone.
  const [postponedId, setPostponedId] = useState<string | null>(null);
  const { collapsed, toggle: toggleGroup, setAll: setAllGroups } = useCollapsedSet(
    loadCollapsed,
    saveCollapsed
  );
  const {
    collapsed: collapsedProjects,
    toggle: toggleProject,
    setAll: setAllProjects,
  } = useCollapsedSet(loadCollapsedProjects, saveCollapsedProjects);
  // Whose settings popup is open, by id — an id rather than the project itself, so the popup keeps
  // showing the live folder list as it is edited (linking a folder returns a new project object; a
  // captured one would go stale the moment the first change landed). A null id is the
  // create-a-new-one form, with `folder` set when it was started from a folder.
  const [editing, setEditing] = useState<
    { id: string | null; folder?: string; group?: string } | null
  >(null);
  // A new virtual folder being made from a session's own menu: the project it goes in, and the
  // session that goes into it the moment it exists. The project is held by id and resolved from the
  // live list, so an edit from another tab can't leave the dialog writing to a project that is gone.
  const [newGroupFor, setNewGroupFor] = useState<{ projectId: string; sessionId: string } | null>(
    null
  );
  // Sessions whose forks are folded away (by session id).
  const [collapsedForks, setCollapsedForks] = useState<Set<string>>(loadCollapsedForks);
  // The manual row order the user dragged into place (per folder). Per-browser, like the collapse
  // state above — unlike a pin, an arrangement really is this browser's view of the list.
  const [order, setOrder] = useState<SessionOrder>(loadSessionOrder);

  const aliveIds = () => new Set(sessions.map((s) => s.id));

  // Which rows are pinned comes off the session list itself: the server keys pins by conversation, so
  // this stays right through a reopen and matches what every other browser is showing.
  const pinned = useMemo(
    () => new Set(sessions.filter((s) => s.pinned).map((s) => s.id)),
    [sessions]
  );

  // No optimistic flip: the server raises its change event as it writes, so the updated list is
  // pushed down the events socket immediately — and to every other browser at the same time.
  const togglePin = (id: string, pinned: boolean) => {
    void api.setPinned(id, pinned).catch(() => {});
  };

  // Drop of a dragged row: rewrite that folder's order from what is on screen, so every row in it
  // gets an explicit place. A session created later isn't in the list and lands back on top.
  const reorderFolder = (list: string, from: number, to: number, ids: string[]) =>
    setOrder((prev) => saveSessionOrder({ ...prev, [list]: move(ids, from, to) }, aliveIds()));

  const toggleForks = (id: string) =>
    setCollapsedForks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      // Drop ids that aren't in the list any more, so a long-lived browser doesn't keep collapse
      // state for every session it has ever seen.
      const alive = new Set(sessions.map((s) => s.id));
      for (const kept of next) if (!alive.has(kept)) next.delete(kept);
      saveCollapsedForks(next);
      return next;
    });

  // The scrolling list, which is the tree's single tab stop — see useTreeKeyNav.
  const treeRef = useRef<HTMLDivElement>(null);

  /**
   * Walk the list with the arrow keys. ↑/↓ step row to row over everything on screen — project
   * headings, folder headers, virtual folders and the sessions themselves — → and ← unfold and fold
   * whatever the row holds, Home/End jump to the ends, and Enter opens a session.
   *
   * Unlike the file trees, arrowing onto a row does *not* open it: a session is a terminal to attach
   * to, not a file to preview, so stepping past one has to be free. Enter is the thing that opens.
   */
  const treeKeys = useTreeKeyNav({
    containerRef: treeRef,
    onToggleDir: (key) => {
      const { kind, id } = parseNavKey(key);
      if (kind === "project") toggleProject(id);
      else if (kind === "fold") toggleGroup(id);
      else if (kind === "session") toggleForks(id);
    },
    onActivateFile: (key) => onSelect(parseNavKey(key).id),
  });

  // Sessions shown after applying the filter ("active" = running only, "activity" = carrying a mark).
  // Recents aren't filtered (they're presets, not live sessions).
  const visibleSessions = useMemo(
    () =>
      filter === "active"
        ? sessions.filter((s) => s.state === "Running")
        : filter === "activity"
          ? withActivity(sessions, activityIds, activeId)
          : sessions,
    [filter, sessions, activityIds, activeId]
  );
  const activeCount = sessions.filter((s) => s.state === "Running").length;
  const activityCount = sessions.filter((s) => hasMark(s, activityIds)).length;
  // Any filter but "all" hides what has nothing to show under it: empty projects, empty boxes.
  const narrowed = filter !== "all";
  /**
   * The sessions filed into a virtual folder by hand, and everything the folder grouping still owns.
   * A filed session is drawn in its box and nowhere else — showing it in both places would double
   * every count and make the grouping look like a tag rather than a move.
   *
   * A membership only counts inside the project that owns the group (see groupForSession), so a
   * folder that has since moved projects quietly hands its sessions back to the folder grouping.
   */
  const filed = useMemo(() => {
    const byGroup = new Map<string, SessionInfo[]>();
    const rest: SessionInfo[] = [];
    for (const s of visibleSessions) {
      const g = groupForSession(s, projects);
      if (!g) {
        rest.push(s);
        continue;
      }
      const list = byGroup.get(g.id);
      if (list) list.push(s);
      else byGroup.set(g.id, [s]);
    }
    return { byGroup, rest };
  }, [visibleSessions, projects]);

  // The grouped list, built once: pins first, then the hand-arranged order, then newest-first for
  // anything the user hasn't placed. `rootIds` is the drag list — top-level rows only, since a fork
  // is drawn under its parent wherever the parent sits — and a drop rewrites exactly that list.
  const groups = useMemo(
    () =>
      groupByFolder(filed.rest).map((g) => {
        const key = dirKey(g.dir);
        const nodes = forkTree(
          sortFolderSessions(g.items.map(({ item }) => item), pinned, order[key]),
          collapsedForks
        );
        return {
          dir: g.dir,
          key,
          count: g.items.length,
          items: g.items.map(({ item }) => item),
          nodes,
          rootIds: nodes.filter((n) => n.depth === 0).map((n) => n.session.id),
        };
      }),
    [filed, pinned, order, collapsedForks]
  );

  /**
   * A project's virtual folders as lists to draw: the same shape a folder group has, so the rows,
   * the fork nesting and the drag-to-reorder inside one are the same code. The order key is the
   * group rather than a path, and prefixed so it can't collide with either of the other two kinds.
   */
  const virtualGroups = useMemo(
    () =>
      new Map(
        projects.map((p) => [
          p.id,
          p.groups.map((group) => {
            const items = filed.byGroup.get(group.id) ?? [];
            const key = `group:${group.id}`;
            const nodes = forkTree(sortFolderSessions(items, pinned, order[key]), collapsedForks);
            return {
              group,
              key,
              count: items.length,
              items,
              nodes,
              rootIds: nodes.filter((n) => n.depth === 0).map((n) => n.session.id),
            };
          }),
        ])
      ),
    [projects, filed, pinned, order, collapsedForks]
  );

  /**
   * The virtual folders actually drawn under a project. Under the active-only filter an empty one is
   * a heading over nothing, the same call the empty projects get; with the filter off it stays, as
   * the thing you drop a session onto.
   */
  const shownGroups = (project: Project | null) => {
    const gs = project ? virtualGroups.get(project.id) ?? [] : [];
    return narrowed ? gs.filter((g) => g.count > 0) : gs;
  };

  // The same groups, filed under the project each one's folder belongs to (see sectionsByProject).
  const sessionSections = useMemo(
    () => sectionsByProject(groups, projects, (g) => g.dir),
    [groups, projects]
  );
  /**
   * The flat list's sections: the sessions themselves under their project, no folder headings in
   * between. Each carries its own fork tree and drag list, exactly like a folder group — a section is
   * a list you can arrange, and the whole point of the flat view is that a project heading is the
   * only structure over it.
   *
   * The order key is the project rather than a folder (a project spans several), and it is prefixed
   * so it can never collide with a grouped list's key, which is a path. With no projects at all
   * sectionsByProject returns a single null-project section — the plain flat list, arrangeable on the
   * same terms.
   */
  const flatSections = useMemo(
    () =>
      sectionsByProject(filed.rest, projects, (s) => s.workingDirectory).map((sec) => {
        const key = `project:${sec.project?.id ?? ""}`;
        const nodes = forkTree(sortFolderSessions(sec.items, pinned, order[key]), collapsedForks);
        return {
          ...sec,
          key,
          nodes,
          rootIds: nodes.filter((n) => n.depth === 0).map((n) => n.session.id),
        };
      }),
    [filed, pinned, projects, order, collapsedForks]
  );

  // Every arrangeable list on screen, by its key, so a drop can find the row order it is rewriting
  // without caring which view produced it. Grouped keys are paths, flat keys are "project:<id>".
  const rootIdsByList = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const g of groups) map[g.key] = g.rootIds;
    for (const sec of flatSections) map[sec.key] = sec.rootIds;
    for (const gs of virtualGroups.values()) for (const g of gs) map[g.key] = g.rootIds;
    return map;
  }, [groups, flatSections, virtualGroups]);

  /**
   * Sections to actually draw. Under the active-only filter an empty project is a heading over
   * nothing — the sessions that justify it exist, they just aren't running — so it goes. With the
   * filter off it stays: an empty project is still where you drop a folder and reach its settings,
   * and hiding it would leave a project you just made nowhere to be seen.
   */
  const shown = <T,>(sections: ProjectSection<T>[]) =>
    narrowed
      ? sections.filter((s) => s.items.length > 0 || shownGroups(s.project).length > 0)
      : sections;

  // ---- What the collapse/expand-all button acts on -----------------------------------------------
  // Two kinds of heading fold: folder groups, which only the grouped lists have, and project
  // headings, which both lists have — so the button belongs in the flat list too, where projects are
  // the one thing it can fold. It flips to "expand" once everything on screen is already folded.
  const visibleGroups = grouped
    ? tab === "sessions"
      ? groups.map((g) => ({ dir: g.dir }))
      : groupByFolder(recents).map((g) => ({ dir: g.dir }))
    : [];
  // A folder header merged into its project heading isn't on screen to fold, so the button must not
  // wait on it to call everything collapsed — the project's own chevron is what folds those rows.
  const visibleDirs = (
    projects.length
      ? sectionsByProject(visibleGroups, projects, (g) => g.dir).flatMap((sec) =>
          // A folded project's own headings aren't on screen, so the button must not wait on them
          // to call everything collapsed — its chevron is what folds them.
          collapsedProjects.has(sec.project?.id ?? "") ||
          mergesFolderHeader(
            sec.project,
            sec.items.map((g) => g.dir),
            tab === "sessions" && shownGroups(sec.project).length > 0
          )
            ? []
            : sec.items
        )
      : visibleGroups
  ).map((g) => g.dir);
  // Virtual folders fold on the same terms and out of the same set (a group key is not a path), and
  // unlike the folder headers they are on screen in the flat view too — a box is the one piece of
  // structure that view keeps.
  const virtualKeys =
    tab === "sessions"
      ? projects.flatMap((p) =>
          collapsedProjects.has(p.id) ? [] : shownGroups(p).map((g) => g.key)
        )
      : [];
  // The project headings actually on screen. Taken from the sections the list will draw, so the
  // button doesn't wait on a heading that isn't there (an empty "No project", say) to call itself done.
  const headingKeys = <T,>(secs: ProjectSection<T>[]) =>
    shown(secs).map((sec) => sec.project?.id ?? "");
  const projectKeys =
    tab === "sessions"
      ? grouped
        ? headingKeys(sessionSections)
        : headingKeys(flatSections)
      : projects.length
        ? [...projects.map((p) => p.id), ""]
        : [];
  // Everything on screen that folds out of the folder set — the folder headers (grouped view only)
  // and the virtual folders (both views).
  const foldableKeys = [...visibleDirs, ...virtualKeys];
  const canFoldAll = foldableKeys.length > 0 || projectKeys.length > 0;
  const allCollapsed =
    canFoldAll &&
    foldableKeys.every((k) => collapsed.has(k)) &&
    projectKeys.every((k) => collapsedProjects.has(k));
  const toggleAllGroups = () => {
    setAllGroups(foldableKeys, !allCollapsed);
    setAllProjects(projectKeys, !allCollapsed);
  };

  const editingProject = editing?.id ? projects.find((p) => p.id === editing.id) ?? null : null;

  // Drag-to-reorder within one list — a folder group in the grouped view, a project section in the
  // flat one. The list key scopes the drag, so a row can't be dropped into a list it isn't part of.
  const dnd = useDragReorder((from, to, list) => {
    const ids = rootIdsByList[list];
    if (!ids) return;
    // Pins outrank the manual order, so a row dropped on the other side of the pinned block would
    // be sorted straight back where it came from. It carries its pin across instead — see
    // pinAfterMove — which is what makes the drop stick.
    const id = ids[from];
    const pin = pinAfterMove(ids, from, to, pinned);
    if (id && pin !== pinned.has(id)) togglePin(id, pin);
    reorderFolder(list, from, to, ids);
  });

  /**
   * Link a folder to a project, or (with a null project) take it out of the one it is in.
   *
   * Taking it out has a wrinkle: a folder can be in a project through an *ancestor* link rather than
   * its own path, and the model has no way to say "everything under C:\git except this one". So the
   * only honest move is to unlink the ancestor — which takes its siblings out too — and that is worth
   * asking about first rather than doing quietly.
   */
  const moveFolderToProject = async (dir: string, projectId: string | null) => {
    const current = projectForDir(dir, projects);
    if (current?.id === (projectId ?? "")) return; // already where it was dropped
    try {
      if (projectId) {
        onProjectsChange(await api.addProjectFolder(projectId, dir));
        return;
      }
      if (!current) return;
      // The deepest of this project's links covering the folder is the one that puts it here.
      const link = [...current.folders]
        .filter((f) => isUnder(dir, f))
        .sort((a, b) => dirKey(b).length - dirKey(a).length)[0];
      if (!link) return;
      if (!sameFolder(link, dir)) {
        const ok = await confirm({
          title: `Take “${folderLabel(link)}” out of ${current.name}?`,
          description: (
            <>
              <span className="font-mono text-foreground">{folderLabel(dir)}</span> is in this project
              through <span className="font-mono text-foreground">{link}</span>, so it can only leave
              with that folder — everything else under it leaves too.
            </>
          ),
          confirmLabel: "Unlink",
        });
        if (!ok) return;
      }
      onProjectsChange(await api.removeProjectFolder(current.id, link));
    } catch {
      /* the list is re-read on the next load; a failed link isn't worth a dialog */
    }
  };

  const folderDnd = useFolderDrag((dir, projectId) => void moveFolderToProject(dir, projectId));

  /**
   * File a session into a virtual folder, or (with a null group) take it out of the one it is in.
   *
   * The whole branch goes, in one call: a fork is drawn under the session it branched from, never in
   * a place of its own, so one left behind in the old box would be torn off its parent and redrawn as
   * a root there. Moving the row it hangs off is the only way to move it at all, and filing the rows
   * one at a time would draw exactly that torn tree in the window between two writes.
   *
   * Only the project list comes back on the response; which group a row is in rides the session list
   * (SessionInfo.groupId), which the server pushes to every browser as it writes — so there is
   * nothing to flip optimistically here, exactly as with a pin.
   */
  const moveSessionToGroup = async (sessionId: string, groupId: string | null) => {
    const row = sessions.find((x) => x.id === sessionId);
    if (!row) return;
    // Only the ones the move would actually change. Filing a session where it already is still saves
    // the project list and tells every browser the session list changed, and a branch is often mostly
    // in place already — a fork filed with its parent, then dropped there again.
    const branch = [row, ...forkDescendants(sessions, sessionId)].filter(
      (x) => (groupForSession(x, projects)?.id ?? null) !== groupId
    );
    if (branch.length === 0) return;
    try {
      onProjectsChange(await api.setSessionGroup(branch.map((x) => x.id), groupId));
    } catch {
      /* the list is re-read on the next load; a failed drop isn't worth a dialog */
    }
  };

  /**
   * Which box is in the air, by id. The drag hook reports the index the box had when the drag
   * started, and this list rearranges itself underneath a drag: under the active-only filter a box
   * appears the moment a session starts in it and goes the moment its last one closes, both of which
   * arrive unprompted from the session feed. An index is then a position in a list that no longer
   * exists, and honouring it moves whichever box happens to be sitting there now. An id can't drift.
   */
  const draggedGroup = useRef<string | null>(null);

  /**
   * Arrange a project's virtual folders by dragging one box past another. `to` is a position in the
   * list as it stands right now, and the box being moved is resolved in that same list — see
   * groupIdsAfterMove for what a drop means when the filter is hiding some of them.
   *
   * The whole order goes to the server rather than the move that produced it, so a group another
   * browser added since this list was read lands at the end instead of somewhere arbitrary.
   */
  const reorderGroups = async (project: Project, movedId: string, to: number) => {
    const visible = shownGroups(project).map((g) => g.group.id);
    const from = visible.indexOf(movedId);
    // The box left the list mid-drag (its last session closed under the active-only filter), or it
    // is already where it was dropped. Either way there is no move to make.
    if (from < 0 || to >= visible.length || from === to) return;
    try {
      onProjectsChange(
        await api.reorderProjectGroups(project.id, groupIdsAfterMove(project.groups, visible, from, to))
      );
    } catch {
      /* the list is re-read on the next load; a failed drag isn't worth a dialog */
    }
  };

  // Scoped to the project (the list key): a box can only be arranged among its own project's boxes,
  // because a session may only sit in a group of the project its folder belongs to — moving the box
  // elsewhere would strand everything in it. The hook's `from` is deliberately ignored; see
  // draggedGroup above.
  const groupDnd = useDragReorder((_from, to, list) => {
    const project = projects.find((p) => p.id === list);
    const moved = draggedGroup.current;
    if (project && moved) void reorderGroups(project, moved, to);
  });

  /**
   * Put a session under another in the list, or (with a null parent) take it back out — which leaves
   * it where forking left it: under the session it branched from, or at the top level.
   *
   * Nothing comes back: the link rides the session list, which the server pushes to every browser as
   * it writes, exactly like a pin or a group. Anything nested under the row travels with it without
   * being mentioned — those rows point at it, not at where it sits.
   */
  const nestUnder = async (sessionId: string, parentId: string | null) => {
    try {
      await api.setSessionParent(sessionId, parentId);
    } catch {
      /* the list is re-read on the next load; a failed drop isn't worth a dialog */
    }
  };

  /**
   * Whether two sessions are drawn in the same list, which is the only place nesting shows: a tree is
   * built per list, so a parent sitting in another one is simply not there to hang off, and the row
   * would come out at the top level of its own list as if nothing had happened.
   *
   * Which lists exist depends on the view. A virtual folder is one list whatever folder its rows run
   * in; outside one, the grouped view draws a list per folder and the flat view a list per project.
   */
  const sameList = (a: SessionInfo, b: SessionInfo) => {
    const ga = groupForSession(a, projects)?.id ?? null;
    const gb = groupForSession(b, projects)?.id ?? null;
    if (ga !== gb) return false;
    if (ga !== null) return true;
    return grouped
      ? dirKey(a.workingDirectory) === dirKey(b.workingDirectory)
      : (projectForDir(a.workingDirectory, projects)?.id ?? null) ===
        (projectForDir(b.workingDirectory, projects)?.id ?? null);
  };

  /**
   * Whether a row is any of this dragged session's business (see useSessionDrag): the two are drawn
   * in the same list, so arranging one against the other is what the gesture can mean at all.
   *
   * It has to be this and not "any row but me". A row sits inside its project's section, which is a
   * drop target for the same drag — dropping a session there moves it to that project — so a row that
   * claimed every drag would swallow the ones aimed past it at the section around it, and dropping a
   * session onto another project's rows would quietly stop working.
   */
  const inSameList = (sessionId: string, row: SessionInfo) => {
    const s = sessions.find((x) => x.id === sessionId);
    return !!s && s.id !== row.id && sameList(s, row);
  };

  /**
   * Whether dropping one row on another would put it somewhere new: not where it already hangs, not
   * in a list that cannot draw it, and not inside its own branch — a session under its own descendant
   * is a loop, which the server refuses and which would take both rows off the list.
   */
  const canNest = (sessionId: string, parent: SessionInfo) => {
    const s = sessions.find((x) => x.id === sessionId);
    if (!s || s.id === parent.id || parentOf(s) === parent.id) return false;
    if (!sameList(s, parent)) return false;
    return !forkDescendants(sessions, sessionId).some((x) => x.id === parent.id);
  };

  /**
   * Whether a project's boxes are any of this dragged session's business at all: a session can only
   * be filed under the project its own folder belongs to — a group refines the path rule, it never
   * overrules it. This is `claims` for both targets (see useSessionDrag), which is why a box swallows
   * a drop even when the row is already in it.
   */
  const inProject = (sessionId: string, project: Project | null) => {
    const s = sessions.find((x) => x.id === sessionId);
    return !!s && !!project && projectForDir(s.workingDirectory, projects)?.id === project.id;
  };

  /**
   * Whether dropping it there would move it — a box it is already in is not somewhere to drop it.
   * Its forks count too, since they travel with it: a branch left half-filed by an earlier drop that
   * failed partway is repaired by dropping it there again, which a row-only check would refuse.
   */
  const canFile = (sessionId: string, project: Project | null, groupId: string | null) => {
    const s = sessions.find((x) => x.id === sessionId);
    if (!s || !inProject(sessionId, project)) return false;
    return [s, ...forkDescendants(sessions, sessionId)].some(
      (x) => (groupForSession(x, projects)?.id ?? null) !== groupId
    );
  };

  // The sessions in a set that have a finished-but-unseen tick. Closed ones are skipped for the same
  // reason folderActivity skips them: a closed session is not showing a tick to clear.
  const doneIn = (items: SessionInfo[]) =>
    items.filter((s) => s.state !== "Restorable" && activityIds.done.has(s.id)).map((s) => s.id);

  const sessionDnd = useSessionDrag();

  /** The project a session is in, which is the one that owns the folder it runs in. */
  const projectOf = (sessionId: string) => {
    const s = sessions.find((x) => x.id === sessionId);
    return s ? projectForDir(s.workingDirectory, projects) : null;
  };

  /**
   * Move a session to another project — or, with a null project, out of the one it is in.
   *
   * A session has no project of its own: it is in the one that owns its working directory. So what
   * this actually moves is the folder, and anything else running in it travels along. That is the
   * honest reading of the gesture rather than a limitation to work around — a per-session override
   * would let a row and its own folder claim different projects — but it is worth saying out loud
   * before it happens, whenever it is more than the branch that was dragged.
   *
   * The row's own forks are not part of that "more": a fork runs in its parent's folder and is drawn
   * hanging off it, so it was always coming along, and a dialog about it would be asking whether the
   * gesture means what it plainly means.
   */
  const moveSessionToProject = async (sessionId: string, project: Project | null) => {
    const s = sessions.find((x) => x.id === sessionId);
    if (!s) return;
    const dir = s.workingDirectory;
    const current = projectForDir(dir, projects);
    if ((current?.id ?? null) === (project?.id ?? null)) return;
    // Leaving a project is the folder drag's business, dialog and all: a folder can be in a project
    // through an ancestor, and only that ancestor can be unlinked.
    if (!project) {
      await moveFolderToProject(dir, null);
      return;
    }
    const branch = new Set([sessionId, ...forkDescendants(sessions, sessionId).map((x) => x.id)]);
    const others = sessions.filter((x) => !branch.has(x.id) && isUnder(x.workingDirectory, dir));
    if (others.length > 0) {
      const ok = await confirm({
        title: `Move “${folderLabel(dir)}” to ${project.name}?`,
        description: (
          <>
            A project holds folders, not sessions, so{" "}
            <span className="font-mono text-foreground">{folderLabel(dir)}</span> moves — and the{" "}
            {others.length === 1 ? "other session" : `${others.length} other sessions`} running in it
            {others.length === 1 ? " moves" : " move"} with it.
          </>
        ),
        confirmLabel: "Move",
      });
      if (!ok) return;
    }
    try {
      // A folder belongs to whichever project links it deepest, so an exact link in the old project
      // would tie with the one being added here and keep the folder where it was. That link has to
      // go; an ancestor link can stay, since the new one is deeper and wins on its own.
      const exact = current?.folders.find((f) => sameFolder(f, dir));
      if (current && exact) onProjectsChange(await api.removeProjectFolder(current.id, exact));
      onProjectsChange(await api.addProjectFolder(project.id, dir));
    } catch {
      /* the list is re-read on the next load; a failed drop isn't worth a dialog */
    }
  };

  /**
   * Dropping a row on a project heading. Which of two things it means depends on where the row came
   * from, and both are the plain reading of the gesture:
   *
   * - a row already in this project is leaving a virtual folder (a box swallows drops inside itself,
   *   so this only fires for a row that was in one);
   * - anything else is being adopted — see moveSessionToProject.
   *
   * Which is why this claims every session drag, not just its own project's: a heading that ignored
   * the rest would leave the browser showing "no" over the one place the row was being dragged to.
   */
  const sectionSessionDrop = (project: Project | null) => {
    const key = `project:${project?.id ?? ""}`;
    return {
      props: sessionDnd.targetProps(
        key,
        () => true,
        (id) =>
          inProject(id, project)
            ? canFile(id, project, null)
            : (projectOf(id)?.id ?? null) !== (project?.id ?? null),
        (id) =>
          inProject(id, project)
            ? void moveSessionToGroup(id, null)
            : void moveSessionToProject(id, project)
      ),
      over: sessionDnd.isOver(key),
    };
  };

  const toggleGrouped = () =>
    setGrouped((v) => {
      saveGrouped(!v);
      return !v;
    });

  // The two filter buttons are one setting: turning one on switches the other off, and clicking the
  // one that is on goes back to everything.
  const toggleFilter = (mode: Exclude<SessionFilter, "all">) =>
    setFilter((v) => {
      const next = v === mode ? "all" : mode;
      saveFilter(next);
      return next;
    });

  // A single session row. Sessions are ordered newest-first (by creation time); `showPath` is
  // dropped in grouped mode where the folder is already in the header. `depth` nests forks under the
  // session they branched from — indented, with a small elbow so the relationship reads at a glance.
  const renderRow = (
    { session: s, depth, hasChildren, hiddenCount }: ForkNode,
    showPath: boolean,
    // Drag-to-reorder props for this row, plus whether it's the row a drag is hovering. Only passed
    // in grouped mode, and only for top-level rows: a fork is drawn under its parent wherever the
    // parent sits, so it has no place of its own to drag to.
    drag?: { props: Record<string, unknown>; over: boolean },
    // Depth of the header this row hangs off, for the keyboard tree — the row's own fork depth is
    // added to it, so ← walks out of a branch and then on out of the folder above it.
    base = 0
  ) => {
    const restorable = s.state === "Restorable";
    const color = sessionColor(s.color);
    // Session colour (set via `/color`) as a band down the row's left edge, painted as a background
    // rather than an absolute element: a background is clipped by the row's border-radius, so the
    // band tapers around the top and bottom corners instead of stopping short of them or poking out
    // (the row can't be overflow-hidden — that would clip its own actions menu). border-box origin
    // takes it right to the outer edge; no-repeat keeps it from tiling into the 1px border ring, which
    // is what once left a stray arc in the opposite corner.
    const colorEdge = color
      ? {
          backgroundImage: `linear-gradient(to right, ${color} 0 3px, transparent 3px)`,
          backgroundOrigin: "border-box",
          backgroundRepeat: "no-repeat",
        }
      : undefined;
    const activity = sessionActivity(s, activityIds);
    const detail = activity ? activityDetail(activity, s.id, activityIds) : null;
    // What the sessions nested under this one are up to, said the way a folder heading says it: the
    // most urgent mark among them and how many of them have finished. The corner dot is this
    // session's own, so without this a parent reads as idle while a fork three levels down waits
    // on you -- and folded, the fork isn't on screen to say so itself. Counted over every
    // descendant, not just the rows drawn, for the same reason: a folded branch is still running.
    const nested = hasChildren
      ? (() => {
          const below = forkDescendants(sessions, s.id);
          return {
            activity: folderActivity(below, activityIds),
            doneIds: doneIn(below),
            ...folderProgress(below, activityIds),
          };
        })()
      : null;
    // The corner holds one mark, so a parent's is the more urgent of its own and its branch's -- the
    // same rule a folder heading's dot follows. Drawn anywhere else the branch's mark either sat
    // away from every other dot in the list or collided with this one in the corner. The ring still
    // answers for this session alone; the mark-as-seen button below answers for the corner. When the
    // branch's mark wins it is drawn hollow (ActivityMark's `nested`), so a parent working and a
    // parent with a fork working underneath it no longer look the same.
    // A closed session has no mark of its own (a restored one can be on screen for a paint before the
    // prune drops it), but a live branch under it still gets one.
    const own = restorable ? null : activity;
    const ownRanks = !!own && (!nested?.activity || FOLDER_URGENCY[own] >= FOLDER_URGENCY[nested.activity]);
    const cornerActivity = ownRanks ? own : (nested?.activity ?? null);
    const cornerLabel = ownRanks
      ? (detail ?? undefined)
      : cornerActivity
        ? `Nested sessions: ${ACTIVITY_MARK[cornerActivity].label}`
        : undefined;
    // Every tick this row can clear: its own, and on a parent, each one in the branch under it -- a
    // tick in the corner that came from a fork is one the row has to be able to answer for too.
    const seenIds = [...(activity === "done" ? [s.id] : []), ...(nested?.doneIds ?? [])];
    const openInNewTab = () => window.open(sessionUrl(s.id), "_blank", "noopener");
    // Enough of a step that a fork reads as sitting under its parent at a glance, but capped after
    // a few levels: a fork of a fork of a fork would otherwise squeeze the name out of a narrow
    // sidebar entirely (it can be dragged down to 220px).
    const indent = Math.min(depth, 4) * 14;
    // Dropping a row on this one puts it under this one. The target is drawn as an overlay rather
    // than handlers on the row itself because the row is already a drop target for the reorder drag:
    // an overlay is hit-tested first and stops the event there, so the two gestures divide the row
    // between them instead of both answering for the same pixel.
    const nestKey = `nest:${s.id}`;
    const nestOver = sessionDnd.isOver(nestKey);
    return (
      <div
        key={s.id}
        // Two drags start here: reorder within this list (top-level rows only — a fork is drawn
        // under its parent, so it has no place of its own to move to) and file into a virtual
        // folder, which any row can do. Neither may start while the row is being renamed: the
        // rename box has to stay selectable with the mouse.
        {...mergeProps(drag?.props, editingId === s.id ? undefined : sessionDnd.rowProps(s.id))}
        // A session with forks folds like a directory but is still a session Enter opens, hence
        // `expandable` rather than `isDir`. `current` is where the arrows resume from when focus
        // has yet to land anywhere in the list.
        {...navRowProps({
          path: navKey.session(s.id),
          expandable: hasChildren,
          open: hasChildren && hiddenCount === 0,
          current: activeId === s.id,
          depth: base + depth,
        })}
        style={{ ...(depth > 0 ? { marginLeft: indent } : null), ...colorEdge }}
        onClick={(e) => (e.ctrlKey || e.metaKey ? openInNewTab() : onSelect(s.id))}
        // Middle-click opens the session in a new tab; suppress the OS autoscroll it would otherwise start.
        onMouseDown={(e) => e.button === 1 && e.preventDefault()}
        onAuxClick={(e) => e.button === 1 && openInNewTab()}
        // With no path line of its own (grouped mode, or under a project), the folder still has to be
        // recoverable — a project can span several, and "which repo is this one in" is a fair question.
        title={[
          detail,
          showPath ? null : s.workingDirectory,
          restorable ? "Closed — opens on its files; reopen to get the terminal back" : null,
          "Middle-click or Ctrl/⌘-click to open in a new tab",
        ]
          .filter(Boolean)
          .join("\n")}
        className={cn(
          "group relative flex cursor-pointer flex-col gap-1 rounded-md border border-transparent py-1 pl-1.5 pr-2 text-sm hover:bg-accent",
          // Dim a closed session by colour, not opacity: opacity on the row would make its
          // actions menu translucent too, letting the rows underneath show through it. It still
          // opens — the dimming says there is nothing running in it, not that it is out of reach.
          restorable && "text-muted-foreground",
          activeId === s.id && "border-border bg-accent",
          // All three rings are drawn INSIDE the row. A ring is a box-shadow and sits outside the
          // box by default, which the 2px between rows exactly cancels: two neighbours both wearing
          // one met in the middle with no white left between them, and the pair read as a single
          // tall box with a seam through it rather than as two finished sessions. Ringing the inside
          // costs no layout — the row keeps its size and the list its density — and leaves the gap
          // plus both transparent borders standing between the lines.
          //
          // Claude is waiting on a prompt — draw the eye with a ring even when the row isn't selected.
          !restorable && activityIds.waiting.has(s.id) && "ring-1 ring-inset ring-amber-400/70",
          // Softer than waiting's ring, and deliberately so: one is a request, the other a receipt.
          // It is what makes a finished session findable in a long list without reading every row.
          // Guarded like the ring above rather than trusting `done` to be free of closed sessions:
          // what keeps them out of it is a prune that runs in an effect, so a mark restored from
          // storage is on screen for a paint before the prune has had a chance to drop it.
          !restorable && activity === "done" && "ring-1 ring-inset ring-emerald-400/40",
          // Same weight as the tick's ring, in the colour of the cross: the other receipt, for the
          // ending you probably want to do something about.
          !restorable && activity === "failed" && "ring-1 ring-inset ring-red-400/40",
          // Where a dropped row would land: inside this one. The box a session is filed into lights
          // up the same way, because it is the same kind of answer — this thing swallows that one.
          nestOver && "bg-accent ring-1 ring-primary"
        )}
      >
        {/* Only while a session is in flight: an overlay that sat here permanently would swallow the
            clicks meant for the row under it. It takes the lower half of a row that also reorders, so
            both gestures fit — aim at the top of a row to put something above it, at the bottom to
            put it inside — and the whole of a row that does not (a nested row has no place of its own
            in the order to move to, so nothing else wants its pixels). */}
        {sessionDnd.active && (
          <span
            {...mergeProps(
              sessionDnd.targetProps(
                nestKey,
                (id) => inSameList(id, s),
                (id) => canNest(id, s),
                (id) => void nestUnder(id, s.id)
              ),
              // The row drew a line above itself on the way in here; from inside this half of it, the
              // drop is no longer the one that line describes.
              { onDragOver: () => dnd.clearOver() }
            )}
            className={cn("absolute inset-x-0 z-10", drag ? "bottom-0 h-1/2" : "inset-y-0")}
          />
        )}
        {/* Where a dragged row would land. A bar of its own rather than the row's top border: a
            border follows the rounded corners around the sides, which reads as a box half-drawn
            instead of a line between two rows. Inset and pill-ended so it stays a line. */}
        {drag?.over && (
          <span className="pointer-events-none absolute inset-x-2 -top-px h-0.5 rounded-full bg-primary" />
        )}
        {/* Activity dot, in the top-left corner rather than sitting in the name's line: an inline
            gutter would have to stay reserved on every idle row — most of them — just so the title
            wouldn't shift when the mark appears. What it can say lives in ACTIVITY_MARK and is drawn
            by ActivityMark, so this row and its folder header always say it the same way. It sits ON
            the colour band deliberately, and with no padding of its own: the background stops at the
            glyph rather than ringing it, which at this size read as a halo rather than as breathing
            room. The offset carries the 2px that padding used to hold, so the mark has not moved. */}
        {cornerActivity && (
          <span className="pointer-events-none absolute left-1 top-1 rounded-full bg-background leading-none">
            <ActivityMark activity={cornerActivity} label={cornerLabel} nested={!ownRanks} />
          </span>
        )}
        <div className="flex items-center justify-between gap-1">
          <span className="flex min-w-0 flex-1 items-center gap-0.5">
            {/* Fold away whatever is nested under this session — its forks, and anything put under it
                by hand. Only a row that actually has some gets the toggle: no gutter is reserved
                elsewhere, so a childless row starts at its name. How much a collapsed row is hiding
                rides in the tooltip rather than an inline count, which would cost a reserved slot on
                every parent row just to keep the name from jumping. */}
            {hasChildren && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleForks(s.id);
                }}
                aria-expanded={hiddenCount === 0}
                title={
                  hiddenCount > 0
                    ? `Show ${hiddenCount} nested session${hiddenCount === 1 ? "" : "s"}`
                    : "Hide the sessions nested under this one"
                }
                className="flex shrink-0 items-center text-muted-foreground hover:text-foreground"
              >
                {hiddenCount > 0 ? (
                  <ChevronRight className="size-3.5" />
                ) : (
                  <ChevronDown className="size-3.5" />
                )}
              </button>
            )}
            {/* Nested fork: mark the row as a branch of the one above it. The parent's name is right
                there in the list, so the tooltip carries it rather than the row spending width on it.
                A row put under another by hand is nested too, but it is not a fork and gets no mark —
                the indent already says where it sits, and the icon would be claiming its conversation
                came from the row above. */}
            {depth > 0 && !s.nestedUnderId && (
              <span
                className="flex shrink-0 items-center text-muted-foreground"
                title={s.parentName ? `Forked from “${s.parentName}”` : "Forked session"}
              >
                <GitFork className="size-3" aria-label="forked session" />
              </span>
            )}
            {/* Started by a clock rather than by a person. This is provenance, like the fork mark
                above it, so it sits in the same place and wears the same weight — and NOT in the
                activity corner, where it would be a sixth thing to learn about a list that is mostly
                quiet (see ActivityMark). One icon covers both a run a schedule launched and a live
                session it pokes; which one, and on what clock, is the tooltip's job. */}
            {s.scheduleId && (
              <span
                className="flex shrink-0 items-center text-muted-foreground"
                title={
                  s.scheduleLabel
                    ? `Scheduled — ${s.scheduleLabel}`
                    : "Started by a schedule"
                }
              >
                <CalendarClock className="size-3" aria-label="scheduled session" />
              </span>
            )}
            {/* Whether a session survived a restart of the app (re-attached, not relaunched) is worth
                knowing but not worth a badge on every row it applies to — it lives in the session
                info panel, next to the pid it's really a statement about. */}
            {editingId === s.id ? (
              <RenameField
                value={s.name}
                onSubmit={(name) => {
                  onRename(s.id, name);
                  setEditingId(null);
                }}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <span
                className={cn(
                  depth > 0 ? "flex min-w-0" : "truncate",
                  s.state !== "Running" && "text-muted-foreground"
                )}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setEditingId(s.id);
                }}
                title={depth > 0 ? `${s.name} — double-click to rename` : "Double-click to rename"}
              >
                {depth > 0 ? <MiddleTruncated text={s.name} /> : s.name}
              </span>
            )}
            {nested && editingId !== s.id && <HeadingProgress done={nested.done} active={nested.active} />}
            {s.remoteControl && editingId !== s.id && (
              <Radio className="size-3 shrink-0 text-muted-foreground" aria-label="remote control" />
            )}
            {/* Why this row sits above the newer ones — without it a pinned folder just looks
                mis-sorted. */}
            {pinned.has(s.id) && editingId !== s.id && (
              <Pin className="size-3 shrink-0 text-muted-foreground" aria-label="pinned" />
            )}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {/* This row's own tick, cleared where it is drawn. A heading has been able to do this
                for the whole set under it; a single finished session could only be dismissed by
                opening it, which is the one thing you don't want to do to the ones you already know
                the ending of — and opening it to dismiss a tick costs a terminal attach and takes
                the main area off whatever you were reading. Shown only while this row is the one
                ticking, here or anywhere in the branch under it, so the button appears exactly when
                there is a tick to answer for and goes when it does. */}
            {seenIds.length > 0 && editingId !== s.id && (
              <MarkSeenButton
                count={seenIds.length}
                reveal="row"
                label={seenIds.length === 1 && seenIds[0] === s.id ? "Mark as seen" : undefined}
                onMarkSeen={() => onMarkSeen(seenIds)}
              />
            )}
            {/* Postponed-message counter, so a stashed pool is discoverable from the list. It sits
                left of the menu button, which holds the right edge of every row. Clicking it opens
                the pool itself: the number was the only thing a closed session showed of its stash,
                and reading it back used to mean relaunching the session that left it. */}
            {s.postponedCount > 0 && (
              <button
                type="button"
                title={`${s.postponedCount} postponed message${s.postponedCount === 1 ? "" : "s"}${
                  s.postponedAutoSend ? ", auto-sending" : ""
                } — click to read`}
                onClick={(e) => {
                  e.stopPropagation();
                  setPostponedId(s.id);
                }}
                className={cn(
                  badgeVariants({ variant: "secondary" }),
                  "gap-0.5 px-1.5 transition-colors hover:bg-accent"
                )}
              >
                {/* A play glyph when the pool is working itself through, so a queue left running is
                    visible from the list and not only from inside the session. */}
                {s.postponedAutoSend ? <Play className="size-3" /> : <Inbox className="size-3" />}
                {s.postponedCount}
              </button>
            )}
            {editingId !== s.id && (
              <RowActionsMenu
                canFork={s.canFork}
                restorable={restorable}
                running={s.state === "Running"}
                pinned={pinned.has(s.id)}
                dir={s.workingDirectory}
                projects={projects}
                projectId={projectForDir(s.workingDirectory, projects)?.id ?? null}
                onMoveToProject={(id) => void moveFolderToProject(s.workingDirectory, id)}
                onNewProject={() => setEditing({ id: null, folder: s.workingDirectory })}
                groups={projectForDir(s.workingDirectory, projects)?.groups ?? []}
                groupId={groupForSession(s, projects)?.id ?? null}
                nested={!!s.nestedUnderId}
                onUnnest={() => void nestUnder(s.id, null)}
                onMoveToGroup={(id) => void moveSessionToGroup(s.id, id)}
                onNewGroup={() => {
                  const p = projectForDir(s.workingDirectory, projects);
                  if (p) setNewGroupFor({ projectId: p.id, sessionId: s.id });
                }}
                onRevealFolder={() => onRevealFolder(s.workingDirectory)}
                onTogglePin={() => togglePin(s.id, !pinned.has(s.id))}
                onRename={() => setEditingId(s.id)}
                onClone={() => onClone(s)}
                onFork={() => onFork(s)}
                onSchedule={
                  s.claudeSessionId
                    ? () => onSchedules({ conversationId: s.claudeSessionId!, name: s.name })
                    : null
                }
                onRestore={() => onRestore(s.id)}
                onStop={() => onStop(s.id)}
                onRemove={() => onRemove(s.id)}
              />
            )}
          </span>
        </div>
        {showPath && (
          <span className="truncate font-mono text-xs text-muted-foreground">{s.workingDirectory}</span>
        )}
      </div>
    );
  };

  /**
   * The rows of one folder group: its fork tree, in the order the list was arranged into.
   *
   * `indent` is a step in, taken when there is a header of their own above them — a folder group's,
   * or a virtual folder's. Where the rows hang straight off the project heading instead (a merged
   * folder header, or the flat list), they are at the project's own child level and take no step, so
   * a row's fork chevron lands in the same column as the chevron of a box sitting beside it.
   */
  const renderGroupRows = (
    g: { key: string; nodes: ForkNode[]; rootIds: string[] },
    indent = "pl-[18px]",
    // Depth of the header above these rows in the keyboard tree — see renderRow.
    base = 0
  ) => (
    // No gap between the rows. The activity ring is drawn inside the row (see renderRow), so what
    // stands between two ringed neighbours is the pair of transparent borders they already carry --
    // enough to read as two boxes, and the tightest they go before the lines meet again. Any gap
    // here is added to that, and two finished sessions end up a visible step apart.
    <div className={cn("mt-0.5", indent)}>
      {/* A fork always shares its parent's folder, so nesting inside the group is the same
          tree the flat list shows — just scoped to this folder. */}
      {g.nodes.map((n) => {
        const i = g.rootIds.indexOf(n.session.id);
        // Rows are draggable only while nothing in them is being renamed: the rename box has
        // to stay selectable with the mouse.
        const draggable = i >= 0 && editingId !== n.session.id;
        return renderRow(
          n,
          false,
          draggable ? { props: dnd.rowProps(i, g.key), over: dnd.isOver(i, g.key) } : undefined,
          base
        );
      })}
    </div>
  );

  /**
   * One virtual folder: its header and, unless folded, the sessions filed into it. The body is a
   * folder group's body — once you are looking at rows, a box you filled by hand and a box a path
   * filled are the same list. The box itself is the drop target that fills it.
   */
  const renderVirtualGroup = (vg: VirtualGroup, project: Project, index: number) => {
    const isCollapsed = collapsed.has(vg.key);
    return (
      <div
        key={vg.key}
        // Two drops land here: a session filed into this box, and another box arranged past it. The
        // whole box is the target for both — a collapsed one is a single row, and aiming at a header
        // hidden among the sessions it holds would be the fiddliest part of the gesture.
        {...mergeProps(
          sessionDnd.targetProps(
            vg.key,
            (id) => inProject(id, project),
            (id) => canFile(id, project, vg.group.id),
            (id) => void moveSessionToGroup(id, vg.group.id)
          ),
          groupDnd.targetProps(index, project.id)
        )}
        className={cn(
          "relative rounded-md transition-colors",
          sessionDnd.isOver(vg.key) && "bg-accent ring-1 ring-primary"
        )}
      >
        {/* Where a dragged box would land — the same line a dragged row draws, for the same reason:
            a box joins the order at a position, it doesn't get swallowed by the box it lands on. */}
        {groupDnd.isOver(index, project.id) && (
          <span className="pointer-events-none absolute inset-x-2 -top-px z-10 h-0.5 rounded-full bg-primary" />
        )}
        <VirtualFolderHeader
          group={vg.group}
          count={vg.count}
          collapsed={isCollapsed}
          onToggle={() => toggleGroup(vg.key)}
          activity={folderActivity(vg.items, activityIds)}
          onEdit={() => setEditing({ id: project.id, group: vg.group.id })}
          // Only the header grabs. The rows inside have drags of their own, and a box that could be
          // picked up anywhere would swallow them.
          dragProps={mergeProps(groupDnd.handleProps(index, project.id), {
            onDragStart: () => (draggedGroup.current = vg.group.id),
            onDragEnd: () => (draggedGroup.current = null),
          })}
          doneCount={doneIn(vg.items).length}
          activeCount={folderProgress(vg.items, activityIds).active}
          onMarkSeen={() => onMarkSeen(doneIn(vg.items))}
          // A virtual folder only ever hangs off a project heading, so it always sits at depth 1.
          navProps={navRowProps({
            path: navKey.fold(vg.key),
            isDir: true,
            open: !isCollapsed,
            depth: 1,
          })}
        />
        {!isCollapsed && renderGroupRows(vg, undefined, 2)}
      </div>
    );
  };

  // A project heading as a row of the keyboard tree: the top level of the list, holding the folder
  // headers, virtual folders and sessions under it.
  const projectNavRow = (project: Project | null) => {
    const key = project?.id ?? "";
    return navRowProps({
      path: navKey.project(key),
      isDir: true,
      open: !collapsedProjects.has(key),
      depth: 0,
    });
  };

  /** A project's virtual folders, or null when it has none to draw (see ProjectSections.before). */
  const renderVirtualGroups = (project: Project | null) => {
    const gs = shownGroups(project);
    if (!project || gs.length === 0) return null;
    return gs.map((vg, i) => renderVirtualGroup(vg, project, i));
  };

  // One folder group: its header and, unless folded, the fork tree of the sessions in it. Pulled out
  // of the list because it is now rendered from two places — inside a project, and loose below them.
  const renderFolderGroup = (g: (typeof groups)[number]) => {
    const isCollapsed = collapsed.has(g.dir);
    // With projects on screen these headers hang off a project heading; with none they are the top
    // level of the list, which is the only case the loose `groups.map` branch renders.
    const headDepth = projects.length > 0 ? 1 : 0;
    return (
      <div key={g.key}>
        <GroupHeader
          dir={g.dir}
          count={g.count}
          collapsed={isCollapsed}
          onToggle={() => toggleGroup(g.dir)}
          onNewSession={() => onNewInFolder(g.dir)}
          onRemove={() => setRemoveDir(g.key)}
          activity={folderActivity(g.items, activityIds)}
          doneCount={doneIn(g.items).length}
          activeCount={folderProgress(g.items, activityIds).active}
          onMarkSeen={() => onMarkSeen(doneIn(g.items))}
          projects={projects}
          projectId={projectForDir(g.dir, projects)?.id ?? null}
          onMoveToProject={(id) => void moveFolderToProject(g.dir, id)}
          onNewProject={() => setEditing({ id: null, folder: g.dir })}
          dragProps={folderDnd.folderProps(g.dir)}
          navProps={navRowProps({
            path: navKey.fold(g.dir),
            isDir: true,
            open: !isCollapsed,
            depth: headDepth,
          })}
        />
        {!isCollapsed && renderGroupRows(g, undefined, headDepth + 1)}
      </div>
    );
  };

  /**
   * One flat-list section: the rows of a project (or of the whole list, when there are no projects).
   * Mirrors renderFolderGroup's body — same ordering, same drag scoping — minus the folder header,
   * which is the thing the flat view exists to leave out. `items` is ignored in favour of the
   * section built in flatSections, so the rows and the drag list can never disagree about the order.
   */
  const renderFlatSection = (project: Project | null, fallback: SessionInfo[]) => {
    const key = `project:${project?.id ?? ""}`;
    const sec = flatSections.find((x) => x.key === key);
    const nodes = sec?.nodes ?? forkTree(sortPinnedFirst(fallback, pinned), collapsedForks);
    const rootIds = sec?.rootIds ?? [];
    return nodes.map((n) => {
      const i = rootIds.indexOf(n.session.id);
      const draggable = i >= 0 && editingId !== n.session.id;
      return renderRow(
        n,
        // Under a project heading the path is a line per row saying what the heading already says.
        // It stays where nothing above the row does: the "No project" section, and the plain list.
        !project,
        draggable ? { props: dnd.rowProps(i, key), over: dnd.isOver(i, key) } : undefined,
        // A heading above them, or nothing at all — the plain list's rows are its own top level.
        projects.length > 0 ? 1 : 0
      );
    });
  };

  return (
    <div className="flex h-full flex-col bg-card">
      {/* Tab switcher: active sessions vs. reusable recent presets. The row is tight on purpose —
          at the narrow end of the sidebar the labels have to survive next to four icon buttons. */}
      <div className="flex items-center gap-0.5 p-2">
        <TabButton active={tab === "sessions"} onClick={() => setTab("sessions")} count={sessions.length}>
          Sessions
        </TabButton>
        <TabButton active={tab === "recent"} onClick={() => setTab("recent")} count={recents.length}>
          Recent
        </TabButton>
        {(sessions.length > 0 || recents.length > 0) && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0 text-muted-foreground"
            title="Search sessions and recents (Ctrl+Shift+F)"
            onClick={onSearch}
          >
            <Search className="size-3.5" />
          </Button>
        )}
        {tab === "sessions" && sessions.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="size-6 shrink-0 px-0 text-muted-foreground"
            title={
              filter === "activity"
                ? `Showing ${activityCount} session${activityCount === 1 ? "" : "s"} with activity — click to show all`
                : "Show only sessions with activity (working, waiting, finished…)"
            }
            aria-pressed={filter === "activity"}
            onClick={() => toggleFilter("activity")}
          >
            <ActivityIcon className={cn("size-3.5", filter === "activity" && "text-emerald-500")} />
          </Button>
        )}
        {tab === "sessions" && sessions.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="size-6 shrink-0 px-0 text-muted-foreground"
            title={
              filter === "active"
                ? `Showing ${activeCount} running session${activeCount === 1 ? "" : "s"} — click to show all`
                : "Show running sessions only"
            }
            aria-pressed={filter === "active"}
            onClick={() => toggleFilter("active")}
          >
            <Filter className={cn("size-3.5", filter === "active" && "text-emerald-500")} />
          </Button>
        )}
        {((tab === "sessions" && sessions.length > 0) ||
          (tab === "recent" && recents.length > 0)) && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0 text-muted-foreground"
            title={grouped ? "Show as a flat list" : "Group by folder"}
            aria-pressed={grouped}
            onClick={toggleGrouped}
          >
            {grouped ? <List className="size-3.5" /> : <FolderTree className="size-3.5" />}
          </Button>
        )}
        {/* Projects head both views now, so the button isn't tied to the grouped one. */}
        {tab === "sessions" && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0 text-muted-foreground"
            title="New project"
            onClick={() => setEditing({ id: null })}
          >
            <FolderPlus className="size-3.5" />
          </Button>
        )}
        {tab === "sessions" && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0 text-muted-foreground"
            title="Schedules — run a template on a clock"
            onClick={() => onSchedules()}
          >
            <CalendarClock className="size-3.5" />
          </Button>
        )}
        {canFoldAll && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0 text-muted-foreground"
            title={`${allCollapsed ? "Expand" : "Collapse"} all ${
              foldableKeys.length > 0 ? "folders and projects" : "projects"
            }`}
            onClick={toggleAllGroups}
          >
            {allCollapsed ? (
              <ChevronsUpDown className="size-3.5" />
            ) : (
              <ChevronsDownUp className="size-3.5" />
            )}
          </Button>
        )}
      </div>

      {tab === "recent" ? (
        <RecentList
          recents={recents}
          grouped={grouped}
          collapsed={collapsed}
          onToggleGroup={toggleGroup}
          onReuse={onReuse}
          onRemove={onRemoveRecent}
          onReorder={onReorderRecent}
          projects={projects}
          collapsedProjects={collapsedProjects}
          onToggleProject={toggleProject}
          onProjectSettings={(p) => setEditing({ id: p.id })}
          onNewProject={(folder) => setEditing({ id: null, folder })}
          onMoveToProject={(dir, id) => void moveFolderToProject(dir, id)}
          folderDnd={folderDnd}
        />
      ) : (
      <div
        ref={treeRef}
        data-menu-bounds
        {...treeKeys}
        // The list is the tree's one tab stop and focus roves over its rows from there, so the
        // container itself must not draw a ring around everything when it takes focus.
        className="flex-1 overflow-auto pb-2 pl-2 pr-1 outline-none"
      >
        {sessions.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">No sessions yet</p>
        ) : visibleSessions.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            {filter === "activity" ? "Nothing going on right now" : "No running sessions"}
          </p>
        ) : null}
        {grouped ? (
          projects.length > 0 ? (
            <ProjectSections
              sections={shown(sessionSections)}
              collapsed={collapsedProjects}
              onToggle={toggleProject}
              onSettings={(p) => setEditing({ id: p.id })}
              onNewSession={onNewInProject}
              dnd={folderDnd}
              sessionDrop={sectionSessionDrop}
              before={renderVirtualGroups}
              navRow={projectNavRow}
              renderItems={(gs, project) =>
                // A project that is just one folder draws its sessions itself: the folder header
                // would only repeat the heading right above it.
                mergesFolderHeader(project, gs.map((g) => g.dir), shownGroups(project).length > 0)
                  // No folder header of their own: the rows hang straight off the project heading,
                  // so in the keyboard tree they are at its child level, not a header's.
                  ? renderGroupRows(gs[0], "pl-0", 1)
                  : gs.map(renderFolderGroup)
              }
              countOf={(gs, project) =>
                gs.reduce((n, g) => n + g.count, 0) +
                shownGroups(project).reduce((n, g) => n + g.count, 0)
              }
              activityOf={(gs, project) =>
                folderActivity(
                  [...gs.flatMap((g) => g.items), ...shownGroups(project).flatMap((g) => g.items)],
                  activityIds
                )
              }
              doneOf={(gs, project) =>
                doneIn([...gs.flatMap((g) => g.items), ...shownGroups(project).flatMap((g) => g.items)])
              }
              activeOf={(gs, project) =>
                folderProgress(
                  [...gs.flatMap((g) => g.items), ...shownGroups(project).flatMap((g) => g.items)],
                  activityIds
                ).active
              }
              onMarkSeen={onMarkSeen}
              postponedOf={(gs, project) =>
                folderPostponed([
                  ...gs.flatMap((g) => g.items),
                  ...shownGroups(project).flatMap((g) => g.items),
                ])
              }
            />
          ) : (
            // No projects yet: the list is exactly what it always was, headings and all.
            <div className="space-y-2">{groups.map(renderFolderGroup)}</div>
          )
        ) : projects.length > 0 ? (
          // Flat list, under project headings: the sessions themselves, with no folder groups in
          // between — the whole point of the flat view is not to have them. Rows are dragged into
          // order within their section, the same as inside a folder group upstairs; what a row can't
          // do here is change project, because a project holds folders, not sessions.
          <ProjectSections
            sections={shown(flatSections)}
            collapsed={collapsedProjects}
            onToggle={toggleProject}
            onSettings={(p) => setEditing({ id: p.id })}
            onNewSession={onNewInProject}
            sessionDrop={sectionSessionDrop}
            before={renderVirtualGroups}
            navRow={projectNavRow}
            renderItems={(ss, project) => renderFlatSection(project, ss)}
            // No folder header stands between a project and its rows here, so they sit at the
            // project's own child level — level with the virtual folders beside them, which is what
            // puts a row's fork chevron in the same column as a box's. (They used to carry a folder
            // group's indent as well, which lined them up with the grouped view at the cost of
            // looking like they hung off a header that isn't there.)
            // 5px, not 6: a row carries a 1px transparent border (it turns solid when selected)
            // and a header does not, so the row needs one pixel less to put its chevron in the
            // same column as a virtual folder's.
            // No row gap, for the reason renderGroupRows gives: the rings are inside the rows and
            // the borders alone are what stands between two of them.
            bodyClassName="pl-[15px]"
            countOf={(ss, project) =>
              ss.length + shownGroups(project).reduce((n, g) => n + g.count, 0)
            }
            activityOf={(ss, project) =>
              folderActivity([...ss, ...shownGroups(project).flatMap((g) => g.items)], activityIds)
            }
            postponedOf={(ss, project) =>
              folderPostponed([...ss, ...shownGroups(project).flatMap((g) => g.items)])
            }
            doneOf={(ss, project) => doneIn([...ss, ...shownGroups(project).flatMap((g) => g.items)])}
            activeOf={(ss, project) =>
              folderProgress([...ss, ...shownGroups(project).flatMap((g) => g.items)], activityIds).active
            }
            onMarkSeen={onMarkSeen}
          />
        ) : (
          // Plain flat list: no projects to head it, but the same one arrangeable list underneath —
          // pins float to the top, and everything else keeps the place it was dragged to.
          <div>{renderFlatSection(null, visibleSessions)}</div>
        )}
      </div>
      )}

      {/* Sessions that outlived the app but nothing points at any more. Renders nothing when there
          are none, which is nearly always. */}
      <OrphanBar />

      {/* Padding and control size match the Postponed bar's header, so the two footers line up. */}
      <div className="flex items-center gap-1 border-t px-2 py-1.5">
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          title="Sign out"
          onClick={onLogout}
        >
          <LogOut className="size-4" />
        </Button>
        <div className="ml-auto flex items-center gap-1">
          <NotificationToggle />
          <ThemeToggle />
        </div>
      </div>

      {/* Resolved from the live list on every render; a project deleted from another tab simply
          stops rendering its popup rather than editing something that is no longer there. */}
      {editing && (editing.id === null || editingProject) && (
        <ProjectDialog
          project={editingProject}
          projects={projects}
          initialFolders={editing.folder ? [editing.folder] : undefined}
          initialGroup={editing.group}
          onSaved={onProjectsChange}
          onClose={() => setEditing(null)}
        />
      )}

      {/* Resolved from the live list on every render, like the project popup above. */}
      {newGroupFor && projects.some((p) => p.id === newGroupFor.projectId) && (
        <GroupDialog
          project={projects.find((p) => p.id === newGroupFor.projectId)!}
          onSaved={onProjectsChange}
          onCreated={(groupId) => void moveSessionToGroup(newGroupFor.sessionId, groupId)}
          onClose={() => setNewGroupFor(null)}
        />
      )}

      {/* Resolved from the live list, like the popups above: a session that leaves the list while its
          stash is open takes the dialog with it rather than leaving one nothing can answer. */}
      {postponedId && sessions.some((s) => s.id === postponedId) && (
        <PostponedDialog
          sessionId={postponedId}
          sessionName={sessions.find((s) => s.id === postponedId)!.name}
          live={sessions.find((s) => s.id === postponedId)!.state === "Running"}
          onClose={() => setPostponedId(null)}
        />
      )}

      {removeDir && (
        <FolderRemoveDialog
          dir={removeDir}
          sessions={sessions.filter((s) => dirKey(s.workingDirectory) === removeDir)}
          onRemove={(ids) => {
            onRemoveSessions(ids);
            setRemoveDir(null);
          }}
          onClose={() => setRemoveDir(null)}
        />
      )}
    </div>
  );
}

/**
 * Per-row action menu. The row is only as wide as the sidebar, so the actions live behind one
 * three-dot button instead of a strip of icons competing with the session name.
 */
function RowActionsMenu({
  canFork,
  nested,
  onUnnest,
  restorable,
  running,
  pinned,
  dir,
  projects,
  projectId,
  onMoveToProject,
  onNewProject,
  groups,
  groupId,
  onMoveToGroup,
  onNewGroup,
  onRevealFolder,
  onTogglePin,
  onRename,
  onClone,
  onFork,
  onSchedule,
  onRestore,
  onStop,
  onRemove,
}: {
  canFork: boolean;
  /** Whether this row was put under another by hand — the only nesting there is anything to undo. */
  nested: boolean;
  onUnnest: () => void;
  restorable: boolean;
  /** Whether there is a live process to stop. False for a closed row and for one that already exited. */
  running: boolean;
  pinned: boolean;
  /** The session's folder — what "move to project" actually moves. */
  dir: string;
  projects: readonly Project[];
  projectId: string | null;
  onMoveToProject: (projectId: string | null) => void;
  onNewProject: () => void;
  /** The virtual folders of the project this session's folder is in — the only ones it can go into. */
  groups: readonly ProjectGroup[];
  groupId: string | null;
  onMoveToGroup: (groupId: string | null) => void;
  onNewGroup: () => void;
  onRevealFolder: () => void;
  onTogglePin: () => void;
  onRename: () => void;
  onClone: () => void;
  onFork: () => void;
  /**
   * Start a schedule that keeps sending to this conversation. Null when there is nothing to schedule
   * against yet — a schedule outlives a reboot by holding Claude's conversation id, and a session too
   * young to have reported one has no handle to hold.
   */
  onSchedule: (() => void) | null;
  onRestore: () => void;
  onStop: () => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Which level of the menu is showing. Reset on close, so reopening never lands you halfway down
  // a list you finished with.
  const [view, setView] = useState<"root" | "project" | "group">("root");
  const { dropUp, maxHeight, place } = useMenuPlacement(200);
  const shut = useCallback(() => {
    setOpen(false);
    setView("root");
  }, []);
  const ref = useDismissable<HTMLSpanElement>(open, shut);

  const project = projects.find((p) => p.id === projectId) ?? null;
  const group = groups.find((g) => g.id === groupId) ?? null;

  // Rows near the bottom of the list would push the menu past it, so flip it upwards. The root level
  // is a fixed dozen entries now that the lists are behind submenus, so what counts as "near the
  // bottom" no longer grows with the number of projects; a submenu that outgrows the room scrolls.
  const toggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    place(e.currentTarget, 280);
    setOpen((o) => !o);
  };

  const pick = (e: React.MouseEvent, run: () => void) => {
    e.stopPropagation();
    shut();
    run();
  };

  /**
   * One entry. `disabled` draws it greyed and inert rather than leaving it out: an action that is
   * missing teaches nothing, while one you can see but not press says it exists and, in its
   * tooltip, what it is waiting for.
   */
  const item = (
    label: string,
    icon: ReactNode,
    run: () => void,
    destructive = false,
    disabled?: string | false
  ) => (
    <button
      type="button"
      disabled={!!disabled}
      title={disabled || undefined}
      onClick={(e) => {
        e.stopPropagation();
        shut();
        run();
      }}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm",
        disabled ? "cursor-default text-muted-foreground opacity-60" : "hover:bg-accent",
        destructive && !disabled && "text-destructive"
      )}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <span
      ref={ref}
      // See FolderMenu: keeps the tree's arrow keys off a row whose menu is standing open.
      data-menu-open={open ? "1" : undefined}
      className="relative flex items-center"
      onClick={(e) => e.stopPropagation()}
      {...cancelDrag}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        title="Session actions"
        className={cn(
          // Always on screen, unlike the hover-only actions: it is the row's only entry point on a
          // touch device, and a button that holds the right edge on every row is somewhere the eye
          // can go straight to instead of hunting for the row that happens to be under the pointer.
          "inline-flex rounded text-muted-foreground hover:text-foreground",
          open && "text-foreground"
        )}
      >
        <MoreVertical className="size-3.5" />
      </button>
      {open && (
        <div
          // The cap comes from the room the list actually has (see useMenuPlacement) — with the
          // project and group sections in it this menu is taller than a short window, and a fixed
          // cap would either clip it or overflow the list it lives in.
          style={{ maxHeight }}
          className={cn(
            // As wide as the folder menu, which now lists the same projects: a name plus its tick
            // needs the room, and two menus offering one action shouldn't be two different widths.
            "absolute right-0 z-50 w-52 overflow-y-auto rounded-md popover-edge bg-popover py-1 text-popover-foreground shadow-md",
            dropUp ? "bottom-full mb-1" : "top-full mt-1"
          )}
        >
          {view === "project" && (
            <>
              <SubmenuHeader
                title="Move to project"
                // The nuance there was no room for on the row that opens this: a project holds
                // folders, not sessions, so this moves the whole folder and everything else in it.
                hint={`Moves the folder — ${folderLabel(dir)}`}
                onBack={() => setView("root")}
              />
              {sortedByName(projects).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={(e) => pick(e, () => onMoveToProject(p.id))}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <ProjectGlyph project={p} className="size-3.5 shrink-0" />
                  <span className="truncate">{p.name}</span>
                  {projectId === p.id && (
                    <Check className="ml-auto size-3.5 shrink-0 text-emerald-500" />
                  )}
                </button>
              ))}
              {projectId && (
                <button
                  type="button"
                  onClick={(e) => pick(e, () => onMoveToProject(null))}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <Minus className="size-3.5 shrink-0" />
                  No project
                </button>
              )}
              <div className="my-1 border-t" />
              {item("New project…", <FolderPlus className="size-3.5" />, onNewProject)}
            </>
          )}

          {view === "group" && (
            <>
              <SubmenuHeader
                title="Group"
                hint={project ? `A virtual folder in ${project.name}` : undefined}
                onBack={() => setView("root")}
              />
              {groups.map((g) => {
                const Icon = groupIcon(g.icon);
                const accent = sessionColor(g.color);
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={(e) => pick(e, () => onMoveToGroup(g.id))}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    <Icon
                      className="size-3.5 shrink-0"
                      style={accent ? { color: accent } : undefined}
                    />
                    <span className="truncate">{g.name}</span>
                    {groupId === g.id && (
                      <Check className="ml-auto size-3.5 shrink-0 text-emerald-500" />
                    )}
                  </button>
                );
              })}
              {groupId && (
                <button
                  type="button"
                  onClick={(e) => pick(e, () => onMoveToGroup(null))}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <Minus className="size-3.5 shrink-0" />
                  No group
                </button>
              )}
              <div className="my-1 border-t" />
              {item("New group…", <FolderPlus className="size-3.5" />, onNewGroup)}
            </>
          )}

          {view === "root" && (
            <>
              {/* First, on a closed row: it is the one thing that row is for, and everything below
                  is housekeeping you would do to a session you were not about to open anyway. */}
              {restorable && (
                <>
                  {item("Reopen", <RotateCcw className="size-3.5" />, onRestore)}
                  <div className="my-1 border-t" />
                </>
              )}
              {pinned
                ? item("Unpin", <PinOff className="size-3.5" />, onTogglePin)
                : item("Pin to top", <Pin className="size-3.5" />, onTogglePin)}
              {item("Rename", <Pencil className="size-3.5" />, onRename)}
              {item("Clone", <Copy className="size-3.5" />, onClone)}
              {/* Always listed, greyed until it can run. Forking needs Claude's own conversation id,
                  which the app learns from the session's first hook event -- so a session resumed
                  with --continue (which never says which conversation it landed on) has none until
                  it is used. Leaving the entry out made that read as "this session cannot be
                  forked", when the truth is "not yet, and here is what is missing". */}
              {item(
                "Fork",
                <GitFork className="size-3.5" />,
                onFork,
                false,
                !canFork && "Fork needs Claude's conversation id — send this session a message first"
              )}
              {/* Same handle as a fork: both wait on the conversation id, which is why they appear
                  together -- and why they grey out and come back together too. */}
              {item(
                "Schedule…",
                <CalendarClock className="size-3.5" />,
                onSchedule ?? (() => {}),
                false,
                !onSchedule && "Scheduling needs Claude's conversation id — send this session a message first"
              )}
              {/* Only for a row put under another by hand, and only that is undone: a fork goes back
                  to hanging off the session it was forked from, which is where it belongs and was
                  never the user's arrangement to begin with. */}
              {nested && item("Move out", <CornerLeftUp className="size-3.5" />, onUnnest)}

              <div className="my-1 border-t" />

              {/* Heads the folder half of the menu: the row names a session, and this is how you get
                  from it to the folder behind it — in the Files tree, which lists every drive and is
                  not somewhere you would want to walk down to a deep path by hand. */}
              {item("Show folder in Files", <FolderSearch className="size-3.5" />, onRevealFolder)}

              {/* Both lists live one level in. Inline, a dozen projects turned the menu into a
                  scrolling column that buried Close session below the fold; behind a row that says
                  what is currently chosen, the menu stays a fixed, readable length. */}
              <SubmenuRow
                label="Move to project"
                icon={
                  <ProjectGlyph project={project} className="size-3.5 shrink-0" />
                }
                value={project?.name ?? "None"}
                onOpen={() => setView("project")}
              />
              {projectId && (
                <SubmenuRow
                  label="Group"
                  icon={(() => {
                    const Icon = groupIcon(group?.icon);
                    const accent = sessionColor(group?.color);
                    return (
                      <Icon
                        className="size-3.5 shrink-0"
                        style={accent ? { color: accent } : undefined}
                      />
                    );
                  })()}
                  value={group?.name ?? "None"}
                  onOpen={() => setView("group")}
                />
              )}

              <div className="my-1 border-t" />

              {/* Two steps, not one. Closing ends the session and leaves it where it is — in this
                  project, in this folder, reopenable — because a session you have finished with for
                  today is still the place that work happened. One that died on its own is closed the
                  same way, which is what gives it back its Reopen. Removing it is the second step,
                  offered once the row is sitting there closed, and it is what clears it out of the
                  list into the Recent tab. */}
              {!restorable &&
                item(
                  running ? "Stop session" : "Close session",
                  <Square className="size-3.5" />,
                  onStop
                )}
              {item("Remove session", <X className="size-3.5" />, onRemove, true)}
            </>
          )}
        </div>
      )}
    </span>
  );
}

/**
 * Confirmation popup for bulk-removing a folder's sessions. Lets the user choose whether to remove
 * active (running) and/or inactive (closed/exited/failed) sessions in that folder before removing.
 */
function FolderRemoveDialog({
  dir,
  sessions,
  onRemove,
  onClose,
}: {
  dir: string;
  sessions: SessionInfo[];
  onRemove: (ids: string[]) => void;
  onClose: () => void;
}) {
  const active = sessions.filter((s) => s.state === "Running");
  const inactive = sessions.filter((s) => s.state !== "Running");
  // Nothing is pre-selected. Inactive used to mean leftovers — sessions from a previous run, or ones
  // that died — and pre-checking that bucket was a convenience. It now also holds every session
  // somebody stopped and deliberately kept in this folder, so a dialog that opens ready to delete
  // them would undo the whole point of keeping them. Both buckets are an explicit choice.
  const [rmActive, setRmActive] = useState(false);
  const [rmInactive, setRmInactive] = useState(false);

  const ids = [
    ...(rmActive ? active : []),
    ...(rmInactive ? inactive : []),
  ].map((s) => s.id);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Remove sessions</DialogTitle>
          <DialogDescription>
            In <span className="font-mono text-foreground">{folderLabel(dir)}</span>. Choose which to
            remove — this stops running processes and forgets the rest.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <label className={cn("flex items-center gap-2 text-sm", active.length === 0 && "opacity-50")}>
            <Checkbox
              checked={rmActive}
              onCheckedChange={(v) => setRmActive(v === true)}
              disabled={active.length === 0}
            />
            <span>Active (running)</span>
            <span className="ml-auto text-xs text-muted-foreground">{active.length}</span>
          </label>
          <label className={cn("flex items-center gap-2 text-sm", inactive.length === 0 && "opacity-50")}>
            <Checkbox
              checked={rmInactive}
              onCheckedChange={(v) => setRmInactive(v === true)}
              disabled={inactive.length === 0}
            />
            <span>Inactive (closed / exited)</span>
            <span className="ml-auto text-xs text-muted-foreground">{inactive.length}</span>
          </label>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={ids.length === 0}
            onClick={() => onRemove(ids)}
          >
            Remove {ids.length > 0 ? ids.length : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TabButton({
  active,
  onClick,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  count?: number;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium transition-colors",
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
      )}
    >
      {/* Label truncates before the count does: a clipped word still reads, a clipped number lies. */}
      <span className="truncate">{children}</span>
      {count !== undefined && count > 0 && (
        <span className="shrink-0 text-[10px] tabular-nums opacity-70">{count}</span>
      )}
    </button>
  );
}

function RecentList({
  recents,
  grouped,
  collapsed,
  onToggleGroup,
  onReuse,
  onRemove,
  onReorder,
  projects,
  collapsedProjects,
  onToggleProject,
  onProjectSettings,
  onNewProject,
  onMoveToProject,
  folderDnd,
}: {
  recents: RecentSession[];
  grouped: boolean;
  collapsed: Set<string>;
  onToggleGroup: (dir: string) => void;
  onReuse: (r: RecentSession) => void;
  onRemove: (r: RecentSession) => void;
  onReorder: (from: number, to: number) => void;
  // Projects work the same way here as on the sessions tab — the two lists group by folder, so they
  // group by project too, and a folder linked from one tab is linked on the other.
  projects: Project[];
  collapsedProjects: ReadonlySet<string>;
  onToggleProject: (key: string) => void;
  onProjectSettings: (project: Project) => void;
  onNewProject: (folder: string) => void;
  onMoveToProject: (dir: string, projectId: string | null) => void;
  folderDnd: ReturnType<typeof useFolderDrag>;
}) {
  const dnd = useDragReorder(onReorder);

  // `i` is the index in the flat `recents` list so drag-reorder is unaffected by grouping;
  // `showPath` is dropped in grouped mode where the folder is already in the header.
  const renderRow = (r: RecentSession, i: number, showPath: boolean) => (
    <div
      key={i}
      {...dnd.rowProps(i)}
      onClick={() => onReuse(r)}
      title="Click to adjust and create"
      className="group relative flex cursor-pointer flex-col gap-1 rounded-md border border-transparent px-2.5 py-2 text-sm hover:bg-accent"
    >
      {/* Drop indicator; see the session row's for why it isn't the top border. */}
      {dnd.isOver(i) && (
        <span className="pointer-events-none absolute inset-x-2 -top-px h-0.5 rounded-full bg-primary" />
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate">{recentLabel(r)}</span>
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove(r);
          }}
          className="opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
          title="Remove from recent"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="flex items-center gap-1.5">
        {r.model ? (
          <Badge variant="secondary" className="capitalize">{r.model}</Badge>
        ) : (
          <Badge variant="secondary">default</Badge>
        )}
        {r.remoteControl && (
          <Radio className="size-3 text-muted-foreground" aria-label="remote control" />
        )}
      </div>
      {r.command && (
        <span className="flex items-start gap-1 truncate text-[10px] text-muted-foreground">
          <Terminal className="mt-0.5 size-2.5 shrink-0" />
          <span className="truncate">{r.command}</span>
        </span>
      )}
      {showPath && (
        <span className="truncate font-mono text-[10px] text-muted-foreground">{r.workingDirectory}</span>
      )}
    </div>
  );

  // The presets of one folder, drawn under the folder's header or — where the project heading has
  // already named the folder — straight under that. Same indent either way.
  const renderGroupRows = (g: ReturnType<typeof groupByFolder<RecentSession>>[number]) => (
    <div className="mt-1 space-y-1 pl-[18px]">
      {g.items.map(({ item, index }) => renderRow(item, index, false))}
    </div>
  );

  const renderFolderGroup = (g: ReturnType<typeof groupByFolder<RecentSession>>[number]) => {
    const isCollapsed = collapsed.has(g.dir);
    return (
      <div key={g.dir}>
        <GroupHeader
          dir={g.dir}
          count={g.items.length}
          collapsed={isCollapsed}
          onToggle={() => onToggleGroup(g.dir)}
          projects={projects}
          projectId={projectForDir(g.dir, projects)?.id ?? null}
          onMoveToProject={(id) => onMoveToProject(g.dir, id)}
          onNewProject={() => onNewProject(g.dir)}
          dragProps={folderDnd.folderProps(g.dir)}
        />
        {!isCollapsed && renderGroupRows(g)}
      </div>
    );
  };

  return (
    <div data-menu-bounds className="flex-1 overflow-auto px-2 pb-2">
      {recents.length === 0 && (
        <p className="px-2 py-6 text-center text-xs text-muted-foreground">
          No recent sessions yet. Created sessions are saved here to relaunch.
        </p>
      )}
      {grouped ? (
        projects.length > 0 ? (
          <ProjectSections
            sections={sectionsByProject(groupByFolder(recents), projects, (g) => g.dir)}
            collapsed={collapsedProjects}
            onToggle={onToggleProject}
            onSettings={onProjectSettings}
            dnd={folderDnd}
            renderItems={(gs, project) =>
              mergesFolderHeader(project, gs.map((g) => g.dir))
                ? renderGroupRows(gs[0])
                : gs.map(renderFolderGroup)
            }
            countOf={(gs) => gs.reduce((n, g) => n + g.items.length, 0)}
          />
        ) : (
          <div className="space-y-2">{groupByFolder(recents).map(renderFolderGroup)}</div>
        )
      ) : (
        <div className="space-y-1">{recents.map((r, i) => renderRow(r, i, true))}</div>
      )}
    </div>
  );
}
