import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitHubPullDetail, GitHubPullFile } from "@/types";
import { api } from "@/lib/api";
import { STATUS_COLOR } from "@/lib/gitStatusColor";
import { allRows, oneSidedAs, parseUnifiedDiff, type DiffHunk } from "@/lib/unifiedDiff";
import { cn } from "@/lib/utils";
import { Markdown } from "./Markdown";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  SquareArrowOutUpRight,
  WrapText,
} from "lucide-react";

// Whether the file sidebar is showing, remembered per browser: it's a use of screen width, like the
// Split view's divider, not something the session should carry to every device.
const SIDEBAR_KEY = "claudeweb.prFilesSidebar";
// Whether long lines wrap instead of running off to the right. Per-browser for the same reason: it
// is a reaction to how wide this screen's pane is. On by default, which is where this differs from
// GitHub — GitHub is read in a whole browser window, this in half of one, and two columns of eighty
// characters do not fit in half a window. Off gives GitHub's behaviour exactly.
const WRAP_KEY = "claudeweb.prDiffWrap";
// A diff this big is not read top to bottom, and drawing every row of every such file on open would
// cost seconds. Those files arrive collapsed instead, one click from being read. Both a row count and
// a size, because they catch different things: a long file, and a generated one whose "two changed
// lines" are two lines of a megabyte each.
const BIG_DIFF_ROWS = 800;
const BIG_DIFF_CHARS = 60_000;
// Shared empty list, so a PR that has not loaded yet hands out the same array every render and the
// work keyed on it (the row counts below) is redone when the PR changes rather than on every render.
const NO_FILES: GitHubPullFile[] = [];

function readSidebarOpen(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== "closed";
  } catch {
    return true;
  }
}

function readWrap(): boolean {
  try {
    return localStorage.getItem(WRAP_KEY) !== "off";
  } catch {
    return true;
  }
}

/** The word a status letter stands for, for the file row's tooltip. */
const STATUS_WORD: Record<string, string> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
};

/** Split a path into the folders (dimmed) and the file name (the part being looked for). */
function splitPath(path: string): { dir: string; name: string } {
  const at = path.lastIndexOf("/");
  return at === -1 ? { dir: "", name: path } : { dir: path.slice(0, at + 1), name: path.slice(at + 1) };
}

/**
 * One pull request, reviewed in the pane: the files it changes listed down the left, and the changes
 * themselves on the right, old beside new the way GitHub shows them.
 *
 * GitHub is asked once, when the tab is first opened. The view then stays mounted behind whatever
 * else the session shows (see SessionView), so a review that has been sitting behind another tab is
 * as old as the last time it was fetched — which is what the reload in the header is for. It is a
 * deliberate trade: re-asking on every tab click would put a `gh` call behind a keystroke.
 */
export function PullRequestView({
  sessionId,
  number,
  onTitle,
}: {
  sessionId: string;
  number: number;
  /** The PR's real title, once GitHub has given it — the tab may be showing an older one. */
  onTitle?: (title: string) => void;
}) {
  const [detail, setDetail] = useState<GitHubPullDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState(readSidebarOpen);
  const [wrap, setWrap] = useState(readWrap);
  // Files the reader has collapsed or expanded by hand, by path. Everything not in here follows the
  // default, which is "open unless it is enormous" — so a re-fetch doesn't undo what was folded away.
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const fileRefs = useRef(new Map<string, HTMLDivElement>());
  // Held in a ref rather than depended on: the caller writes it inline, so a new function arrives
  // every render, and a fetch keyed on that would re-fetch the PR for the rest of the page's life.
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.githubPull(sessionId, number);
      setDetail(res);
      setError(res.error ?? null);
      if (res.pull?.title) onTitleRef.current?.(res.pull.title);
    } catch {
      setDetail(null);
      setError("Could not reach the server.");
    } finally {
      setLoading(false);
    }
  }, [sessionId, number]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleSidebar = useCallback(() => {
    setSidebar((open) => {
      try {
        localStorage.setItem(SIDEBAR_KEY, open ? "closed" : "open");
      } catch {
        /* private window — the default stands in */
      }
      return !open;
    });
  }, []);

  const toggleWrap = useCallback(() => {
    setWrap((on) => {
      try {
        localStorage.setItem(WRAP_KEY, on ? "off" : "on");
      } catch {
        /* private window — the default stands in */
      }
      return !on;
    });
  }, []);

  const files = detail?.files ?? NO_FILES;

  // Which files are too big to draw on open, worked out once per load rather than per render.
  const big = useMemo(
    () =>
      new Set(
        files
          .filter((f) => f.additions + f.deletions > BIG_DIFF_ROWS || f.diff.length > BIG_DIFF_CHARS)
          .map((f) => f.path)
      ),
    [files]
  );
  const isOpen = useCallback(
    (f: GitHubPullFile) => folded[f.path] ?? (!f.binary && !big.has(f.path)),
    [folded, big]
  );

  const setAll = (open: boolean) =>
    setFolded(Object.fromEntries(files.map((f) => [f.path, open])));

  // Clicking a file in the sidebar brings it into view and opens it — asking for a file is asking to
  // read it, and scrolling to a collapsed header would land on nothing.
  const reveal = useCallback((path: string) => {
    setFolded((prev) => ({ ...prev, [path]: true }));
    // After the row has been laid out at its new height.
    requestAnimationFrame(() =>
      fileRefs.current.get(path)?.scrollIntoView({ block: "start", behavior: "smooth" })
    );
  }, []);

  const pull = detail?.pull;
  const { Icon: StateIcon, className: stateClass } = (() => {
    if (!pull) return { Icon: GitPullRequest, className: "text-muted-foreground" };
    if (pull.state === "MERGED") return { Icon: GitMerge, className: "text-violet-500" };
    if (pull.state === "CLOSED") return { Icon: GitPullRequestClosed, className: "text-red-500" };
    if (pull.draft) return { Icon: GitPullRequestDraft, className: "text-muted-foreground" };
    return { Icon: GitPullRequest, className: "text-emerald-500" };
  })();

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-start gap-2 border-b px-3 py-2">
        {/* Hidden below md, where the sidebar itself is: the files are all on screen as their own
            headers there, and a 16rem column beside them would leave nothing for the diff. */}
        <button
          type="button"
          onClick={toggleSidebar}
          title={sidebar ? "Hide the file list" : "Show the file list"}
          className="mt-0.5 hidden rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground md:block"
        >
          {sidebar ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />}
        </button>
        <StateIcon className={cn("mt-1 size-4 shrink-0", stateClass)} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0 text-sm text-muted-foreground">#{number}</span>
            <span className="min-w-0 truncate text-sm font-medium">
              {pull?.title ?? (loading ? "Loading…" : "Pull request")}
            </span>
          </div>
          {pull && (
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              <span className="truncate">{pull.author}</span>
              <span className="truncate font-mono">
                {pull.headRefName} → {pull.baseRefName}
              </span>
              <span>
                <span className="text-emerald-600 dark:text-emerald-400">+{pull.additions}</span>{" "}
                <span className="text-red-600 dark:text-red-400">−{pull.deletions}</span>
              </span>
              <span>
                {pull.changedFiles} {pull.changedFiles === 1 ? "file" : "files"}
              </span>
            </div>
          )}
        </div>
        {files.length > 0 && (
          <div className="flex shrink-0 items-center gap-1 text-xs">
            <button
              type="button"
              onClick={() => setAll(false)}
              className="rounded px-1.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Collapse all
            </button>
            <button
              type="button"
              onClick={() => setAll(true)}
              className="rounded px-1.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Expand all
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={toggleWrap}
          title={
            wrap
              ? "Long lines wrap — click to let them run off to the right instead"
              : "Long lines run off to the right — click to wrap them"
          }
          aria-pressed={wrap}
          className={cn(
            "mt-0.5 shrink-0 rounded p-1 hover:bg-accent hover:text-foreground",
            wrap ? "text-foreground" : "text-muted-foreground"
          )}
        >
          <WrapText className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => void load()}
          title="Reload from GitHub"
          className="mt-0.5 shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <RefreshCw className={cn("size-4", loading && "animate-spin")} />
        </button>
        {pull?.url && (
          <a
            href={pull.url}
            target="_blank"
            rel="noreferrer"
            title="Open this pull request on GitHub"
            className="mt-0.5 shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <SquareArrowOutUpRight className="size-4" />
          </a>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        {sidebar && (
          <div className="hidden w-64 shrink-0 flex-col overflow-y-auto border-r md:flex">
            <div className="sticky top-0 z-10 bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground">
              {files.length} changed {files.length === 1 ? "file" : "files"}
            </div>
            {files.map((f) => {
              const { dir, name } = splitPath(f.path);
              return (
                <button
                  key={f.path}
                  type="button"
                  onClick={() => reveal(f.path)}
                  title={`${f.path}${f.oldPath ? ` (was ${f.oldPath})` : ""} — ${STATUS_WORD[f.status] ?? "changed"}`}
                  className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-accent"
                >
                  <span className={cn("w-3 shrink-0 font-mono", STATUS_COLOR[f.status] ?? "text-muted-foreground")}>
                    {f.status}
                  </span>
                  {/* The folders give way first — the shrink factors are what decides that — so a
                      deep path loses its middle rather than the file name someone is scanning for. */}
                  <span className="flex min-w-0 flex-1 items-baseline">
                    <span className="min-w-0 shrink-[999] truncate text-muted-foreground">{dir}</span>
                    <span className="min-w-0 truncate">{name}</span>
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {f.additions > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{f.additions}</span>}
                    {f.deletions > 0 && <span className="text-red-600 dark:text-red-400"> −{f.deletions}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {error && (
            <div className="m-3 flex items-start gap-2 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
              <div className="min-w-0">
                <div className="break-words">{error}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Pull requests are read through the GitHub CLI on the server machine.
                </div>
              </div>
            </div>
          )}

          {loading && !detail ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Asking GitHub…
            </div>
          ) : (
            <>
              {detail?.body?.trim() && (
                <div className="border-b">
                  <button
                    type="button"
                    onClick={() => setDescriptionOpen((o) => !o)}
                    className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    {descriptionOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                    Description
                  </button>
                  {descriptionOpen && (
                    <div className="px-4 pb-4">
                      <Markdown text={detail.body} />
                    </div>
                  )}
                </div>
              )}

              {!error && files.length === 0 && !loading && (
                <div className="p-4 text-sm text-muted-foreground">
                  This pull request changes no files.
                </div>
              )}

              {files.map((f) => (
                <FileDiff
                  key={f.path}
                  file={f}
                  open={isOpen(f)}
                  wrap={wrap}
                  bigByDefault={big.has(f.path)}
                  onToggle={() => setFolded((prev) => ({ ...prev, [f.path]: !isOpen(f) }))}
                  register={(el) => {
                    if (el) fileRefs.current.set(f.path, el);
                    else fileRefs.current.delete(f.path);
                  }}
                />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** One file of the review: a header that folds it away, and its diff below. */
function FileDiff({
  file,
  open,
  wrap,
  bigByDefault,
  onToggle,
  register,
}: {
  file: GitHubPullFile;
  open: boolean;
  /** Long lines wrap rather than running off to the right — see WRAP_KEY. */
  wrap: boolean;
  /** The file arrived folded because its diff is enormous — say so, so the fold isn't a mystery. */
  bigByDefault: boolean;
  onToggle: () => void;
  register: (el: HTMLDivElement | null) => void;
}) {
  // Parsing is the expensive part of drawing a file, so it waits until the file is actually open.
  const hunks = useMemo(() => (open && !file.binary ? parseUnifiedDiff(file.diff) : []), [open, file]);
  const side = oneSidedAs(file.status);
  const { dir, name } = splitPath(file.path);

  return (
    <div ref={register} className="border-b last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        // Sticky so the name of what you are reading stays on screen through a long diff.
        className="sticky top-0 z-10 flex w-full items-center gap-2 border-b bg-muted/60 px-3 py-1.5 text-left text-xs backdrop-blur hover:bg-muted"
      >
        {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5" />}
        <span className={cn("shrink-0 font-mono", STATUS_COLOR[file.status] ?? "text-muted-foreground")}>
          {file.status}
        </span>
        {/* Same shrink order as the sidebar: the folders go before the file name does. */}
        <span className="flex min-w-0 flex-1 items-baseline font-mono">
          <span className="min-w-0 shrink-[999] truncate text-muted-foreground">{dir}</span>
          <span className="min-w-0 truncate font-medium">{name}</span>
          {file.oldPath && (
            <span className="min-w-0 shrink-[999] truncate text-muted-foreground">
              &nbsp;← {file.oldPath}
            </span>
          )}
        </span>
        <span className="shrink-0 font-mono text-[11px]">
          <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>{" "}
          <span className="text-red-600 dark:text-red-400">−{file.deletions}</span>
        </span>
      </button>

      {open ? (
        file.binary ? (
          <div className="p-4 text-sm text-muted-foreground">Binary file — nothing to show.</div>
        ) : file.truncated ? (
          // The server sends no text for a file it cut, precisely so half a diff is never drawn as
          // though it were the whole one. The counts in the header still say how much changed.
          <div className="p-4 text-sm text-muted-foreground">
            This file's diff is too large to show here — it is on GitHub.
          </div>
        ) : hunks.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">
            {file.status === "R" ? "Renamed with no other change." : "No changes to show."}
          </div>
        ) : side ? (
          <OneSided hunks={hunks} side={side} wrap={wrap} />
        ) : (
          <SideBySide hunks={hunks} wrap={wrap} />
        )
      ) : (
        bigByDefault && (
          <div className="px-4 py-2 text-xs text-muted-foreground">
            Large diff — click the header to load it.
          </div>
        )
      )}
    </div>
  );
}

// Grid geometry, shared by both views so their line numbers line up down the page.
const NUM_CELL =
  "select-none px-2 text-right font-mono text-[11px] leading-[1.45rem] text-muted-foreground/70";
const CODE_CELL = "px-2 font-mono text-xs leading-[1.45rem]";

/**
 * What a line too long for its column does, and how wide the grid is as a result.
 *
 * Wrapped, the grid is exactly the width of the pane and a long line takes several visual lines; the
 * rest of its row stretches with it, so the two sides stay level. Unwrapped, the grid is as wide as
 * its widest line and the pane scrolls — `1fr` columns in a max-content-sized grid all take the
 * width of the widest one, which is what keeps the two halves of a split equal however lopsided the
 * change is, and what makes one scrollbar move both sides together.
 */
function lineMode(wrap: boolean) {
  return {
    grid: wrap ? "w-full" : "w-max min-w-full",
    code: wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre",
    scroll: wrap ? "" : "overflow-x-auto",
  };
}

/** Background for a cell, by what happened to the line it holds. */
function tint(kind: "add" | "del" | "none" | "gap"): string {
  if (kind === "add") return "bg-emerald-500/10";
  if (kind === "del") return "bg-red-500/10";
  if (kind === "gap") return "bg-muted/40"; // the other side has no line here at all
  return "";
}

/** The old file beside the new one — the view for a file that existed before and still does. */
function SideBySide({ hunks, wrap }: { hunks: DiffHunk[]; wrap: boolean }) {
  const mode = lineMode(wrap);
  return (
    <div className={mode.scroll}>
      <div className={cn("grid grid-cols-[3.25rem_1fr_3.25rem_1fr]", mode.grid)}>
        {hunks.map((hunk, h) => (
          <HunkRows key={h} header={hunk.header} span={4}>
            {hunk.rows.map((row, i) => {
              const leftKind = row.left ? (row.kind === "context" ? "none" : "del") : "gap";
              const rightKind = row.right ? (row.kind === "context" ? "none" : "add") : "gap";
              return (
                <div key={i} className="contents">
                  <div className={cn(NUM_CELL, tint(leftKind))}>{row.left?.number ?? ""}</div>
                  <div className={cn(CODE_CELL, mode.code, tint(leftKind))}>{row.left?.text || " "}</div>
                  <div className={cn(NUM_CELL, "border-l", tint(rightKind))}>{row.right?.number ?? ""}</div>
                  <div className={cn(CODE_CELL, mode.code, tint(rightKind))}>{row.right?.text || " "}</div>
                </div>
              );
            })}
          </HunkRows>
        ))}
      </div>
    </div>
  );
}

/**
 * A file that was added or deleted, as one column of its content. There is nothing to compare it
 * against, so the second column would be a full-height empty gutter beside the only thing worth
 * reading — the content itself, which is what this shows.
 */
function OneSided({ hunks, side, wrap }: { hunks: DiffHunk[]; side: "add" | "del"; wrap: boolean }) {
  const rows = allRows(hunks);
  const mode = lineMode(wrap);
  return (
    <div className={mode.scroll}>
      <div className={cn("grid grid-cols-[3.25rem_1fr]", mode.grid)}>
        {rows.map((row, i) => {
          const line = side === "add" ? row.right : row.left;
          if (!line) return null;
          // Every line of a new file is an addition; a context line can still turn up where the file
          // was added in a repo that had it before, and it is not tinted.
          const kind = row.kind === "context" ? "none" : side;
          return (
            <div key={i} className="contents">
              <div className={cn(NUM_CELL, tint(kind))}>{line.number}</div>
              <div className={cn(CODE_CELL, mode.code, tint(kind))}>{line.text || " "}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A hunk's "@@" header, spanning the grid, with the hunk's rows under it. */
function HunkRows({
  header,
  span,
  children,
}: {
  header: string;
  span: number;
  children: React.ReactNode;
}) {
  return (
    <>
      <div
        className="border-y bg-sky-500/5 px-3 py-0.5 font-mono text-[11px] text-sky-700 dark:text-sky-400"
        style={{ gridColumn: `span ${span} / span ${span}` }}
      >
        {header}
      </div>
      {children}
    </>
  );
}
