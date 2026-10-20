import { useCallback, useState } from "react";
import { Check, ChevronDown, FolderGit2, GitBranch, Search } from "lucide-react";
import { syncSessionUi } from "@/lib/sessionUi";
import { useDismissable } from "@/lib/useDismissable";
import { badgeVariants } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { GitWorktree } from "@/types";
import { useApi, useSessionKey } from "@/lib/node";

function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * The header's branch badge. Its body opens the changes, as it always has; the chevron beside it
 * picks which worktree of the repo the badge is about. A session that starts a task in a fresh
 * worktree goes on running in the main folder, so left alone the badge names the folder's branch
 * rather than the one the work is on -- the pick (also settable from inside the session, through
 * /api/self/worktree) puts it on the right one. It is the session's, kept on the server, so every
 * browser shows the same.
 */
export function BranchBadge({
  sessionId,
  branch,
  changeCount,
  worktree,
  onOpenChanges,
}: {
  sessionId: string;
  branch: string;
  changeCount: number;
  /** Folder of the worktree the badge names; "" for the session's own. */
  worktree: string;
  onOpenChanges: () => void;
}) {
  const api = useApi();
  const uiKey = useSessionKey(sessionId);
  const [open, setOpen] = useState(false);
  const [trees, setTrees] = useState<GitWorktree[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismissable<HTMLDivElement>(open, close);

  const toggle = () => {
    if (open) return close();
    setOpen(true);
    setError(null);
    setQuery("");
    setTrees(null);
    api.gitWorktrees(sessionId)
      .then(setTrees)
      .catch(() => setTrees([]));
  };

  const pick = async (tree: GitWorktree) => {
    setError(null);
    try {
      await api.selectGitWorktree(sessionId, tree.isCurrent ? {} : { path: tree.path });
      // The pick is in the session's bag now; fetch it rather than wait for the list push to say so.
      await syncSessionUi(uiKey);
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't switch the worktree");
    }
  };

  // The tick goes on the worktree being shown: the session's own folder when nothing is picked.
  const isShown = (t: GitWorktree) => (worktree ? samePath(t.path, worktree) : t.isCurrent);

  // A repo can carry dozens of worktrees: the search matches the branch or the folder's name -- not
  // its whole path, which every worktree of the repo shares the start of.
  const needle = query.trim().toLowerCase();
  const shown =
    trees && needle
      ? trees.filter(
          (t) =>
            (t.branch ?? "").toLowerCase().includes(needle) ||
            baseName(t.path).toLowerCase().includes(needle)
        )
      : trees;

  return (
    <div ref={ref} className="relative flex shrink-0 items-center">
      <div
        className={cn(
          badgeVariants({ variant: "outline" }),
          "gap-0 overflow-hidden p-0",
          worktree && "border-sky-500/60"
        )}
      >
        <button
          type="button"
          onClick={onOpenChanges}
          className="flex min-w-0 items-center gap-1 py-0.5 pl-2 pr-1 transition-colors hover:bg-accent"
          title={worktree ? `Show git changes — worktree ${worktree}` : "Show git changes"}
        >
          {worktree ? (
            <FolderGit2 className="size-3 shrink-0 text-sky-500" />
          ) : (
            <GitBranch className="size-3 shrink-0" />
          )}
          <span className="max-w-[6rem] truncate @min-[40rem]:max-w-[10rem]">{branch}</span>
          {changeCount > 0 && <span className="shrink-0 text-amber-500">·{changeCount}</span>}
        </button>
        <button
          type="button"
          onClick={toggle}
          title="Choose the worktree whose branch this shows"
          aria-label="Choose the worktree whose branch this shows"
          aria-haspopup="menu"
          aria-expanded={open}
          className={cn(
            "flex self-stretch items-center px-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            open && "bg-accent text-foreground"
          )}
        >
          <ChevronDown className="size-3" />
        </button>
      </div>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-50 mt-2 flex max-h-[min(32rem,calc(100dvh-8rem))] w-80 max-w-[calc(100vw-2rem)] flex-col rounded-md popover-edge bg-popover p-1 text-popover-foreground shadow-md"
        >
          <div className="px-2 pb-1 pt-1.5 text-[11px] text-muted-foreground">Show the branch of</div>
          <div className="relative px-1 pb-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Enter takes the only match, so typing a ticket number and Enter is enough.
                if (e.key === "Enter" && shown?.length === 1) void pick(shown[0]);
              }}
              placeholder="Search branches or folders"
              aria-label="Search worktrees"
              className="h-7 w-full rounded border bg-transparent pl-7 pr-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {shown === null ? (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">Loading…</div>
            ) : shown.length === 0 ? (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">
                {needle ? "No worktree matches." : "No worktrees found."}
              </div>
            ) : (
              shown.map((t) => (
                <button
                  key={t.path}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isShown(t)}
                  onClick={() => void pick(t)}
                  title={t.path}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <Check className={cn("size-3.5 shrink-0", !isShown(t) && "invisible")} />
                  {t.isCurrent ? (
                    <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <FolderGit2 className="size-3.5 shrink-0 text-sky-500" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{t.branch ?? "(detached)"}</span>
                  <span className="max-w-[45%] shrink-0 truncate font-mono text-[11px] text-muted-foreground">
                    {t.isCurrent ? "this folder" : baseName(t.path)}
                  </span>
                </button>
              ))
            )}
          </div>
          {error && <div className="px-2 py-1.5 text-xs text-destructive">{error}</div>}
          <div className="mt-1 border-t px-2 pb-1 pt-2 text-[11px] leading-relaxed text-muted-foreground">
            A session can pick this itself: <span className="font-mono">POST /api/self/worktree</span> with a
            branch or a folder.
          </div>
        </div>
      )}
    </div>
  );
}
