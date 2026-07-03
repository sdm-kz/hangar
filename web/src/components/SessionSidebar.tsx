import type { SessionInfo, SessionState } from "@/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "./ThemeToggle";
import { cn } from "@/lib/utils";
import { Bot, PanelLeftClose, Plus, Radio, X, LogOut } from "lucide-react";

function stateBadge(state: SessionState) {
  switch (state) {
    case "Running":
      return <Badge variant="success">running</Badge>;
    case "Exited":
      return <Badge variant="secondary">exited</Badge>;
    case "Failed":
      return <Badge variant="destructive">failed</Badge>;
  }
}

export function SessionSidebar({
  sessions,
  activeId,
  onSelect,
  onNew,
  onClose,
  onLogout,
  onCollapse,
}: {
  sessions: SessionInfo[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: (id: string) => void;
  onLogout: () => void;
  onCollapse?: () => void;
}) {
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

      <div className="flex-1 overflow-auto px-2 pb-2">
        {sessions.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">No sessions yet</p>
        )}
        <div className="space-y-1">
          {sessions.map((s) => (
            <div
              key={s.id}
              onClick={() => onSelect(s.id)}
              className={cn(
                "group flex cursor-pointer flex-col gap-1 rounded-md border border-transparent px-2.5 py-2 text-sm hover:bg-accent",
                activeId === s.id && "border-border bg-accent"
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{s.name}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(s.id);
                  }}
                  className="opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                  title="Close session"
                >
                  <X className="size-3.5" />
                </button>
              </div>
              <div className="flex items-center gap-1.5">
                {stateBadge(s.state)}
                {s.remoteControl && (
                  <Radio className="size-3 text-muted-foreground" aria-label="remote control" />
                )}
              </div>
              <span className="truncate font-mono text-[10px] text-muted-foreground">
                {s.workingDirectory}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-1 border-t p-2">
        <Button variant="ghost" size="sm" className="flex-1 justify-start text-muted-foreground" onClick={onLogout}>
          <LogOut className="size-4" /> Sign out
        </Button>
        <ThemeToggle />
      </div>
    </div>
  );
}
