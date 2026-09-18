import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { GitStatus, SessionInfo, SessionLink, SessionPull } from "@/types";
import { api } from "@/lib/api";
import { useConfirm } from "@/components/ui/confirm";
import { readUrlState, patchUrlState, type TabName } from "@/lib/urlState";
import {
  flushSessionUi,
  loadSessionUi,
  noteSessionUiRev,
  saveSessionUi,
  subscribeSessionUi,
  syncSessionUi,
} from "@/lib/sessionUi";
import { fileEntryFromPath, useFileTabs } from "@/lib/useFileTabs";
import { MAX_LINKS, useSessionLinks } from "@/lib/sessionLinks";
import { useSessionPulls } from "@/lib/sessionPulls";
import { useShells } from "@/lib/useShells";
import { FileBrowser, type FileBrowserHandle } from "./FileBrowser";
import { FileTabStrip } from "./FileTabStrip";
import { LinkDialog } from "./LinkDialog";
import { LinkTabStrip } from "./LinkTabStrip";
import { PullRequestView } from "./PullRequestView";
import { PullTabStrip } from "./PullTabStrip";
import { ShellTabStrip } from "./ShellTabStrip";
import { WebLinkView } from "./WebLinkView";
import { TerminalPane, type TerminalPaneHandle } from "./TerminalPane";
import { PostponedPool } from "./PostponedPool";
import { RenameField } from "./RenameField";
import { Button } from "@/components/ui/button";
import { Badge, badgeVariants } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useDismissable } from "@/lib/useDismissable";
import { sessionColor } from "@/lib/sessionColors";
import { Check, Columns2, Copy, FileText, FolderTree, GitBranch, GitFork, Info, Loader2, Menu, MoreVertical, PanelLeftOpen, Pencil, Play, Radio, ShieldCheck, ShieldOff, Square, TerminalSquare } from "lucide-react";
import { writeToClipboard } from "@/lib/clipboard";

// Desktop width of the Files panel in Split view. Persisted per-browser and drag-resizable.
const SPLIT_MIN = 280; // keep both the files panel and the terminal usable
const SPLIT_DEFAULT = 480;
const SPLIT_WIDTH_KEY = "claudeweb.splitFilesWidth";

function readSplitWidth() {
  const n = Number(localStorage.getItem(SPLIT_WIDTH_KEY));
  return Number.isFinite(n) && n >= SPLIT_MIN ? n : SPLIT_DEFAULT;
}

// Compact process uptime, e.g. "45s", "5m 12s", "2h 8m", "1d 3h".
function formatUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// Convert an absolute path (from a terminal file-link) into one relative to the session's working
// directory, using forward slashes (the shape FileBrowser uses). Returns null if it's outside the
// working directory — the per-session browser can only show files under it.
function toWorkingDirRelative(workingDir: string, abs: string): string | null {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const a = norm(abs);
  const wd = norm(workingDir);
  if (a.toLowerCase() === wd.toLowerCase()) return "";
  return a.toLowerCase().startsWith(wd.toLowerCase() + "/") ? a.slice(wd.length + 1) : null;
}

function StateBadge({ state }: { state: SessionInfo["state"] }) {
  // "running" is the normal case — don't badge it; only surface states that need attention.
  if (state === "Running") return null;
  if (state === "Exited") return <Badge variant="secondary">exited</Badge>;
  if (state === "Restorable") return <Badge variant="outline">closed</Badge>;
  return <Badge variant="destructive">failed</Badge>;
}

export function SessionView({
  session,
  busy,
  parent,
  shellsRev,
  onFork,
  onSelectSession,
  onToggleSidebar,
  collapsed,
  onToggleCollapsed,
  onStopped,
  onRename,
  onTerminalRename,
  onTerminalColor,
}: {
  session: SessionInfo;
  // Whether Claude is currently working in this session (from the live /hub/events busy set).
  busy?: boolean;
  // The session this one was forked from, when it's still around — null once it's been closed and
  // forgotten, in which case the header falls back to the name recorded at fork time.
  parent?: SessionInfo | null;
  // The server's shell-set revision, pushed on the events hub. When it moves, this session re-reads
  // its own shell tabs — that is how a shell opened (or closed) on another device shows up here.
  shellsRev?: number;
  onFork: (s: SessionInfo) => void;
  onSelectSession: (id: string) => void; // used by the "forked from" link to jump to the parent
  onToggleSidebar: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** The session was closed and stays in the list — the row it should be replaced with. */
  onStopped: (session: SessionInfo) => void;
  onRename: (id: string, name: string) => void;
  // Apply a rename detected in this session's terminal (Claude's /rename confirmation).
  onTerminalRename?: (id: string, name: string) => void;
  // Apply a color detected in this session's terminal (Claude's /color confirmation).
  onTerminalColor?: (id: string, color: string) => void;
}) {
  const confirm = useConfirm();
  const terminalRef = useRef<TerminalPaneHandle>(null);
  const [stopping, setStopping] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  // View mode is remembered per session (in the browser). On first mount honor a deep-linked ?tab=
  // when it targets this session, otherwise fall back to this session's saved mode.
  const [view, setView] = useState<TabName>(() => {
    const url = readUrlState();
    if (url.session === session.id && url.tab) return url.tab;
    return loadSessionUi(session.id).view ?? url.tab ?? "terminal";
  });
  // The files this session has open. They are tabs in the bar below the header, beside
  // Terminal/Split/Files, so the state belongs here rather than inside the Files panel.
  const { fileTabs, closeGuard, settleCloseGuard } = useFileTabs(session.id);
  const [copiedPath, setCopiedPath] = useState(false);
  const [splitWidth, setSplitWidth] = useState(readSplitWidth); // Files-panel width in Split view
  // Optimistic mirror of the watchdog toggle so it flips instantly, then syncs from the session poll.
  const [wdEnabled, setWdEnabled] = useState(session.watchdogEnabled);
  const [nowTick, setNowTick] = useState(() => Date.now()); // ticks so the header uptime stays live
  const contentRef = useRef<HTMLDivElement>(null);
  const fileBrowserRef = useRef<FileBrowserHandle>(null);
  // Candidates when a bare filename clicked in the terminal matched more than one file.
  const [filePicker, setFilePicker] = useState<{ name: string; matches: string[] } | null>(null);
  // The session's shell tabs — a real shell in its working folder, beside the Claude terminal. The
  // hook owns the server-side list; this view only decides what to do with it.
  const shells = useShells({
    owner: { sessionId: session.id, workingDirectory: session.workingDirectory },
    shellsRev,
    initialActive: () => loadSessionUi(session.id).shell ?? null,
    // A click is a choice worth remembering, and the bag is shared, so it follows to every device.
    // Both fields in one patch: two saveSessionUi calls would rewrite the whole mirrored store twice
    // for one click, and land as two revisions for every other browser to chase.
    onActivate: (id) => saveSessionUi(session.id, { shell: id, view: "shell" }),
    onError: (message) =>
      void confirm({
        title: "Could not open a shell",
        description: message,
        confirmLabel: "OK",
        destructive: false,
      }),
  });

  // The web pages pinned to this session — a Jira issue, a PR, a doc — as tabs beside the shells.
  // Unlike the shells there is no process behind them, so they live in the session's UI bag and the
  // hook is the whole of the feature's state.
  const links = useSessionLinks(session.id);
  // The add/edit dialog: null when closed, `{}` when adding, `{ edit }` when changing one.
  const [linkDialog, setLinkDialog] = useState<{ edit?: SessionLink } | null>(null);
  // Link ids whose frame has been mounted at least once. A frame is kept alive behind the other
  // tabs so coming back to a page finds it where it was left, but mounting every link on open would
  // fetch every pinned page whether or not anyone looked at one.
  const [mountedLinks, setMountedLinks] = useState<string[]>([]);

  // The pull requests this session has open as tabs. Like the links they live in the session's UI
  // bag, so a review follows the session to every device; unlike them, what is drawn under the tab
  // is fetched from GitHub each time it is opened.
  const pulls = useSessionPulls(session.id);
  // Whether this session's folder is a GitHub repo — read from its git remote, so it costs no
  // network call. It is what decides whether the PR picker is in the tab bar at all.
  const [isGitHub, setIsGitHub] = useState(false);
  // Reviews mounted at least once, kept alive behind the other tabs the way the link frames are — so
  // coming back to one finds it loaded, with the files folded the way they were left, instead of
  // asking GitHub again. The session they belong to is part of the state because this view is NOT
  // remounted when the session changes, and a PR number is a small integer that means a different
  // review in every repo: carried over, session A's #42 would be handed straight to session B's.
  const [mountedPulls, setMountedPulls] = useState<{ session: string; numbers: number[] }>(() => ({
    session: session.id,
    numbers: [],
  }));

  useEffect(() => setWdEnabled(session.watchdogEnabled), [session.watchdogEnabled]);

  // Keep the header uptime ticking while the process runs.
  useEffect(() => {
    if (session.state !== "Running") return;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [session.state]);

  const toggleWatchdog = useCallback(() => {
    setWdEnabled((prev) => {
      const next = !prev;
      // Ask for notification permission here — a real click — so the first "needs attention" alert
      // isn't lost to browsers that ignore permission prompts not triggered by a user gesture.
      if (next && "Notification" in window && Notification.permission === "default")
        Notification.requestPermission().catch(() => {});
      api.setWatchdog(session.id, next).catch(() => setWdEnabled(prev)); // revert on failure
      return next;
    });
  }, [session.id]);

  const sendContinue = useCallback(() => {
    api.continueSession(session.id).catch(() => {});
  }, [session.id]);

  // Drag the divider between the Files panel and the terminal (Split view, desktop); persist it.
  const startSplitResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = readSplitWidth();
    let width = startW;
    const onMove = (ev: PointerEvent) => {
      // Leave at least SPLIT_MIN for the terminal on the right.
      const max = (contentRef.current?.clientWidth ?? Infinity) - SPLIT_MIN;
      width = Math.min(max, Math.max(SPLIT_MIN, startW + ev.clientX - startX));
      setSplitWidth(width);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem(SPLIT_WIDTH_KEY, String(width));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const resetSplitWidth = useCallback(() => {
    setSplitWidth(SPLIT_DEFAULT);
    localStorage.setItem(SPLIT_WIDTH_KEY, String(SPLIT_DEFAULT));
  }, []);

  const copyPath = useCallback(async () => {
    await writeToClipboard(session.workingDirectory);
    setCopiedPath(true);
    setTimeout(() => setCopiedPath(false), 1500);
  }, [session.workingDirectory]);

  // Mirror the active tab into the URL (deep-linking / refresh restore).
  useEffect(() => {
    patchUrlState({ tab: view });
  }, [view]);

  // Switch a tab and remember it for this session, so returning to the session restores the mode.
  const changeView = useCallback(
    (next: TabName) => {
      setView(next);
      saveSessionUi(session.id, { view: next });
    },
    [session.id]
  );

  // Open a working-tree-relative file in this session's Files panel. If the panel is already showing
  // (files/split/a file tab), reveal it via the browser's imperative handle — that also expands the
  // tree down to it. Otherwise open the tab here and switch to the Files view; the saved `file` is
  // written first so the tree expands to it as it mounts.
  const openInFiles = useCallback(
    (rel: string) => {
      // "terminal" and "shell" are the views with no tree on screen — FileBrowser isn't mounted, so
      // there is no handle to reveal through and the panel has to be brought up instead.
      if (view === "terminal" || view === "shell") {
        saveSessionUi(session.id, { file: rel });
        patchUrlState({ file: rel });
        void fileTabs.open(fileEntryFromPath(rel), false);
        changeView("files");
      } else {
        fileBrowserRef.current?.revealFile(rel);
      }
    },
    [view, session.id, changeView, fileTabs]
  );

  // Open this session's git-changes view (from the header branch badge). If the Files panel is already
  // showing, flip it via the imperative handle; otherwise seed the mode and switch to the Files view.
  const openChanges = useCallback(() => {
    if (view === "terminal" || view === "shell") {
      saveSessionUi(session.id, { changes: true });
      changeView("files");
    } else {
      fileBrowserRef.current?.showChanges();
    }
  }, [view, session.id, changeView]);

  // A full file path clicked in the terminal: resolve it under the working directory, then open it in
  // this session's Files panel (ignore paths outside the working directory — the browser can't show them).
  const onTerminalOpenFile = useCallback(
    (absolutePath: string) => {
      const rel = toWorkingDirRelative(session.workingDirectory, absolutePath);
      if (rel) openInFiles(rel);
    },
    [session.workingDirectory, openInFiles]
  );

  // A bare filename clicked in the terminal: search the working directory. Open the single hit, or
  // offer a picker when several match.
  const onTerminalFindFile = useCallback(
    async (name: string) => {
      try {
        const res = await api.searchSessionFiles(session.id, name);
        const files = res.entries.filter((e) => !e.isDir);
        const exact = files.filter((e) => e.name === name);
        const list = (exact.length ? exact : files).map((e) => e.path);
        if (list.length === 0) return;
        if (list.length === 1) openInFiles(list[0]);
        else setFilePicker({ name, matches: list });
      } catch {
        /* ignore — search is best-effort */
      }
    },
    [session.id, openInFiles]
  );

  // Seed the store with the initial mode (once), so returning to this session restores it even when
  // the initial mode came from a deep link rather than a tab click.
  useEffect(() => {
    saveSessionUi(session.id, { view });
    // Mount-only: session switches are handled by the restore effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On switching to another session, restore that session's last-used view mode — and hand whatever
  // the browser it was left in still owes the server, so the next device sees it.
  const prevViewSession = useRef(session.id);
  useEffect(() => {
    if (prevViewSession.current === session.id) return;
    flushSessionUi(prevViewSession.current);
    prevViewSession.current = session.id;
    setView(loadSessionUi(session.id).view ?? "terminal");
  }, [session.id]);

  // The saved state lives on the server, so opening a session fetches it: this device may never have
  // seen the session, or may have last seen it before another one moved things around.
  useEffect(() => {
    void syncSessionUi(session.id, true);
  }, [session.id]);

  // A revision on the session list higher than the one this browser holds means another browser
  // wrote — re-fetch (the tabs follow through useFileTabs' own subscription).
  useEffect(() => {
    noteSessionUiRev(session.id, session.uiRev);
  }, [session.id, session.uiRev]);

  // Take the view mode from the copy fetched on open, but not from a later remote write: the tab
  // list is shared state worth following live, while which surface is on screen is whatever the
  // person in front of this browser last chose.
  useEffect(
    () =>
      subscribeSessionUi(session.id, (seed) => {
        if (!seed) return;
        const ui = loadSessionUi(session.id);
        setView(ui.view ?? "terminal");
        // Which shell that view names is handled by useShells, which reconciles the remembered id
        // against what the server actually has. `restore`, not `activate`: adopting a value that
        // came FROM the bag must not write it back — that is a device merely opening the session
        // stamping on whichever tab another device is watching.
        if (ui.shell) shells.restore(ui.shell);
      }),
    [session.id]
  );

  // A file tab has nothing to show once its file is closed; fall back to the tree it came from.
  useEffect(() => {
    if (view === "file" && !fileTabs.tabs.length) changeView("files");
  }, [view, fileTabs.tabs.length, changeView]);

  // Showing a shell tab: the pane is the shell's, and the session remembers which one it was on
  // (through the hook's onActivate above, which is what a click means).
  const showShell = useCallback(
    (id: string) => {
      shells.activate(id);
      setView("shell");
    },
    // Only the two stable callbacks are used; depending on the handle itself would rebuild these
    // every render, since the hook returns a fresh object each time.
    [shells.activate]
  );

  // Open another shell in the session's folder, and give it the pane.
  const openShell = useCallback(
    async (shell: string) => {
      if (await shells.open(shell)) setView("shell");
    },
    [shells.open]
  );

  // Showing a linked page. Both writes land in one request — saveSessionUi coalesces what a single
  // click queues — so the session comes back to this page on its other devices too.
  const showLink = useCallback(
    (id: string) => {
      links.activate(id);
      changeView("link");
    },
    [links.activate, changeView]
  );

  // Mount the frame of whichever link is being looked at, and leave it mounted from then on.
  useEffect(() => {
    if (view !== "link" || !links.activeId) return;
    const id = links.activeId;
    setMountedLinks((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, [view, links.activeId]);

  // Forget frames for links that are gone (removed here, or on another device), so their iframes
  // are unmounted rather than kept alive behind a tab that no longer exists.
  useEffect(() => {
    setMountedLinks((prev) => {
      const next = prev.filter((id) => links.links.some((l) => l.id === id));
      return next.length === prev.length ? prev : next;
    });
  }, [links.links]);

  // The last link closed: the pane goes back to the terminal, the way it does for the shells.
  useEffect(() => {
    if (view === "link" && !links.links.length) changeView("terminal");
  }, [view, links.links.length, changeView]);

  // Ask once per session whether its folder is a GitHub repo. A session doesn't change folders, and
  // a remote is not added mid-session often enough to be worth polling for.
  useEffect(() => {
    let cancelled = false;
    setIsGitHub(false);
    api
      .githubRepo(session.id)
      .then((r) => !cancelled && setIsGitHub(r.isGitHub))
      .catch(() => {
        /* not a repo, or the server is not answering — no picker, which is the safe default */
      });
    return () => {
      cancelled = true;
    };
  }, [session.id]);

  // Showing a PR review. Both writes land in one request — saveSessionUi coalesces what a single
  // click queues — so the session comes back to this review on its other devices too.
  const showPull = useCallback(
    (number: number) => {
      pulls.activate(number);
      changeView("pull");
    },
    [pulls.activate, changeView]
  );

  // Opening one from the picker: `open` moves to the tab if it is already there, so this only has to
  // give the pane over. Looking a PR up is asking to read it.
  const openPull = useCallback(
    (pull: SessionPull) => {
      pulls.open(pull);
      changeView("pull");
    },
    [pulls.open, changeView]
  );

  // Mount the review being looked at, and leave it mounted from then on. A session switch starts the
  // list again rather than clearing it in an effect of its own — which would race this one, and on
  // the first render would win, leaving the tab with nothing under it.
  useEffect(() => {
    if (view !== "pull" || !pulls.activeNumber) return;
    const n = pulls.activeNumber;
    setMountedPulls((prev) =>
      prev.session !== session.id
        ? { session: session.id, numbers: [n] }
        : prev.numbers.includes(n)
          ? prev
          : { session: prev.session, numbers: [...prev.numbers, n] }
    );
  }, [view, pulls.activeNumber, session.id]);

  // Forget reviews that are gone (closed here, or on another device), so they are unmounted rather
  // than kept alive behind a tab that no longer exists. A list belonging to the session just left is
  // dropped whole, for the reason the state carries its session at all.
  useEffect(() => {
    setMountedPulls((prev) => {
      if (prev.session !== session.id)
        return prev.numbers.length ? { session: session.id, numbers: [] } : prev;
      const numbers = prev.numbers.filter((n) => pulls.pulls.some((p) => p.number === n));
      return numbers.length === prev.numbers.length ? prev : { session: prev.session, numbers };
    });
  }, [pulls.pulls, session.id]);

  // The last review closed: the pane goes back to the terminal, the way it does for the links.
  useEffect(() => {
    if (view === "pull" && !pulls.pulls.length) changeView("terminal");
  }, [view, pulls.pulls.length, changeView]);

  // Pinning a page gives it the pane straight away — adding it is asking to look at it. `add` picks
  // the tab itself (it may have landed on one that was already there), so this only moves the view.
  const addLink = useCallback(
    (link: Omit<SessionLink, "id">) => {
      links.add(link);
      changeView("link");
    },
    [links.add, changeView]
  );

  // No shells left: the pane goes back to the terminal. Keyed on the LIST being empty rather than on
  // there being no active id — the hook picks the active one in an effect, so on the render where a
  // session's shells first arrive the id is still null, and reading that as "nothing to show" would
  // bounce a deep-linked ?tab=shell to the terminal and write that back to the shared bag.
  useEffect(() => {
    if (shells.loaded && shells.shells.length === 0 && view === "shell") changeView("terminal");
  }, [shells.loaded, shells.shells.length, view, changeView]);

  // Clicking a file tab fills the pane with that file. Clicking the one already showing beside the
  // tree does too — that is what asking for its own tab means.
  const openFileTab = useCallback(
    async (path: string) => {
      await fileTabs.activate(path);
      changeView("file");
    },
    [fileTabs, changeView]
  );

  const bump = useCallback(() => setRefreshToken((t) => t + 1), []);
  const loadGit = useCallback(() => {
    api.gitStatus(session.id).then(setGit).catch(() => setGit(null));
  }, [session.id]);
  const onRefresh = useCallback(() => {
    bump();
    loadGit();
  }, [bump, loadGit]);

  // Auto-refresh: poll the working dir's change counter; when it moves, reload tree + git.
  useEffect(() => {
    setGit(null);
    loadGit();
    let last = -1;
    let stopped = false;
    const tick = async () => {
      try {
        const v = await api.fsVersion(session.id);
        if (stopped) return;
        if (v !== last) {
          if (last !== -1) {
            bump();
            loadGit();
          }
          last = v;
        }
      } catch {
        /* session gone / not ready */
      }
    };
    tick();
    const t = setInterval(tick, 2500);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [session.id, loadGit, bump]);

  const changeCount = git?.isRepo ? Object.keys(git.files).length : 0;

  /**
   * Close the session. It stays in the list, in its project and folder, and can be reopened — this
   * ends the work rather than clearing it away, and taking the row out of the list is the sidebar
   * menu's job one deliberate step later. A session that has already exited goes the same way: there
   * is no process left to kill, but closing it is what turns the row into one that can be reopened.
   */
  async function stop() {
    const running = session.state === "Running";
    // Only a live process is worth a dialog; closing one that already exited costs nothing.
    if (running) {
      const ok = await confirm({
        title: "Stop session?",
        description: (
          <>
            This kills the <span className="font-medium text-foreground">{session.name}</span>{" "}
            process.
            {session.remoteControl && " Its Remote Control session in the Claude Code app ends too."}{" "}
            The session stays in the list and can be reopened.
          </>
        ),
        confirmLabel: "Stop",
      });
      if (!ok) return;
    }
    setStopping(true);
    try {
      onStopped(await api.stopSession(session.id));
    } catch {
      // The session list is left exactly as it is: the poll and the live stream both carry what
      // really happened, and drawing this session as closed on a failed call would be a lie.
    } finally {
      setStopping(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="relative flex shrink-0 flex-col">
        {/* Row 1: session name + badges on the left, uptime/info/RC and session actions on the
            right — h-14 so it lines up with the sidebar's app header. On a phone the width goes to
            the name instead: the folder and branch drop to a second line and the right-hand cluster
            collapses into a "⋯" menu. */}
        {/* A container, so what the row drops when it runs out of width is decided by the width the
            row actually has -- which is the window minus a sidebar the user can resize or collapse,
            and nothing a viewport breakpoint can see. */}
        <div className="@container relative flex min-h-10 min-w-0 shrink-0 items-center gap-2 border-b px-3 py-1 md:h-10 md:py-0">
          {/* Session color (set via `/color`) as a left accent border, the same color the sidebar row
              shows. Scoped to this row rather than the whole header: run down the header and it lines
              up alongside the Terminal/Split/Files tabs too, which the colour says nothing about. */}
          {sessionColor(session.color) && (
            <span
              aria-hidden
              className="absolute inset-y-0 left-0 w-1"
              style={{ backgroundColor: sessionColor(session.color)! }}
              title={`Color: ${session.color}`}
            />
          )}
          {/* The sidebar toggle. Pulled back by the button's own centering inset (-ml-2.5) so the
              glyph -- not the box around it -- starts on the row's padding edge, lining up with the
              tab icons below and with the session name when the sidebar is open and the button is
              gone. The inset is 10px, not 8: Button's `[&_svg]:size-4` outranks a `size-5` written
              here, so the glyph is 16px however it is asked for, and it centres in a 36px box. */}
          <Button
            variant="ghost"
            size="icon"
            className="-ml-2.5 size-9 shrink-0 md:hidden"
            onClick={onToggleSidebar}
          >
            <Menu />
          </Button>
          {collapsed && (
            <Button
              variant="ghost"
              size="icon"
              className="-ml-2.5 hidden md:inline-flex"
              title="Show sidebar"
              onClick={onToggleCollapsed}
            >
              <PanelLeftOpen />
            </Button>
          )}
          {/* No overflow-hidden here — it would clip the info popup; children truncate themselves.
              Two stacked lines on a phone (name, then folder/branch), one line from md up. */}
          <div className="group flex min-w-0 flex-1 flex-col gap-0.5 md:flex-row md:items-center md:gap-2">
            <div className="flex min-w-0 items-center gap-2">
              {renaming ? (
                <RenameField
                  value={session.name}
                  onSubmit={(name) => {
                    onRename(session.id, name);
                    setRenaming(false);
                  }}
                  onCancel={() => setRenaming(false)}
                  className="max-w-[16rem] font-semibold"
                />
              ) : (
                <h2
                  className="min-w-0 cursor-text truncate font-semibold"
                  title="Double-click to rename"
                  onDoubleClick={() => setRenaming(true)}
                >
                  {session.name}
                </h2>
              )}
              {!renaming && (
                <button
                  onClick={() => setRenaming(true)}
                  title="Rename session"
                  className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Pencil className="size-3.5" />
                </button>
              )}
              <StateBadge state={session.state} />
              {session.state === "Running" && session.watchdogStatus === "recovering" && (
                <Badge variant="warning" title="Watchdog detected an error and is auto-continuing">
                  Auto-recovering
                </Badge>
              )}
              {session.state === "Running" && session.watchdogStatus === "attention" && (
                <Badge variant="destructive" title="Watchdog gave up after repeated errors — needs you">
                  Needs attention
                </Badge>
              )}
            </div>

            {/* Second line on a phone, same line from md up: where the session lives. */}
            <div className="flex min-w-0 items-center gap-2 md:flex-1">
              {session.parentSessionId && <ForkedFrom parent={parent} name={session.parentName} onOpen={onSelectSession} />}
              {git?.isRepo && git.branch && (
                <button
                  type="button"
                  onClick={openChanges}
                  className={cn(
                    badgeVariants({ variant: "outline" }),
                    "min-w-0 shrink gap-1 transition-colors hover:bg-accent"
                  )}
                  title="Show git changes"
                >
                  <GitBranch className="size-3 shrink-0" />
                  <span className="max-w-[6rem] truncate sm:max-w-[10rem]">{git.branch}</span>
                  {changeCount > 0 && <span className="shrink-0 text-amber-500">·{changeCount}</span>}
                </button>
              )}
              <button
                type="button"
                onClick={copyPath}
                title="Copy working directory"
                className="group/path flex min-w-0 items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
              >
                <span className="truncate">{session.workingDirectory}</span>
                {copiedPath ? (
                  <Check className="size-3 shrink-0 text-emerald-500" />
                ) : (
                  <Copy className="size-3 shrink-0 opacity-0 transition-opacity group-hover/path:opacity-100" />
                )}
              </button>
            </div>
          </div>

          {/* Right side of the title row: uptime · info popup · RC badge — desktop only; the phone
              gets the same set through the "⋯" menu below. */}
          <div className="ml-auto hidden shrink-0 items-center gap-2 md:flex">
              {/* First to go when the row is tight. The right-hand cluster does not shrink, so every
                  pixel it holds is taken off the branch and the folder opposite -- and those name the
                  thing you are looking at, where uptime is a number you glance at. It is in the info
                  popup beside it either way, so nothing is actually lost by dropping it here. */}
              {session.state === "Running" && (
                <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground @min-[64rem]:inline">
                  up {formatUptime(nowTick - new Date(session.createdAt).getTime())}
                </span>
              )}
              <SessionInfoPopover session={session} nowTick={nowTick} />
              {session.remoteControl &&
                (session.state === "Running" ? (
                  <a
                    href={session.remoteUrl ?? "https://claude.ai/code"}
                    target="_blank"
                    rel="noreferrer"
                    className={cn(
                      badgeVariants({ variant: "outline" }),
                      "hidden gap-1 border-emerald-500/40 text-emerald-600 transition-colors hover:bg-emerald-500/10 dark:text-emerald-500 sm:inline-flex"
                    )}
                    title="Open this Remote Control session in the Claude Code app"
                  >
                    <Radio className="size-3" /> RC
                  </a>
                ) : (
                  <Badge
                    variant="outline"
                    className="hidden gap-1 border-emerald-500/40 text-emerald-600 dark:text-emerald-500 sm:inline-flex"
                    title="Registered for Remote Control — drive it from the Claude Code app"
                  >
                    <Radio className="size-3" /> RC
                  </Badge>
                ))}
              {session.canFork && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-[30px]"
                  onClick={() => onFork(session)}
                  title="Fork — branch this conversation into a new session"
                >
                  <GitFork className="size-4" />
                </Button>
              )}
              {session.state === "Running" && (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-[30px]"
                    onClick={toggleWatchdog}
                    title={
                      wdEnabled
                        ? "Hang watchdog on — auto-sends “continue” on API errors. Click to disable."
                        : "Hang watchdog off. Click to enable auto-recovery."
                    }
                    aria-pressed={wdEnabled}
                  >
                    {wdEnabled ? (
                      <ShieldCheck className="size-4 text-emerald-600 dark:text-emerald-500" />
                    ) : (
                      <ShieldOff className="size-4 text-muted-foreground" />
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-[30px]"
                    onClick={sendContinue}
                    title="Send “continue” to this session now"
                  >
                    <Play className="size-4" />
                  </Button>
                </>
              )}
              <Button
                variant="destructive"
                size="icon"
                className="size-[30px]"
                onClick={stop}
                disabled={stopping}
                title={session.state === "Running" ? "Stop session" : "Close session"}
              >
                {stopping ? <Loader2 className="size-4 animate-spin" /> : <Square className="size-4" />}
              </Button>
          </div>

          <SessionActionsMenu
            session={session}
            nowTick={nowTick}
            wdEnabled={wdEnabled}
            onToggleWatchdog={toggleWatchdog}
            onContinue={sendContinue}
            onFork={() => onFork(session)}
            onStop={stop}
            stopping={stopping}
          />
        </div>

        {/* Row 2: view tabs resting on the header's bottom border, styled like the sidebar tabs.
            Terminal is the primary surface; Files is the secondary view of the working directory.
            Split shows both side by side (desktop only). */}
        <div className="flex h-10 shrink-0 items-center border-b">
          <ViewTab active={view === "terminal"} onClick={() => changeView("terminal")}>
            <TerminalSquare className="size-4" />
            <span className="hidden sm:inline">Terminal</span>
          </ViewTab>
          <ViewTab active={view === "split"} onClick={() => changeView("split")} className="hidden md:flex">
            <Columns2 className="size-4" />
            <span className="hidden sm:inline">Split</span>
          </ViewTab>
          <ViewTab active={view === "files"} onClick={() => changeView("files")}>
            <FolderTree className="size-4" />
            <span className="hidden sm:inline">Files</span>
          </ViewTab>
          {/* The repo's pull requests: the picker, then whichever reviews are open. Right after
              Files because a review is a view of the same repo the tree is showing. The strip is
              here whenever there is something in it — the picker alone is what waits on the folder
              turning out to be on GitHub, since the tabs are saved state and a probe that is slow,
              or that failed, must not leave an open review with no tab to get back to. */}
          {(isGitHub || pulls.pulls.length > 0) && (
            <PullTabStrip
              sessionId={session.id}
              picker={isGitHub}
              pulls={pulls.pulls}
              activeNumber={pulls.activeNumber}
              showingPull={view === "pull"}
              onOpen={openPull}
              onActivate={showPull}
              onClose={pulls.close}
            />
          )}
          {/* The open files, as tabs of the same standing: one click and the file has the pane. */}
          <FileTabStrip
            tabs={fileTabs.tabs}
            activePath={fileTabs.activePath}
            previewPath={fileTabs.previewPath}
            showingFile={view === "file"}
            gitFiles={git?.isRepo ? git.files : undefined}
            onActivate={(p) => void openFileTab(p)}
            onPin={fileTabs.pin}
            onClose={(p) => void fileTabs.close(p)}
            onCloseAll={() => void fileTabs.closeAll()}
          />
          {/* Shells in the same folder, and the "+" that opens another. After the views that are
              always there, so those keep their places as shells come and go. */}
          <ShellTabStrip
            shells={shells.shells}
            activeId={shells.activeId}
            showingShell={view === "shell"}
            busy={shells.opening}
            onActivate={showShell}
            onOpen={(sh) => void openShell(sh)}
            onClose={(id) => void shells.close(id)}
          />
          {/* The pages this session is working from, and the "+" that pins another — last in the
              row, so that "+" is always in the same place at the end of the bar. */}
          <LinkTabStrip
            links={links.links}
            activeId={links.activeId}
            showingLink={view === "link"}
            onActivate={showLink}
            onEdit={(id) => setLinkDialog({ edit: links.links.find((l) => l.id === id) })}
            onAdd={() => setLinkDialog({})}
            onClose={links.remove}
          />
        </div>
      </header>

      {/* The terminal stays mounted in every view (hidden in Files) so toggling never drops its
          connection; the Files panel is a resizable left column in Split and full-width in Files. */}
      <div ref={contentRef} className="flex min-h-0 flex-1 flex-col md:flex-row">
        {(view === "files" || view === "split" || view === "file") && (
          <div
            style={{ "--split-w": `${splitWidth}px` } as React.CSSProperties}
            className={cn(
              "flex min-h-0 min-w-0 flex-1 flex-col",
              view === "split" && "md:w-[var(--split-w)] md:flex-none md:shrink-0"
            )}
          >
            <FileBrowser
              ref={fileBrowserRef}
              sessionId={session.id}
              workingDirectory={session.workingDirectory}
              gitFiles={git?.isRepo ? git.files : undefined}
              tabs={fileTabs}
              previewOnly={view === "file"}
              onRefresh={onRefresh}
              refreshToken={refreshToken}
            />
          </div>
        )}

        {view === "split" && (
          <div
            onPointerDown={startSplitResize}
            onDoubleClick={resetSplitWidth}
            title="Drag to resize · double-click to reset"
            className="hidden w-1.5 shrink-0 cursor-col-resize border-l bg-transparent transition-colors hover:bg-primary/20 active:bg-primary/30 md:block"
          />
        )}

        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col",
            view !== "terminal" && view !== "split" && "hidden"
          )}
        >
          {/* The pane keeps flex-1 so FitAddon measures the height left over by the pool bar below. */}
          <div className="min-h-0 flex-1">
            <TerminalPane
              key={session.id}
              ref={terminalRef}
              sessionId={session.id}
              workingDirectory={session.workingDirectory}
              // A shell is showing: its tab bar and header sit outside the shell pane's own
              // `data-owns-image-paste` wrapper, so a Ctrl+V there would otherwise land here —
              // uploading the image and injecting its path into Claude's live prompt.
              imagePaste={view !== "shell"}
              onRenameDetected={(name) => onTerminalRename?.(session.id, name)}
              onColorDetected={(color) => onTerminalColor?.(session.id, color)}
              onOpenFile={onTerminalOpenFile}
              onFindFile={onTerminalFindFile}
            />
          </div>
          <PostponedPool sessionId={session.id} busy={busy} terminalRef={terminalRef} />
        </div>

        {/* Every open shell stays mounted, hidden behind the active tab: switching away from a
            build must not drop its socket and stop showing its output. `data-owns-image-paste`
            keeps the Claude terminal's document-level paste handler out of a shell — an image
            dropped at a shell prompt is a path nobody asked for. */}
        {shells.shells.map((sh) => (
          <div
            key={sh.id}
            data-owns-image-paste
            className={cn(
              "flex min-h-0 min-w-0 flex-1 flex-col",
              !(view === "shell" && sh.id === shells.activeId) && "hidden"
            )}
          >
            <TerminalPane
              sessionId={session.id}
              socketPath={`/hub/shells/${sh.id}/terminal`}
              imagePaste={false}
              workingDirectory={sh.workingDirectory}
              onOpenFile={onTerminalOpenFile}
              onFindFile={onTerminalFindFile}
            />
          </div>
        ))}

        {/* A linked page stays mounted behind the other tabs once it has been opened, so returning
            to it finds it where it was left rather than reloading — the same reason the shells and
            the terminal stay mounted. Only pages actually visited are here (see mountedLinks). */}
        {links.links
          .filter((l) => mountedLinks.includes(l.id))
          .map((l) => (
            <div
              key={l.id}
              className={cn(
                "flex min-h-0 min-w-0 flex-1 flex-col",
                !(view === "link" && l.id === links.activeId) && "hidden"
              )}
            >
              <WebLinkView link={l} onEdit={() => setLinkDialog({ edit: l })} />
            </div>
          ))}

        {/* A review stays mounted behind the other tabs once it has been opened, so coming back to it
            finds it loaded and folded the way it was left rather than asking GitHub again. */}
        {pulls.pulls
          .filter((p) => mountedPulls.session === session.id && mountedPulls.numbers.includes(p.number))
          .map((p) => (
            // Keyed by session as well as number, so a review can never be handed the instance a
            // different repo's PR of the same number left behind.
            <div
              key={`${session.id}:${p.number}`}
              className={cn(
                "flex min-h-0 min-w-0 flex-1 flex-col",
                !(view === "pull" && p.number === pulls.activeNumber) && "hidden"
              )}
            >
              <PullRequestView
                sessionId={session.id}
                number={p.number}
                onTitle={(title) => pulls.retitle(p.number, title)}
              />
            </div>
          ))}
      </div>

      {/* Pin a web page to this session, or change one already pinned. */}
      {linkDialog && (
        <LinkDialog
          edit={linkDialog.edit}
          full={!linkDialog.edit && links.links.length >= MAX_LINKS}
          onSave={(l) => {
            if (linkDialog.edit) links.update(linkDialog.edit.id, l);
            else addLink(l);
          }}
          onClose={() => setLinkDialog(null)}
        />
      )}

      {/* Save-changes prompt shown when a tab with unsaved edits is about to close. */}
      <Dialog open={!!closeGuard} onOpenChange={(o) => !o && settleCloseGuard("cancel")}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Save changes?</DialogTitle>
            <DialogDescription>
              <span className="font-medium text-foreground">{closeGuard?.name}</span> has unsaved
              changes. Save them before closing?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => settleCloseGuard("cancel")}>
              Cancel
            </Button>
            <Button variant="outline" onClick={() => settleCloseGuard("discard")}>
              Don't save
            </Button>
            <Button onClick={() => settleCloseGuard("save")} autoFocus>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Picker shown when a bare filename clicked in the terminal matched more than one file. */}
      <Dialog open={!!filePicker} onOpenChange={(o) => !o && setFilePicker(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="truncate">Open “{filePicker?.name}”</DialogTitle>
            <DialogDescription>
              {filePicker?.matches.length} files match under the working directory — pick one.
            </DialogDescription>
          </DialogHeader>
          <div className="-mx-1 max-h-80 overflow-auto">
            {filePicker?.matches.map((rel) => (
              <button
                key={rel}
                onClick={() => {
                  openInFiles(rel);
                  setFilePicker(null);
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                title={rel}
              >
                <FileText className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{rel}</span>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * "Forked from <parent>" badge for a session that branched another one's conversation. Clickable
 * while the parent is still listed; once it's closed and forgotten there's nothing to navigate to,
 * so it degrades to the plain name recorded at fork time.
 */
function ForkedFrom({
  parent,
  name,
  onOpen,
}: {
  parent?: SessionInfo | null;
  name: string | null;
  onOpen: (id: string) => void;
}) {
  const label = parent?.name ?? name;
  if (!label) return null;

  const content = (
    <>
      <GitFork className="size-3 shrink-0" />
      <span className="max-w-[8rem] truncate sm:max-w-[12rem]">{label}</span>
    </>
  );

  if (!parent)
    return (
      <span
        className={cn(badgeVariants({ variant: "outline" }), "min-w-0 shrink gap-1 text-muted-foreground")}
        title={`Forked from “${label}”, which is no longer in the session list`}
      >
        {content}
      </span>
    );

  return (
    <button
      type="button"
      onClick={() => onOpen(parent.id)}
      className={cn(badgeVariants({ variant: "outline" }), "min-w-0 shrink gap-1 transition-colors hover:bg-accent")}
      title={`Forked from “${label}” — click to open it`}
    >
      {content}
    </button>
  );
}

// The "i" popup holding the session details that used to crowd the header line (pid, model, …).
function SessionInfoPopover({ session, nowTick }: { session: SessionInfo; nowTick: number }) {
  const [open, setOpen] = useState(false);
  const ref = useDismissable(open, useCallback(() => setOpen(false), []));

  return (
    <div ref={ref} className="relative flex shrink-0 items-center">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Session info"
        aria-expanded={open}
        className={cn(
          "text-muted-foreground transition-colors hover:text-foreground",
          open && "text-foreground"
        )}
      >
        <Info className="size-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-md popover-edge bg-popover p-3 text-popover-foreground shadow-md">
          <SessionInfoList session={session} nowTick={nowTick} />
        </div>
      )}
    </div>
  );
}

function SessionInfoList({ session, nowTick }: { session: SessionInfo; nowTick: number }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
      <InfoRow label="State">{session.state}</InfoRow>
      <InfoRow label="PID">
        {session.processId}
        {/* Survived a restart of the app: still the original process, re-attached rather than
            relaunched, so whatever it was in the middle of is intact. */}
        {session.adopted && (
          <span className="text-muted-foreground"> · re-attached after an app restart</span>
        )}
      </InfoRow>
      {session.model && <InfoRow label="Model">{session.model}</InfoRow>}
      {session.permissionMode && <InfoRow label="Permissions">{session.permissionMode}</InfoRow>}
      <InfoRow label="Remote Control">{session.remoteControl ? "on" : "off"}</InfoRow>
      <InfoRow label="Watchdog">{session.watchdogEnabled ? "on" : "off"}</InfoRow>
      <InfoRow label="Started">{new Date(session.createdAt).toLocaleString()}</InfoRow>
      {session.state === "Running" && (
        <InfoRow label="Uptime">{formatUptime(nowTick - new Date(session.createdAt).getTime())}</InfoRow>
      )}
      <InfoRow label="Folder">{session.workingDirectory}</InfoRow>
      <InfoRow label="Session id">{session.id}</InfoRow>
    </dl>
  );
}

/**
 * Phone-sized replacement for the header's right-hand cluster: one "⋯" button holding uptime, the
 * RC link, the watchdog toggle, continue, stop and the full info list. Everything the wide header
 * shows inline lives here, so the title row can spend its width on the session name and folder.
 */
function SessionActionsMenu({
  session,
  nowTick,
  wdEnabled,
  onToggleWatchdog,
  onContinue,
  onFork,
  onStop,
  stopping,
}: {
  session: SessionInfo;
  nowTick: number;
  wdEnabled: boolean;
  onToggleWatchdog: () => void;
  onContinue: () => void;
  onFork: () => void;
  onStop: () => void;
  stopping: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismissable(open, useCallback(() => setOpen(false), []));
  const running = session.state === "Running";

  return (
    <div ref={ref} className="relative flex shrink-0 items-center md:hidden">
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="Session actions"
      >
        <MoreVertical className="size-5" />
      </Button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-72 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-md popover-edge bg-popover text-popover-foreground shadow-md">
          {running && (
            <div className="border-b px-3 py-2 font-mono text-[11px] text-muted-foreground">
              up {formatUptime(nowTick - new Date(session.createdAt).getTime())}
            </div>
          )}
          <div className="flex flex-col py-1">
            {session.remoteControl && running && (
              <a
                href={session.remoteUrl ?? "https://claude.ai/code"}
                target="_blank"
                rel="noreferrer"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 px-3 py-2 text-sm text-emerald-600 hover:bg-accent dark:text-emerald-500"
              >
                <Radio className="size-4" /> Open in Claude Code app
              </a>
            )}
            {running && (
              <>
                <MenuItem
                  onClick={() => {
                    onToggleWatchdog();
                    setOpen(false);
                  }}
                >
                  {wdEnabled ? (
                    <ShieldCheck className="size-4 text-emerald-600 dark:text-emerald-500" />
                  ) : (
                    <ShieldOff className="size-4 text-muted-foreground" />
                  )}
                  Hang watchdog: {wdEnabled ? "on" : "off"}
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    onContinue();
                    setOpen(false);
                  }}
                >
                  <Play className="size-4" /> Send “continue”
                </MenuItem>
              </>
            )}
            {session.canFork && (
              <MenuItem
                onClick={() => {
                  onFork();
                  setOpen(false);
                }}
              >
                <GitFork className="size-4" /> Fork session…
              </MenuItem>
            )}
            <MenuItem
              destructive
              disabled={stopping}
              onClick={() => {
                onStop();
                setOpen(false);
              }}
            >
              {stopping ? <Loader2 className="size-4 animate-spin" /> : <Square className="size-4" />}
              {running ? "Stop session" : "Close session"}
            </MenuItem>
          </div>
          <div className="max-h-64 overflow-auto border-t p-3">
            <SessionInfoList session={session} nowTick={nowTick} />
          </div>
        </div>
      )}
    </div>
  );
}

function MenuItem({
  onClick,
  destructive,
  disabled,
  children,
}: {
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent disabled:opacity-50",
        destructive && "text-destructive"
      )}
    >
      {children}
    </button>
  );
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="whitespace-nowrap text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all font-mono">{children}</dd>
    </>
  );
}

function ViewTab({
  active,
  onClick,
  className,
  children,
}: {
  active: boolean;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-full items-center gap-1.5 border-b-2 px-3 text-sm font-medium transition-colors",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
        className
      )}
    >
      {children}
    </button>
  );
}
