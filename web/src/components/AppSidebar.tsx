import { useContext, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { filesUrl } from "@/lib/urlState";
import { Button } from "@/components/ui/button";
import { Bot, FolderTree, LogOut, MessagesSquare, PanelLeftClose, Plus, SquareTerminal } from "lucide-react";
import { NotificationToggle } from "./NotificationToggle";
import { SessionsProgressContext } from "./SessionsProgressMenu";
import { ThemeToggle } from "./ThemeToggle";

export type SidebarTab = "sessions" | "files" | "shells";

/**
 * Wraps the left sidebar: the "Hangar" header on top, then a three-tab switcher between the
 * session list, the server-filesystem Files tree and every open shell, and a footer under all of
 * them. The panels are supplied by the caller; only the active one is mounted.
 */
export function AppSidebar({
  tab,
  onTabChange,
  onNew,
  onCollapse,
  onLogout,
  sessions,
  files,
  shells,
  shellsCount,
  update,
  sessionsProgress,
}: {
  tab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  onNew: () => void;
  onCollapse?: () => void; // desktop only: hide the sidebar
  onLogout: () => void;
  sessions: ReactNode;
  files: ReactNode;
  shells: ReactNode;
  /** How many shells are open, on the Shells tab — they keep running whichever tab is showing. */
  shellsCount?: number;
  update?: ReactNode; // "Update available" button; renders nothing unless a build is staged
  /**
   * How much of everything running has finished, shown on the Sessions tab. The headings inside
   * answer that question a project or a folder at a time; this is the same answer for the lot, and
   * it is the one still readable with the list scrolled somewhere else entirely -- or sitting on the
   * Files tab. Its own button (see SessionsProgressMenu), so it sits beside the tab's, not inside.
   */
  sessionsProgress?: ReactNode;
}) {
  // The Sessions count, while it shows, is what crowds the row -- see TabLabel.
  const crowded = useContext(SessionsProgressContext).active > 0;
  return (
    <div className="flex h-full flex-col bg-card">
      {/* App header sits above the tabs so the branding is always on top. */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Bot className="size-4" />
        </div>
        <span className="min-w-0 truncate font-semibold">Hangar</span>
        {/* New session lives here rather than in the session list: it applies to both tabs, and the
            header has room the list header doesn't. */}
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground"
            title="New session"
            onClick={onNew}
          >
            <Plus className="size-4" />
          </Button>
          {onCollapse && (
            <Button
              variant="ghost"
              size="icon"
              className="hidden size-7 text-muted-foreground md:inline-flex"
              title="Hide sidebar"
              onClick={onCollapse}
            >
              <PanelLeftClose className="size-4" />
            </Button>
          )}
        </div>
      </div>
      {/* Positioned so the Sessions fraction's list hangs from the row's left edge, inside the sidebar.
          A container, so the tabs drop their words by the sidebar's own width, not the window's. */}
      <div className="@container relative flex h-10 shrink-0 border-b">
        <TabButton
          active={tab === "sessions"}
          onClick={() => onTabChange("sessions")}
          extra={sessionsProgress}
          title="Sessions"
        >
          <MessagesSquare className="size-4 shrink-0" />
          <TabLabel crowded={crowded}>Sessions</TabLabel>
        </TabButton>
        <TabButton
          active={tab === "files"}
          onClick={() => onTabChange("files")}
          // Middle-click opens the Files tab in a new browser tab (like a session row).
          onMouseDown={(e) => e.button === 1 && e.preventDefault()}
          onAuxClick={(e) => e.button === 1 && window.open(filesUrl(), "_blank", "noopener")}
          title="Files — middle-click to open in a new tab"
        >
          <FolderTree className="size-4 shrink-0" />
          <TabLabel crowded={crowded}>Files</TabLabel>
        </TabButton>
        <TabButton active={tab === "shells"} onClick={() => onTabChange("shells")} title="Shells">
          <SquareTerminal className="size-4 shrink-0" />
          <TabLabel crowded={crowded}>Shells</TabLabel>
          {!!shellsCount && (
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">{shellsCount}</span>
          )}
        </TabButton>
      </div>
      <div className="min-h-0 flex-1">{tab === "sessions" ? sessions : tab === "files" ? files : shells}</div>
      {/* Under both tabs. A staged build's Update sits here rather than in the header, where it
          squeezed the title down to a letter on a narrow sidebar; its colour does the announcing. */}
      <div className="flex shrink-0 items-center gap-1 border-t px-2 py-1.5">
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
          {update}
          <NotificationToggle />
          <ThemeToggle />
        </div>
      </div>
    </div>
  );
}

/**
 * A tab's word, shown only while the row has room for every tab's. Below that the tabs go to icons
 * alone -- the word was what got squeezed anyway, cut through mid-letter with the Sessions count
 * printed over it -- and the tab's tooltip still names it.
 *
 * How much room that takes depends on the count. Without it the words fit in 17.5rem -- just under
 * the default 288px sidebar, which the row is a border's width short of. With it, the Sessions third
 * needs 26rem's worth: a two-digit "10/12" beside the word, and a little to spare. Both classes are
 * spelled out because Tailwind only generates what it finds in the source.
 */
function TabLabel({ crowded, children }: { crowded: boolean; children: ReactNode }) {
  return <span className={crowded ? "hidden @min-[26rem]:inline" : "hidden @min-[17.5rem]:inline"}>{children}</span>;
}

function TabButton({
  active,
  onClick,
  children,
  extra,
  ...rest
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  /** A control of its own beside the label. A button can't hold another, so the tab becomes a cell. */
  extra?: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const look = cn(
    "flex h-full min-w-0 flex-1 items-center justify-center gap-1.5 border-b-2 text-sm font-medium transition-colors",
    active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
  );
  if (extra)
    return (
      // The whole cell still switches tab; the label's button is what keyboard focus lands on.
      <div onClick={onClick} className={cn(look, "cursor-pointer")}>
        <button type="button" {...rest} className="flex min-w-0 items-center gap-1.5 rounded-sm">
          {children}
        </button>
        {extra}
      </div>
    );
  return (
    <button onClick={onClick} {...rest} className={look}>
      {children}
    </button>
  );
}
