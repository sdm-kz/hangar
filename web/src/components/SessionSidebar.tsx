import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import type { Project, SessionInfo } from "@/types";
import { sessionColor } from "@/lib/sessionColors";
import { forkTree, type ForkNode } from "@/lib/sessionTree";
import {
  isUnder,
  projectForDir,
  sameFolder,
  sectionsByProject,
  type ProjectSection,
} from "@/lib/projects";
import { api } from "@/lib/api";
import { ProjectDialog } from "./ProjectDialog";
import { useConfirm } from "@/components/ui/confirm";
import {
  dirKey,
  loadSessionOrder,
  move,
  saveSessionOrder,
  sortFolderSessions,
  sortPinnedFirst,
  type SessionOrder,
} from "@/lib/sessionOrder";
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
  Boxes,
  Check,
  Copy,
  Filter,
  FolderPlus,
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
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
} from "lucide-react";

// The two lists the session sidebar can show: live sessions, or recent launch presets.
export type SessionListTab = "sessions" | "recent";

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
 * What an activity dot can say, and how it looks — one definition, so a session row and the folder
 * header above it can never disagree about what amber means.
 */
type Activity = "busy" | "compacting" | "waiting" | "attention" | "recovering";
const ACTIVITY_DOT: Record<Activity, { className: string; label: string }> = {
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
};

/** A session's own dot: what it is doing right now, with the live signal (busy) winning. */
function sessionActivity(
  s: SessionInfo,
  busy: boolean,
  waiting: boolean,
  compacting: boolean
): Activity | null {
  // Ahead of plain busy: it's the more specific reading of the same "working" state, and it explains
  // a session that has gone quiet for a minute or two without having stalled.
  if (compacting) return "compacting";
  if (busy) return "busy";
  if (waiting) return "waiting";
  if (s.watchdogStatus === "attention") return "attention";
  if (s.watchdogStatus === "recovering") return "recovering";
  return null;
}

/**
 * A folder's dot: the most urgent thing inside it, which is a different question from what any one
 * session is doing. Waiting-on-you outranks merely working, so a collapsed folder can't hide a
 * prompt behind a session that happens to be generating — the whole point of surfacing it up here.
 */
const FOLDER_URGENCY: Record<Activity, number> = {
  waiting: 5,
  attention: 4,
  recovering: 3,
  compacting: 2,
  busy: 1,
};
function folderActivity(
  items: SessionInfo[],
  busyIds: Set<string>,
  waitingIds: Set<string>,
  compactingIds: Set<string>
): Activity | null {
  let top: Activity | null = null;
  for (const s of items) {
    if (s.state === "Restorable") continue; // a closed session isn't doing anything
    const a = sessionActivity(s, busyIds.has(s.id), waitingIds.has(s.id), compactingIds.has(s.id));
    if (a && (!top || FOLDER_URGENCY[a] > FOLDER_URGENCY[top])) top = a;
  }
  return top;
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
        <FolderTree className="size-3.5 shrink-0" />
        <span className="truncate font-mono text-xs font-medium">{folderLabel(dir)}</span>
        {/* Session count, right after the name rather than pinned to the row's edge: it reads as
            part of the folder's label, and never drifts away from it on a wide sidebar. */}
        <span className="shrink-0 font-mono text-xs tabular-nums">({count})</span>
      </button>
      {activity && (
        <span
          className={cn("size-1.5 shrink-0 rounded-full", ACTIVITY_DOT[activity].className)}
          aria-label={ACTIVITY_DOT[activity].label}
          title={`${ACTIVITY_DOT[activity].label} (in this folder)`}
        />
      )}
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
  const [dropUp, setDropUp] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useDismissable<HTMLSpanElement>(open, useCallback(() => setOpen(false), []));

  // Headers near the bottom of the list would push the menu past the viewport, so flip it upwards.
  const toggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const box = e.currentTarget.getBoundingClientRect();
    setDropUp(window.innerHeight - box.bottom < 160);
    setOpen((o) => !o);
  };

  const pick = (e: React.MouseEvent, run: () => void) => {
    e.stopPropagation();
    setOpen(false);
    run();
  };

  const copyPath = async () => {
    await writeToClipboard(dir);
    // Keep the menu open just long enough to show the copy landed.
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
      setOpen(false);
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
          className={cn(
            "absolute right-0 z-50 w-52 overflow-hidden rounded-md border bg-popover py-1 text-popover-foreground shadow-md",
            dropUp ? "bottom-full mb-1" : "top-full mt-1"
          )}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void copyPath();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
          >
            {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
            {copied ? "Copied!" : "Copy path"}
          </button>

          {/* Move to project. Flat entries rather than a submenu: at this width a fly-out has
              nowhere to go, and a project list is short enough to sit inline. Scrolls once it
              isn't — the menu must not grow past the viewport. */}
          <div className="my-1 border-t" />
          <p className="px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Project
          </p>
          <div className="max-h-48 overflow-auto">
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
                {projectId === p.id && <Check className="ml-auto size-3.5 shrink-0 text-emerald-500" />}
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
          </div>
          <button
            type="button"
            onClick={(e) => pick(e, onNewProject)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
          >
            <FolderPlus className="size-3.5" />
            New project…
          </button>

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
        </div>
      )}
    </span>
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
        {project ? (
          // The colour rides on the icon rather than the text: a tinted label fights the folder
          // names underneath it for attention, and at this size a solid glyph reads better anyway.
          <Boxes className="size-3.5 shrink-0" style={accent ? { color: accent } : undefined} />
        ) : (
          <Minus className="size-3.5 shrink-0" />
        )}
        <span
          className={cn(
            "truncate text-xs font-semibold",
            project ? "text-foreground" : "font-medium italic"
          )}
        >
          {project ? project.name : "No project"}
        </span>
        <span className="shrink-0 font-mono text-xs tabular-nums">({count})</span>
      </button>
      {activity && (
        <span
          className={cn("size-1.5 shrink-0 rounded-full", ACTIVITY_DOT[activity].className)}
          aria-label={ACTIVITY_DOT[activity].label}
          title={`${ACTIVITY_DOT[activity].label} (in this project)`}
        />
      )}
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
  renderItems,
  bodyClassName,
  countOf,
  activityOf,
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
  /** What the number after the project name counts. Defaults to the number of items. */
  countOf?: (items: T[]) => number;
  activityOf?: (items: T[]) => Activity | null;
}) {
  return (
    <div className="space-y-2">
      {sections.map(({ project, items }) => {
        const key = project?.id ?? "";
        const isCollapsed = collapsed.has(key);
        const over = dnd?.isOver(project?.id ?? null) ?? false;
        return (
          <div
            key={key}
            {...(dnd?.sectionProps(project?.id ?? null) ?? {})}
            className={cn(
              "rounded-md transition-colors",
              // Where the folder in flight would land. A tint on the whole section rather than a
              // line: a folder joins a project, it doesn't take a position in it.
              over && "bg-accent ring-1 ring-primary"
            )}
          >
            <ProjectHeader
              project={project}
              count={countOf ? countOf(items) : items.length}
              collapsed={isCollapsed}
              onToggle={() => onToggle(key)}
              onSettings={project ? () => onSettings(project) : undefined}
              onNewSession={project && onNewSession ? () => onNewSession(project) : undefined}
              activity={activityOf?.(items) ?? null}
            />
            {!isCollapsed && (
              // A shallow indent by default: enough that the folder headers read as sitting inside
              // the project, without spending width the session names below them need more.
              <div className={cn("mt-0.5", bodyClassName ?? "space-y-2 pl-2")}>
                {items.length > 0 ? (
                  renderItems(items, project)
                ) : dnd ? (
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
  // Collapse every given key, or clear the set to expand all.
  const setAll = (keys: string[], allCollapsed: boolean) =>
    setCollapsed(() => {
      const next = allCollapsed ? new Set(keys) : new Set<string>();
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
  busyIds,
  waitingIds,
  compactingIds,
  activeId,
  onSelect,
  onNewInFolder,
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
  busyIds: Set<string>;
  waitingIds: Set<string>; // sessions where Claude is waiting on a prompt/dialog
  compactingIds: Set<string>; // sessions where Claude is compacting its conversation
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewInFolder: (dir: string) => void; // start a session in a folder (hover action on group headers)
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
  const [editing, setEditing] = useState<{ id: string | null; folder?: string } | null>(null);
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
  // The grouped list, built once: pins first, then the hand-arranged order, then newest-first for
  // anything the user hasn't placed. `rootIds` is the drag list — top-level rows only, since a fork
  // is drawn under its parent wherever the parent sits — and a drop rewrites exactly that list.
  const groups = useMemo(
    () =>
      groupByFolder(visibleSessions).map((g) => {
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
    [visibleSessions, pinned, order, collapsedForks]
  );

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
      sectionsByProject(visibleSessions, projects, (s) => s.workingDirectory).map((sec) => {
        const key = `project:${sec.project?.id ?? ""}`;
        const nodes = forkTree(sortFolderSessions(sec.items, pinned, order[key]), collapsedForks);
        return {
          ...sec,
          key,
          nodes,
          rootIds: nodes.filter((n) => n.depth === 0).map((n) => n.session.id),
        };
      }),
    [visibleSessions, pinned, projects, order, collapsedForks]
  );

  // Every arrangeable list on screen, by its key, so a drop can find the row order it is rewriting
  // without caring which view produced it. Grouped keys are paths, flat keys are "project:<id>".
  const rootIdsByList = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const g of groups) map[g.key] = g.rootIds;
    for (const sec of flatSections) map[sec.key] = sec.rootIds;
    return map;
  }, [groups, flatSections]);

  /**
   * Sections to actually draw. Under the active-only filter an empty project is a heading over
   * nothing — the sessions that justify it exist, they just aren't running — so it goes. With the
   * filter off it stays: an empty project is still where you drop a folder and reach its settings,
   * and hiding it would leave a project you just made nowhere to be seen.
   */
  const shown = <T,>(sections: ProjectSection<T>[]) =>
    filter === "active" ? sections.filter((s) => s.items.length > 0) : sections;

  // ---- What the collapse/expand-all button acts on -----------------------------------------------
  // Two kinds of heading fold: folder groups, which only the grouped lists have, and project
  // headings, which both lists have — so the button belongs in the flat list too, where projects are
  // the one thing it can fold. It flips to "expand" once everything on screen is already folded.
  const visibleDirs = grouped
    ? (tab === "sessions" ? groupByFolder(visibleSessions) : groupByFolder(recents)).map((g) => g.dir)
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
  const canFoldAll = visibleDirs.length > 0 || projectKeys.length > 0;
  const allCollapsed =
    canFoldAll &&
    visibleDirs.every((d) => collapsed.has(d)) &&
    projectKeys.every((k) => collapsedProjects.has(k));
  const toggleAllGroups = () => {
    // Only touch the folder set where folders are on screen: doing it in the flat list would quietly
    // expand every folder group the user had folded away in the grouped one.
    if (grouped) setAllGroups(visibleDirs, !allCollapsed);
    setAllProjects(projectKeys, !allCollapsed);
  };

  const editingProject = editing?.id ? projects.find((p) => p.id === editing.id) ?? null : null;

  // Drag-to-reorder within one list — a folder group in the grouped view, a project section in the
  // flat one. The list key scopes the drag, so a row can't be dropped into a list it isn't part of.
  const dnd = useDragReorder((from, to, list) => {
    const ids = rootIdsByList[list];
    if (ids) reorderFolder(list, from, to, ids);
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
    const activity = sessionActivity(s, busyIds.has(s.id), waitingIds.has(s.id), compactingIds.has(s.id));
    // Restorable sessions can't be opened in place (they need reopening first), so no new-tab either.
    const openInNewTab = () => window.open(sessionUrl(s.id), "_blank", "noopener");
    // Enough of a step that a fork reads as sitting under its parent at a glance, but capped after
    // a few levels: a fork of a fork of a fork would otherwise squeeze the name out of a narrow
    // sidebar entirely (it can be dragged down to 220px).
    const indent = Math.min(depth, 4) * 14;
    return (
      <div
        key={s.id}
        {...(drag?.props ?? {})}
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
          !restorable && waitingIds.has(s.id) && "ring-1 ring-amber-400/70"
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
            wouldn't shift when the dot appears. What it can say lives in ACTIVITY_DOT, so this row
            and its folder header always mean the same thing by the same colour. It sits ON the colour
            band deliberately, with a ring of the page background around it so the two colours stay
            legible where they meet. */}
        {!restorable && activity && (
          <span className="pointer-events-none absolute left-0.5 top-0.5 rounded-full bg-background p-[2px] leading-none">
            <span
              className={cn("block size-1.5 rounded-full", ACTIVITY_DOT[activity].className)}
              aria-label={ACTIVITY_DOT[activity].label}
            />
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
            {editingId !== s.id && (
              <RowActionsMenu
                canFork={s.canFork}
                restorable={restorable}
                pinned={pinned.has(s.id)}
                onTogglePin={() => togglePin(s.id, !pinned.has(s.id))}
                onRename={() => setEditingId(s.id)}
                onClone={() => onClone(s)}
                onFork={() => onFork(s)}
                onRestore={() => onRestore(s.id)}
                onClose={() => onClose(s.id)}
              />
            )}
            {/* Postponed-message counter: always visible (unlike the hover-only actions) so a stashed
                pool is discoverable from the list. Pinned last so the action buttons expand to its left. */}
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
          </span>
        </div>
        {showPath && (
          <span className="truncate font-mono text-xs text-muted-foreground">{s.workingDirectory}</span>
        )}
      </div>
    );
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
          activity={folderActivity(g.items, busyIds, waitingIds, compactingIds)}
          projects={projects}
          projectId={projectForDir(g.dir, projects)?.id ?? null}
          onMoveToProject={(id) => void moveFolderToProject(g.dir, id)}
          onNewProject={() => setEditing({ id: null, folder: g.dir })}
          dragProps={folderDnd.folderProps(g.dir)}
        />
        {!isCollapsed && (
          <div className="mt-0.5 space-y-0.5 pl-[18px]">
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
        )}
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
              visibleDirs.length > 0 ? "folders and projects" : "projects"
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
      <div className="flex-1 overflow-auto pb-2 pl-2 pr-1">
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
              renderItems={(gs) => gs.map(renderFolderGroup)}
              countOf={(gs) => gs.reduce((n, g) => n + g.count, 0)}
              activityOf={(gs) =>
                folderActivity(gs.flatMap((g) => g.items), busyIds, waitingIds, compactingIds)
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
            renderItems={(ss, project) => renderFlatSection(project, ss)}
            // No folder header stands between a project and its rows here, so the rows carry the
            // indent themselves — the same distance in as a grouped row (a section's pl-2 plus the
            // 18px a folder group gives its own), so switching views doesn't shift them sideways.
            bodyClassName="space-y-0.5 pl-[26px]"
            activityOf={(ss) => folderActivity(ss, busyIds, waitingIds, compactingIds)}
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
          onSaved={onProjectsChange}
          onClose={() => setEditing(null)}
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
  onTogglePin: () => void;
  onRename: () => void;
  onClone: () => void;
  onFork: () => void;
  onRestore: () => void;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const ref = useDismissable<HTMLSpanElement>(open, useCallback(() => setOpen(false), []));

  // Rows near the bottom of the list would push the menu past the viewport, so flip it upwards.
  const toggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const box = e.currentTarget.getBoundingClientRect();
    setDropUp(window.innerHeight - box.bottom < 200);
    setOpen((o) => !o);
  };

  const item = (label: string, icon: ReactNode, run: () => void, destructive = false) => (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setOpen(false);
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
          "rounded text-muted-foreground hover:text-foreground",
          // Touch devices never fire hover, so the strip's only entry point has to stay on screen.
          open
            ? "inline-flex text-foreground"
            : "hidden group-hover:inline-flex [@media(hover:none)]:inline-flex"
        )}
      >
        <MoreVertical className="size-3.5" />
      </button>
      {open && (
        <div
          className={cn(
            "absolute right-0 z-50 w-48 overflow-hidden rounded-md border bg-popover py-1 text-popover-foreground shadow-md",
            dropUp ? "bottom-full mb-1" : "top-full mt-1"
          )}
        >
          {pinned
            ? item("Unpin", <PinOff className="size-3.5" />, onTogglePin)
            : item("Pin to top", <Pin className="size-3.5" />, onTogglePin)}
          {item("Rename", <Pencil className="size-3.5" />, onRename)}
          {item("Clone", <Copy className="size-3.5" />, onClone)}
          {canFork && item("Fork", <GitFork className="size-3.5" />, onFork)}
          {restorable && item("Reopen", <RotateCcw className="size-3.5" />, onRestore)}
          {item(
            restorable ? "Forget" : "Close session",
            <X className="size-3.5" />,
            onClose,
            true
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
        {!isCollapsed && (
          <div className="mt-1 space-y-1 pl-[18px]">
            {g.items.map(({ item, index }) => renderRow(item, index, false))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex-1 overflow-auto px-2 pb-2">
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
            renderItems={(gs) => gs.map(renderFolderGroup)}
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
