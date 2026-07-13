import { useRef, useState, type ReactNode } from "react";
import type { SessionInfo } from "@/types";
import { recentLabel, type RecentSession } from "@/lib/recentSessions";
import { sessionUrl } from "@/lib/urlState";
import { RenameField } from "./RenameField";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "./ThemeToggle";
import { cn } from "@/lib/utils";
import {
  Bot,
  PanelLeftClose,
  Plus,
  Radio,
  RotateCcw,
  X,
  LogOut,
  Pencil,
  Terminal,
  FolderTree,
  List,
  ChevronRight,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
} from "lucide-react";

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
}: {
  dir: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={dir}
      className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-muted-foreground hover:text-foreground"
    >
      {collapsed ? (
        <ChevronRight className="size-3.5 shrink-0" />
      ) : (
        <ChevronDown className="size-3.5 shrink-0" />
      )}
      <FolderTree className="size-3.5 shrink-0" />
      <span className="truncate font-mono text-[11px] font-medium">{folderLabel(dir)}</span>
      <span className="ml-auto shrink-0 text-[10px]">{count}</span>
    </button>
  );
}

/** Shared collapse-set state hook for grouped lists. */
function useCollapsedGroups() {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (dir: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
  // Collapse every given folder, or clear the set to expand all.
  const setAll = (dirs: string[], allCollapsed: boolean) =>
    setCollapsed(allCollapsed ? new Set(dirs) : new Set());
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
  activeId,
  onSelect,
  onNew,
  onClose,
  onRestore,
  onRename,
  onLogout,
  onCollapse,
  recents,
  onReuse,
  onRemoveRecent,
  onReorderRecent,
}: {
  sessions: SessionInfo[];
  busyIds: Set<string>;
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: (id: string) => void;
  onRestore: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onLogout: () => void;
  onCollapse?: () => void;
  recents: RecentSession[];
  onReuse: (r: RecentSession) => void;
  onRemoveRecent: (r: RecentSession) => void;
  onReorderRecent: (from: number, to: number) => void;
}) {
  const [tab, setTab] = useState<"sessions" | "recent">("sessions");
  const [grouped, setGrouped] = useState<boolean>(loadGrouped);
  const [editingId, setEditingId] = useState<string | null>(null);
  const { collapsed, toggle: toggleGroup, setAll: setAllGroups } = useCollapsedGroups();

  // Dirs of the groups currently shown, and whether every one is collapsed — drives the
  // collapse/expand-all toggle so it flips to "expand" once nothing is left open.
  const visibleDirs = (tab === "sessions"
    ? groupByFolder(sessions)
    : groupByFolder(recents)
  ).map((g) => g.dir);
  const allCollapsed = visibleDirs.length > 0 && visibleDirs.every((d) => collapsed.has(d));
  const toggleAllGroups = () => setAllGroups(visibleDirs, !allCollapsed);

  const toggleGrouped = () =>
    setGrouped((v) => {
      saveGrouped(!v);
      return !v;
    });

  // A single session row. Sessions are ordered newest-first (by creation time); `showPath` is
  // dropped in grouped mode where the folder is already in the header.
  const renderRow = (s: SessionInfo, showPath: boolean) => {
    const restorable = s.state === "Restorable";
    // Restorable sessions can't be opened in place (they need reopening first), so no new-tab either.
    const openInNewTab = () => window.open(sessionUrl(s.id), "_blank", "noopener");
    return (
      <div
        key={s.id}
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
          "group flex flex-col gap-1 rounded-md border border-transparent px-2.5 py-2 text-sm hover:bg-accent",
          restorable ? "opacity-80" : "cursor-pointer",
          activeId === s.id && !restorable && "border-border bg-accent"
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1">
            {/* Fixed-width gutter so the title never shifts when the activity dot appears. Busy
                (emerald) wins; otherwise the watchdog surfaces recovering (amber) / attention (red). */}
            <span className="flex w-2.5 shrink-0 items-center justify-center">
              {!restorable &&
                (busyIds.has(s.id) ? (
                  <span
                    className="size-2 rounded-full bg-emerald-500 animate-pulse"
                    aria-label="Claude is working"
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
                className="opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
              >
                <Pencil className="size-3.5" />
              </button>
            )}
            {restorable && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRestore(s.id);
                }}
                title="Reopen — resumes this conversation (--continue)"
                className="flex items-center gap-1 rounded px-1 py-0.5 text-[10px] font-medium text-muted-foreground hover:text-foreground"
              >
                <RotateCcw className="size-3" /> Reopen
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose(s.id);
              }}
              className="opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
              title={restorable ? "Forget" : "Close session"}
            >
              <X className="size-3.5" />
            </button>
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
      <div className="flex h-14 items-center gap-2 border-b px-3">
        <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Bot className="size-4" />
        </div>
        <span className="font-semibold">Claude Web</span>
        {onCollapse && (
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto hidden size-7 text-muted-foreground md:inline-flex"
            title="Hide sidebar"
            onClick={onCollapse}
          >
            <PanelLeftClose className="size-4" />
          </Button>
        )}
      </div>

      <div className="p-2">
        <Button onClick={onNew} className="w-full justify-start" size="sm">
          <Plus className="size-4" /> New session
        </Button>
      </div>

      {/* Tab switcher: active sessions vs. reusable recent presets. */}
      <div className="flex items-center gap-1 px-2 pb-2">
        <TabButton active={tab === "sessions"} onClick={() => setTab("sessions")}>
          Sessions{sessions.length > 0 && ` (${sessions.length})`}
        </TabButton>
        <TabButton active={tab === "recent"} onClick={() => setTab("recent")}>
          Recent{recents.length > 0 && ` (${recents.length})`}
        </TabButton>
        {((tab === "sessions" && sessions.length > 0) ||
          (tab === "recent" && recents.length > 0)) && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground"
            title={grouped ? "Show as a flat list" : "Group by folder"}
            aria-pressed={grouped}
            onClick={toggleGrouped}
          >
            {grouped ? <List className="size-4" /> : <FolderTree className="size-4" />}
          </Button>
        )}
        {grouped && visibleDirs.length > 0 && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground"
            title={allCollapsed ? "Expand all folders" : "Collapse all folders"}
            onClick={toggleAllGroups}
          >
            {allCollapsed ? (
              <ChevronsUpDown className="size-4" />
            ) : (
              <ChevronsDownUp className="size-4" />
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
        {sessions.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">No sessions yet</p>
        )}
        {grouped ? (
          <div className="space-y-2">
            {groupByFolder(sessions).map((g) => {
              const isCollapsed = collapsed.has(g.dir);
              return (
                <div key={g.dir}>
                  <GroupHeader
                    dir={g.dir}
                    count={g.items.length}
                    collapsed={isCollapsed}
                    onToggle={() => toggleGroup(g.dir)}
                  />
                  {!isCollapsed && (
                    <div className="mt-1 space-y-1 pl-1">
                      {g.items.map(({ item }) => renderRow(item, false))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="space-y-1">{sessions.map((s) => renderRow(s, true))}</div>
        )}
      </div>
      )}

      <div className="flex items-center gap-1 border-t p-2">
        <Button variant="ghost" size="sm" className="flex-1 justify-start text-muted-foreground" onClick={onLogout}>
          <LogOut className="size-4" /> Sign out
        </Button>
        <ThemeToggle />
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
      )}
    >
      {children}
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
          <span className="truncate font-medium">{recentLabel(r)}</span>
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
