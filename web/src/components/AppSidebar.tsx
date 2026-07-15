import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { filesUrl } from "@/lib/urlState";
import { Button } from "@/components/ui/button";
import { Bot, FolderTree, MessagesSquare, PanelLeftClose } from "lucide-react";

export type SidebarTab = "sessions" | "files";

/**
 * Wraps the left sidebar: the "Claude Web" header on top, then a two-tab switcher between the session
 * list and the server-filesystem Files tree. Both panels are supplied by the caller; only the active
 * one is mounted.
 */
export function AppSidebar({
  tab,
  onTabChange,
  onCollapse,
  sessions,
  files,
}: {
  tab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  onCollapse?: () => void; // desktop only: hide the sidebar
  sessions: ReactNode;
  files: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col bg-card">
      {/* App header sits above the tabs so the branding is always on top. */}
      <div className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
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
      <div className="flex shrink-0 border-b">
        <TabButton active={tab === "sessions"} onClick={() => onTabChange("sessions")}>
          <MessagesSquare className="size-4" />
          Sessions
        </TabButton>
        <TabButton
          active={tab === "files"}
          onClick={() => onTabChange("files")}
          // Middle-click opens the Files tab in a new browser tab (like a session row).
          onMouseDown={(e) => e.button === 1 && e.preventDefault()}
          onAuxClick={(e) => e.button === 1 && window.open(filesUrl(), "_blank", "noopener")}
          title="Middle-click to open in a new tab"
        >
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
  ...rest
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      onClick={onClick}
      {...rest}
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
