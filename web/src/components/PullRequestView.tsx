import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type UIEvent,
} from "react";
import type {
  GitHubCommitDiff,
  GitHubPullCommit,
  GitHubPullDetail,
  GitHubPullFile,
  GrepMatch,
  PullFolds,
} from "@/types";
import { age } from "@/lib/age";
import { useDismissable } from "@/lib/useDismissable";
import { loadSessionUi, saveSessionUi, subscribeSessionUi } from "@/lib/sessionUi";
import { reviewKey } from "@/lib/sessionPulls";
import { writeToClipboard } from "@/lib/clipboard";
import { STATUS_COLOR } from "@/lib/gitStatusColor";
import { highlightLines, type CodeToken } from "@/lib/highlight";
import { useCodeNav } from "@/lib/codeNav";
import { allRows, oneSidedAs, parseUnifiedDiff, type DiffRow } from "@/lib/unifiedDiff";
import { cn } from "@/lib/utils";
import {
  appendComment,
  commentBlock,
  commentMessage,
  countComments,
  deleteReview,
  readReview,
  reviewFilePath,
  writeReview,
  type ReviewContext,
  type ReviewTarget,
} from "@/lib/prReview";
import { CopyPathButton } from "./CopyPathButton";
import { Markdown } from "./Markdown";
import { CommentButton, CommentCard, pickLines, ReviewButton, ReviewDialog, spotFor, type Spot } from "./PullReview";
import { usePersistentZoom, ZOOM_LEVELS } from "./ZoomControls";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  GitCommitHorizontal,
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
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useApi, useSessionKey } from "@/lib/node";

// Whether the file sidebar is showing, remembered per browser: it's a use of screen width, like the
// Split view's divider, not something the session should carry to every device.
const SIDEBAR_KEY = "hangar.prFilesSidebar";
// Whether long lines wrap instead of running off to the right. Per-browser for the same reason: it
// is a reaction to how wide this screen's pane is. On by default, which is where this differs from
// GitHub — GitHub is read in a whole browser window, this in half of one, and two columns of eighty
// characters do not fit in half a window. Off gives GitHub's behaviour exactly.
const WRAP_KEY = "hangar.prDiffWrap";
// Width of the file sidebar, dragged by the divider beside it. Per-browser like the Split view's
// own divider, and for the same reason: how much of this screen the list deserves is a fact about
// this screen. Paths are long and deeply nested, so the default is wider than a tab strip wants.
const SIDEBAR_MIN = 140;
const SIDEBAR_DEFAULT = 256;
const SIDEBAR_WIDTH_KEY = "hangar.prFilesWidth";
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
const SHARE_KEY = "hangar.prDiffSplit";
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
function readFolds(sessionId: string, review: string): PullFolds {
  const saved = loadSessionUi(sessionId).pullFolds?.[review];
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
  repo,
  closed = false,
  onTitle,
}: {
  sessionId: string;
  number: number;
  /**
   * The repo the PR is in, when it is not the one the session's own folder points at. Passed on to
   * every call below — gh answers for any repo by name, so a linked repo reviews like the session's
   * own without a checkout of it anywhere.
   */
  repo?: string;
  /** The session is not running: comments can still go into the review, but nothing can be sent. */
  closed?: boolean;
  /** The PR's real title, once GitHub has given it — the tab may be showing an older one. */
  onTitle?: (title: string) => void;
}) {
  const api = useApi();
  const uiKey = useSessionKey(sessionId);
  // What identifies this review wherever it is remembered — its folds, its scroll offset. Repo and
  // number together, because #42 of one repo and #42 of another are two reviews.
  const review = reviewKey(repo, number);
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
  // Reading size for the code itself, and the description read alongside it. Shares the app's zoom
  // stops and its storage convention, under a key of its own so a review's size is not whatever the
  // last file preview was left at.
  const [zoom, setZoom] = usePersistentZoom("prDiff");
  // The line-number column, at this zoom. The grid and the divider both measure against it, so it is
  // worked out once here rather than in each of them.
  const numCol = Math.round(NUM_COL * zoom);
  // Which files are folded away: what Collapse all / Expand all last said, plus the files toggled by
  // hand since. Everything else follows the size default, so a re-fetch doesn't undo what was folded.
  // Restored from the bag, so a review comes back where it was left — on this device and the others.
  const [folds, setFolds] = useState<PullFolds>(() => readFolds(uiKey, review));
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  // Files marked as read. Seeded from the review — the server holds the marks and does the comparing,
  // so a file the author has pushed over simply is not in the list — and kept here so a click shows
  // at once rather than after a round trip.
  const [viewed, setViewed] = useState<Set<string>>(new Set());
  const fileRefs = useRef(new Map<string, HTMLDivElement>());
  // The file just marked read, whose header the pane keeps in place as it folds — see markViewed.
  const anchorRef = useRef<string | null>(null);
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

  // The review narrowed to one commit — GitHub's "Changes from" menu. A pull request is read as a
  // whole, but written a commit at a time, and "what did this push change" is a question the whole
  // diff cannot answer. None of this is remembered in the bag: it is a look at one part of the
  // review, and the review is what a reload, or another device, should come back to.
  const [commits, setCommits] = useState<GitHubPullCommit[] | null>(null);
  const [commitsError, setCommitsError] = useState<string | null>(null);
  const [commitSha, setCommitSha] = useState<string | null>(null);
  const [commitDiff, setCommitDiff] = useState<GitHubCommitDiff | null>(null);
  const [commitLoading, setCommitLoading] = useState(false);
  // Bumped by the reload, so a commit being looked at is fetched again along with everything else.
  const [commitEpoch, setCommitEpoch] = useState(0);
  // Folds for the commit on screen. Local, and started afresh for each commit: they are about files
  // of this commit, and writing them into the review's folds would fold the whole review's copy of
  // the same path away behind the reader's back.
  const [commitFolds, setCommitFolds] = useState<PullFolds>({});
  // Mirrors commitSha for the scroll handler, which has to know *now* — a scroll event can arrive
  // between the click that switches view and the render that hands it the new value.
  const inCommitRef = useRef(false);
  // Where the whole review was scrolled to when a commit was opened, so going back finds it there,
  // and the offset the pane should take once the view it is switching to has been drawn.
  const wholeScrollRef = useRef(0);
  const pendingScrollRef = useRef<number | null>(null);

  // Comments for the session's own Claude, on lines picked out of the diff — see prReview. What is
  // held here mirrors the review file, which is read again before each comment is added to it, so
  // one added from another device in the meantime is kept rather than written over.
  const reviewPath = reviewFilePath(repo, number);
  const [reviewText, setReviewText] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  // The lines a selection covers, with the Comment button under them; then the comment being written.
  const [picked, setPicked] = useState<{ target: ReviewTarget; spot: Spot } | null>(null);
  // The comment carries the review's context as it was when its lines were picked: the page stays
  // usable while the card is open, and a switch to one commit after picking lines of the whole pull
  // request must not relabel those line numbers as the commit's.
  const [commenting, setCommenting] = useState<{ target: ReviewTarget; spot: Spot; ctx: ReviewContext } | null>(
    null
  );
  // Bumped by every write to the review, so a read that set off before one is dropped when it lands
  // rather than putting back what the write replaced.
  const reviewSeqRef = useRef(0);

  const loadReview = useCallback(async () => {
    const seq = reviewSeqRef.current;
    try {
      const text = await readReview(api, sessionId, reviewPath);
      if (seq === reviewSeqRef.current) setReviewText(text);
    } catch {
      /* the server is out of reach — what is on screen stands until the next reload */
    }
  }, [sessionId, reviewPath]);

  /** Take in a review that now holds something else, so the screen never shows a write it lost. */
  const putReviewText = useCallback((text: string) => {
    reviewSeqRef.current++;
    setReviewText(text);
  }, []);

  // Watch for a selection in the code. Looked at once the button is let go — a Comment button
  // chasing the pointer through a drag would be in the drag's way — and, on a touch screen, where a
  // selection is made with handles rather than a drag, once it stops changing.
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    let pressed = false;
    let timer = 0;
    let frame = 0;
    const check = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (pressed) return;
        const sel = window.getSelection();
        const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
        const target = range ? pickLines(range, box) : null;
        setPicked(target && range ? { target, spot: spotFor(range) } : null);
      }, 150);
    };
    // A split diff selects down one column, the way GitHub's does: the side a drag starts on is the
    // side it stays on, because the other is unselectable until the next press (see index.css).
    const down = (e: PointerEvent) => {
      pressed = true;
      const side = (e.target as Element | null)?.closest?.("[data-side]")?.getAttribute("data-side");
      if (side) box.dataset.selSide = side;
      else delete box.dataset.selSide;
    };
    const up = () => {
      if (!pressed) return;
      pressed = false;
      check();
    };
    // The button stays with the selection as the pane scrolls under it.
    const scrolled = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const sel = window.getSelection();
        if (!sel?.rangeCount) return;
        const range = sel.getRangeAt(0);
        setPicked((p) => (p ? { ...p, spot: spotFor(range) } : p));
      });
    };
    box.addEventListener("pointerdown", down);
    // Captured, so the scroll of one file's own sideways scroller — unwrapped lines — counts too.
    box.addEventListener("scroll", scrolled, { capture: true, passive: true });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    document.addEventListener("selectionchange", check);
    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
      box.removeEventListener("pointerdown", down);
      box.removeEventListener("scroll", scrolled, { capture: true });
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      document.removeEventListener("selectionchange", check);
    };
  }, []);

  // The commit list: asked for beside the review rather than inside it, so the diff is never kept
  // waiting on a list most readers will not open — but asked for at once, so the header can say
  // how many there are. A failed ask keeps the list already held: a reload that could not reach
  // GitHub says nothing about which commits the pull request has, and treating it as "none" would
  // throw the reader out of the commit they were reading.
  const loadCommits = useCallback(async () => {
    try {
      const res = await api.githubPullCommits(sessionId, number, repo);
      setCommitsError(res.error ?? null);
      if (!res.error) setCommits(res.commits ?? []);
    } catch {
      setCommitsError("Could not reach the server.");
    }
  }, [sessionId, number, repo]);

  const load = useCallback(async () => {
    setLoading(true);
    void loadCommits();
    void loadReview();
    setCommitEpoch((e) => e + 1);
    try {
      const res = await api.githubPull(sessionId, number, repo);
      setDetail(res);
      setViewed(new Set(res.viewed ?? []));
      setError(res.error ?? null);
      if (res.pull?.title) onTitleRef.current?.(res.pull.title);
    } catch {
      setDetail(null);
      setError("Could not reach the server.");
    } finally {
      setLoading(false);
    }
  }, [sessionId, number, repo, loadCommits, loadReview]);

  useEffect(() => {
    void load();
  }, [load]);

  // One commit's changes, fetched when it is chosen and again on a reload. What arrives for a commit
  // no longer chosen is dropped rather than drawn: the reader has moved on.
  useEffect(() => {
    inCommitRef.current = commitSha !== null;
    if (!commitSha) return;
    let cancelled = false;
    setCommitLoading(true);
    api
      .githubPullCommit(sessionId, number, commitSha, repo)
      .then((r) => !cancelled && setCommitDiff(r))
      .catch(
        () =>
          !cancelled &&
          setCommitDiff({ sha: commitSha, files: [], error: "Could not reach the server." })
      )
      .finally(() => !cancelled && setCommitLoading(false));
    return () => {
      cancelled = true;
    };
  }, [sessionId, number, repo, commitSha, commitEpoch]);

  useEffect(
    () => subscribeSessionUi(uiKey, (seed) => seed && setSeedEpoch((e) => e + 1)),
    [sessionId]
  );

  // Take the folds the seed brought. Safe to overwrite what is on screen with: the bag layers this
  // browser's own unacknowledged writes back on top of the server's answer, so what comes out here
  // is the server's state with ours already in it.
  useEffect(() => {
    if (seedEpoch > 0) setFolds(readFolds(uiKey, review));
  }, [sessionId, review, seedEpoch]);

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
    // A reload while one commit is on screen: the saved offset is the whole review's, and dropping
    // it onto the commit would put the reader somewhere arbitrary in a different list of files.
    if (inCommitRef.current) {
      restoredRef.current = true;
      return;
    }
    const target = loadSessionUi(uiKey).pullScroll?.[review] ?? 0;
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
  }, [sessionId, review, detail, seedEpoch]);

  // Save it back on a short debounce. Scrolls before the restore are the browser shifting rows about
  // as they load, not the reader, so they must not overwrite the offset being replayed.
  const onScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      // Where the reader is in one commit is not where they are in the review, which is what the
      // saved offset is for — so a commit's scrolling is not written anywhere.
      if (!restoredRef.current || inCommitRef.current) return;
      const top = Math.round(e.currentTarget.scrollTop);
      window.clearTimeout(saveScrollRef.current);
      saveScrollRef.current = window.setTimeout(
        () =>
          saveSessionUi(uiKey, {
            pullScroll: { ...loadSessionUi(uiKey).pullScroll, [review]: top },
          }),
        200
      );
    },
    [sessionId, review]
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

  const inCommit = commitSha !== null;
  // The commit's own answer, and only once it is the commit's: while the next one loads, what is in
  // state is still the last one, and drawing its files under the new commit's name would be a lie.
  const shownCommit = commitDiff && commitDiff.sha === commitSha ? commitDiff : null;
  const files = inCommit ? shownCommit?.files ?? NO_FILES : detail?.files ?? NO_FILES;
  const commitIndex = inCommit && commits ? commits.findIndex((c) => c.sha === commitSha) : -1;
  const commit = commitIndex >= 0 ? commits![commitIndex] : null;

  /**
   * Narrow the review to one commit, or open it back out. The whole review's scroll offset is kept
   * aside on the way in and put back on the way out, because the thing a reader does next after
   * looking at one commit is carry on with the review where they left it.
   */
  const chooseCommit = useCallback(
    (sha: string | null) => {
      if (!inCommitRef.current && sha !== null) {
        // Where the review is "at". Normally where it is scrolled to — but a review opened a moment
        // ago may still be waiting for its rows to arrive before replaying its saved offset, and
        // then that offset is where the reader is on their way to. The replay is called off either
        // way: left running it would land on the commit's files instead.
        wholeScrollRef.current = restoredRef.current
          ? scrollRef.current?.scrollTop ?? 0
          : loadSessionUi(uiKey).pullScroll?.[review] ?? 0;
        restoredRef.current = true;
      }
      inCommitRef.current = sha !== null;
      pendingScrollRef.current = sha === null ? wholeScrollRef.current : 0;
      setCommitFolds({});
      setCommitSha(sha);
    },
    [sessionId, review]
  );

  // A commit the author has since rewritten away: the list no longer holds it, so the reader goes
  // back to the whole review — the same way "All changes" would take them, place and all.
  useEffect(() => {
    if (commitSha && commits && !commits.some((c) => c.sha === commitSha)) chooseCommit(null);
  }, [commits, commitSha, chooseCommit]);

  // What the commit on screen changes in all, for the counts in the header.
  const commitTotals = useMemo(
    () =>
      shownCommit?.files.reduce(
        (t, f) => ({ additions: t.additions + f.additions, deletions: t.deletions + f.deletions }),
        { additions: 0, deletions: 0 }
      ) ?? null,
    [shownCommit]
  );

  // Take the offset chooseCommit set aside, once the view it belongs to is on the page. A layout
  // effect rather than a frame callback: it runs after React has put the review's rows back and
  // before anything is painted, so there is height to scroll into and no flash of the top first —
  // and it does not wait on a frame, which a browser never draws for a tab nobody is looking at.
  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (box && pendingScrollRef.current !== null) {
      box.scrollTop = pendingScrollRef.current;
      pendingScrollRef.current = null;
    }
  }, [commitSha]);

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
  // The folds in force: the review's, or the commit's own while one is on screen.
  const shownFolds = inCommit ? commitFolds : folds;
  // A set, not the array itself: this is asked once per file per render, and a review of three
  // hundred files with three hundred exceptions would otherwise be a scan inside a scan.
  const excepted = useMemo(() => new Set(shownFolds.except ?? []), [shownFolds.except]);
  const isOpen = useCallback(
    (f: GitHubPullFile) => {
      const base = shownFolds.all ?? byDefault(f);
      return excepted.has(f.path) ? !base : base;
    },
    [shownFolds.all, excepted, byDefault]
  );

  // Every change to the folds goes to the bag as it is made: there is no "done reading" moment to
  // save at, and the reader may well close the tab as the next thing they do.
  const putFolds = useCallback(
    (next: PullFolds) => {
      // A commit's folds stay on this screen — see commitFolds.
      if (inCommitRef.current) {
        setCommitFolds(next);
        return;
      }
      const all = capFolds({ ...loadSessionUi(uiKey).pullFolds, [review]: next }, review);
      // What is kept for this review may have been trimmed on the way into the budget, so the state
      // takes what was actually stored rather than what was asked for — otherwise the screen and the
      // bag would disagree until the next reload.
      setFolds(all[review] ?? next);
      saveSessionUi(uiKey, { pullFolds: all });
    },
    [sessionId, review]
  );

  const setAll = (open: boolean) => putFolds({ all: open, except: [] });

  const toggleFile = useCallback(
    (f: GitHubPullFile) => {
      const except = shownFolds.except ?? [];
      // Back to the baseline rather than a second exception, so toggling twice leaves no trace.
      const next = excepted.has(f.path)
        ? except.filter((p) => p !== f.path)
        : [...except, f.path];
      putFolds({ ...shownFolds, except: next });
    },
    [shownFolds, excepted, putFolds]
  );

  /** Fold or unfold one file to a known state, rather than to the other side of where it is. */
  const setFileOpen = useCallback(
    (f: GitHubPullFile, open: boolean) => {
      if (isOpen(f) !== open) toggleFile(f);
    },
    [isOpen, toggleFile]
  );

  /**
   * Mark a file read, or unread. Reading one is finishing with it, so it folds away — and unmarking
   * opens it again, since the reason to unmark is to look at it. The mark itself goes to the server,
   * where it is kept against the pull request rather than this session: the same review read from
   * another browser, or from a session reopened tomorrow, is the same review.
   */
  const markViewed = useCallback(
    (f: GitHubPullFile, next: boolean) => {
      if (next && isOpen(f)) anchorRef.current = f.path;
      setViewed((prev) => {
        const out = new Set(prev);
        if (next) out.add(f.path);
        else out.delete(f.path);
        return out;
      });
      setFileOpen(f, !next);
      // Fire and forget, and put the mark back if it did not land: a checkbox that lies about what
      // was stored is worse than one that flicks back.
      api.githubSetViewed(sessionId, number, f.path, f.sha, next, repo).catch(() =>
        setViewed((prev) => {
          const out = new Set(prev);
          if (next) out.delete(f.path);
          else out.add(f.path);
          return out;
        })
      );
    },
    [sessionId, number, repo, isOpen, setFileOpen]
  );

  // A file marked read folds away, and the diff it held goes with it. Read to its end, the file's
  // top is far above the pane — its sticky header was all that was left of it on screen — so the
  // fold would pull the files below it up past the reader, leaving them somewhere in the middle of
  // the next one. Bring the folded header back to the top of the pane instead, where the next file
  // starts right under it. A file whose top is still on screen is left where it is.
  useLayoutEffect(() => {
    const path = anchorRef.current;
    if (path === null) return;
    anchorRef.current = null;
    const box = scrollRef.current;
    const el = fileRefs.current.get(path);
    if (!box || !el) return;
    const above = box.getBoundingClientRect().top - el.getBoundingClientRect().top;
    if (above > 0) box.scrollTop -= above;
  });

  /** Everything unread again, and open again — the way back from having marked the lot. */
  const clearViewed = useCallback(() => {
    setViewed(new Set());
    setAll(true);
    api.githubClearViewed(sessionId, number, repo).catch(() => void load());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, number, repo, load]);

  /** Fold or unfold one file, as the exception it is to whatever the rest of the review is doing. */
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

  // Going from a name to where it is declared, across files. A file the review changes is brought up
  // in its own card at that line; any other file opens in the peek beside the review, read at the same
  // commit, and a trail of them is kept for Back.
  const [goto, setGoto] = useState<{ path: string; line: number; word: string; seq: number } | null>(null);
  const [peek, setPeek] = useState<PeekPlace[]>([]);
  const openAt = useCallback(
    (m: GrepMatch, word: string) => {
      const f = files.find((x) => x.path === m.path);
      if (f) {
        setPeek([]);
        setFileOpen(f, true);
        setGoto((g) => ({ path: f.path, line: m.line, word, seq: (g?.seq ?? 0) + 1 }));
      } else setPeek((stack) => [...stack, { path: m.path, line: m.line, word }]);
    },
    [files, setFileOpen]
  );
  // A peek is of the commit it was opened at, and so is a line asked of a card — whose remount under
  // another commit would otherwise take it up again. Another commit, or review, starts with neither.
  useEffect(() => {
    setPeek([]);
    setGoto(null);
  }, [commitSha, number, repo]);

  const pull = detail?.pull;
  const { Icon: StateIcon, className: stateClass } = (() => {
    if (!pull) return { Icon: GitPullRequest, className: "text-muted-foreground" };
    if (pull.state === "MERGED") return { Icon: GitMerge, className: "text-violet-500" };
    if (pull.state === "CLOSED") return { Icon: GitPullRequestClosed, className: "text-red-500" };
    if (pull.draft) return { Icon: GitPullRequestDraft, className: "text-muted-foreground" };
    return { Icon: GitPullRequest, className: "text-emerald-500" };
  })();

  // What a comment says about where it is, beyond its own lines.
  const reviewCtx = useMemo<ReviewContext>(
    () => ({
      number,
      repo,
      title: pull?.title,
      head: pull?.headRefName,
      base: pull?.baseRefName,
      commit: commitSha?.slice(0, 7),
    }),
    [number, repo, pull?.title, pull?.headRefName, pull?.baseRefName, commitSha]
  );

  const sendComment = useCallback(
    async (t: ReviewTarget, body: string, ctx: ReviewContext) => {
      await api.sendMessage(sessionId, commentMessage(t, body, ctx));
    },
    [sessionId]
  );

  const addComment = useCallback(
    async (t: ReviewTarget, body: string, ctx: ReviewContext) => {
      const next = appendComment(await readReview(api, sessionId, reviewPath), commentBlock(t, body, ctx), ctx);
      await writeReview(api, sessionId, reviewPath, next);
      putReviewText(next);
    },
    [sessionId, reviewPath, putReviewText]
  );

  const saveReview = useCallback(
    async (text: string) => {
      await writeReview(api, sessionId, reviewPath, text);
      putReviewText(text);
    },
    [sessionId, reviewPath, putReviewText]
  );

  // Whether the file is still the one the dialog opened on, asked before anything replaces or
  // deletes it — a comment added from another device since then must not go unsent and unseen.
  // When it is not, the new version is taken in and the reader decides again.
  const reviewUnchanged = useCallback(
    async (expected: string) => {
      const fresh = await readReview(api, sessionId, reviewPath);
      if (fresh === expected) return true;
      putReviewText(fresh);
      return false;
    },
    [sessionId, reviewPath, putReviewText]
  );

  // Sent or thrown away: either way the file goes. Should deleting it fail, reading it back puts the
  // review on offer again rather than leaving the header claiming there is none.
  const finishReview = useCallback(() => {
    putReviewText("");
    setReviewOpen(false);
    deleteReview(api, sessionId, reviewPath).catch(() => void loadReview());
  }, [sessionId, reviewPath, loadReview, putReviewText]);

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
              {/* The counts are of whatever is on screen: the pull request, or the one commit it is
                  narrowed to — they sit beside the menu that says which, and read as that. Nothing
                  while a commit is still arriving, rather than the pull request's under its name. */}
              {(() => {
                const t = inCommit ? commitTotals : pull;
                const n = inCommit ? files.length : pull.changedFiles;
                if (!t) return null;
                return (
                  <>
                    <span title={inCommit ? "What this commit changes" : undefined}>
                      <span className="text-emerald-600 dark:text-emerald-400">+{t.additions}</span>{" "}
                      <span className="text-red-600 dark:text-red-400">−{t.deletions}</span>
                    </span>
                    <span>
                      {n} {n === 1 ? "file" : "files"}
                    </span>
                  </>
                );
              })()}
              {commits && commits.length > 0 && (
                <CommitMenu commits={commits} selected={commitSha} onSelect={chooseCommit} />
              )}
              {commitsError && !commits?.length && (
                <span title={commitsError} className="text-amber-600 dark:text-amber-400">
                  commits unavailable
                </span>
              )}
            </div>
          )}
        </div>
        {reviewText.trim() && (
          <ReviewButton
            count={countComments(reviewText)}
            onClick={() => {
              void loadReview();
              setReviewOpen(true);
            }}
          />
        )}
        {/* How much of the review is behind you. A button, because the only thing anyone wants to do
            with that number is put it back to nothing. */}
        {viewed.size > 0 && !inCommit && (
          <button
            type="button"
            onClick={clearViewed}
            title="Mark every file unread"
            className="mt-0.5 shrink-0 rounded px-1.5 py-1 text-xs tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {viewed.size}/{files.length} read
          </button>
        )}
        {/* Kept while a commit is on screen even before its files arrive, so the header does not
            jump twice on the way to it. */}
        {(files.length > 0 || inCommit) && (
          <div className="flex shrink-0 items-center">
            {/* Reading size for the code and the description. The percentage resets, the way it does
                on every other zoomed view in the app — and it is the only label here, so it goes on
                narrow panes. */}
            <button
              type="button"
              onClick={() => stepZoom(-1)}
              disabled={zoom === ZOOM_LEVELS[0]}
              title="Make the code and description smaller"
              className="mt-0.5 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <ZoomOut className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => setZoom(1)}
              title="Reset the code and description to 100%"
              className="mt-0.5 hidden min-w-10 rounded px-1 py-1 text-center text-xs tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground sm:block"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              onClick={() => stepZoom(1)}
              disabled={zoom === ZOOM_LEVELS[ZOOM_LEVELS.length - 1]}
              title="Make the code and description bigger"
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

      <div ref={splitRef} className="relative flex min-h-0 flex-1">
        {peek.length > 0 && (
          <PeekFile
            key={peek.length}
            place={peek[peek.length - 1]}
            canGoBack={peek.length > 1}
            sessionId={sessionId}
            number={number}
            repo={repo}
            headRef={inCommit ? commitSha! : pull?.headRefOid ?? ""}
            wrap={wrap}
            zoom={zoom}
            numCol={numCol}
            onOpenAt={openAt}
            onBack={() => setPeek((stack) => stack.slice(0, -1))}
            onClose={() => setPeek([])}
          />
        )}
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
          {/* Not above a commit: a pull request whose diff is too large to fetch whole is exactly
              the one read a commit at a time, and the warning is about something not on screen. */}
          {error && !inCommit && (
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

          {inCommit && (
            <CommitBanner
              commit={commit}
              sha={commitSha!}
              index={commitIndex}
              count={commits?.length ?? 0}
              onPrev={() => commitIndex > 0 && chooseCommit(commits![commitIndex - 1].sha)}
              onNext={() =>
                commits && commitIndex < commits.length - 1 && chooseCommit(commits[commitIndex + 1].sha)
              }
              onClose={() => chooseCommit(null)}
            />
          )}

          {inCommit && shownCommit?.error && (
            <div className="m-3 flex items-start gap-2 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
              <div className="min-w-0 break-words">{shownCommit.error}</div>
            </div>
          )}

          {inCommit ? (
            !shownCommit && commitLoading ? (
              <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Reading the commit…
              </div>
            ) : shownCommit && !shownCommit.error && files.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">This commit changes no files.</div>
            ) : null
          ) : loading && !detail ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Asking GitHub…
            </div>
          ) : null}

          {(inCommit ? !!shownCommit : !(loading && !detail)) && (
            <>
              {!inCommit && detail?.body?.trim() && (
                <div className="border-b">
                  <button
                    type="button"
                    onClick={() => setDescriptionOpen((o) => !o)}
                    className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    {descriptionOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                    Description
                  </button>
                  {/* The same typography the file preview renders Markdown with. Without it
                      Tailwind's reset has already taken the headings' size and the lists' markers
                      away, and a description comes out as one flat run of text — which is what a
                      pull request body, all headings and bullets, least survives. Zoomed with the
                      code: it is read like the code, not looked past like the headers, and CSS zoom
                      rather than a font size takes its headings, code blocks and spacing along, as
                      the file preview's Markdown does. */}
                  {descriptionOpen && (
                    <div
                      style={{ zoom }}
                      className="prose prose-sm max-w-none px-4 pb-4 dark:prose-invert prose-pre:bg-muted prose-pre:text-foreground"
                    >
                      <Markdown text={detail.body} />
                    </div>
                  )}
                </div>
              )}

              {!inCommit && !error && files.length === 0 && !loading && (
                <div className="p-4 text-sm text-muted-foreground">
                  This pull request changes no files.
                </div>
              )}

              {files.map((f) => (
                <FileDiff
                  // Per commit as well as per path: a file of one commit and the same file of the
                  // next are two different changes, and neither should inherit the other's state.
                  key={commitSha ? `${commitSha}:${f.path}` : f.path}
                  sessionId={sessionId}
                  number={number}
                  repo={repo}
                  // One commit is read at itself, and a file it deletes at the parent it was diffed
                  // against — the same two sides its diff is drawn from.
                  headRef={inCommit ? commitSha! : pull?.headRefOid ?? ""}
                  baseRef={inCommit ? commit?.parent ?? "" : pull?.baseRefOid ?? ""}
                  scope={inCommit ? "commit" : "pull"}
                  file={f}
                  open={isOpen(f)}
                  viewed={!inCommit && viewed.has(f.path)}
                  onViewed={markViewed}
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
                  goto={goto?.path === f.path ? goto : undefined}
                  onOpenAt={openAt}
                />
              ))}
            </>
          )}
        </div>
      </div>

      {/* Outside the scrolling pane, so a press in them is not taken for the start of a selection. */}
      {picked && !commenting && (
        <CommentButton
          spot={picked.spot}
          onClick={() => {
            setCommenting({ ...picked, ctx: reviewCtx });
            setPicked(null);
          }}
        />
      )}
      {commenting && (
        <CommentCard
          target={commenting.target}
          spot={commenting.spot}
          closed={closed}
          onSend={(body) => sendComment(commenting.target, body, commenting.ctx)}
          onAdd={(body) => addComment(commenting.target, body, commenting.ctx)}
          onClose={() => setCommenting(null)}
        />
      )}
      {reviewOpen && (
        <ReviewDialog
          sessionId={sessionId}
          path={reviewPath}
          text={reviewText}
          closed={closed}
          onSave={saveReview}
          onCheck={reviewUnchanged}
          onDone={finishReview}
          onClose={() => setReviewOpen(false)}
        />
      )}
    </div>
  );
}

/** A commit's first line, which is what a list of them is read by. */
function headline(message: string): string {
  return message.split("\n", 1)[0].trim() || "(no message)";
}

/**
 * The pull request's commits, as a menu off the counts in the header — GitHub's "Changes from" menu,
 * where the whole review is the first choice and each commit after it narrows the review to that
 * commit alone. Oldest first, the order they were made in and the order GitHub lists them.
 */
function CommitMenu({
  commits,
  selected,
  onSelect,
}: {
  commits: GitHubPullCommit[];
  selected: string | null;
  onSelect: (sha: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismissable<HTMLSpanElement>(open, close);
  const index = selected ? commits.findIndex((c) => c.sha === selected) : -1;
  const pick = (sha: string | null) => {
    // The one already on screen is not a new choice, and treating it as one would unfold its files.
    if (sha !== selected) onSelect(sha);
    setOpen(false);
  };

  return (
    <span ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Show the changes of one commit, or of the whole pull request"
        className={cn(
          "flex items-center gap-1 rounded px-1 hover:bg-accent hover:text-foreground",
          selected && "text-foreground"
        )}
      >
        <GitCommitHorizontal className="size-3.5" />
        {index >= 0
          ? `commit ${index + 1} of ${commits.length}`
          : `${commits.length} ${commits.length === 1 ? "commit" : "commits"}`}
        <ChevronDown className="size-3" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-30 mt-1 flex max-h-[60vh] w-[30rem] max-w-[calc(100vw-2rem)] flex-col overflow-y-auto rounded-md popover-edge bg-popover p-1 text-sm shadow-md"
        >
          <button
            type="button"
            role="menuitemradio"
            aria-checked={selected === null}
            onClick={() => pick(null)}
            className={cn(
              "flex items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent",
              selected === null && "bg-accent/60"
            )}
          >
            <span className="flex w-3.5 shrink-0 justify-center">
              {selected === null && <Check className="size-3.5" />}
            </span>
            <span className="font-medium">All changes</span>
            <span className="text-xs text-muted-foreground">— the whole pull request</span>
          </button>
          <div className="my-1 h-px bg-border" />
          {commits.map((c) => {
            const on = c.sha === selected;
            const when = age(c.date);
            return (
              <button
                key={c.sha}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                onClick={() => pick(c.sha)}
                title={c.message}
                className={cn(
                  "flex items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-accent",
                  on && "bg-accent/60"
                )}
              >
                <span className="flex w-3.5 shrink-0 justify-center pt-0.5">
                  {on && <Check className="size-3.5" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{headline(c.message)}</span>
                  <span className="flex gap-2 text-xs text-muted-foreground">
                    <span className="font-mono">{c.sha.slice(0, 7)}</span>
                    <span className="truncate">{c.author}</span>
                    {when && <span className="shrink-0">{when}</span>}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}

/**
 * Which commit the review is narrowed to, above its files: what it is called, who made it and when,
 * the rest of its message, and the way to the commits either side of it — or back out to the whole
 * pull request. It stands where the description does, because a commit's message is to its diff what
 * the description is to the review's.
 */
function CommitBanner({
  commit,
  sha,
  index,
  count,
  onPrev,
  onNext,
  onClose,
}: {
  /** Null only for the render in which the list stops holding it, just before the reader is taken
      back to the whole review — see the effect beside chooseCommit. */
  commit: GitHubPullCommit | null;
  sha: string;
  index: number;
  count: number;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const body = commit ? commit.message.split("\n").slice(1).join("\n").trim() : "";
  const when = commit ? age(commit.date) : "";
  const step = "rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent";
  return (
    <div className="flex items-start gap-2 border-b bg-muted/30 px-3 py-2 text-xs">
      <div className="flex shrink-0 items-center">
        <button type="button" onClick={onPrev} disabled={index <= 0} title="The commit before this one" className={step}>
          <ChevronLeft className="size-4" />
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={index < 0 || index >= count - 1}
          title="The commit after this one"
          className={step}
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 font-mono text-muted-foreground">{sha.slice(0, 7)}</span>
          <span className="min-w-0 truncate text-sm font-medium">{commit ? headline(commit.message) : ""}</span>
        </div>
        {commit && (
          <div className="text-muted-foreground">
            {commit.author}
            {when && ` · ${when} ago`}
            {index >= 0 && ` · commit ${index + 1} of ${count}`}
          </div>
        )}
        {body && (
          // Its own lines, as the author wrapped them: a commit body is plain text, not Markdown, and
          // trailers like Co-authored-by read as a list only while they keep their line breaks.
          <pre className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-sans text-muted-foreground">
            {body}
          </pre>
        )}
      </div>
      <button
        type="button"
        onClick={onClose}
        title="Back to every change in the pull request"
        className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="size-3.5" />
        <span className="hidden sm:inline">All changes</span>
      </button>
    </div>
  );
}

/**
 * Copying from a file header's path: the folders and the name are flex items of their own (so each
 * can be cut separately), and the browser puts a line break between flex items in what it copies --
 * "src/lib/\nfile.ts". A selection wholly inside the path is copied as the one line it reads as. One
 * that runs on beyond it is left to the browser, line breaks and all, as the rest of the page is.
 */
function copyPathSelection(e: React.ClipboardEvent<HTMLElement>) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  if (!e.currentTarget.contains(sel.anchorNode) || !e.currentTarget.contains(sel.focusNode)) return;
  e.clipboardData.setData("text/plain", sel.toString().replace(/\r?\n/g, ""));
  e.preventDefault();
}

/** A place a search found, in a file the review does not change. */
interface PeekPlace {
  path: string;
  line: number;
  word: string;
}

/**
 * A file the review does not change, read whole at the review's commit and opened at a line — where a
 * name used in the change turned out to be declared. Over the review rather than in it: it is a look
 * aside, and closing it puts the reader back where they were. Names in it navigate on in the same way,
 * and Back retraces the trail.
 */
function PeekFile({
  place,
  canGoBack,
  sessionId,
  number,
  repo,
  headRef,
  wrap,
  zoom,
  numCol,
  onOpenAt,
  onBack,
  onClose,
}: {
  place: PeekPlace;
  canGoBack: boolean;
  sessionId: string;
  number: number;
  repo?: string;
  headRef: string;
  wrap: boolean;
  zoom: number;
  numCol: number;
  onOpenAt: (match: GrepMatch, word: string) => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const api = useApi();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { dir, name } = splitPath(place.path);

  const nav = useCodeNav({
    lineSelector: "[data-side]",
    path: place.path,
    search: (word) => api.githubPullGrep(sessionId, number, word, headRef, repo),
    onOpen: (m, word) => (m.path === place.path ? nav.revealAt(m.line, word) : onOpenAt(m, word)),
  });
  const { revealAt } = nav;

  useEffect(() => {
    let cancelled = false;
    api
      .githubPullFile(sessionId, number, place.path, headRef, repo)
      .then((r) => {
        if (cancelled) return;
        if (r.error) setError(r.error);
        else if (r.truncated) setError("This file is too large to show here — it is on GitHub.");
        else setText(r.content);
      })
      .catch(() => !cancelled && setError("Could not reach the server."));
    return () => {
      cancelled = true;
    };
  }, [api, sessionId, number, place.path, headRef, repo]);

  // Once the file is drawn, the line it was opened for.
  useEffect(() => {
    if (text !== null) revealAt(place.line, place.word);
  }, [text, place.line, place.word, revealAt]);

  const btn = "flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground";
  return (
    <div className="absolute inset-y-0 right-0 z-20 flex w-full flex-col border-l bg-background shadow-xl md:w-[min(960px,85%)]">
      <div className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5 text-xs">
        <button type="button" onClick={onBack} disabled={!canGoBack} title="Back" className={cn(btn, "disabled:opacity-30")}>
          <ArrowLeft className="size-3.5" />
        </button>
        <span className="min-w-0 truncate font-mono">
          <span className="text-muted-foreground">{dir}</span>
          <span className="font-medium">{name}</span>
          <span className="text-muted-foreground">:{place.line}</span>
        </span>
        <span className="shrink-0 text-muted-foreground">· not changed here, at {headRef.slice(0, 7)}</span>
        <span className="flex-1" />
        <button type="button" onClick={onClose} title="Close" className={btn}>
          <X className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {nav.overlay}
        <div ref={nav.ref}>
          {error ? (
            <div className="p-4 text-sm text-muted-foreground">{error}</div>
          ) : text === null ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Reading the file…
            </div>
          ) : (
            <FileListing path={place.path} text={text} side="new" wrap={wrap} zoom={zoom} numCol={numCol} />
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
  repo,
  headRef,
  baseRef,
  scope,
  file,
  open,
  viewed,
  onViewed,
  wrap,
  zoom,
  numCol,
  share,
  onShareResize,
  onShareReset,
  bigByDefault,
  onToggle,
  register,
  goto,
  onOpenAt,
}: {
  sessionId: string;
  number: number;
  /** The repo the review is in, when it is not the session folder's own. */
  repo?: string;
  /** The commits the review names. A file is read whole at the head, except a deleted one. */
  headRef: string;
  baseRef: string;
  /** Whether what is on screen is the whole pull request or one of its commits — said in the titles. */
  scope: "pull" | "commit";
  file: GitHubPullFile;
  open: boolean;
  /** Marked as read: the header says so, and the file arrived folded because of it. */
  viewed: boolean;
  onViewed: (file: GitHubPullFile, viewed: boolean) => void;
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
  /** A line of this file to bring into view, word marked — where a search from elsewhere pointed.
   *  A new `seq` is a new request, even for the same line. */
  goto?: { line: number; word: string; seq: number };
  /** Goes to a search result in another file — a card of its own, or the peek beside the review. */
  onOpenAt: (match: GrepMatch, word: string) => void;
}) {
  const api = useApi();
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
    let done = false;
    setLoadingContent(true);
    setContentError(null);
    const fail = (message: string) => {
      fetchedFor.current = null;
      setContentError(message);
    };
    api
      .githubPullFile(sessionId, number, file.path, readAt, repo)
      .then((r) => {
        if (cancelled) return;
        if (r.error) fail(r.error);
        else if (r.truncated) fail("This file is too large to show here — it is on GitHub.");
        else setContent(r.content);
      })
      .catch(() => !cancelled && fail("Could not reach the server."))
      .finally(() => {
        done = true;
        if (!cancelled) setLoadingContent(false);
      });
    return () => {
      cancelled = true;
      // Left before the file arrived — back to Diff mid-read, say. What was asked for never landed,
      // so it has not been fetched: the next File asks again rather than waiting on this one forever.
      if (!done) {
        fetchedFor.current = null;
        setLoadingContent(false);
      }
    };
  }, [whole, sessionId, number, repo, file.path, readAt]);

  const copyAll = useCallback(async () => {
    if (content === null) return;
    await writeToClipboard(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [content]);

  // Nothing to read whole: a binary has no text, and a pure rename has no commit of its own to ask
  // about beyond what the review already said.
  const canReadWhole = !file.binary && !!readAt;

  // Names in the code: a click marks a name's every occurrence, Ctrl/⌘+click goes to its declaration
  // (see useCodeNav). A diff holds only the lines around the change, so a name declared elsewhere in
  // the file is not in it — that sends the card to the whole file, to look again once it is here.
  // Past the file, the rest of the pull request's code is searched (git grep at the commit the file
  // is read at): a declaration in another file opens there, one in this file comes back as a line.
  const [seeking, setSeeking] = useState<{ word: string; line?: number } | null>(null);
  const nav = useCodeNav({
    lineSelector: "[data-side]",
    path: file.path,
    search: canReadWhole ? (word) => api.githubPullGrep(sessionId, number, word, headRef, repo) : undefined,
    onOpen: (m, word) => (m.path === file.path ? seekLine(m.line, word) : onOpenAt(m, word)),
    onNoDefinition: (word) => {
      if (whole || !canReadWhole) return false;
      setSeeking({ word });
      setWhole(true);
      return true;
    },
  });
  const { goToDefinition, revealAt } = nav;

  /** A line of this file, which only the whole file is sure to have on screen. */
  function seekLine(line: number, word: string) {
    if (!canReadWhole) return;
    setSeeking({ word, line });
    setWhole(true);
  }

  useEffect(() => {
    if (!seeking) return;
    // Back to the diff before the file came: the look it was waiting to take is off.
    if (!whole || contentError) setSeeking(null);
    else if (content !== null && !loadingContent) {
      setSeeking(null);
      if (seeking.line) revealAt(seeking.line, seeking.word);
      else goToDefinition(seeking.word);
    }
  }, [seeking, whole, content, contentError, loadingContent, goToDefinition, revealAt]);

  // Asked for from outside — a search in another file found its answer here.
  useEffect(() => {
    if (goto) seekLine(goto.line, goto.word);
    // Only a new request: the line and word ride along with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goto?.seq]);

  return (
    <div
      ref={register}
      data-review-path={file.path}
      data-review-old-path={file.oldPath}
      className="border-b last:border-b-0"
    >
      {/* Sticky so the name of what you are reading stays on screen through a long diff. The row is
          not one big button: the controls at its end are buttons of their own, and a button cannot
          hold another one -- nor can the text in a button be selected, and the path is worth copying. */}
      {/* The border is the one between this header and what it holds, so a folded file leaves it to
          the card's own border rather than stacking two rules with nothing in between. */}
      <div
        onClick={(e) => {
          // A click on the row folds or unfolds the file, the way the whole row once did as a button.
          // Not a click on the controls at its end (they are outside [data-fold]) or on the path (it
          // stops its own clicks), and not the click that ends a drag selecting text across the row.
          if (e.target !== e.currentTarget && !(e.target as HTMLElement).closest("[data-fold]")) return;
          const sel = window.getSelection();
          if (sel && !sel.isCollapsed && e.currentTarget.contains(sel.anchorNode)) return;
          onToggle();
        }}
        className={cn(
          "group/fh sticky top-0 z-10 flex cursor-pointer items-center gap-2 bg-muted/60 px-3 py-1.5 text-xs backdrop-blur",
          open && "border-b"
        )}
      >
        <div data-fold className="flex min-w-0 flex-1 items-center gap-2 hover:text-foreground">
          {/* The fold control for the keyboard; a mouse can use the whole row. */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            aria-expanded={open}
            aria-label={`${open ? "Fold" : "Unfold"} ${file.path}`}
            className="shrink-0 rounded"
          >
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
          <span className={cn("shrink-0 font-mono", STATUS_COLOR[file.status] ?? "text-muted-foreground")}>
            {file.status}
          </span>
          {/* Same shrink order as the sidebar: the folders go before the file name does. The path is
              text to select rather than part of the fold target, so a click on it places the caret
              and a drag selects; the button after it copies the whole path, however much of it the
              row has room to show. */}
          <span className="flex min-w-0 items-baseline font-mono">
            <span
              onClick={(e) => e.stopPropagation()}
              onCopy={copyPathSelection}
              className="flex min-w-0 cursor-text items-baseline select-text"
            >
              <span className="min-w-0 shrink-[999] truncate text-muted-foreground">{dir}</span>
              <span className={cn("min-w-0 truncate font-medium", viewed && "font-normal line-through")}>
                {name}
              </span>
              {file.oldPath && (
                <span className="min-w-0 shrink-[999] truncate text-muted-foreground">
                  &nbsp;← {file.oldPath}
                </span>
              )}
            </span>
            <CopyPathButton
              path={file.path}
              iconClassName="size-3"
              className="ml-1.5 inline-flex shrink-0 self-center rounded text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/fh:opacity-100 [@media(hover:none)]:opacity-100"
            />
          </span>
          <span className="min-w-0 flex-1" />
          {/* Said in the row rather than under it. As a line of its own it made this one file's row
              half again as tall as every other folded row, and a list you are scanning for what is
              left to read wants one height, not two. */}
          {bigByDefault && !open && (
            <span
              title="A large diff — it is not drawn until you open it"
              className="shrink-0 rounded bg-muted-foreground/15 px-1 text-[10px] text-muted-foreground"
            >
              large
            </span>
          )}
          <span className="shrink-0 font-mono text-[11px]">
            <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>{" "}
            <span className="text-red-600 dark:text-red-400">−{file.deletions}</span>
          </span>
        </div>

        {/* Change or file. Only once the file is open — they are how to read what is on screen, and
            there is nothing on screen to read while it is folded away. */}
        {open && canReadWhole && (
          <span className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => setWhole(false)}
              title={`Show what this ${scope === "commit" ? "commit" : "pull request"} changes in the file`}
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
              title={
                scope === "commit"
                  ? `Show the whole file as it is ${file.status === "D" ? "just before" : "at"} this commit`
                  : `Show the whole file as it is at ${file.status === "D" ? "the base" : "the head"} of this pull request`
              }
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
        {/* Read, or not. Last in the row because it is what you reach for having finished with the
            file above it — and absent where GitHub gave no sha, since a mark with nothing to compare
            against could never reset when the author pushes again. */}
        {file.sha && (
          <button
            type="button"
            role="checkbox"
            aria-checked={viewed}
            onClick={() => onViewed(file, !viewed)}
            title={viewed ? "Marked read — click to read it again" : "Mark this file read"}
            className={cn(
              "flex shrink-0 items-center gap-1 rounded px-1.5 py-1 transition-colors hover:bg-accent",
              viewed ? "text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
          >
            <span
              className={cn(
                "flex size-3.5 items-center justify-center rounded-[3px] border",
                viewed
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-muted-foreground/50"
              )}
            >
              {viewed && <Check className="size-3" />}
            </span>
            <span className="hidden sm:inline">Viewed</span>
          </button>
        )}
      </div>

      {nav.overlay}
      <div ref={nav.ref}>
        {open && whole ? (
          loadingContent ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Reading the file…
            </div>
          ) : contentError ? (
            <div className="p-4 text-sm text-muted-foreground">{contentError}</div>
          ) : (
            <FileListing
              path={file.path}
              text={content ?? ""}
              side={file.status === "D" ? "old" : "new"}
              wrap={wrap}
              zoom={zoom}
              numCol={numCol}
            />
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
        ) : null}
      </div>
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
function Code({
  tokens,
  text,
  className,
  side,
  line,
}: {
  tokens?: CodeToken[];
  text: string;
  className: string;
  /** Which version of the file this cell is from, and its line number there — what a selection is
   *  turned into lines with (see pickLines). A cell with no line is the empty side of a change. */
  side: "old" | "new";
  line?: number;
}) {
  const attrs = { className, "data-side": side, "data-line": line };
  if (!tokens) return <div {...attrs}>{text || " "}</div>;
  if (!tokens.length) return <div {...attrs}> </div>;
  return (
    <div {...attrs}>
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
                    side="old"
                    line={row.left?.number}
                  />
                  <div className={cn(NUM_CELL, "border-l", tint(rightKind))}>{row.right?.number ?? ""}</div>
                  <Code
                    tokens={row.rightTokens}
                    text={row.right?.text ?? ""}
                    className={cn(CODE_CELL, mode.code, tint(rightKind))}
                    side="new"
                    line={row.right?.number}
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
              <Code
                tokens={tokens}
                text={line.text}
                className={cn(CODE_CELL, mode.code, tint(kind))}
                side={side === "add" ? "new" : "old"}
                line={line.number}
              />
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
  side,
  wrap,
  zoom,
  numCol,
}: {
  path: string;
  text: string;
  /** The version the file was read at: the head, or the base for a file the change deletes. */
  side: "old" | "new";
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
            <Code tokens={tokens?.[i]} text={line} className={cn(CODE_CELL, mode.code)} side={side} line={i + 1} />
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
