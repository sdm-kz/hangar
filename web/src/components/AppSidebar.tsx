import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { FolderTree, MessagesSquare } from "lucide-react";

export type SidebarTab = "sessions" | "files";

/**
 * Wraps the left sidebar in a two-tab switcher: the session list and the server-filesystem Files
 * tree. Both panels are supplied by the caller; only the active one is mounted.
 */
export function AppSidebar({
  tab,
  onTabChange,
  sessions,
  files,
}: {
  tab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  sessions: ReactNode;
  files: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 border-b">
        <TabButton active={tab === "sessions"} onClick={() => onTabChange("sessions")}>
          <MessagesSquare className="size-4" />
          Sessions
        </TabButton>
        <TabButton active={tab === "files"} onClick={() => onTabChange("files")}>
          <FolderTree className="size-4" />
          Files
        </TabButton>
      </div>
      <div className="min-h-0 flex-1">{tab === "sessions" ? sessions : files}</div>
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
      onClick={onClick}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 border-b-2 py-2 text-sm font-medium transition-colors",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}
