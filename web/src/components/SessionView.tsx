import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { GitStatus, SessionInfo } from "@/types";
import { api } from "@/lib/api";
import { useConfirm } from "@/components/ui/confirm";
import { readUrlState, patchUrlState, type TabName } from "@/lib/urlState";
import { loadSessionUi, saveSessionUi } from "@/lib/sessionUi";
import { FileBrowser, type FileBrowserHandle } from "./FileBrowser";
import { TerminalPane, type TerminalPaneHandle } from "./TerminalPane";
import { PostponedPool } from "./PostponedPool";
import { RenameField } from "./RenameField";
import { Button } from "@/components/ui/button";
import { Badge, badgeVariants } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
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
  onFork: (s: SessionInfo) => void;
  onSelectSession: (id: string) => void; // used by the "forked from" link to jump to the parent
  onToggleSidebar: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onStopped: (id: string) => void;
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
  const [copiedPath, setCopiedPath] = useState(false);
  const [splitWidth, setSplitWidth] = useState(readSplitWidth); // Files-panel width in Split view
  // Optimistic mirror of the watchdog toggle so it flips instantly, then syncs from the session poll.
  const [wdEnabled, setWdEnabled] = useState(session.watchdogEnabled);
  const [nowTick, setNowTick] = useState(() => Date.now()); // ticks so the header uptime stays live
  const contentRef = useRef<HTMLDivElement>(null);
  const fileBrowserRef = useRef<FileBrowserHandle>(null);
  // Candidates when a bare filename clicked in the terminal matched more than one file.
  const [filePicker, setFilePicker] = useState<{ name: string; matches: string[] } | null>(null);

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
  // (files/split), reveal it via the browser's imperative handle; otherwise seed the selection and
  // switch to the Files view so the browser opens it as it mounts.
  const openInFiles = useCallback(
    (rel: string) => {
      if (view === "terminal") {
        saveSessionUi(session.id, { file: rel });
        patchUrlState({ file: rel });
        changeView("files");
      } else {
        fileBrowserRef.current?.revealFile(rel);
      }
    },
    [view, session.id, changeView]
  );

  // Open this session's git-changes view (from the header branch badge). If the Files panel is already
  // showing, flip it via the imperative handle; otherwise seed the mode and switch to the Files view.
  const openChanges = useCallback(() => {
    if (view === "terminal") {
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

  // On switching to another session, restore that session's last-used view mode.
  const prevViewSession = useRef(session.id);
  useEffect(() => {
    if (prevViewSession.current === session.id) return;
    prevViewSession.current = session.id;
    setView(loadSessionUi(session.id).view ?? "terminal");
  }, [session.id]);

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

  async function stop() {
    const running = session.state === "Running";
    const ok = await confirm({
      title: running ? "Stop session?" : "Remove session?",
      description: running ? (
        <>
          This kills the <span className="font-medium text-foreground">{session.name}</span> process.
          {session.remoteControl && " Its Remote Control session in the Claude Code app ends too."}
        </>
      ) : (
        <>
          Remove <span className="font-medium text-foreground">{session.name}</span> from the list?
        </>
      ),
      confirmLabel: running ? "Stop" : "Remove",
    });
    if (!ok) return;
    setStopping(true);
    try {
      await api.deleteSession(session.id);
      onStopped(session.id);
    } finally {
      setStopping(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="relative flex shrink-0 flex-col">
        {/* Session color (set via `/color`) as a left accent border — the same color the sidebar row shows. */}
        {sessionColor(session.color) && (
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 w-1"
            style={{ backgroundColor: sessionColor(session.color)! }}
            title={`Color: ${session.color}`}
          />
        )}
        {/* Row 1: session name + badges on the left, uptime/info/RC and session actions on the
            right — h-14 so it lines up with the sidebar's app header. On a phone the width goes to
            the name instead: the folder and branch drop to a second line and the right-hand cluster
            collapses into a "⋯" menu. */}
        <div className="flex min-h-10 min-w-0 shrink-0 items-center gap-2 border-b px-3 py-1 md:h-10 md:py-0">
        <Button variant="ghost" size="icon" className="size-9 shrink-0 md:hidden" onClick={onToggleSidebar}>
          <Menu className="size-5" />
        </Button>
        {collapsed && (
          <Button
            variant="ghost"
            size="icon"
            className="hidden md:inline-flex"
            title="Show sidebar"
            onClick={onToggleCollapsed}
          >
            <PanelLeftOpen className="size-5" />
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
              {session.state === "Running" && (
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
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
                title={session.state === "Running" ? "Stop session" : "Remove session"}
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
        </div>
      </header>

      {/* The terminal stays mounted in every view (hidden in Files) so toggling never drops its
          connection; the Files panel is a resizable left column in Split and full-width in Files. */}
      <div ref={contentRef} className="flex min-h-0 flex-1 flex-col md:flex-row">
        {view !== "terminal" && (
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

        <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", view === "files" && "hidden")}>
          {/* The pane keeps flex-1 so FitAddon measures the height left over by the pool bar below. */}
          <div className="min-h-0 flex-1">
            <TerminalPane
              key={session.id}
              ref={terminalRef}
              sessionId={session.id}
              workingDirectory={session.workingDirectory}
              onRenameDetected={(name) => onTerminalRename?.(session.id, name)}
              onColorDetected={(color) => onTerminalColor?.(session.id, color)}
              onOpenFile={onTerminalOpenFile}
              onFindFile={onTerminalFindFile}
            />
          </div>
          <PostponedPool sessionId={session.id} busy={busy} terminalRef={terminalRef} />
        </div>
      </div>

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

/**
 * Dismiss-on-outside-click/Escape for the header's little popups. Returns the ref to put on the
 * popup's root — anything inside it (including the trigger) counts as "inside".
 */
function useDismissable(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
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
        <div className="absolute right-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-md border bg-popover p-3 text-popover-foreground shadow-md">
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
      <InfoRow label="PID">{session.processId}</InfoRow>
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
        <div className="absolute right-0 top-full z-50 mt-1 w-72 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md">
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
              {running ? "Stop session" : "Remove session"}
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
