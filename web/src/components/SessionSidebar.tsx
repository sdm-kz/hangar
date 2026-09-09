import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import type { Project, ProjectGroup, SessionInfo } from "@/types";
import { sessionColor } from "@/lib/sessionColors";
import { forkTree, type ForkNode } from "@/lib/sessionTree";
import {
  groupForSession,
  isUnder,
  mergesFolderHeader,
  projectForDir,
  sameFolder,
  sectionsByProject,
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
import { type ActivityIds } from "@/lib/sessionActivity";
import { recentLabel, type RecentSession } from "@/lib/recentSessions";
import { sessionUrl } from "@/lib/urlState";
import { RenameField } from "./RenameField";
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
import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "./ThemeToggle";
import { NotificationToggle } from "./NotificationToggle";
import { OrphanBar } from "./OrphanBar";
import { cn } from "@/lib/utils";
import { useDismissable } from "@/lib/useDismissable";
import { writeToClipboard } from "@/lib/clipboard";
import {
  type LucideIcon,
  Boxes,
  Check,
  Copy,
  Filter,
  FolderPlus,
  FolderSearch,
  Minus,
  MoreVertical,
  GitFork,
  Inbox,
  Plus,
  Settings,
  Radio,
  RotateCcw,
  Search,
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

// Session-state filter: "active" shows only running sessions, "all" shows everything (exited/closed
// too). Per-browser preference, remembered across refreshes like the grouped toggle.
type SessionFilter = "active" | "all";
const FILTER_KEY = "claudeweb.sessionsFilter";
function loadFilter(): SessionFilter {
  try {
    return localStorage.getItem(FILTER_KEY) === "active" ? "active" : "all";
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
 * something inside woke up. Here it costs nothing and shifts nothing. The ring of page background
 * keeps it legible against a coloured glyph, and out of the flow it takes no pointer events — the
 * same trade the dot on a session row already makes.
 *
 * Expects a positioned parent: wrap the icon, not the row.
 */
function HeadingActivityMark({ activity }: { activity: Activity | null }) {
  if (!activity) return null;
  return (
    <span className="pointer-events-none absolute -left-1 -top-1 rounded-full bg-background p-[2px] leading-none">
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
 */
function ActivityMark({ activity }: { activity: Activity }) {
  const { className, label, Icon } = ACTIVITY_MARK[activity];
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
type Activity = "busy" | "compacting" | "waiting" | "attention" | "recovering" | "done";
const ACTIVITY_MARK: Record<Activity, { className: string; label: string; Icon?: LucideIcon }> = {
  busy: { className: "bg-emerald-500 animate-pulse", label: "Claude is working" },
  // A flavour of busy, so it stays in the working family — a slower pulse and a cooler green, because
  // "still here, but not on your task" is the useful thing to read off it from across the room.
  compacting: {
    className: "bg-teal-400 animate-pulse [animation-duration:2s]",
    label: "Claude is compacting the conversation",
  },
  waiting: {
    className: "bg-amber-400 animate-pulse ring-2 ring-amber-400/40",
    label: "Claude is waiting for your input",
  },
  attention: { className: "bg-red-500", label: "Session needs attention" },
  recovering: { className: "bg-amber-500 animate-pulse", label: "Watchdog is auto-recovering this session" },
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
  if (s.watchdogStatus === "recovering") return "recovering";
  // Last, because it is the only one in past tense: anything the session is doing *now* is the more
  // useful thing to say about it, and a finished turn keeps its tick until you go and look.
  if (ids.done.has(s.id)) return "done";
  return null;
}

/**
 * A folder's mark: the most urgent thing inside it, which is a different question from what any one
 * session is doing. Waiting-on-you outranks merely working, so a collapsed folder can't hide a
 * prompt behind a session that happens to be generating — the whole point of surfacing it up here.
 */
const FOLDER_URGENCY: Record<Activity, number> = {
  waiting: 5,
  attention: 4,
  recovering: 3,
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

function folderActivity(items: SessionInfo[], ids: ActivityIds): Activity | null {
  let top: Activity | null = null;
  for (const s of items) {
    if (s.state === "Restorable") continue; // a closed session isn't doing anything
    const a = sessionActivity(s, ids);
    if (a && (!top || FOLDER_URGENCY[a] > FOLDER_URGENCY[top])) top = a;
  }
  return top;
}

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
}) {
  return (
    <div
      {...dragProps}
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
      // Hidden rather than transparent while idle, so it takes no width and the count next to it
      // sits flush right. Touch devices never fire hover, so the menu's only entry point has to
      // stay on screen there.
      className={cn(
        "relative items-center",
        open ? "flex" : "hidden group-hover/gh:flex [@media(hover:none)]:flex"
      )}
      onClick={(e) => e.stopPropagation()}
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
              {projects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={(e) => pick(e, () => onMoveToProject(p.id))}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <Boxes
                    className="size-3.5 shrink-0"
                    style={sessionColor(p.color) ? { color: sessionColor(p.color)! } : undefined}
                  />
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
                  <Boxes
                    className="size-3.5 shrink-0"
                    style={
                      project && sessionColor(project.color)
                        ? { color: sessionColor(project.color)! }
                        : undefined
                    }
                  />
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
}: {
  group: ProjectGroup;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  activity?: Activity | null;
  onEdit: () => void;
}) {
  const Icon = groupIcon(group.icon);
  const accent = sessionColor(group.color);
  return (
    <div className="group/vf flex w-full items-center gap-1 rounded px-1 py-1 text-muted-foreground">
      <button
        type="button"
        onClick={onToggle}
        title={`${group.name} — a virtual folder; drag sessions onto it to file them here`}
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
  postponed = 0,
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
  // Postponed messages stashed across the whole project, so a collapsed one still says they are
  // there — the per-session badges it is a total of are hidden inside it.
  postponed?: number;
}) {
  const accent = project ? sessionColor(project.color) : null;
  return (
    <div className="group/ph flex w-full items-center gap-1 rounded px-1 py-1 text-muted-foreground">
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
            <Boxes className="size-3.5" style={accent ? { color: accent } : undefined} />
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
  countOf,
  activityOf,
  postponedOf,
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
   * What the number after the project name counts. Defaults to the number of items — anything that
   * also draws virtual folders has to add those in itself, since their sessions are not in `items`.
   */
  countOf?: (items: T[], project: Project | null) => number;
  activityOf?: (items: T[], project: Project | null) => Activity | null;
  /** Postponed messages stashed inside the section. Sessions view only; a recent preset has none. */
  postponedOf?: (items: T[], project: Project | null) => number;
}) {
  return (
    <div className="space-y-2">
      {sections.map(({ project, items }) => {
        const key = project?.id ?? "";
        const isCollapsed = collapsed.has(key);
        const drop = sessionDrop?.(project);
        const groups = before?.(project) ?? null;
        const over = (dnd?.isOver(project?.id ?? null) ?? false) || (drop?.over ?? false);
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
              postponed={postponedOf?.(items, project) ?? 0}
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
 * - `claims` — is this drag any of this target's business? (the session belongs to this project)
 * - `changes` — would dropping here actually alter anything? Only then does the target take the drop
 *   and light up; otherwise it stays quiet and the browser shows the "no" cursor.
 */
function useSessionDrag(onDropSession: (sessionId: string, groupId: string | null) => void) {
  const dragged = useRef<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const end = () => {
    dragged.current = null;
    setOver(null);
  };

  return {
    rowProps: (id: string) => ({
      draggable: true,
      onDragStart: () => {
        dragged.current = id;
      },
      onDragEnd: end,
    }),
    isOver: (key: string) => over === key,
    targetProps: (
      key: string,
      groupId: string | null,
      claims: (sessionId: string) => boolean,
      changes: (sessionId: string) => boolean
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
        onDropSession(id, groupId);
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

/**
 * Native drag-to-reorder for a vertical list. Returns props to spread on each row; a row initiates
 * the drag and is also a drop target. `isOver` reports the row currently hovered during a drag (for
 * a drop indicator). onReorder(from, to, list) receives indices within one list.
 *
 * `list` scopes a drag: the sessions sidebar draws one list per folder, and a row dragged out of its
 * folder has no meaningful index in the folder it lands on, so a cross-list drop is simply ignored.
 * Single-list callers can leave it out.
 */
function useDragReorder(onReorder: (from: number, to: number, list: string) => void) {
  const dragged = useRef<{ index: number; list: string } | null>(null);
  const [over, setOver] = useState<{ index: number; list: string } | null>(null);
  return {
    isOver: (index: number, list = "") => over?.index === index && over.list === list,
    rowProps: (index: number, list = "") => ({
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        dragged.current = { index, list };
        e.dataTransfer.effectAllowed = "move";
      },
      onDragOver: (e: React.DragEvent) => {
        if (dragged.current?.list !== list) return; // from another folder — not a drop target
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (over?.index !== index || over.list !== list) setOver({ index, list });
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        const from = dragged.current;
        if (from && from.list === list && from.index !== index) onReorder(from.index, index, list);
        dragged.current = null;
        setOver(null);
      },
      onDragEnd: () => {
        dragged.current = null;
        setOver(null);
      },
    }),
  };
}

export function SessionSidebar({
  sessions,
  activityIds,
  activeId,
  onSelect,
  onNewInFolder,
  onRevealFolder,
  onNewInProject,
  onClose,
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
  tab,
  onTabChange,
  projects,
  onProjectsChange,
}: {
  sessions: SessionInfo[];
  // Who is busy / waiting on you / compacting / finished-but-unseen, in one bag — see ActivityIds.
  activityIds: ActivityIds;
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewInFolder: (dir: string) => void; // start a session in a folder (hover action on group headers)
  onRevealFolder: (dir: string) => void; // show a folder in the whole-server Files tree
  // Start a session in a project: the create dialog opens with its linked folders offered as picks.
  onNewInProject: (project: Project) => void;
  onClose: (id: string) => void;
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

  // Sessions shown after applying the active/all filter ("active" = running only). Recents aren't
  // filtered (they're presets, not live sessions).
  const visibleSessions =
    filter === "active" ? sessions.filter((s) => s.state === "Running") : sessions;
  const activeCount = sessions.filter((s) => s.state === "Running").length;
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
    return filter === "active" ? gs.filter((g) => g.count > 0) : gs;
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
    filter === "active"
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
   * Only the project list comes back on the response; which group a row is in rides the session list
   * (SessionInfo.groupId), which the server pushes to every browser as it writes — so there is
   * nothing to flip optimistically here, exactly as with a pin.
   */
  const moveSessionToGroup = async (sessionId: string, groupId: string | null) => {
    try {
      onProjectsChange(await api.setSessionGroup(sessionId, groupId));
    } catch {
      /* the list is re-read on the next load; a failed drop isn't worth a dialog */
    }
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

  /** Whether dropping it there would move it — a box it is already in is not somewhere to drop it. */
  const canFile = (sessionId: string, project: Project | null, groupId: string | null) => {
    const s = sessions.find((x) => x.id === sessionId);
    if (!s || !inProject(sessionId, project)) return false;
    return (groupForSession(s, projects)?.id ?? null) !== groupId;
  };

  const sessionDnd = useSessionDrag((id, groupId) => void moveSessionToGroup(id, groupId));

  /** Dropping a row on the project itself is how it leaves a box — see ProjectSections.sessionDrop. */
  const sectionSessionDrop = (project: Project | null) => ({
    props: sessionDnd.targetProps(
      `ungroup:${project?.id ?? ""}`,
      null,
      (id) => inProject(id, project),
      (id) => canFile(id, project, null)
    ),
    over: sessionDnd.isOver(`ungroup:${project?.id ?? ""}`),
  });

  const toggleGrouped = () =>
    setGrouped((v) => {
      saveGrouped(!v);
      return !v;
    });

  const toggleFilter = () =>
    setFilter((v) => {
      const next = v === "active" ? "all" : "active";
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
    drag?: { props: Record<string, unknown>; over: boolean }
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
    // Restorable sessions can't be opened in place (they need reopening first), so no new-tab either.
    const openInNewTab = () => window.open(sessionUrl(s.id), "_blank", "noopener");
    // Enough of a step that a fork reads as sitting under its parent at a glance, but capped after
    // a few levels: a fork of a fork of a fork would otherwise squeeze the name out of a narrow
    // sidebar entirely (it can be dragged down to 220px).
    const indent = Math.min(depth, 4) * 14;
    return (
      <div
        key={s.id}
        // Two drags start here: reorder within this list (top-level rows only — a fork is drawn
        // under its parent, so it has no place of its own to move to) and file into a virtual
        // folder, which any row can do. Neither may start while the row is being renamed: the
        // rename box has to stay selectable with the mouse.
        {...mergeProps(drag?.props, editingId === s.id ? undefined : sessionDnd.rowProps(s.id))}
        style={{ ...(depth > 0 ? { marginLeft: indent } : null), ...colorEdge }}
        onClick={
          restorable
            ? undefined
            : (e) => (e.ctrlKey || e.metaKey ? openInNewTab() : onSelect(s.id))
        }
        // Middle-click opens the session in a new tab; suppress the OS autoscroll it would otherwise start.
        onMouseDown={restorable ? undefined : (e) => e.button === 1 && e.preventDefault()}
        onAuxClick={restorable ? undefined : (e) => e.button === 1 && openInNewTab()}
        // With no path line of its own (grouped mode, or under a project), the folder still has to be
        // recoverable — a project can span several, and "which repo is this one in" is a fair question.
        title={
          restorable
            ? undefined
            : showPath
              ? "Middle-click or Ctrl/⌘-click to open in a new tab"
              : `${s.workingDirectory}
Middle-click or Ctrl/⌘-click to open in a new tab`
        }
        className={cn(
          "group relative flex flex-col gap-1 rounded-md border border-transparent py-1 pl-1.5 pr-2 text-sm hover:bg-accent",
          // Dim a closed session by colour, not opacity: opacity on the row would make its
          // actions menu translucent too, letting the rows underneath show through it.
          restorable ? "text-muted-foreground" : "cursor-pointer",
          activeId === s.id && !restorable && "border-border bg-accent",
          // Claude is waiting on a prompt — draw the eye with a ring even when the row isn't selected.
          !restorable && activityIds.waiting.has(s.id) && "ring-1 ring-amber-400/70",
          // Softer than waiting's ring, and deliberately so: one is a request, the other a receipt.
          // It is what makes a finished session findable in a long list without reading every row.
          // Guarded like the ring above rather than trusting `done` to be free of closed sessions:
          // what keeps them out of it is a prune that runs in an effect, so a mark restored from
          // storage is on screen for a paint before the prune has had a chance to drop it.
          !restorable && activity === "done" && "ring-1 ring-emerald-400/40"
        )}
      >
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
            the colour band deliberately, with a ring of the page background around it so the two
            colours stay legible where they meet. */}
        {!restorable && activity && (
          <span className="pointer-events-none absolute left-0.5 top-0.5 rounded-full bg-background p-[2px] leading-none">
            <ActivityMark activity={activity} />
          </span>
        )}
        <div className="flex items-center justify-between gap-1">
          <span className="flex min-w-0 flex-1 items-center gap-0.5">
            {/* Fold this session's forks away. Only a row that actually has forks gets the toggle —
                no gutter is reserved elsewhere, so a childless row starts at its name. How much a
                collapsed row is hiding rides in the tooltip rather than an inline count, which would
                cost a reserved slot on every parent row just to keep the name from jumping. */}
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
                    ? `Show ${hiddenCount} fork${hiddenCount === 1 ? "" : "s"}`
                    : "Hide this session's forks"
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
                there in the list, so the tooltip carries it rather than the row spending width on it. */}
            {depth > 0 && (
              <span
                className="flex shrink-0 items-center text-muted-foreground"
                title={s.parentName ? `Forked from “${s.parentName}”` : "Forked session"}
              >
                <GitFork className="size-3" aria-label="forked session" />
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
                  "truncate",
                  // A fork's name starts with its parent's, so cutting the tail would leave every
                  // row in a branch looking identical. Lay the text out right-to-left instead so the
                  // ellipsis eats the shared head and the distinguishing tail survives; the inner
                  // bdi keeps the name itself reading left-to-right.
                  depth > 0 && "text-left [direction:rtl]",
                  s.state !== "Running" && "text-muted-foreground"
                )}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setEditingId(s.id);
                }}
                title={depth > 0 ? `${s.name} — double-click to rename` : "Double-click to rename"}
              >
                {depth > 0 ? <bdi dir="ltr">{s.name}</bdi> : s.name}
              </span>
            )}
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
            {/* Postponed-message counter, so a stashed pool is discoverable from the list. It sits
                left of the menu button, which holds the right edge of every row. */}
            {s.postponedCount > 0 && (
              <Badge
                variant="secondary"
                className="gap-0.5 px-1.5"
                title={`${s.postponedCount} postponed message${s.postponedCount === 1 ? "" : "s"}`}
              >
                <Inbox className="size-3" />
                {s.postponedCount}
              </Badge>
            )}
            {editingId !== s.id && (
              <RowActionsMenu
                canFork={s.canFork}
                restorable={restorable}
                pinned={pinned.has(s.id)}
                dir={s.workingDirectory}
                projects={projects}
                projectId={projectForDir(s.workingDirectory, projects)?.id ?? null}
                onMoveToProject={(id) => void moveFolderToProject(s.workingDirectory, id)}
                onNewProject={() => setEditing({ id: null, folder: s.workingDirectory })}
                groups={projectForDir(s.workingDirectory, projects)?.groups ?? []}
                groupId={groupForSession(s, projects)?.id ?? null}
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
                onRestore={() => onRestore(s.id)}
                onClose={() => onClose(s.id)}
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
    indent = "pl-[18px]"
  ) => (
    <div className={cn("mt-0.5 space-y-0.5", indent)}>
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
          draggable ? { props: dnd.rowProps(i, g.key), over: dnd.isOver(i, g.key) } : undefined
        );
      })}
    </div>
  );

  /**
   * One virtual folder: its header and, unless folded, the sessions filed into it. The body is a
   * folder group's body — once you are looking at rows, a box you filled by hand and a box a path
   * filled are the same list. The box itself is the drop target that fills it.
   */
  const renderVirtualGroup = (vg: VirtualGroup, project: Project) => {
    const isCollapsed = collapsed.has(vg.key);
    return (
      <div
        key={vg.key}
        {...sessionDnd.targetProps(
          vg.key,
          vg.group.id,
          (id) => inProject(id, project),
          (id) => canFile(id, project, vg.group.id)
        )}
        className={cn(
          "rounded-md transition-colors",
          sessionDnd.isOver(vg.key) && "bg-accent ring-1 ring-primary"
        )}
      >
        <VirtualFolderHeader
          group={vg.group}
          count={vg.count}
          collapsed={isCollapsed}
          onToggle={() => toggleGroup(vg.key)}
          activity={folderActivity(vg.items, activityIds)}
          onEdit={() => setEditing({ id: project.id, group: vg.group.id })}
        />
        {!isCollapsed && renderGroupRows(vg)}
      </div>
    );
  };

  /** A project's virtual folders, or null when it has none to draw (see ProjectSections.before). */
  const renderVirtualGroups = (project: Project | null) => {
    const gs = shownGroups(project);
    if (!project || gs.length === 0) return null;
    return gs.map((vg) => renderVirtualGroup(vg, project));
  };

  // One folder group: its header and, unless folded, the fork tree of the sessions in it. Pulled out
  // of the list because it is now rendered from two places — inside a project, and loose below them.
  const renderFolderGroup = (g: (typeof groups)[number]) => {
    const isCollapsed = collapsed.has(g.dir);
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
          projects={projects}
          projectId={projectForDir(g.dir, projects)?.id ?? null}
          onMoveToProject={(id) => void moveFolderToProject(g.dir, id)}
          onNewProject={() => setEditing({ id: null, folder: g.dir })}
          dragProps={folderDnd.folderProps(g.dir)}
        />
        {!isCollapsed && renderGroupRows(g)}
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
        draggable ? { props: dnd.rowProps(i, key), over: dnd.isOver(i, key) } : undefined
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
              filter === "active"
                ? `Showing ${activeCount} running session${activeCount === 1 ? "" : "s"} — click to show all`
                : "Showing all sessions — click to show running only"
            }
            aria-pressed={filter === "active"}
            onClick={toggleFilter}
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
      <div data-menu-bounds className="flex-1 overflow-auto pb-2 pl-2 pr-1">
        {sessions.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">No sessions yet</p>
        ) : visibleSessions.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">No running sessions</p>
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
              renderItems={(gs, project) =>
                // A project that is just one folder draws its sessions itself: the folder header
                // would only repeat the heading right above it.
                mergesFolderHeader(project, gs.map((g) => g.dir), shownGroups(project).length > 0)
                  ? renderGroupRows(gs[0], "pl-0")
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
            renderItems={(ss, project) => renderFlatSection(project, ss)}
            // No folder header stands between a project and its rows here, so they sit at the
            // project's own child level — level with the virtual folders beside them, which is what
            // puts a row's fork chevron in the same column as a box's. (They used to carry a folder
            // group's indent as well, which lined them up with the grouped view at the cost of
            // looking like they hung off a header that isn't there.)
            // 5px, not 6: a row carries a 1px transparent border (it turns solid when selected)
            // and a header does not, so the row needs one pixel less to put its chevron in the
            // same column as a virtual folder's.
            bodyClassName="space-y-0.5 pl-[15px]"
            countOf={(ss, project) =>
              ss.length + shownGroups(project).reduce((n, g) => n + g.count, 0)
            }
            activityOf={(ss, project) =>
              folderActivity([...ss, ...shownGroups(project).flatMap((g) => g.items)], activityIds)
            }
            postponedOf={(ss, project) =>
              folderPostponed([...ss, ...shownGroups(project).flatMap((g) => g.items)])
            }
          />
        ) : (
          // Plain flat list: no projects to head it, but the same one arrangeable list underneath —
          // pins float to the top, and everything else keeps the place it was dragged to.
          <div className="space-y-0.5">{renderFlatSection(null, visibleSessions)}</div>
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
  restorable,
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
  onRestore,
  onClose,
}: {
  canFork: boolean;
  restorable: boolean;
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
  onRestore: () => void;
  onClose: () => void;
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

  const item = (label: string, icon: ReactNode, run: () => void, destructive = false) => (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        shut();
        run();
      }}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent",
        destructive && "text-destructive"
      )}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <span ref={ref} className="relative flex items-center" onClick={(e) => e.stopPropagation()}>
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
              {projects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={(e) => pick(e, () => onMoveToProject(p.id))}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <Boxes
                    className="size-3.5 shrink-0"
                    style={sessionColor(p.color) ? { color: sessionColor(p.color)! } : undefined}
                  />
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
              {pinned
                ? item("Unpin", <PinOff className="size-3.5" />, onTogglePin)
                : item("Pin to top", <Pin className="size-3.5" />, onTogglePin)}
              {item("Rename", <Pencil className="size-3.5" />, onRename)}
              {item("Clone", <Copy className="size-3.5" />, onClone)}
              {canFork && item("Fork", <GitFork className="size-3.5" />, onFork)}
              {restorable && item("Reopen", <RotateCcw className="size-3.5" />, onRestore)}

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
                  <Boxes
                    className="size-3.5 shrink-0"
                    style={
                      project && sessionColor(project.color)
                        ? { color: sessionColor(project.color)! }
                        : undefined
                    }
                  />
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

              {item(
                restorable ? "Forget" : "Close session",
                <X className="size-3.5" />,
                onClose,
                true
              )}
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
  // Default to removing only inactive sessions — killing running ones should be a deliberate opt-in.
  const [rmActive, setRmActive] = useState(active.length > 0 && inactive.length === 0);
  const [rmInactive, setRmInactive] = useState(inactive.length > 0);

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
