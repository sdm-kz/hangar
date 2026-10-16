import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { FileEntry, GitStatus, Project, SessionInfo, SessionLink, SessionPull } from "@/types";
import { api } from "@/lib/api";
import { useConfirm } from "@/components/ui/confirm";
import { patchUrlState, readUrlState, type TabName } from "@/lib/urlState";
import {
  flushSessionUi,
  loadSessionUi,
  noteSessionUiRev,
  saveSessionUi,
  subscribeSessionUi,
  syncSessionUi,
} from "@/lib/sessionUi";
import { EXPLORER_GUARD, fileEntryFromPath, useFileTabs, type FileTabs } from "@/lib/useFileTabs";
import { linkTabLabel, MAX_LINKS, useSessionLinks } from "@/lib/sessionLinks";
import { parsePullKey, pullKey, useSessionPulls } from "@/lib/sessionPulls";
import { connectionTarget, MAX_REMOTES, remoteTabLabel, useSessionRemotes } from "@/lib/sessionRemotes";
import { clearFileClip, getFileClip } from "@/lib/fileClipboard";
import { useShells } from "@/lib/useShells";
import {
  activateRef,
  applyPreset,
  CLAUDE,
  FILES,
  fileRef,
  findGroup,
  groupOf,
  groupsOf,
  linkRef,
  moveRef,
  paneArg,
  paneKind,
  placeRef,
  pullRef,
  reconcile,
  remoteRef,
  revealRef,
  shellRef,
  singleLayout,
  splitGroup,
  splitLayout,
  type PaneGroup,
  type PaneKind,
  type PaneLayout,
  type PaneRef,
} from "@/lib/layout";
import { useSessionLayout, visibleRefs } from "@/lib/useSessionLayout";
import { fileKind } from "@/lib/fileKind";
import { STATUS_COLOR } from "@/lib/gitStatusColor";
import { BranchBadge } from "./BranchBadge";
import { FileBrowser, type FileBrowserHandle } from "./FileBrowser";
import { LinkDialog } from "./LinkDialog";
import { LinkIcon } from "./LinkIcon";
import { PullRequestView } from "./PullRequestView";
import { PullPicker } from "./PullTabStrip";
import { shellIcon, shellTabLabel } from "./ShellTabStrip";
import type { ShellFocus } from "./ShellView";
import { WebLinkView } from "./WebLinkView";
import { RemoteFilesView } from "./RemoteFilesView";
import { RemoteConnectDialog } from "./RemoteConnect";
import { TerminalPane, type TerminalPaneHandle } from "./TerminalPane";
import { PostponedPool } from "./PostponedPool";
import { HeadingActivityMark, type Activity } from "./ActivityMark";
import { shellMark, shellMarkLabel, useShownShellsSeen, type ShellActivity } from "@/lib/shellActivity";
import { RenameField } from "./RenameField";
import { PaneGroups, type DropZone, type PaneTab } from "./PaneGroups";
import { GroupAddMenu } from "./GroupAddMenu";
import { LayoutMenu } from "./LayoutMenu";
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
import {
  Check,
  Copy,
  File as FileIcon,
  FileText,
  FolderTree,
  GitFork,
  GitPullRequest,
  Image as ImageIcon,
  Info,
  Loader2,
  Menu,
  MoreVertical,
  Pencil,
  Play,
  Radio,
  RotateCcw,
  Server,
  ShieldCheck,
  ShieldOff,
  Square,
  SquareArrowOutUpRight,
  TerminalSquare,
  Video,
} from "lucide-react";
import { MobileSessionsProgress, ShowSidebarButton } from "@/components/ShowSidebarButton";
import { writeToClipboard } from "@/lib/clipboard";

// Wide enough for groups side by side — the width the app has always switched to its desktop
// layout at. Narrower, the groups fold into a single strip and one of them is drawn.
const WIDE_QUERY = "(min-width: 48rem)";

function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(WIDE_QUERY);
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

/**
 * The layout for a session that has none saved yet, built from how it was last seen before the pane
 * could be split into groups: the one surface its `view` named, or — for the old Split view — the
 * terminal and the files in two groups, arranged the way that split was.
 */
function legacyLayout(sessionId: string, present: PaneRef[]): PaneLayout {
  const ui = loadSessionUi(sessionId);
  const url = readUrlState();
  const view: TabName = (url.session === sessionId && url.tab) || ui.view || "terminal";
  // The shells are fetched from the server and are not in `present` yet; a shell the session was
  // showing is kept in the layout until they arrive and say whether it is still there.
  const tabs = view === "shell" && ui.shell && !present.includes(shellRef(ui.shell)) ? [...present, shellRef(ui.shell)] : present;
  if (view === "split") {
    const files = tabs.filter((r) => r === FILES || paneKind(r) === "file");
    const rest = tabs.filter((r) => !files.includes(r));
    const terminal = { tabs: rest, active: CLAUDE };
    const side = { tabs: files, active: FILES };
    let atBottom = false;
    try {
      atBottom = localStorage.getItem("claudeweb.splitSide") === "bottom";
    } catch {
      /* storage disabled — side by side, as it defaulted to */
    }
    return atBottom ? splitLayout("col", [side, terminal], [0.4, 0.6], 1) : splitLayout("row", [terminal, side], [0.6, 0.4]);
  }
  const active: Record<TabName, PaneRef | null> = {
    terminal: CLAUDE,
    split: CLAUDE,
    files: FILES,
    file: ui.file ? fileRef(ui.file) : FILES,
    shell: ui.shell ? shellRef(ui.shell) : CLAUDE,
    link: ui.link ? linkRef(ui.link) : CLAUDE,
    pull: ui.pull ? pullRef(String(ui.pull)) : CLAUDE,
  };
  return singleLayout(tabs, active[view] ?? CLAUDE);
}

/**
 * Show a file that has just been opened, in the group it was meant for. A group whose explorer is
 * showing keeps it: the explorer previews the file beside its tree, which is what opening one from
 * the tree has always done.
 */
function revealFileIn(l: PaneLayout, ref: PaneRef, target: string): PaneLayout {
  let g = groupOf(l, ref);
  if (!g) return l;
  if (g.id !== target && findGroup(l, target)) {
    l = placeRef(l, ref, target);
    g = groupOf(l, ref)!;
  }
  return g.active === FILES ? l : activateRef(l, ref);
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

/**
 * What fills the terminal's place in a closed session: no process, no socket, and one button that
 * brings both back. The rest of the session — its files, its diff, its reviews, and a fresh shell in
 * the folder it worked in — is reachable from the tabs above without any of that, which is the whole
 * point of being able to open a closed session at all; this says so, so the missing terminal reads as
 * a state and not a fault. Not its old shell tabs, though: those went with the process it was stopped
 * with, so this says what is there rather than promising the session back whole.
 */
function ClosedTerminal({
  session,
  onReopen,
  onReopenWithOptions,
}: {
  session: SessionInfo;
  onReopen: () => void;
  onReopenWithOptions: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <TerminalSquare className="size-6" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">This session is closed</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          Nothing is running in{" "}
          <span className="font-mono">{session.workingDirectory}</span>. Its files and git history are
          in the tabs above, and a shell still opens in that folder — reopen the session to get the
          terminal back.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button onClick={onReopen} className="gap-2">
          <Play className="size-4" />
          Reopen session
        </Button>
        {/* The same relaunch, through the create dialog: the model, the permission mode and the
            prompt are all adjustable there before anything starts. Second, and quieter, because
            most reopens want the session back exactly as it was. */}
        <Button variant="outline" onClick={onReopenWithOptions} className="gap-2">
          <Pencil className="size-4" />
          Reopen with options…
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Resumes{" "}
        {session.resumeExact ? (
          <>
            this exact conversation (<span className="font-mono">--resume</span>)
          </>
        ) : (
          <>
            the folder&rsquo;s most recent conversation (<span className="font-mono">--continue</span>)
          </>
        )}
      </p>
    </div>
  );
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
  activity = null,
  activityLabel,
  onTerminalShown,
  parent,
  shellsRev,
  revealShell,
  onShellRevealed,
  shellActivity,
  shellsSeen,
  onShellSeen,
  onFork,
  onSelectSession,
  onToggleSidebar,
  collapsed,
  onToggleCollapsed,
  onStopped,
  onReopen,
  onReopenWithOptions,
  onRename,
  onTerminalRename,
  onTerminalColor,
  onOpenServerFile,
  project = null,
  onProjectsChange,
}: {
  session: SessionInfo;
  // Whether Claude is currently working in this session (from the live /hub/events busy set).
  busy?: boolean;
  // This session's activity mark, as its row in the sidebar wears it, and what it says -- drawn on the
  // Terminal tab, so a terminal tucked behind a pull request or a file still says what it is doing.
  activity?: Activity | null;
  activityLabel?: string;
  // Whether Claude's terminal is on screen right now -- the active tab of a group that is showing --
  // reported up so a finished turn only counts as seen once its terminal has actually been looked at.
  onTerminalShown?: (id: string, shown: boolean) => void;
  // The session this one was forked from, when it's still around — null once it's been closed and
  // forgotten, in which case the header falls back to the name recorded at fork time.
  parent?: SessionInfo | null;
  // The server's shell-set revision, pushed on the events hub. When it moves, this session re-reads
  // its own shell tabs — that is how a shell opened (or closed) on another device shows up here.
  shellsRev?: number;
  // One of this session's shells to bring forward once its tab exists (picked in the Shells tab).
  revealShell?: ShellFocus | null;
  onShellRevealed?: () => void;
  // What the commands in every session shell are doing (the hub's snapshot), which finished ones this
  // browser has looked at, and how to say it has looked at another.
  shellActivity?: Record<string, ShellActivity> | null;
  shellsSeen?: Record<string, number>;
  onShellSeen?: (id: string, endedAt: number) => void;
  onFork: (s: SessionInfo) => void;
  onSelectSession: (id: string) => void; // used by the "forked from" link to jump to the parent
  onToggleSidebar: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** The session was closed and stays in the list — the row it should be replaced with. */
  onStopped: (session: SessionInfo) => void;
  /** Relaunch a closed session, resuming its conversation. Confirmed by the caller. */
  onReopen: () => void;
  /** The same, through the create dialog, so the launch can be adjusted before it starts. */
  onReopenWithOptions: () => void;
  onRename: (id: string, name: string) => void;
  // Apply a rename detected in this session's terminal (Claude's /rename confirmation).
  onTerminalRename?: (id: string, name: string) => void;
  // Apply a color detected in this session's terminal (Claude's /color confirmation).
  onTerminalColor?: (id: string, color: string) => void;
  // Open any file on the server in the app's own file viewer -- where a path clicked in the terminal
  // goes when it is outside this session's folder, which its Files panel can't show.
  onOpenServerFile?: (absolutePath: string) => void;
  // The project this session's folder belongs to: its saved SSH connections are offered when a remote
  // files tab is opened, and a new one can be saved there.
  project?: Project | null;
  onProjectsChange?: (projects: Project[]) => void;
}) {
  const confirm = useConfirm();
  // Closed: the session is a row and a folder, with no process behind either. Everything reading the
  // folder works as it always did; what needs something to talk to — the terminal, the watchdog,
  // "continue", stopping — is out, and the Reopen button stands where the terminal would be.
  const closed = session.state === "Restorable";
  const terminalRef = useRef<TerminalPaneHandle>(null);
  const [stopping, setStopping] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const wide = useWide();
  // The files this session has open. Each is a tab in whichever group of the pane holds it.
  const { fileTabs, closeGuard, settleCloseGuard } = useFileTabs(session.id);
  const [copiedPath, setCopiedPath] = useState(false);
  // Optimistic mirror of the watchdog toggle so it flips instantly, then syncs from the session poll.
  const [wdEnabled, setWdEnabled] = useState(session.watchdogEnabled);
  const [nowTick, setNowTick] = useState(() => Date.now()); // ticks so the header uptime stays live
  const fileBrowserRef = useRef<FileBrowserHandle>(null);
  // Each shell's terminal, so a group taking focus from the keyboard can put the keys into it.
  const shellHandles = useRef(new Map<string, TerminalPaneHandle>());
  // Candidates when a bare filename clicked in the terminal matched more than one file.
  const [filePicker, setFilePicker] = useState<{ name: string; matches: string[] } | null>(null);
  // The session's shell tabs — a real shell in its working folder, beside the Claude terminal. The
  // hook owns the server-side list; this view only decides what to do with it.
  const shells = useShells({
    owner: { sessionId: session.id, workingDirectory: session.workingDirectory },
    shellsRev,
    initialActive: () => loadSessionUi(session.id).shell ?? null,
    // A click is a choice worth remembering, and the bag is shared, so it follows to every device.
    onActivate: (id) => saveSessionUi(session.id, { shell: id }),
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

  // The pull requests this session has open as tabs. Like the links they live in the session's UI
  // bag, so a review follows the session to every device; unlike them, what is drawn under the tab
  // is fetched from GitHub each time it is opened.
  const pulls = useSessionPulls(session.id);

  // Remote files tabs (SSH). Like the links, the list lives in the session's UI bag; the connection
  // behind each one is held by the server, in memory, under the tab's id.
  const remotes = useSessionRemotes(session.id);
  const [remoteDialog, setRemoteDialog] = useState(false);
  const remoteTarget = useRef<string | null>(null);

  // ---- The pane's layout ------------------------------------------------------------------------
  // Every tab the session has, in the order a single group lists them: the two that always exist,
  // then the reviews, the files, the shells and the pages.
  const present = useMemo<PaneRef[]>(
    () => [
      CLAUDE,
      FILES,
      ...pulls.pulls.map((p) => pullRef(pullKey(p))),
      ...fileTabs.tabs.map((t) => fileRef(t.path)),
      ...shells.shells.map((s) => shellRef(s.id)),
      ...links.links.map((l) => linkRef(l.id)),
      ...remotes.remotes.map((r) => remoteRef(r.id)),
    ],
    [pulls.pulls, fileTabs.tabs, shells.shells, links.links, remotes.remotes]
  );

  const { layout, update, current, seedTick, seeded } = useSessionLayout(session.id, () =>
    legacyLayout(session.id, present)
  );
  const groups = groupsOf(layout.root);

  // A shell tab on screen is how its finished command gets seen (see useShownShellsSeen).
  useShownShellsSeen(
    groups
      .map((g) => g.active)
      .filter((ref): ref is PaneRef => !!ref && paneKind(ref) === "shell")
      .map((ref) => paneArg(ref)),
    shellActivity,
    shellsSeen,
    onShellSeen
  );

  // Groups in the order they last had focus: a file opened from the tree or the terminal goes to the
  // group most recently used for reading files.
  const mru = useRef<string[]>([]);
  useEffect(() => {
    mru.current = [layout.active, ...mru.current.filter((id) => id !== layout.active)].slice(0, 8);
  }, [layout.active]);
  const wideRef = useRef(wide);
  wideRef.current = wide;

  /**
   * The group a file being opened should land in: the focused group if it is showing a file, else
   * the one that showed one most recently, else wherever the explorer is. Narrow, only the focused
   * group is on screen, so that is where it goes.
   */
  const fileTarget = useCallback((l: PaneLayout): string => {
    if (!wideRef.current) return l.active;
    const gs = groupsOf(l.root);
    const showsFile = (g?: PaneGroup) => !!g?.active && paneKind(g.active) === "file";
    const focused = gs.find((g) => g.id === l.active);
    if (focused && showsFile(focused)) return focused.id;
    for (const id of mru.current) {
      const g = gs.find((x) => x.id === id);
      if (g && showsFile(g)) return g.id;
    }
    return gs.find(showsFile)?.id ?? groupOf(l, FILES)?.id ?? l.active;
  }, []);

  // A tab about to be created from a group's "+" (a shell, a page, a review) lands in that group and
  // is shown there. Anything that appears without one (another device opened it) goes to the
  // focused group, behind whatever it is showing.
  const pending = useRef<{ kind: PaneKind; group: string; at: number } | null>(null);
  const expect = useCallback((kind: PaneKind, group: string) => {
    pending.current = { kind, group, at: Date.now() };
  }, []);
  // A file just opened from the tree or the terminal, to be shown once its tab exists.
  // Stamped, so one whose open was cancelled at a save prompt cannot fire on a later, unrelated open.
  const pendingReveal = useRef<{ ref: PaneRef; target: string; at: number } | null>(null);
  // The active file, where the placement below can read it: a file tab that arrives already active
  // was opened by something that meant it to be seen — the self-open API, another device.
  const activePathRef = useRef(fileTabs.activePath);
  activePathRef.current = fileTabs.activePath;
  // The same, for a review: one that arrives already active was opened to be looked at.
  const activePullRef = useRef(pulls.activeKey);
  activePullRef.current = pulls.activeKey;

  // Keep the layout in step with the tabs: place what appeared, drop what went away.
  const presentKey = present.join("\n");
  useEffect(() => {
    update((l) => {
      let next = reconcile(
        l,
        present,
        (kind) => kind !== "shell" || shells.loaded,
        (cur, ref) => {
          const p = pending.current;
          if (p && p.kind === paneKind(ref) && Date.now() - p.at < 15_000 && findGroup(cur, p.group)) {
            pending.current = null;
            return { group: p.group, activate: true };
          }
          if (paneKind(ref) === "file") {
            const group = fileTarget(cur);
            // Shown, unless the explorer is showing there: it previews the active file already.
            const activate = paneArg(ref) === activePathRef.current && findGroup(cur, group)?.active !== FILES;
            return { group, activate };
          }
          if (paneKind(ref) === "pull" && paneArg(ref) === activePullRef.current) {
            // Where reviews are being read, if one is on screen; else where files are.
            const showsPull = (g?: PaneGroup) => !!g?.active && paneKind(g.active) === "pull";
            const gs = groupsOf(cur.root);
            const focused = gs.find((g) => g.id === cur.active);
            const group = (showsPull(focused) ? focused : gs.find(showsPull))?.id ?? fileTarget(cur);
            return { group, activate: true };
          }
          return { group: cur.active, activate: false };
        }
      );
      const r = pendingReveal.current;
      if (r && Date.now() - r.at > 10_000) pendingReveal.current = null;
      else if (r && groupOf(next, r.ref)) {
        pendingReveal.current = null;
        next = revealFileIn(next, r.ref, r.target);
      }
      return next;
      // Not saved until the server's copy has been seen: a first look from a new device would
      // otherwise write its own guess over the arrangement another device left.
    }, seeded());
    // `present` is read through its key: a new array holding the same tabs is not a change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presentKey, shells.loaded, seedTick, update, fileTarget, seeded]);

  // What is on screen, and what has been at least once. Pages and reviews stay mounted behind the
  // other tabs after their first showing (a frame keeps its place, a review its folds), and so does
  // the explorer. A file preview is only mounted while it shows.
  const visible = useMemo(() => new Set(visibleRefs(layout, wide)), [layout, wide]);
  const terminalShown = visible.has(CLAUDE);
  const onTerminalShownRef = useRef(onTerminalShown);
  onTerminalShownRef.current = onTerminalShown;
  useEffect(() => {
    onTerminalShownRef.current?.(session.id, terminalShown);
  }, [session.id, terminalShown]);
  // Gone with the view: whatever replaces it reports for itself.
  useEffect(() => () => onTerminalShownRef.current?.(session.id, false), [session.id]);
  const [everShown, setEverShown] = useState<ReadonlySet<PaneRef>>(() => new Set());
  useEffect(() => {
    setEverShown((prev) => {
      const add = [...visible].filter((r) => !prev.has(r));
      return add.length ? new Set([...prev, ...add]) : prev;
    });
  }, [visible]);
  const kept = (r: PaneRef) => visible.has(r) || everShown.has(r);

  // The explorer drops its own preview while a file is showing in another group beside it: the
  // files it opens go there, the way an IDE's explorer sits beside its editors.
  const explorerGroup = groupOf(layout, FILES)?.id;
  // Not while its own preview holds edits, though — dropping the preview would drop them.
  const explorerTreeOnly =
    wide &&
    !fileTabs.dirty.has(EXPLORER_GUARD) &&
    [...visible].some((r) => paneKind(r) === "file" && groupOf(layout, r)?.id !== explorerGroup);

  // The focused group's tab. A shell there owns what is pasted (see TerminalPane's imagePaste).
  const focusedRef = findGroup(layout, layout.active)?.active ?? null;

  /** Open a file (from the tree, a terminal link, the picker) and show it where files are read. */
  const openFile = useCallback(
    async (f: FileEntry, pin: boolean) => {
      const ref = fileRef(f.path);
      const l0 = current();
      const target = groupOf(l0, ref)?.id ?? fileTarget(l0);
      const existed = fileTabs.tabs.some((t) => t.path === f.path);
      await fileTabs.open(f, pin);
      if (existed) update((l) => revealFileIn(l, ref, target));
      else pendingReveal.current = { ref, target, at: Date.now() };
    },
    [current, fileTarget, fileTabs, update]
  );
  // The tab api the file browsers get: the same, except that opening a file also shows it.
  const paneTabs = useMemo<FileTabs>(() => ({ ...fileTabs, open: openFile }), [fileTabs, openFile]);

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

  const copyPath = useCallback(async () => {
    await writeToClipboard(session.workingDirectory);
    setCopiedPath(true);
    setTimeout(() => setCopiedPath(false), 1500);
  }, [session.workingDirectory]);

  // Open a working-tree-relative file. With the explorer mounted, reveal it there: that also expands
  // the tree down to it, and opens it the way a click in the tree does. Otherwise open the tab
  // directly; the saved `file` is written first so the tree expands to it when the explorer mounts.
  const openInFiles = useCallback(
    (rel: string) => {
      if (fileBrowserRef.current) {
        fileBrowserRef.current.revealFile(rel);
        return;
      }
      saveSessionUi(session.id, { file: rel });
      void openFile(fileEntryFromPath(rel), false);
    },
    [session.id, openFile]
  );

  // A full file path clicked in the terminal: under the working directory it opens in this session's
  // Files panel, as a tab beside the terminal. Anywhere else -- another drive, a OneDrive folder, a
  // sibling repo -- the panel can't show it, so it opens in the app's own file viewer instead, the one
  // a file picked in the sidebar's Files tab opens in; closing that comes back here.
  const onTerminalOpenFile = useCallback(
    (absolutePath: string) => {
      const rel = toWorkingDirRelative(session.workingDirectory, absolutePath);
      if (rel) openInFiles(rel);
      else onOpenServerFile?.(absolutePath);
    },
    [session.workingDirectory, openInFiles, onOpenServerFile]
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

  // `?tab=` named the one surface the pane showed; with groups there is no such thing. It is read
  // once, for a session with no layout yet (see legacyLayout), and cleared so it is not carried on.
  useEffect(() => patchUrlState({ tab: undefined }), []);

  // Leaving the session (this view is keyed by it) hands over whatever this browser still owes the
  // server, so the next device sees it.
  useEffect(() => () => flushSessionUi(session.id), [session.id]);

  // The saved state lives on the server, so opening a session fetches it: this device may never have
  // seen the session, or may have last seen it before another one moved things around.
  useEffect(() => {
    void syncSessionUi(session.id, true);
  }, [session.id]);

  // A revision on the session list higher than the one this browser holds means another browser
  // wrote — re-fetch (the tabs follow through their hooks' own subscriptions).
  useEffect(() => {
    noteSessionUiRev(session.id, session.uiRev);
  }, [session.id, session.uiRev]);

  // Which shell the saved state names is handled by useShells, which reconciles the remembered id
  // against what the server actually has. `restore`, not `activate`: adopting a value that came FROM
  // the bag must not write it back.
  useEffect(
    () =>
      subscribeSessionUi(session.id, (seed) => {
        if (!seed) return;
        const ui = loadSessionUi(session.id);
        if (ui.shell) shells.restore(ui.shell);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.id]
  );

  // ---- Tab actions ------------------------------------------------------------------------------

  /** A tab clicked: show it in its group, focus the group, and tell the tab's own hook. */
  const activateTab = useCallback(
    async (ref: PaneRef) => {
      update((l) => revealRef(l, ref));
      const arg = paneArg(ref);
      const kind = paneKind(ref);
      if (kind === "file") void fileTabs.activate(arg);
      else if (kind === "shell") shells.activate(arg);
      else if (kind === "link") links.activate(arg);
      else if (kind === "pull") pulls.activate(arg);
    },
    // The hooks' callbacks are stable; the handles themselves are fresh objects every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [update, fileTabs.activate, shells.activate, links.activate, pulls.activate]
  );

  // A shell picked in the Shells tab: shown, as a click on its tab would, once the layout has placed
  // it — on a fresh view that is a beat after the shell list arrives. Once per request, so a later
  // click elsewhere is not dragged back to it.
  const revealed = useRef<ShellFocus | null>(null);
  const onShellRevealedRef = useRef(onShellRevealed);
  onShellRevealedRef.current = onShellRevealed;
  useEffect(() => {
    if (!revealShell || revealed.current === revealShell) return;
    const ref = shellRef(revealShell.id);
    if (!groupOf(layout, ref)) return;
    revealed.current = revealShell;
    void activateTab(ref);
    onShellRevealedRef.current?.();
  }, [revealShell, layout, activateTab]);

  const closeTab = useCallback(
    (ref: PaneRef) => {
      const arg = paneArg(ref);
      const kind = paneKind(ref);
      if (kind === "file") void fileTabs.close(arg);
      else if (kind === "shell") void shells.close(arg);
      else if (kind === "link") links.remove(arg);
      else if (kind === "pull") pulls.close(arg);
      else if (kind === "remote") {
        // Closing the tab ends the connection: the server forgets it, password and all — and
        // anything copied in it, which nothing could paste any more.
        remotes.remove(arg);
        const clip = getFileClip();
        if (clip?.source.kind === "remote" && clip.source.tab === arg) clearFileClip();
        void api.remoteDisconnect(arg).catch(() => {});
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fileTabs.close, shells.close, links.remove, pulls.close, remotes.remove]
  );

  /** A tab dropped on a group: its middle to move there, an edge to split it off beside it. */
  const dropTab = useCallback(
    (ref: PaneRef, groupId: string, zone: DropZone, index?: number) => {
      if (zone === "center") {
        update((l) => moveRef(l, ref, groupId, index));
        return;
      }
      // A group's only tab split off its own edge: there is nothing to leave behind, so what opens
      // beside it is an empty group, waiting for something to be dropped or opened in it.
      const g = findGroup(current(), groupId);
      const alone = !!g && g.tabs.length === 1 && g.tabs[0] === ref;
      update((l) => splitGroup(l, groupId, zone, alone ? null : ref));
    },
    [update, current]
  );

  const focusContent = useCallback((ref: PaneRef) => {
    // After the group is drawn: the keys go nowhere while it is still hidden.
    requestAnimationFrame(() => {
      if (ref === CLAUDE) terminalRef.current?.focus();
      else if (paneKind(ref) === "shell") shellHandles.current.get(paneArg(ref))?.focus();
    });
  }, []);

  // Opening from a group's "+": the new tab is expected there.
  const openShell = useCallback(
    (shell: string, group: string) => {
      expect("shell", group);
      void shells.open(shell);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [expect, shells.open]
  );

  const linkTarget = useRef<string | null>(null);
  // The "+" menu's "Pull request…" opens the picker of the same group: which group, and a count that
  // moves on every ask so asking twice opens it twice.
  const [pullAsk, setPullAsk] = useState<{ group: string; n: number }>({ group: "", n: 0 });
  // Pinning a page shows it straight away — adding it is asking to look at it. Re-pinning one already
  // on the bar goes back to its tab instead, wherever that is.
  const addLink = useCallback(
    (l: Omit<SessionLink, "id">) => {
      const had = links.links.some((x) => x.url === l.url);
      if (!had) expect("link", linkTarget.current ?? current().active);
      const stored = links.add(l);
      if (had) update((x) => revealRef(x, linkRef(stored.id)));
    },
    [links, expect, current, update]
  );

  // A remote tab appears only once its connection is up (the dialog connects before it closes), and
  // shows straight away in the group whose "+" asked for it.
  const addRemote = useCallback(
    (tabId: string, connection: Parameters<typeof remotes.add>[0]) => {
      expect("remote", remoteTarget.current ?? current().active);
      remotes.add(connection, tabId);
    },
    [remotes, expect, current]
  );

  // Opening a review from a group's picker: the same, for a PR.
  const openPull = useCallback(
    (pull: SessionPull, group: string) => {
      const key = pullKey(pull);
      const had = pulls.pulls.some((p) => pullKey(p) === key);
      if (!had) expect("pull", group);
      pulls.open(pull);
      if (had) update((l) => revealRef(l, pullRef(key)));
    },
    [pulls, expect, update]
  );

  const [git, setGit] = useState<GitStatus | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const bump = useCallback(() => setRefreshToken((t) => t + 1), []);
  const loadGit = useCallback(() => {
    api.gitStatus(session.id).then(setGit).catch(() => setGit(null));
  }, [session.id]);
  const onRefresh = useCallback(() => {
    bump();
    loadGit();
  }, [bump, loadGit]);

  // Auto-refresh: poll the working dir's change counter; when it moves, reload tree + git.
  //
  // The counter belongs to a live session's folder watcher, so a closed session has none to ask for
  // — and nothing is writing in there on its behalf anyway. It reads its folder once, on arrival,
  // and the refresh button covers anything that changes it from outside.
  useEffect(() => {
    setGit(null);
    loadGit();
    if (closed) return;
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
  }, [session.id, closed, loadGit, bump]);

  // The worktree whose branch the header's badge names (see BranchBadge); "" = the session's own
  // folder. It is the session's, not this browser's, so it follows a pick made anywhere -- another
  // browser, or the session itself through /api/self/worktree.
  const [gitRoot, setGitRoot] = useState(() => loadSessionUi(session.id).gitWorktree ?? "");
  useEffect(() => {
    const read = () => setGitRoot(loadSessionUi(session.id).gitWorktree ?? "");
    read();
    return subscribeSessionUi(session.id, read);
  }, [session.id]);

  // That worktree's status. Its folder isn't the one the session's watcher follows, so on top of the
  // refreshes the session's own folder triggers it is polled, slowly, while the session runs.
  const [rootGit, setRootGit] = useState<GitStatus | null>(null);
  useEffect(() => {
    setRootGit(null);
    if (!gitRoot) return;
    let stopped = false;
    const load = () =>
      api.gitStatus(session.id, gitRoot)
        .then((st) => !stopped && setRootGit(st))
        .catch(() => !stopped && setRootGit(null));
    load();
    const t = closed ? undefined : setInterval(load, 10_000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [session.id, gitRoot, closed, refreshToken]);

  // What the badge shows: the picked worktree, or the session's own folder when nothing is picked or
  // the pick no longer answers (a worktree removed since).
  const badgeRoot = gitRoot && rootGit?.isRepo ? gitRoot : "";
  const badgeGit = badgeRoot ? rootGit : git;
  const changeCount = badgeGit?.isRepo ? Object.keys(badgeGit.files).length : 0;

  // Open this session's git-changes view (from the header branch badge): the explorer, showing the
  // changes of the root the badge names. A Files panel on screen moves there itself (it guards
  // unsaved edits and leaves a linked folder's tabs behind on the way); one that isn't mounted yet is
  // asked to as soon as it is, so the move goes through that same path rather than around it.
  const [pendingChanges, setPendingChanges] = useState<string | null>(null);
  const openChanges = useCallback(() => {
    saveSessionUi(session.id, { changes: true });
    if (fileBrowserRef.current) fileBrowserRef.current.showChanges(badgeRoot);
    else setPendingChanges(badgeRoot);
    update((l) => revealRef(l, FILES));
  }, [session.id, update, badgeRoot]);
  useEffect(() => {
    if (pendingChanges === null || !fileBrowserRef.current) return;
    fileBrowserRef.current.showChanges(pendingChanges);
    setPendingChanges(null);
  });

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

  const gitFiles = git?.isRepo ? git.files : undefined;

  /** How each tab is drawn in its group's strip; null for one whose tab has already gone. */
  const tabInfo = (ref: PaneRef): PaneTab | null => {
    const label = (text: string, className?: string) => (
      <span className={cn("max-w-[10rem] truncate", className)}>{text}</span>
    );
    const arg = paneArg(ref);
    switch (paneKind(ref)) {
      case "claude":
        return {
          icon: (
            <span className="relative inline-flex shrink-0">
              <TerminalSquare className="size-4" />
              <HeadingActivityMark activity={activity} label={activityLabel} />
            </span>
          ),
          label: label("Terminal"),
          title: activityLabel ? `Claude's terminal — ${activityLabel}` : "Claude's terminal",
          closable: false,
        };
      case "files":
        return {
          icon: <FolderTree className="size-4 shrink-0" />,
          label: label("Files"),
          title: "The session's files, and its git changes",
          closable: false,
        };
      case "file": {
        const t = fileTabs.tabs.find((x) => x.path === arg);
        if (!t) return null;
        const kind = fileKind(t.name);
        const Icon = kind === "image" ? ImageIcon : kind === "video" ? Video : kind === "binary" ? FileIcon : FileText;
        return {
          icon: <Icon className="size-4 shrink-0" />,
          // The transient preview tab (a single click reuses it) is in italics; double-click keeps it.
          label: label(t.name, cn(t.path === fileTabs.previewPath && "italic", gitFiles?.[t.path] && STATUS_COLOR[gitFiles[t.path]])),
          title: t.path,
          closable: true,
          onDoubleClick: () => fileTabs.pin(t.path),
        };
      }
      case "shell": {
        const s = shells.shells.find((x) => x.id === arg);
        if (!s) return null;
        const Icon = shellIcon(s.kind);
        const a = shellActivity?.[s.id];
        const mark = shellMark(a, shellsSeen?.[s.id]);
        return {
          icon: (
            <span className="relative inline-flex shrink-0">
              <Icon className="size-4" />
              {mark && a && <HeadingActivityMark activity={mark} label={shellMarkLabel(mark, a)} />}
            </span>
          ),
          // A shell whose process has ended keeps its tab (the output is still worth reading) but
          // says so, rather than looking like a live prompt that ignores typing.
          label: label(shellTabLabel(s), cn(!s.running && "line-through opacity-60")),
          title: `${s.label} — ${s.workingDirectory}${s.running ? "" : " (exited)"}${mark && a ? ` — ${shellMarkLabel(mark, a)}` : ""}`,
          closable: true,
        };
      }
      case "link": {
        const l = links.links.find((x) => x.id === arg);
        if (!l) return null;
        return {
          icon: <LinkIcon src={l.icon} className="size-4 shrink-0 rounded-[2px]" />,
          label: (
            <>
              {label(linkTabLabel(l))}
              {!l.embed && <SquareArrowOutUpRight className="size-3 shrink-0 opacity-60" />}
            </>
          ),
          title: `${linkTabLabel(l)} — ${l.url}${l.embed ? "" : " (opens in a browser tab)"}\nDouble-click to edit`,
          closable: true,
          onDoubleClick: () => setLinkDialog({ edit: l }),
        };
      }
      case "remote": {
        const r = remotes.remotes.find((x) => x.id === arg);
        if (!r) return null;
        return {
          icon: <Server className="size-4 shrink-0" />,
          label: label(remoteTabLabel(r)),
          title: `${remoteTabLabel(r)} — ${connectionTarget(r.connection)} (SSH)`,
          closable: true,
        };
      }
      case "pull": {
        const p = pulls.pulls.find((x) => pullKey(x) === arg);
        if (!p) return null;
        return {
          icon: <GitPullRequest className="size-4 shrink-0" />,
          label: (
            <>
              {/* A review of another repo says which: #42 of two repos would otherwise be two tabs
                  reading as one. Nothing is said for the session's own, which is the usual case. */}
              {p.repo && (
                <span className="max-w-[6rem] shrink-0 truncate text-xs text-muted-foreground">
                  {p.repo.split("/")[1] ?? p.repo}
                </span>
              )}
              <span className="shrink-0 text-xs text-muted-foreground">#{p.number}</span>
              {label(p.title)}
            </>
          ),
          title: `${p.repo ? `${p.repo} ` : ""}#${p.number} ${p.title}`,
          closable: true,
        };
      }
    }
  };

  /** What each tab shows. Null leaves it unmounted — not shown yet, or not kept once hidden. */
  const renderContent = (ref: PaneRef): ReactNode | null => {
    const arg = paneArg(ref);
    switch (paneKind(ref)) {
      case "claude":
        // Always mounted, whatever is showing: its socket and its screen outlive any tab switch.
        return (
          // relative: the postponed pool floats over this corner rather than taking a bar under it.
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1">
              {/* A closed session has no pty to attach to: mounting the pane would open a socket
                  against nothing and leave a black rectangle that looks like a terminal failing.
                  What goes there instead says what happened and offers the one way out of it. */}
              {closed ? (
                <ClosedTerminal session={session} onReopen={onReopen} onReopenWithOptions={onReopenWithOptions} />
              ) : (
                <TerminalPane
                  key={session.id}
                  ref={terminalRef}
                  sessionId={session.id}
                  workingDirectory={session.workingDirectory}
                  // A shell has focus: an image pasted there is not Claude's to upload.
                  imagePaste={!focusedRef || paneKind(focusedRef) !== "shell"}
                  cornerTaken
                  onRenameDetected={(name) => onTerminalRename?.(session.id, name)}
                  onColorDetected={(color) => onTerminalColor?.(session.id, color)}
                  onOpenFile={onTerminalOpenFile}
                  onFindFile={onTerminalFindFile}
                />
              )}
            </div>
            {/* Still here when the session is closed: the stash was written for this session and is
                worth reading back, and throwing out a message you are no longer going to send is the
                other half of that. It does not travel — the pool is keyed by session id and a reopen
                mints a new one, which starts empty — so sending is the one thing it stops offering. */}
            <PostponedPool
              sessionId={session.id}
              busy={busy}
              terminalRef={terminalRef}
              closed={closed}
              serverCount={session.postponedCount}
              autoSend={!!session.postponedAutoSend}
            />
          </div>
        );
      case "files":
        if (!kept(ref)) return null;
        return (
          <div className="min-h-0 flex-1">
            <FileBrowser
              ref={fileBrowserRef}
              sessionId={session.id}
              workingDirectory={session.workingDirectory}
              gitFiles={gitFiles}
              tabs={paneTabs}
              treeOnly={explorerTreeOnly}
              onRefresh={onRefresh}
              refreshToken={refreshToken}
            />
          </div>
        );
      case "file":
        // Mounted while it shows — and while it holds unsaved edits, showing or not, so moving,
        // zooming or switching tabs never throws edits away.
        if ((!visible.has(ref) && !fileTabs.dirty.has(arg)) || !fileTabs.tabs.some((t) => t.path === arg)) return null;
        return (
          <div className="min-h-0 flex-1">
            <FileBrowser
              sessionId={session.id}
              workingDirectory={session.workingDirectory}
              gitFiles={gitFiles}
              tabs={paneTabs}
              previewPath={arg}
              onRefresh={onRefresh}
              refreshToken={refreshToken}
            />
          </div>
        );
      case "shell": {
        // Every open shell stays mounted, showing or not: switching away from a build must not drop
        // its socket and stop showing its output. `data-owns-image-paste` keeps the Claude
        // terminal's document-level paste handler out of a shell — an image dropped at a shell
        // prompt is a path nobody asked for.
        const sh = shells.shells.find((s) => s.id === arg);
        if (!sh) return null;
        return (
          <div data-owns-image-paste className="flex min-h-0 min-w-0 flex-1 flex-col">
            <TerminalPane
              ref={(h) => {
                if (h) shellHandles.current.set(sh.id, h);
                else shellHandles.current.delete(sh.id);
              }}
              sessionId={session.id}
              socketPath={`/hub/shells/${sh.id}/terminal`}
              imagePaste={false}
              workingDirectory={sh.workingDirectory}
              onOpenFile={onTerminalOpenFile}
              onFindFile={onTerminalFindFile}
            />
          </div>
        );
      }
      case "link": {
        // A page stays mounted once it has been opened, so returning to it finds it where it was
        // left rather than reloading.
        const l = links.links.find((x) => x.id === arg);
        if (!l || !kept(ref)) return null;
        return (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <WebLinkView link={l} onEdit={() => setLinkDialog({ edit: l })} />
          </div>
        );
      }
      case "remote": {
        // Mounted once opened and kept: the tree, its expanded folders and the preview survive a
        // switch to another tab, the way a pinned page does.
        const r = remotes.remotes.find((x) => x.id === arg);
        if (!r || !kept(ref)) return null;
        return (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <RemoteFilesView sessionId={session.id} remote={r} />
          </div>
        );
      }
      case "pull": {
        // A review stays mounted once it has been opened, so coming back to it finds it loaded and
        // folded the way it was left rather than asking GitHub again.
        if (!pulls.pulls.some((p) => pullKey(p) === arg) || !kept(ref)) return null;
        const { repo, number } = parsePullKey(arg);
        return (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <PullRequestView
              sessionId={session.id}
              number={number}
              repo={repo}
              closed={closed}
              onTitle={(title) => pulls.retitle(arg, title)}
            />
          </div>
        );
      }
    }
  };

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
          <MobileSessionsProgress />
          {collapsed && (
            <ShowSidebarButton className="-ml-2.5" onClick={onToggleCollapsed} />
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

            {/* Second line on a phone, same line from md up: where the session lives. From md up its
                parts join the row itself, so the badges can hold their width against the name beside
                them: a line squeezed as a whole gave them no room, and they spilled over the buttons
                on the right. The folder takes only what is left over, and goes first. */}
            <div className="flex min-w-0 items-center gap-2 md:contents">
              {session.parentSessionId && <ForkedFrom parent={parent} name={session.parentName} onOpen={onSelectSession} />}
              {badgeGit?.isRepo && badgeGit.branch && (
                <BranchBadge
                  sessionId={session.id}
                  branch={badgeGit.branch}
                  changeCount={changeCount}
                  worktree={badgeRoot}
                  onOpenChanges={openChanges}
                />
              )}
              <button
                type="button"
                onClick={copyPath}
                title="Copy working directory"
                className="group/path flex min-w-0 flex-1 items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
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
              {/* The pane's arrangement: presets, and the keys that split and move between groups. */}
              <LayoutMenu groups={groups.length} onPick={(preset) => update((l) => applyPreset(l, preset))} />
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
              {/* Shown greyed rather than dropped while the conversation id is still unknown -- see
                  the same call in the sidebar's row menu for what is missing and why. */}
              <Button
                variant="ghost"
                size="icon"
                className="size-[30px]"
                disabled={!session.canFork}
                onClick={() => onFork(session)}
                title={
                  session.canFork
                    ? "Fork — branch this conversation into a new session"
                    : "Fork needs Claude's conversation id — send this session a message first"
                }
              >
                <GitFork className="size-4" />
              </Button>
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
              {/* A closed session has no process to stop — the one thing its header can do is start
                  it again, so the button in the same corner reopens it instead. */}
              {closed ? (
                <Button
                  variant="outline"
                  size="icon"
                  className="size-[30px]"
                  onClick={onReopen}
                  title="Reopen this session — relaunch Claude and resume the conversation"
                >
                  <RotateCcw className="size-4" />
                </Button>
              ) : (
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
              )}
          </div>

          <SessionActionsMenu
            session={session}
            nowTick={nowTick}
            wdEnabled={wdEnabled}
            onToggleWatchdog={toggleWatchdog}
            onContinue={sendContinue}
            onFork={() => onFork(session)}
            onStop={stop}
            onReopen={onReopen}
            stopping={stopping}
          />
        </div>

      </header>

      {/* The pane: one group of tabs, or several side by side and stacked (see PaneGroups). */}
      <PaneGroups
        layout={layout}
        update={update}
        wide={wide}
        tabInfo={tabInfo}
        renderContent={renderContent}
        onActivate={(ref) => void activateTab(ref)}
        onClose={closeTab}
        onDrop={dropTab}
        onContentFocus={focusContent}
        onCloseAllFiles={() => void fileTabs.closeAll()}
        renderAdd={(groupId) => {
          const g = findGroup(layout, groupId);
          return (
            <>
              {/* Pull requests, opened into this group. Which repos this session can review — its
                  folder's own, the ones linked to it, the ones its project names — is the picker's
                  own business (lib/sessionRepos.ts), including whether it draws a button at all. */}
              <PullPicker
                atEnd
                sessionId={session.id}
                openSignal={pullAsk.group === groupId ? pullAsk.n : 0}
                onOpen={(p) => openPull(p, groupId)}
              />
              <GroupAddMenu
                busy={shells.opening}
                hasClaude={!!g?.tabs.includes(CLAUDE)}
                hasFiles={!!g?.tabs.includes(FILES)}
                onBring={(what) => update((l) => moveRef(l, what, groupId))}
                onOpenShell={(sh) => openShell(sh, groupId)}
                onOpenPull={() => setPullAsk((a) => ({ group: groupId, n: a.n + 1 }))}
                onAddLink={() => {
                  linkTarget.current = groupId;
                  setLinkDialog({});
                }}
                onAddRemote={
                  remotes.remotes.length < MAX_REMOTES
                    ? () => {
                        remoteTarget.current = groupId;
                        setRemoteDialog(true);
                      }
                    : undefined
                }
              />
            </>
          );
        }}
      />

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

      {/* Open a remote files tab over SSH. */}
      {remoteDialog && (
        <RemoteConnectDialog
          project={project}
          onProjectsChange={onProjectsChange}
          onConnected={addRemote}
          onClose={() => setRemoteDialog(false)}
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
        className={cn(badgeVariants({ variant: "outline" }), "gap-1 text-muted-foreground")}
        title={`Forked from “${label}”, which is no longer in the session list`}
      >
        {content}
      </span>
    );

  return (
    <button
      type="button"
      onClick={() => onOpen(parent.id)}
      className={cn(badgeVariants({ variant: "outline" }), "gap-1 transition-colors hover:bg-accent")}
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
      {/* Only where there was a process to have one. A closed session reports 0, which is not a pid
          and reads as one. */}
      {session.state !== "Restorable" && (
        <InfoRow label="PID">
          {session.processId}
          {/* Survived a restart of the app: still the original process, re-attached rather than
              relaunched, so whatever it was in the middle of is intact. */}
          {session.adopted && (
            <span className="text-muted-foreground"> · re-attached after an app restart</span>
          )}
        </InfoRow>
      )}
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
  onReopen,
  stopping,
}: {
  session: SessionInfo;
  nowTick: number;
  wdEnabled: boolean;
  onToggleWatchdog: () => void;
  onContinue: () => void;
  onFork: () => void;
  onStop: () => void;
  onReopen: () => void;
  stopping: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismissable(open, useCallback(() => setOpen(false), []));
  const running = session.state === "Running";
  const closed = session.state === "Restorable";

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
            <MenuItem
              disabled={!session.canFork}
              title={
                session.canFork
                  ? undefined
                  : "Fork needs Claude's conversation id — send this session a message first"
              }
              onClick={() => {
                onFork();
                setOpen(false);
              }}
            >
              <GitFork className="size-4" /> Fork session…
            </MenuItem>
            {/* Closed: the only thing left to do to this session is start it again. */}
            {closed ? (
              <MenuItem
                onClick={() => {
                  onReopen();
                  setOpen(false);
                }}
              >
                <RotateCcw className="size-4" /> Reopen session
              </MenuItem>
            ) : (
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
            )}
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
  title,
  children,
}: {
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
  /** Why an entry is disabled — the one thing a greyed row cannot say for itself. */
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
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
