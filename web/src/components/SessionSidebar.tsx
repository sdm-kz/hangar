import { useRef, useState, type ReactNode } from "react";
import type { SessionInfo } from "@/types";
import { recentLabel, type RecentSession } from "@/lib/recentSessions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "./ThemeToggle";
import { cn } from "@/lib/utils";
import { Bot, PanelLeftClose, Plus, Radio, RotateCcw, X, LogOut, Terminal } from "lucide-react";

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
  onLogout,
  onCollapse,
  onReorder,
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
  onLogout: () => void;
  onCollapse?: () => void;
  onReorder: (from: number, to: number) => void;
  recents: RecentSession[];
  onReuse: (r: RecentSession) => void;
  onRemoveRecent: (r: RecentSession) => void;
  onReorderRecent: (from: number, to: number) => void;
}) {
  const [tab, setTab] = useState<"sessions" | "recent">("sessions");
  const dnd = useDragReorder(onReorder);

  return (
    <div className="flex h-full flex-col bg-card">
      <div className="flex items-center gap-2 border-b px-3 py-3">
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
      <div className="flex gap-1 px-2 pb-2">
        <TabButton active={tab === "sessions"} onClick={() => setTab("sessions")}>
          Sessions{sessions.length > 0 && ` (${sessions.length})`}
        </TabButton>
        <TabButton active={tab === "recent"} onClick={() => setTab("recent")}>
          Recent{recents.length > 0 && ` (${recents.length})`}
        </TabButton>
      </div>

      {tab === "recent" ? (
        <RecentList recents={recents} onReuse={onReuse} onRemove={onRemoveRecent} onReorder={onReorderRecent} />
      ) : (
      <div className="flex-1 overflow-auto px-2 pb-2">
        {sessions.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">No sessions yet</p>
        )}
        <div className="space-y-1">
          {sessions.map((s, i) => {
            const restorable = s.state === "Restorable";
            return (
            <div
              key={s.id}
              {...dnd.rowProps(i)}
              onClick={() => (restorable ? onRestore(s.id) : onSelect(s.id))}
              title={restorable ? "Reopen — resumes this conversation (--continue)" : undefined}
              className={cn(
                "group relative flex cursor-pointer flex-col gap-1 rounded-md border border-transparent px-2.5 py-2 text-sm hover:bg-accent",
                activeId === s.id && !restorable && "border-border bg-accent",
                restorable && "opacity-80",
                dnd.overIndex === i && "border-t-2 border-t-primary"
              )}
            >
              {busyIds.has(s.id) && !restorable && (
                <span
                  className="absolute left-1 top-1 size-2 rounded-full bg-emerald-500 animate-pulse"
                  aria-label="Claude is working"
                />
              )}
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1">
                  <span
                    className={cn(
                      "truncate font-medium",
                      s.state !== "Running" && "text-muted-foreground"
                    )}
                  >
                    {s.name}
                  </span>
                  {s.remoteControl && (
                    <Radio className="size-3 shrink-0 text-muted-foreground" aria-label="remote control" />
                  )}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-1.5">
                  {restorable && (
                    <span className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground group-hover:text-foreground">
                      <RotateCcw className="size-3" /> Reopen
                    </span>
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
              <span className="truncate font-mono text-xs text-muted-foreground">
                {s.workingDirectory}
              </span>
            </div>
            );
          })}
        </div>
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
  onReuse,
  onRemove,
  onReorder,
}: {
  recents: RecentSession[];
  onReuse: (r: RecentSession) => void;
  onRemove: (r: RecentSession) => void;
  onReorder: (from: number, to: number) => void;
}) {
  const dnd = useDragReorder(onReorder);
  return (
    <div className="flex-1 overflow-auto px-2 pb-2">
      {recents.length === 0 && (
        <p className="px-2 py-6 text-center text-xs text-muted-foreground">
          No recent sessions yet. Created sessions are saved here to relaunch.
        </p>
      )}
      <div className="space-y-1">
        {recents.map((r, i) => (
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
            <span className="truncate font-mono text-[10px] text-muted-foreground">
              {r.workingDirectory}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
