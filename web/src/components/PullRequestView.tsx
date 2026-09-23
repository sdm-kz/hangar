import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type UIEvent,
} from "react";
import type { GitHubPullDetail, GitHubPullFile, PullFolds } from "@/types";
import { api } from "@/lib/api";
import { loadSessionUi, saveSessionUi, subscribeSessionUi } from "@/lib/sessionUi";
import { writeToClipboard } from "@/lib/clipboard";
import { STATUS_COLOR } from "@/lib/gitStatusColor";
import { highlightLines, type CodeToken } from "@/lib/highlight";
import { allRows, oneSidedAs, parseUnifiedDiff, type DiffRow } from "@/lib/unifiedDiff";
import { cn } from "@/lib/utils";
import { Markdown } from "./Markdown";
import { usePersistentZoom, ZOOM_LEVELS } from "./ZoomControls";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
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
  ZoomIn,
  ZoomOut,
} from "lucide-react";

// Whether the file sidebar is showing, remembered per browser: it's a use of screen width, like the
// Split view's divider, not something the session should carry to every device.
const SIDEBAR_KEY = "claudeweb.prFilesSidebar";
// Whether long lines wrap instead of running off to the right. Per-browser for the same reason: it
// is a reaction to how wide this screen's pane is. On by default, which is where this differs from
// GitHub — GitHub is read in a whole browser window, this in half of one, and two columns of eighty
// characters do not fit in half a window. Off gives GitHub's behaviour exactly.
const WRAP_KEY = "claudeweb.prDiffWrap";
// Width of the file sidebar, dragged by the divider beside it. Per-browser like the Split view's
// own divider, and for the same reason: how much of this screen the list deserves is a fact about
// this screen. Paths are long and deeply nested, so the default is wider than a tab strip wants.
const SIDEBAR_MIN = 140;
const SIDEBAR_DEFAULT = 256;
const SIDEBAR_WIDTH_KEY = "claudeweb.prFilesWidth";
// Left for the diffs whatever the sidebar is dragged to. A two-column diff needs the room far more
// than a list of file names does.
const DIFF_MIN = 320;
// How much of a split diff's width the old side takes, dragged by the divider running down the
// middle of every file. One share for the whole review rather than one per file: the point of the
// two columns is that they line up, and a page where each file sat at its own ratio would be a
// worse thing to read down than a page where none of them moved. Per browser, like the two above.
const SHARE_MIN = 0.15;
const SHARE_MAX = 0.85;
const SHARE_DEFAULT = 0.5;
const SHARE_KEY = "claudeweb.prDiffSplit";
// Code geometry at 100%, in pixels rather than rem so the zoom and the divider drag can both do
// arithmetic with it. Everything the grid draws is one of these times the zoom; the file headers and
// the sidebar are not, because zoom here is for reading the code, not for resizing the furniture.
const NUM_COL = 52; // a line-number column, wide enough for five digits
const CODE_FS = 12; // matches text-xs, the size these cells used before they could be zoomed
const NUM_FS = 11;
const LINE_H = 23.2; // 1.45rem
// A diff this big is not read top to bottom, and drawing every row of every such file on open would
// cost seconds. Those files arrive collapsed instead, one click from being read. Both a row count and
// a size, because they catch different things: a long file, and a generated one whose "two changed
// lines" are two lines of a megabyte each.
const BIG_DIFF_ROWS = 800;
const BIG_DIFF_CHARS = 60_000;
// Paths a session may keep across all the reviews it has open. This is a share of a budget, not a
// comfort limit: the bag holds everything the session remembers in one entry the server caps at
// 64KB, and an entry over the cap is dropped whole rather than trimmed — taking the open tabs, the
// open files and the tree state with it, silently, until the next restart shows them gone. A path
// runs to eighty-odd bytes, so a hundred of them is a few KB and leaves the rest of the bag its
// room. The baseline a bulk fold writes costs nothing and is never trimmed.
const MAX_FOLD_PATHS = 100;
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

function readSidebarWidth(): number {
  try {
    const n = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(n) && n >= SIDEBAR_MIN ? n : SIDEBAR_DEFAULT;
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

function readShare(): number {
  try {
    const n = Number(localStorage.getItem(SHARE_KEY));
    return Number.isFinite(n) && n >= SHARE_MIN && n <= SHARE_MAX ? n : SHARE_DEFAULT;
  } catch {
    return SHARE_DEFAULT;
  }
}

/** A diff row with each side's highlight tokens attached, where the language was one we know. */
type ShownRow = DiffRow & { leftTokens?: CodeToken[]; rightTokens?: CodeToken[] };
interface ShownHunk {
  header: string;
  rows: ShownRow[];
}

/** The word a status letter stands for, for the file row's tooltip. */
const STATUS_WORD: Record<string, string> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
};

/** One review's folds out of the saved bag, ignoring anything that is not the shape we wrote. */
function readFolds(sessionId: string, number: number): PullFolds {
  const saved = loadSessionUi(sessionId).pullFolds?.[number];
  if (!saved || typeof saved !== "object") return {};
  return {
    all: typeof saved.all === "boolean" ? saved.all : undefined,
    // Trimmed as well as type-checked: the budget below is enforced on the way out, and a bag
    // written by another device — or by a build that bounded this differently — comes in here.
    except: Array.isArray(saved.except)
      ? saved.except.filter((p) => typeof p === "string").slice(-MAX_FOLD_PATHS)
      : [],
  };
}

/**
 * Bring the whole record inside the budget, when the reviews between them have remembered more paths
 * than a session may keep. The reviews that are not being read give up their exceptions first: they
 * keep their baseline, which is the bulk decision and costs nothing, while the one in front of the
 * reader keeps its detail. Past that the oldest of its own exceptions go, each one quietly returning
 * its file to the baseline — the least surprising thing that can be dropped.
 */
function capFolds(folds: Record<string, PullFolds>, current: string): Record<string, PullFolds> {
  const count = (f: PullFolds) => f.except?.length ?? 0;
  let total = Object.values(folds).reduce((n, f) => n + count(f), 0);
  if (total <= MAX_FOLD_PATHS) return folds;

  const out = { ...folds };
  for (const key of Object.keys(out)) {
    if (total <= MAX_FOLD_PATHS || key === current) continue;
    total -= count(out[key]);
    out[key] = { ...out[key], except: [] };
  }
  const mine = out[current];
  if (total > MAX_FOLD_PATHS && mine?.except) {
    out[current] = { ...mine, except: mine.except.slice(total - MAX_FOLD_PATHS) };
  }
  return out;
}

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
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [share, setShare] = useState(readShare);
  // Bumped when the server's copy of this session's bag replaces the local mirror. Everything below
  // reads that mirror synchronously at mount, which on any device that has seen this session before
  // happens well ahead of the fetch — so without this a review opened on the laptop and reloaded on
  // the desktop would come back at the desktop's stale folds and offset, and the next fold click
  // there would write the stale baseline back over the laptop's. FileBrowser carries the same epoch
  // for the same reason. Only the seed, not every remote write: a fold someone makes elsewhere
  // should not refold what is under the reader's eyes.
  const [seedEpoch, setSeedEpoch] = useState(0);
  // Reading size for the code itself. Shares the app's zoom stops and its storage convention, under
  // a key of its own so a review's size is not whatever the last file preview was left at.
  const [zoom, setZoom] = usePersistentZoom("prDiff");
  // The line-number column, at this zoom. The grid and the divider both measure against it, so it is
  // worked out once here rather than in each of them.
  const numCol = Math.round(NUM_COL * zoom);
  // Which files are folded away: what Collapse all / Expand all last said, plus the files toggled by
  // hand since. Everything else follows the size default, so a re-fetch doesn't undo what was folded.
  // Restored from the bag, so a review comes back where it was left — on this device and the others.
  const [folds, setFolds] = useState<PullFolds>(() => readFolds(sessionId, number));
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const fileRefs = useRef(new Map<string, HTMLDivElement>());
  // The pane that scrolls through the files, and the two flags its saved offset needs: whether the
  // offset has been replayed yet (scrolls before that are the browser laying rows out, not the
  // reader) and the timer that keeps a scroll from writing the bag on every frame.
  const scrollRef = useRef<HTMLDivElement>(null);
  const restoredRef = useRef(false);
  const saveScrollRef = useRef(0);
  // The row holding the sidebar and the diffs, so the drag knows how much width there is to divide.
  const splitRef = useRef<HTMLDivElement>(null);
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

  useEffect(
    () => subscribeSessionUi(sessionId, (seed) => seed && setSeedEpoch((e) => e + 1)),
    [sessionId]
  );

  // Take the folds the seed brought. Safe to overwrite what is on screen with: the bag layers this
  // browser's own unacknowledged writes back on top of the server's answer, so what comes out here
  // is the server's state with ours already in it.
  useEffect(() => {
    if (seedEpoch > 0) setFolds(readFolds(sessionId, number));
  }, [sessionId, number, seedEpoch]);

  // Replay the remembered offset, but only once the files have stopped arriving: they are drawn as
  // the fetch resolves, and scrolling while rows are still appearing above the viewport lets the
  // browser's scroll anchoring drag the offset somewhere else. A quiet DOM means everything that was
  // going to render has; if the review is shorter than it was — files folded since, or a force-push
  // that dropped some — go as far as it allows rather than waiting for room that is not coming.
  useEffect(() => {
    restoredRef.current = false;
    const box = scrollRef.current;
    // Armed by `detail` rather than by the mount: the deadline below is for a layout settling, and
    // starting it at mount spends it on the `gh` round trip instead — a fetch slower than three
    // seconds would use the whole budget against an empty pane, mark the restore done, and let the
    // first scroll write the top of the pane over the remembered offset.
    if (!box || !detail) return;
    const target = loadSessionUi(sessionId).pullScroll?.[number] ?? 0;
    if (!(target > 0)) {
      restoredRef.current = true;
      return;
    }
    const deadline = Date.now() + 3000;
    let timer = 0;
    const apply = () => {
      if (restoredRef.current) return;
      const max = Math.max(0, box.scrollHeight - box.clientHeight);
      if (max < target && Date.now() < deadline) {
        timer = window.setTimeout(apply, 200); // still filling in — look again
        return;
      }
      box.scrollTop = Math.min(target, max);
      restoredRef.current = true;
      obs.disconnect();
    };
    const settle = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(apply, 120);
    };
    const obs = new MutationObserver(settle);
    obs.observe(box, { childList: true, subtree: true });
    settle(); // it may already be complete
    return () => {
      obs.disconnect();
      window.clearTimeout(timer);
    };
  }, [sessionId, number, detail, seedEpoch]);

  // Save it back on a short debounce. Scrolls before the restore are the browser shifting rows about
  // as they load, not the reader, so they must not overwrite the offset being replayed.
  const onScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      if (!restoredRef.current) return;
      const top = Math.round(e.currentTarget.scrollTop);
      window.clearTimeout(saveScrollRef.current);
      saveScrollRef.current = window.setTimeout(
        () =>
          saveSessionUi(sessionId, {
            pullScroll: { ...loadSessionUi(sessionId).pullScroll, [number]: top },
          }),
        200
      );
    },
    [sessionId, number]
  );

  // A save in flight when the tab closes would write the entry back that closing it just pruned —
  // for a review with no tab left to prune it again.
  useEffect(() => () => window.clearTimeout(saveScrollRef.current), []);

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

  // Drag the divider between the file list and the diffs, the way the Split view's divider works.
  // The pointer events go on the window rather than the divider: a fast drag outruns a 6px target,
  // and losing the pointer mid-drag would strand the layout at whatever width it had got to.
  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = readSidebarWidth();
    let width = startW;
    const onMove = (ev: PointerEvent) => {
      const max = (splitRef.current?.clientWidth ?? Infinity) - DIFF_MIN;
      width = Math.min(Math.max(max, SIDEBAR_MIN), Math.max(SIDEBAR_MIN, startW + ev.clientX - startX));
      setSidebarWidth(width);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
      } catch {
        /* private window — the width holds for this page and starts over on the next */
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const resetResize = useCallback(() => {
    setSidebarWidth(SIDEBAR_DEFAULT);
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(SIDEBAR_DEFAULT));
    } catch {
      /* as above */
    }
  }, []);

  // Drag the divider between the two halves of a diff. The handle belongs to one file, but the share
  // it writes is the review's, so every other file moves with it and the columns stay in step.
  const startShareResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startShare = readShare();
    // The width the two code columns divide between them: the whole row, less the two number columns.
    const usable = (e.currentTarget.parentElement?.clientWidth ?? 0) - 2 * numCol;
    if (usable <= 0) return;
    let next = startShare;
    const onMove = (ev: PointerEvent) => {
      next = Math.min(SHARE_MAX, Math.max(SHARE_MIN, startShare + (ev.clientX - startX) / usable));
      setShare(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        localStorage.setItem(SHARE_KEY, String(next));
      } catch {
        /* as above */
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [numCol]);

  const resetShare = useCallback(() => {
    setShare(SHARE_DEFAULT);
    try {
      localStorage.setItem(SHARE_KEY, String(SHARE_DEFAULT));
    } catch {
      /* as above */
    }
  }, []);

  // Move one stop along the app's shared zoom scale, stopping at either end.
  const stepZoom = useCallback(
    (dir: 1 | -1) => {
      const i = ZOOM_LEVELS.indexOf(zoom) + dir;
      setZoom(ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, i))]);
    },
    [zoom, setZoom]
  );

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
  // A file's size default, which is what it follows until somebody says otherwise.
  const byDefault = useCallback(
    (f: GitHubPullFile) => !f.binary && !big.has(f.path),
    [big]
  );
  // A set, not the array itself: this is asked once per file per render, and a review of three
  // hundred files with three hundred exceptions would otherwise be a scan inside a scan.
  const excepted = useMemo(() => new Set(folds.except ?? []), [folds.except]);
  const isOpen = useCallback(
    (f: GitHubPullFile) => {
      const base = folds.all ?? byDefault(f);
      return excepted.has(f.path) ? !base : base;
    },
    [folds.all, excepted, byDefault]
  );

  // Every change to the folds goes to the bag as it is made: there is no "done reading" moment to
  // save at, and the reader may well close the tab as the next thing they do.
  const putFolds = useCallback(
    (next: PullFolds) => {
      const all = capFolds({ ...loadSessionUi(sessionId).pullFolds, [number]: next }, String(number));
      // What is kept for this review may have been trimmed on the way into the budget, so the state
      // takes what was actually stored rather than what was asked for — otherwise the screen and the
      // bag would disagree until the next reload.
      setFolds(all[number] ?? next);
      saveSessionUi(sessionId, { pullFolds: all });
    },
    [sessionId, number]
  );

  const setAll = (open: boolean) => putFolds({ all: open, except: [] });

  /** Fold or unfold one file, as the exception it is to whatever the rest of the review is doing. */
  const toggleFile = useCallback(
    (f: GitHubPullFile) => {
      const except = folds.except ?? [];
      // Back to the baseline rather than a second exception, so toggling twice leaves no trace.
      const next = excepted.has(f.path)
        ? except.filter((p) => p !== f.path)
        : [...except, f.path];
      putFolds({ ...folds, except: next });
    },
    [folds, excepted, putFolds]
  );

  // Clicking a file in the sidebar brings it into view and opens it — asking for a file is asking to
  // read it, and scrolling to a collapsed header would land on nothing.
  const reveal = useCallback(
    (f: GitHubPullFile) => {
      if (!isOpen(f)) toggleFile(f);
      // After the row has been laid out at its new height.
      requestAnimationFrame(() =>
        fileRefs.current.get(f.path)?.scrollIntoView({ block: "start", behavior: "smooth" })
      );
    },
    [isOpen, toggleFile]
  );

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
          <div className="flex shrink-0 items-center">
            {/* Reading size for the code. The percentage resets, the way it does on every other
                zoomed view in the app — and it is the only label here, so it goes on narrow panes. */}
            <button
              type="button"
              onClick={() => stepZoom(-1)}
              disabled={zoom === ZOOM_LEVELS[0]}
              title="Make the code smaller"
              className="mt-0.5 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <ZoomOut className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => setZoom(1)}
              title="Reset the code to 100%"
              className="mt-0.5 hidden min-w-10 rounded px-1 py-1 text-center text-xs tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground sm:block"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              onClick={() => stepZoom(1)}
              disabled={zoom === ZOOM_LEVELS[ZOOM_LEVELS.length - 1]}
              title="Make the code bigger"
              className="mt-0.5 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <ZoomIn className="size-4" />
            </button>
            <span aria-hidden className="mx-1 h-4 w-px bg-border" />
            <button
              type="button"
              onClick={() => setAll(false)}
              title="Collapse every file"
              className="mt-0.5 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ChevronsDownUp className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => setAll(true)}
              title="Expand every file"
              className="mt-0.5 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ChevronsUpDown className="size-4" />
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

      <div ref={splitRef} className="flex min-h-0 flex-1">
        {sidebar && (
          <div
            style={{ "--files-w": `${sidebarWidth}px` } as React.CSSProperties}
            className="hidden w-[var(--files-w)] shrink-0 flex-col overflow-y-auto md:flex"
          >
            <div className="sticky top-0 z-10 bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground">
              {files.length} changed {files.length === 1 ? "file" : "files"}
            </div>
            {files.map((f) => {
              const { dir, name } = splitPath(f.path);
              return (
                <button
                  key={f.path}
                  type="button"
                  onClick={() => reveal(f)}
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

        {sidebar && (
          <div
            onPointerDown={startResize}
            onDoubleClick={resetResize}
            title="Drag to resize · double-click to reset"
            // Carries the border the sidebar used to draw, so widening the grab area does not put a
            // second line on screen.
            className="hidden w-1.5 shrink-0 cursor-col-resize border-l bg-transparent transition-colors hover:bg-primary/20 active:bg-primary/30 md:block"
          />
        )}

        <div ref={scrollRef} onScroll={onScroll} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
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
                  sessionId={sessionId}
                  number={number}
                  headRef={pull?.headRefOid ?? ""}
                  baseRef={pull?.baseRefOid ?? ""}
                  file={f}
                  open={isOpen(f)}
                  wrap={wrap}
                  zoom={zoom}
                  numCol={numCol}
                  share={share}
                  onShareResize={startShareResize}
                  onShareReset={resetShare}
                  bigByDefault={big.has(f.path)}
                  onToggle={() => toggleFile(f)}
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

/** One file of the review: a header that folds it away, and its diff — or the file itself — below. */
function FileDiff({
  sessionId,
  number,
  headRef,
  baseRef,
  file,
  open,
  wrap,
  zoom,
  numCol,
  share,
  onShareResize,
  onShareReset,
  bigByDefault,
  onToggle,
  register,
}: {
  sessionId: string;
  number: number;
  /** The commits the review names. A file is read whole at the head, except a deleted one. */
  headRef: string;
  baseRef: string;
  file: GitHubPullFile;
  open: boolean;
  /** Long lines wrap rather than running off to the right — see WRAP_KEY. */
  wrap: boolean;
  /** Reading size for the code, and the line-number column width that goes with it. */
  zoom: number;
  numCol: number;
  /** How much of the width the old side takes, 0..1 — shared by every file (see SHARE_KEY). */
  share: number;
  onShareResize: (e: React.PointerEvent) => void;
  onShareReset: () => void;
  /** The file arrived folded because its diff is enormous — say so, so the fold isn't a mystery. */
  bigByDefault: boolean;
  onToggle: () => void;
  register: (el: HTMLDivElement | null) => void;
}) {
  // Parsing is the expensive part of drawing a file, so it waits until the file is actually open.
  const rawHunks = useMemo(() => (open && !file.binary ? parseUnifiedDiff(file.diff) : []), [open, file]);

  /**
   * The same hunks with each line's highlighted HTML attached. Each side is highlighted as one text
   * rather than line by line — see highlightLines — so a comment or a string that runs over several
   * lines is still one of those by the time it is drawn. The two sides go separately, because they
   * are two different versions of the file interleaved, and reading them as one would be nonsense.
   *
   * What it cannot know is the code between hunks, which the diff never sent: a block opened in a
   * part of the file nobody changed looks closed to this. That is the same thing GitHub does, and
   * the alternative is fetching the whole file to colour three lines of context.
   */
  const hunks = useMemo(() => {
    const lefts: string[] = [];
    const rights: string[] = [];
    for (const h of rawHunks)
      for (const r of h.rows) {
        if (r.left) lefts.push(r.left.text);
        if (r.right) rights.push(r.right.text);
      }
    const left = highlightLines(file.path, lefts.join("\n"));
    const right = highlightLines(file.path, rights.join("\n"));

    let li = 0;
    let ri = 0;
    return rawHunks.map((h) => ({
      header: h.header,
      rows: h.rows.map((r) => {
        const leftTokens = r.left ? left?.[li++] : undefined;
        const rightTokens = r.right ? right?.[ri++] : undefined;
        return { ...r, leftTokens, rightTokens };
      }),
    }));
  }, [rawHunks, file.path]);
  const side = oneSidedAs(file.status);
  const { dir, name } = splitPath(file.path);

  // Whether this file is showing its change or itself, and the file once it has been fetched. Local
  // to the file, because it is a question about this file and not about the review.
  const [whole, setWhole] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const [copied, setCopied] = useState(false);

  // A deleted file is not at the head any more, so the side to read it from is the base. Everything
  // else is asked for at the head, which is what the review is proposing.
  const readAt = file.status === "D" ? baseRef : headRef;

  // What has already been asked for, so asking twice does not fetch twice. A ref rather than the
  // loading flag: an effect that depends on state it sets re-runs the moment it sets it, and its own
  // cleanup then cancels the request it just made — which reads on screen as "Reading the file…"
  // forever. Cleared again on failure, so switching back to File is a retry rather than a no-op.
  const fetchedFor = useRef<string | null>(null);

  // Fetched when it is first asked for, and kept: the file at a commit does not change under us the
  // way the review around it does, and the reload in the header drops the whole view anyway.
  useEffect(() => {
    if (!whole) return;
    const key = `${file.path}@${readAt}`;
    if (fetchedFor.current === key) return;
    fetchedFor.current = key;

    let cancelled = false;
    setLoadingContent(true);
    setContentError(null);
    const fail = (message: string) => {
      fetchedFor.current = null;
      setContentError(message);
    };
    api
      .githubPullFile(sessionId, number, file.path, readAt)
      .then((r) => {
        if (cancelled) return;
        if (r.error) fail(r.error);
        else if (r.truncated) fail("This file is too large to show here — it is on GitHub.");
        else setContent(r.content);
      })
      .catch(() => !cancelled && fail("Could not reach the server."))
      .finally(() => !cancelled && setLoadingContent(false));
    return () => {
      cancelled = true;
    };
  }, [whole, sessionId, number, file.path, readAt]);

  const copyAll = useCallback(async () => {
    if (content === null) return;
    await writeToClipboard(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [content]);

  // Nothing to read whole: a binary has no text, and a pure rename has no commit of its own to ask
  // about beyond what the review already said.
  const canReadWhole = !file.binary && !!readAt;

  return (
    <div ref={register} className="border-b last:border-b-0">
      {/* Sticky so the name of what you are reading stays on screen through a long diff. The row is
          no longer one big button: the controls at its end are buttons of their own, and a button
          cannot hold another one. */}
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-muted/60 px-3 py-1.5 text-xs backdrop-blur">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-foreground"
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

        {/* Change or file. Only once the file is open — they are how to read what is on screen, and
            there is nothing on screen to read while it is folded away. */}
        {open && canReadWhole && (
          <span className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => setWhole(false)}
              title="Show what this pull request changes in the file"
              className={cn(
                "rounded px-1.5 py-0.5 transition-colors",
                whole ? "text-muted-foreground hover:text-foreground" : "bg-accent text-foreground"
              )}
            >
              Diff
            </button>
            <button
              type="button"
              onClick={() => setWhole(true)}
              title={`Show the whole file as it is at ${file.status === "D" ? "the base" : "the head"} of this pull request`}
              className={cn(
                "rounded px-1.5 py-0.5 transition-colors",
                whole ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              File
            </button>
            {/* Copying a diff would hand over a mix of both sides with markers down the left, which is
                not the file anyone means — so this is offered for the whole file and nowhere else. */}
            {whole && content !== null && (
              <button
                type="button"
                onClick={() => void copyAll()}
                title={copied ? "Copied!" : "Copy the whole file"}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
              </button>
            )}
          </span>
        )}
      </div>

      {open && whole ? (
        loadingContent ? (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Reading the file…
          </div>
        ) : contentError ? (
          <div className="p-4 text-sm text-muted-foreground">{contentError}</div>
        ) : (
          <FileListing path={file.path} text={content ?? ""} wrap={wrap} zoom={zoom} numCol={numCol} />
        )
      ) : open ? (
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
          <OneSided hunks={hunks} side={side} wrap={wrap} zoom={zoom} numCol={numCol} />
        ) : (
          <SideBySide
            hunks={hunks}
            wrap={wrap}
            zoom={zoom}
            numCol={numCol}
            share={share}
            onResize={onShareResize}
            onReset={onShareReset}
          />
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
// The sizes come from variables the grid sets (see codeVars), so one number changes the whole of a
// file's text and nothing else on the page moves with it.
const NUM_CELL =
  "select-none px-2 text-right font-mono text-[length:var(--num-fs)] leading-[var(--line-h)] text-muted-foreground/70";
const CODE_CELL = "px-2 font-mono text-[length:var(--code-fs)] leading-[var(--line-h)]";

/** The type sizes a zoom level works out to, as the variables the cells above read. */
function codeVars(zoom: number): React.CSSProperties {
  return {
    "--code-fs": `${CODE_FS * zoom}px`,
    "--num-fs": `${NUM_FS * zoom}px`,
    "--line-h": `${LINE_H * zoom}px`,
  } as React.CSSProperties;
}

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

/**
 * The four column widths of a split diff. Wrapped, the two code columns divide the pane between them
 * at whatever ratio the divider was left at. Unwrapped they are equal `1fr` again, deliberately: the
 * columns are then sized by their longest line rather than by the pane, and equal `1fr` tracks in a
 * max-content grid both take the width of the widest — which is what keeps the two halves the same
 * width and lets one scrollbar move them together. There is nothing there for a ratio to divide.
 *
 * `minmax(0, …)` rather than a bare `fr` in the wrapped case, and it is load-bearing: a bare `Xfr`
 * means `minmax(auto, Xfr)`, whose floor is the track's min-content width. A column of code has a
 * wide one, so both tracks sit on their floor, the ratio is ignored, and the grid quietly overflows
 * the pane it was told to fit. A zero floor lets the ratio decide and lets the text wrap, which is
 * the whole premise of the mode.
 */
function splitColumns(wrap: boolean, share: number, numCol: number): string {
  const [oldCol, newCol] = wrap
    ? [`minmax(0, ${share}fr)`, `minmax(0, ${1 - share}fr)`]
    : ["1fr", "1fr"];
  return `${numCol}px ${oldCol} ${numCol}px ${newCol}`;
}

/**
 * One line of code in the grid, highlighted where the language is one we have a grammar for and
 * drawn as plain text where it isn't — which is why both paths are here.
 *
 * The tokens become nested spans rather than a string of HTML. The code being coloured came from
 * whoever opened the pull request, and going through React means React escapes it: there is no HTML
 * string on the path at all, so there is nothing on it that could forget to. The nesting is rebuilt
 * per token because the theme has descendant rules — `.hljs-meta .hljs-string` and the like — that a
 * flattened span would stop matching.
 *
 * A blank line still has to occupy its row, hence the space standing in for empty content.
 */
function Code({ tokens, text, className }: { tokens?: CodeToken[]; text: string; className: string }) {
  if (!tokens) return <div className={className}>{text || " "}</div>;
  if (!tokens.length) return <div className={className}> </div>;
  return (
    <div className={className}>
      {tokens.map((t, i) => (
        <Fragment key={i}>
          {t.classes.reduceRight<ReactNode>(
            (child, cls) => <span className={cls}>{child}</span>,
            t.text
          )}
        </Fragment>
      ))}
    </div>
  );
}

/** Background for a cell, by what happened to the line it holds. */
function tint(kind: "add" | "del" | "none" | "gap"): string {
  if (kind === "add") return "bg-emerald-500/10";
  if (kind === "del") return "bg-red-500/10";
  if (kind === "gap") return "bg-muted/40"; // the other side has no line here at all
  return "";
}

/** The old file beside the new one — the view for a file that existed before and still does. */
function SideBySide({
  hunks,
  wrap,
  zoom,
  numCol,
  share,
  onResize,
  onReset,
}: {
  hunks: ShownHunk[];
  wrap: boolean;
  zoom: number;
  numCol: number;
  share: number;
  onResize: (e: React.PointerEvent) => void;
  onReset: () => void;
}) {
  const mode = lineMode(wrap);
  return (
    <div className={cn("relative", mode.scroll)}>
      {/* The divider between the halves. Only while the lines wrap: unwrapped, the columns are as
          wide as their longest line and the pane scrolls, so there is no width here to divide.
          Drawn over the grid rather than in it, since it has to run the height of every row. */}
      {wrap && (
        <div
          onPointerDown={onResize}
          onDoubleClick={onReset}
          title="Drag to resize · double-click to reset"
          style={{ left: `calc(${numCol}px + ${share} * (100% - ${2 * numCol}px))` }}
          className="absolute inset-y-0 z-[5] -ml-[3px] w-1.5 cursor-col-resize bg-transparent transition-colors hover:bg-primary/20 active:bg-primary/30"
        />
      )}
      <div
        style={{ ...codeVars(zoom), gridTemplateColumns: splitColumns(wrap, share, numCol) }}
        className={cn("grid", mode.grid)}
      >
        {hunks.map((hunk, h) => (
          <HunkRows key={h} header={hunk.header} span={4}>
            {hunk.rows.map((row, i) => {
              const leftKind = row.left ? (row.kind === "context" ? "none" : "del") : "gap";
              const rightKind = row.right ? (row.kind === "context" ? "none" : "add") : "gap";
              return (
                <div key={i} className="contents">
                  <div className={cn(NUM_CELL, tint(leftKind))}>{row.left?.number ?? ""}</div>
                  <Code
                    tokens={row.leftTokens}
                    text={row.left?.text ?? ""}
                    className={cn(CODE_CELL, mode.code, tint(leftKind))}
                  />
                  <div className={cn(NUM_CELL, "border-l", tint(rightKind))}>{row.right?.number ?? ""}</div>
                  <Code
                    tokens={row.rightTokens}
                    text={row.right?.text ?? ""}
                    className={cn(CODE_CELL, mode.code, tint(rightKind))}
                  />
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
function OneSided({
  hunks,
  side,
  wrap,
  zoom,
  numCol,
}: {
  hunks: ShownHunk[];
  side: "add" | "del";
  wrap: boolean;
  zoom: number;
  numCol: number;
}) {
  const rows = allRows(hunks);
  const mode = lineMode(wrap);
  return (
    <div className={mode.scroll}>
      <div
        style={{ ...codeVars(zoom), gridTemplateColumns: `${numCol}px ${wrap ? "minmax(0, 1fr)" : "1fr"}` }}
        className={cn("grid", mode.grid)}
      >
        {rows.map((row, i) => {
          const line = side === "add" ? row.right : row.left;
          const tokens = side === "add" ? row.rightTokens : row.leftTokens;
          if (!line) return null;
          // Every line of a new file is an addition; a context line can still turn up where the file
          // was added in a repo that had it before, and it is not tinted.
          const kind = row.kind === "context" ? "none" : side;
          return (
            <div key={i} className="contents">
              <div className={cn(NUM_CELL, tint(kind))}>{line.number}</div>
              <Code tokens={tokens} text={line.text} className={cn(CODE_CELL, mode.code, tint(kind))} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A file as it stands, rather than as a change to it: every line numbered, nothing tinted. The same
 * grid the one-sided view uses, so the two read the same way — what differs is that this is the file
 * at a commit, and the numbers run from one to the end rather than from wherever a hunk started.
 */
function FileListing({
  path,
  text,
  wrap,
  zoom,
  numCol,
}: {
  path: string;
  text: string;
  wrap: boolean;
  zoom: number;
  numCol: number;
}) {
  const mode = lineMode(wrap);
  // One highlight pass over the whole file — the one case where nothing is missing from it, so a
  // block comment or a long string is read exactly as a compiler would read it.
  const tokens = useMemo(() => highlightLines(path, text), [path, text]);
  // A file ends with a newline, and splitting on it leaves an empty last element that is the
  // terminator rather than a line of the file — the same trap the diff parser has to sidestep.
  const lines = useMemo(() => {
    const all = text.split("\n");
    if (all.length > 1 && all[all.length - 1] === "") all.pop();
    return all;
  }, [text]);

  if (!text) return <div className="p-4 text-sm text-muted-foreground">This file is empty.</div>;

  return (
    <div className={mode.scroll}>
      <div
        style={{ ...codeVars(zoom), gridTemplateColumns: `${numCol}px ${wrap ? "minmax(0, 1fr)" : "1fr"}` }}
        className={cn("grid", mode.grid)}
      >
        {lines.map((line, i) => (
          <div key={i} className="contents">
            <div className={NUM_CELL}>{i + 1}</div>
            <Code tokens={tokens?.[i]} text={line} className={cn(CODE_CELL, mode.code)} />
          </div>
        ))}
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
