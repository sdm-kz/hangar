import { useRef, useState, type ReactNode } from "react";
import type { SessionInfo } from "@/types";
import { sessionColor } from "@/lib/sessionColors";
import { forkTree } from "@/lib/sessionTree";
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
import { cn } from "@/lib/utils";
import {
  Copy,
  Filter,
  GitFork,
  Inbox,
  Plus,
  Radio,
  RotateCcw,
  Search,
  X,
  LogOut,
  Pencil,
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
 * Grouping key for a working directory. Windows paths are case-insensitive and mix separators, so the
 * same folder can arrive as both `C:\a\b` and `c:/a/b` (e.g. a `--continue` relaunch) — normalize
 * case, separators and any trailing slash so those collapse into one group instead of duplicating it.
 */
function dirKey(dir: string): string {
  return dir.replace(/[/\\]+/g, "/").replace(/\/+$/, "").toLowerCase();
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

/** Collapsible folder header shared by the grouped session and recent lists. */
function GroupHeader({
  dir,
  count,
  collapsed,
  onToggle,
  onNewSession,
  onRemove,
}: {
  dir: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  // When provided (sessions view only), shows a plus button to start a session in this folder.
  onNewSession?: () => void;
  // When provided (sessions view only), shows a trash button to bulk-remove the folder's sessions.
  onRemove?: () => void;
}) {
  return (
    <div className="group/gh flex w-full items-center gap-1 rounded px-1 py-1 text-muted-foreground">
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
        <span className="truncate font-mono text-[11px] font-medium">{folderLabel(dir)}</span>
      </button>
      <span className="shrink-0 text-[10px]">{count}</span>
      {onNewSession && (
        <button
          type="button"
          onClick={onNewSession}
          title="New session in this folder"
          className="shrink-0 opacity-0 transition-opacity hover:text-foreground group-hover/gh:opacity-100"
        >
          <Plus className="size-3.5" />
        </button>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          title="Remove sessions in this folder…"
          className="shrink-0 opacity-0 transition-opacity hover:text-destructive group-hover/gh:opacity-100"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </div>
  );
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

/** Shared collapse-set state hook for grouped lists; persists the set so it survives a page refresh. */
function useCollapsedGroups() {
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const toggle = (dir: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      saveCollapsed(next);
      return next;
    });
  // Collapse every given folder, or clear the set to expand all.
  const setAll = (dirs: string[], allCollapsed: boolean) =>
    setCollapsed(() => {
      const next = allCollapsed ? new Set(dirs) : new Set<string>();
      saveCollapsed(next);
      return next;
    });
  return { collapsed, toggle, setAll };
}

/**
 * Native drag-to-reorder for a vertical list. Returns props to spread on each row; a row initiates
 * the drag and is also a drop target. `overIndex` is the row currently hovered during a drag (for a
 * drop indicator). onReorder(from, to) receives list indices.
 */
function useDragReorder(onReorder: (from: number, to: number) => void) {
  const dragIndex = useRef<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  return {
    overIndex,
    rowProps: (index: number) => ({
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        dragIndex.current = index;
        e.dataTransfer.effectAllowed = "move";
      },
      onDragOver: (e: React.DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (overIndex !== index) setOverIndex(index);
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        const from = dragIndex.current;
        if (from !== null && from !== index) onReorder(from, index);
        dragIndex.current = null;
        setOverIndex(null);
      },
      onDragEnd: () => {
        dragIndex.current = null;
        setOverIndex(null);
      },
    }),
  };
}

export function SessionSidebar({
  sessions,
  busyIds,
  waitingIds,
  activeId,
  onSelect,
  onNewInFolder,
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
}: {
  sessions: SessionInfo[];
  busyIds: Set<string>;
  waitingIds: Set<string>; // sessions where Claude is waiting on a prompt/dialog
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewInFolder: (dir: string) => void; // start a session in a folder (hover action on group headers)
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
}) {
  const setTab = onTabChange;
  const [grouped, setGrouped] = useState<boolean>(loadGrouped);
  const [filter, setFilter] = useState<SessionFilter>(loadFilter);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Folder whose bulk-remove popup is open (its normalized dirKey), or null.
  const [removeDir, setRemoveDir] = useState<string | null>(null);
  const { collapsed, toggle: toggleGroup, setAll: setAllGroups } = useCollapsedGroups();

  // Sessions shown after applying the active/all filter ("active" = running only). Recents aren't
  // filtered (they're presets, not live sessions).
  const visibleSessions =
    filter === "active" ? sessions.filter((s) => s.state === "Running") : sessions;
  const activeCount = sessions.filter((s) => s.state === "Running").length;

  // Dirs of the groups currently shown, and whether every one is collapsed — drives the
  // collapse/expand-all toggle so it flips to "expand" once nothing is left open.
  const visibleDirs = (tab === "sessions"
    ? groupByFolder(visibleSessions)
    : groupByFolder(recents)
  ).map((g) => g.dir);
  const allCollapsed = visibleDirs.length > 0 && visibleDirs.every((d) => collapsed.has(d));
  const toggleAllGroups = () => setAllGroups(visibleDirs, !allCollapsed);

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
  const renderRow = (s: SessionInfo, showPath: boolean, depth = 0) => {
    const restorable = s.state === "Restorable";
    // Color set via `/color` in the terminal, shown as a left accent stripe on the row.
    const color = sessionColor(s.color);
    // Restorable sessions can't be opened in place (they need reopening first), so no new-tab either.
    const openInNewTab = () => window.open(sessionUrl(s.id), "_blank", "noopener");
    // Stop indenting past a few levels: a fork of a fork of a fork would otherwise squeeze the name
    // out of a narrow sidebar entirely.
    const indent = Math.min(depth, 4) * 12;
    return (
      <div
        key={s.id}
        style={depth > 0 ? { marginLeft: indent } : undefined}
        onClick={
          restorable
            ? undefined
            : (e) => (e.ctrlKey || e.metaKey ? openInNewTab() : onSelect(s.id))
        }
        // Middle-click opens the session in a new tab; suppress the OS autoscroll it would otherwise start.
        onMouseDown={restorable ? undefined : (e) => e.button === 1 && e.preventDefault()}
        onAuxClick={restorable ? undefined : (e) => e.button === 1 && openInNewTab()}
        title={restorable ? undefined : "Middle-click or Ctrl/⌘-click to open in a new tab"}
        className={cn(
          "group relative flex flex-col gap-1 rounded-md border border-transparent px-2.5 py-2 text-sm hover:bg-accent",
          restorable ? "opacity-80" : "cursor-pointer",
          activeId === s.id && !restorable && "border-border bg-accent",
          // Claude is waiting on a prompt — draw the eye with a ring even when the row isn't selected.
          !restorable && waitingIds.has(s.id) && "ring-1 ring-amber-400/70"
        )}
      >
        {color && (
          <span
            aria-hidden
            className="absolute inset-y-1 left-0 w-1 rounded-full"
            style={{ backgroundColor: color }}
          />
        )}
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 flex-1 items-center gap-1">
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
            {/* Fixed-width gutter so the title never shifts when the activity dot appears. Busy
                (emerald) wins; then waiting-on-you (amber, solid); otherwise the watchdog surfaces
                recovering (amber pulse) / attention (red). */}
            <span className="flex w-2.5 shrink-0 items-center justify-center">
              {!restorable &&
                (busyIds.has(s.id) ? (
                  <span
                    className="size-2 rounded-full bg-emerald-500 animate-pulse"
                    aria-label="Claude is working"
                  />
                ) : waitingIds.has(s.id) ? (
                  <span
                    className="size-2 rounded-full bg-amber-400 animate-pulse ring-2 ring-amber-400/40"
                    aria-label="Claude is waiting for your input"
                  />
                ) : s.watchdogStatus === "attention" ? (
                  <span
                    className="size-2 rounded-full bg-red-500"
                    aria-label="Session needs attention"
                  />
                ) : s.watchdogStatus === "recovering" ? (
                  <span
                    className="size-2 rounded-full bg-amber-500 animate-pulse"
                    aria-label="Watchdog is auto-recovering this session"
                  />
                ) : null)}
            </span>
            {editingId === s.id ? (
              <RenameField
                value={s.name}
                onSubmit={(name) => {
                  onRename(s.id, name);
                  setEditingId(null);
                }}
                onCancel={() => setEditingId(null)}
                className="font-medium"
              />
            ) : (
              <span
                className={cn(
                  "truncate font-medium",
                  s.state !== "Running" && "text-muted-foreground"
                )}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setEditingId(s.id);
                }}
                title="Double-click to rename"
              >
                {s.name}
              </span>
            )}
            {s.remoteControl && editingId !== s.id && (
              <Radio className="size-3 shrink-0 text-muted-foreground" aria-label="remote control" />
            )}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {editingId !== s.id && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setEditingId(s.id);
                }}
                title="Rename session"
                className="hidden hover:text-foreground group-hover:inline-flex"
              >
                <Pencil className="size-3.5" />
              </button>
            )}
            {editingId !== s.id && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClone(s);
                }}
                title="Clone — new session with the same settings"
                className="hidden hover:text-foreground group-hover:inline-flex"
              >
                <Copy className="size-3.5" />
              </button>
            )}
            {editingId !== s.id && s.canFork && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onFork(s);
                }}
                title="Fork — branch this conversation into a new session"
                className="hidden hover:text-foreground group-hover:inline-flex"
              >
                <GitFork className="size-3.5" />
              </button>
            )}
            {restorable && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRestore(s.id);
                }}
                title="Reopen — relaunch and resume this session's conversation"
                className="hidden rounded p-0.5 text-muted-foreground hover:text-foreground group-hover:inline-flex"
              >
                <RotateCcw className="size-3.5" />
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose(s.id);
              }}
              className="hidden hover:text-destructive group-hover:inline-flex"
              title={restorable ? "Forget" : "Close session"}
            >
              <X className="size-3.5" />
            </button>
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
        {grouped && visibleDirs.length > 0 && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0 text-muted-foreground"
            title={allCollapsed ? "Expand all folders" : "Collapse all folders"}
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
        />
      ) : (
      <div className="flex-1 overflow-auto px-2 pb-2">
        {sessions.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">No sessions yet</p>
        ) : visibleSessions.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">No running sessions</p>
        ) : null}
        {grouped ? (
          <div className="space-y-2">
            {groupByFolder(visibleSessions).map((g) => {
              const isCollapsed = collapsed.has(g.dir);
              return (
                <div key={g.dir}>
                  <GroupHeader
                    dir={g.dir}
                    count={g.items.length}
                    collapsed={isCollapsed}
                    onToggle={() => toggleGroup(g.dir)}
                    onNewSession={() => onNewInFolder(g.dir)}
                    onRemove={() => setRemoveDir(dirKey(g.dir))}
                  />
                  {!isCollapsed && (
                    <div className="mt-1 space-y-1 pl-1">
                      {/* A fork always shares its parent's folder, so nesting inside the group is
                          the same tree the flat list shows — just scoped to this folder. */}
                      {forkTree(g.items.map(({ item }) => item)).map((n) =>
                        renderRow(n.session, false, n.depth)
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="space-y-1">
            {forkTree(visibleSessions).map((n) => renderRow(n.session, true, n.depth))}
          </div>
        )}
      </div>
      )}

      <div className="flex items-center gap-1 border-t p-2">
        <Button variant="ghost" size="sm" className="flex-1 justify-start text-muted-foreground" onClick={onLogout}>
          <LogOut className="size-4" /> Sign out
        </Button>
        <NotificationToggle />
        <ThemeToggle />
      </div>

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
}: {
  recents: RecentSession[];
  grouped: boolean;
  collapsed: Set<string>;
  onToggleGroup: (dir: string) => void;
  onReuse: (r: RecentSession) => void;
  onRemove: (r: RecentSession) => void;
  onReorder: (from: number, to: number) => void;
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
      className={cn(
        "group flex cursor-pointer flex-col gap-1 rounded-md border border-transparent px-2.5 py-2 text-sm hover:bg-accent",
        dnd.overIndex === i && "border-t-2 border-t-primary"
      )}
    >
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

  return (
    <div className="flex-1 overflow-auto px-2 pb-2">
      {recents.length === 0 && (
        <p className="px-2 py-6 text-center text-xs text-muted-foreground">
          No recent sessions yet. Created sessions are saved here to relaunch.
        </p>
      )}
      {grouped ? (
        <div className="space-y-2">
          {groupByFolder(recents).map((g) => {
            const isCollapsed = collapsed.has(g.dir);
            return (
              <div key={g.dir}>
                <GroupHeader
                  dir={g.dir}
                  count={g.items.length}
                  collapsed={isCollapsed}
                  onToggle={() => onToggleGroup(g.dir)}
                />
                {!isCollapsed && (
                  <div className="mt-1 space-y-1 pl-1">
                    {g.items.map(({ item, index }) => renderRow(item, index, false))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="space-y-1">{recents.map((r, i) => renderRow(r, i, true))}</div>
      )}
    </div>
  );
}
