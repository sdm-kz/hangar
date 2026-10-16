import { useEffect, useRef } from "react";
import { Menu, Server, TerminalSquare, X } from "lucide-react";
import { ShowSidebarButton } from "@/components/ShowSidebarButton";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { useShells } from "@/lib/useShells";
import { useShownShellsSeen, type ShellActivity } from "@/lib/shellActivity";
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

/** What a ShellView shows: one folder's shells, or the SSH connections opened outside a session. */
export type ShellTarget = { folder: string } | { ssh: true };

/** A request to bring one shell of the view to the front; `n` makes a repeat of the same id count. */
export interface ShellFocus {
  id: string;
  n: number;
}

/**
 * Shells for a folder in the server Files tree, filling the main area the way a previewed file does —
 * or, with an `ssh` target, the SSH connections opened from the Shells tab.
 *
 * The session view puts shells beside a Claude terminal; here there is no session, so the shells
 * <em>are</em> the view. Everything else is the same: the tabs live on the server, each shell runs
 * in its own pty host, and a build left running in one survives a restart of the app.
 */
export function ShellView({
  target,
  focus,
  onAddSsh,
  shellsRev,
  shellActivity,
  shellsSeen,
  onShellSeen,
  onClose,
  onReveal,
  onToggleSidebar,
  collapsed,
  onToggleCollapsed,
}: {
  target: ShellTarget;
  /** Show this shell once the list has it (picked in the Shells tab, or just opened). */
  focus?: ShellFocus | null;
  /** The SSH view's "+": ask for another connection. */
  onAddSsh?: () => void;
  shellsRev?: number;
  /** What the shells' commands are doing, which finished ones were seen, and how to say one was. */
  shellActivity?: Record<string, ShellActivity> | null;
  shellsSeen?: Record<string, number>;
  onShellSeen?: (id: string, endedAt: number) => void;
  onClose: () => void;
  /** Show this folder in the Files tree (the header's folder name links to it). */
  onReveal?: (path: string) => void;
  onToggleSidebar?: () => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const confirm = useConfirm();
  // A folder's view opens a shell when it has none; the SSH view has nothing to open without
  // asking where to, so an empty one simply stands down.
  const folder = "folder" in target ? target.folder : null;
  const viewKey = folder ?? "@ssh";
  const shells = useShells({
    owner: folder !== null ? { folder } : { ssh: true },
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
  }, [viewKey]);
  useEffect(() => {
    if (shells.shells.length > 0) hadShells.current = true;
  }, [shells.shells.length]);

  // Opening the view is the request for a shell, so it starts one rather than showing an empty
  // frame with a "+" in it. Guarded per folder, since the list re-reads on every revision bump.
  useEffect(() => {
    // `failed` matters as much as `loaded`: the hook reports a failed read as loaded-with-no-change
    // (it keeps the tabs on screen), and taking that for an empty folder would open a second shell
    // beside the build already running in the first.
    if (folder === null || !shells.loaded || shells.failed || seeded.current === folder) return;
    seeded.current = folder;
    if (shells.shells.length === 0) void shells.open("");
  }, [folder, shells.loaded, shells.failed, shells.shells.length, shells.open]);

  // Nothing to show in the SSH view, from the start (a refresh after the last connection closed
  // elsewhere, or a row picked for one that just closed): there is no "open one" that needs no
  // answers, so the view stands down. A connection just opened is always in the first read: the view
  // only comes up once the server has answered for it.
  useEffect(() => {
    if (folder === null && shells.loaded && !shells.failed && shells.shells.length === 0) onClose();
  }, [folder, shells.loaded, shells.failed, shells.shells.length, onClose]);

  // Bring the requested shell forward once it is in the list, and only once per request: a later
  // click on another tab must not be dragged back to it on the next re-read.
  const focused = useRef<ShellFocus | null>(null);
  const { restore } = shells;
  useEffect(() => {
    if (!focus || focused.current === focus || !shells.shells.some((s) => s.id === focus.id)) return;
    focused.current = focus;
    restore(focus.id);
  }, [focus, shells.shells, restore]);

  const active = shells.shells.find((s) => s.id === shells.activeId);
  // The tab in front is how a finished command in it gets seen, as in a session's tab bar.
  useShownShellsSeen(active ? [active.id] : [], shellActivity, shellsSeen, onShellSeen);

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
        {folder === null ? (
          <>
            <Server className="size-4 shrink-0 text-muted-foreground" />
            {/* Where the tab in front is connected to, in the place a folder view has its path. */}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">SSH connections</div>
              <div className="truncate text-xs text-muted-foreground">{active?.remote ?? "\u00a0"}</div>
            </div>
          </>
        ) : (
          <>
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
          </>
        )}
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
          onAdd={folder === null ? onAddSsh : undefined}
          addTitle={folder === null ? "Open another SSH connection" : "Open another shell in this folder"}
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
