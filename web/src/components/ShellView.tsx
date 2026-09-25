import { useEffect, useRef } from "react";
import { Menu, TerminalSquare, X } from "lucide-react";
import { ShowSidebarButton } from "@/components/ShowSidebarButton";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { useShells } from "@/lib/useShells";
import { cn } from "@/lib/utils";
import { CopyPathButton } from "./CopyPathButton";
import { ShellTabStrip } from "./ShellTabStrip";
import { TerminalPane } from "./TerminalPane";

/** The last segment of a path, for the header's title line. */
function baseName(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return i >= 0 ? trimmed.slice(i + 1) || trimmed : trimmed;
}

/**
 * Shells for a folder in the server Files tree, filling the main area the way a previewed file does.
 *
 * The session view puts shells beside a Claude terminal; here there is no session, so the shells
 * <em>are</em> the view. Everything else is the same: the tabs live on the server, each shell runs
 * in its own pty host, and a build left running in one survives a restart of the app.
 */
export function ShellView({
  folder,
  shellsRev,
  onClose,
  onReveal,
  onToggleSidebar,
  collapsed,
  onToggleCollapsed,
}: {
  /** Absolute path on the server machine. */
  folder: string;
  shellsRev?: number;
  onClose: () => void;
  /** Show this folder in the Files tree (the header's folder name links to it). */
  onReveal?: (path: string) => void;
  onToggleSidebar?: () => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const confirm = useConfirm();
  const shells = useShells({
    owner: { folder },
    shellsRev,
    onError: (message) =>
      void confirm({
        title: "Could not open a shell",
        description: message,
        confirmLabel: "OK",
        destructive: false,
      }),
  });

  const seeded = useRef<string | null>(null);
  // Whether this folder has ever had a shell. The auto-close below keys on it rather than on
  // `opening`: the seeding effect's setState is not visible to an effect in the same commit, so a
  // close condition of "no shells and not opening" would fire in the very flush that starts the
  // first one, and the view would shut itself the moment it opened.
  const hadShells = useRef(false);
  useEffect(() => {
    seeded.current = null;
    hadShells.current = false;
  }, [folder]);
  useEffect(() => {
    if (shells.shells.length > 0) hadShells.current = true;
  }, [shells.shells.length]);

  // Opening the view is the request for a shell, so it starts one rather than showing an empty
  // frame with a "+" in it. Guarded per folder, since the list re-reads on every revision bump.
  useEffect(() => {
    // `failed` matters as much as `loaded`: the hook reports a failed read as loaded-with-no-change
    // (it keeps the tabs on screen), and taking that for an empty folder would open a second shell
    // beside the build already running in the first.
    if (!shells.loaded || shells.failed || seeded.current === folder) return;
    seeded.current = folder;
    if (shells.shells.length === 0) void shells.open("");
  }, [folder, shells.loaded, shells.failed, shells.shells.length, shells.open]);

  // The last tab closed: the folder has nothing left to show, so the view stands down and the main
  // area goes back to whatever it was showing before.
  useEffect(() => {
    if (hadShells.current && shells.loaded && !shells.failed && shells.shells.length === 0) onClose();
  }, [shells.loaded, shells.failed, shells.shells.length, onClose]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        {onToggleSidebar && (
          <Button variant="ghost" size="icon" className="md:hidden" onClick={onToggleSidebar} title="Sessions & files">
            <Menu className="size-5" />
          </Button>
        )}
        {collapsed && onToggleCollapsed && (
          <ShowSidebarButton onClick={onToggleCollapsed} />
        )}
        <TerminalSquare className="size-4 shrink-0 text-muted-foreground" />
        <div className="group min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1">
            <button
              type="button"
              onClick={() => onReveal?.(folder)}
              title={onReveal ? "Show this folder in the Files tree" : undefined}
              className={cn("truncate text-left text-sm font-medium", onReveal && "hover:underline")}
            >
              {baseName(folder)}
            </button>
          </div>
          <div className="flex min-w-0 items-center gap-1">
            <div className="truncate text-xs text-muted-foreground" title={folder}>
              {folder}
            </div>
            <CopyPathButton
              path={folder}
              className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
              iconClassName="size-3"
            />
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} title="Close">
          <X className="size-4" />
        </Button>
      </header>

      {/* One row, same shape as the session's tab bar: the open shells and the "+" that adds one. */}
      <div className="flex h-10 shrink-0 items-center border-b pl-1">
        <ShellTabStrip
          shells={shells.shells}
          activeId={shells.activeId}
          showingShell
          busy={shells.opening}
          onActivate={shells.activate}
          onOpen={(sh) => void shells.open(sh)}
          onClose={(id) => void shells.close(id)}
          className="ml-0 mr-auto"
        />
      </div>

      {/* Every open shell stays mounted, hidden behind the active tab: switching away from a build
          must not drop its socket and stop showing its output. */}
      <div className="flex min-h-0 flex-1 flex-col">
        {shells.shells.map((sh) => (
          <div
            key={sh.id}
            className={cn("flex min-h-0 min-w-0 flex-1 flex-col", sh.id !== shells.activeId && "hidden")}
          >
            <TerminalPane
              // No session behind this one: the pane's session-scoped extras (image upload, the
              // file-link handlers that open a session's Files panel) have nowhere to go, so they
              // stay off and the folder stands in as the working directory.
              sessionId=""
              socketPath={`/hub/shells/${sh.id}/terminal`}
              imagePaste={false}
              workingDirectory={sh.workingDirectory}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
