import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { GitStatus, SessionInfo } from "@/types";
import { api } from "@/lib/api";
import { useConfirm } from "@/components/ui/confirm";
import { readUrlState, patchUrlState, type TabName } from "@/lib/urlState";
import { loadSessionUi, saveSessionUi } from "@/lib/sessionUi";
import { FileBrowser } from "./FileBrowser";
import { TerminalPane } from "./TerminalPane";
import { RenameField } from "./RenameField";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Check, Columns2, Copy, ExternalLink, FolderTree, GitBranch, Loader2, Menu, PanelLeftOpen, Pencil, Play, Radio, ShieldCheck, ShieldOff, Square, TerminalSquare } from "lucide-react";
import { writeToClipboard } from "@/lib/clipboard";

// Desktop width of the Files panel in Split view. Persisted per-browser and drag-resizable.
const SPLIT_MIN = 280; // keep both the files panel and the terminal usable
const SPLIT_DEFAULT = 480;
const SPLIT_WIDTH_KEY = "claudeweb.splitFilesWidth";

function readSplitWidth() {
  const n = Number(localStorage.getItem(SPLIT_WIDTH_KEY));
  return Number.isFinite(n) && n >= SPLIT_MIN ? n : SPLIT_DEFAULT;
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
  onToggleSidebar,
  collapsed,
  onToggleCollapsed,
  onStopped,
  onRename,
  onTerminalRename,
}: {
  session: SessionInfo;
  onToggleSidebar: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onStopped: (id: string) => void;
  onRename: (id: string, name: string) => void;
  // Apply a rename detected in this session's terminal (Claude's /rename confirmation).
  onTerminalRename?: (id: string, name: string) => void;
}) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
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
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => setWdEnabled(session.watchdogEnabled), [session.watchdogEnabled]);

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
    setBusy(true);
    try {
      await api.deleteSession(session.id);
      onStopped(session.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-col gap-2 border-b px-3 py-2 md:h-14 md:flex-row md:items-center md:gap-2 md:py-0">
        {/* Title group: full-width first row on mobile so the name + folder read clearly; on desktop
            it's the flex-1 left side of a single row. */}
        <div className="flex min-w-0 items-center gap-2 md:flex-1">
        <Button variant="ghost" size="icon" className="md:hidden" onClick={onToggleSidebar}>
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
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2 overflow-hidden">
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
                className="shrink-0 text-muted-foreground hover:text-foreground"
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
            {session.remoteControl && (
              <Badge variant="outline" className="hidden gap-1 sm:inline-flex">
                <Radio className="size-3" /> RC
              </Badge>
            )}
            {git?.isRepo && git.branch && (
              <Badge variant="outline" className="min-w-0 shrink gap-1" title="Current git branch">
                <GitBranch className="size-3 shrink-0" />
                <span className="max-w-[6rem] truncate sm:max-w-[10rem]">{git.branch}</span>
                {changeCount > 0 && <span className="shrink-0 text-amber-500">·{changeCount}</span>}
              </Badge>
            )}
          </div>
          <p className="flex items-center font-mono text-[11px] text-muted-foreground">
            <button
              type="button"
              onClick={copyPath}
              title="Copy working directory"
              className="group/path flex min-w-0 items-center gap-1 hover:text-foreground"
            >
              <span className="truncate">{session.workingDirectory}</span>
              {copiedPath ? (
                <Check className="size-3 shrink-0 text-emerald-500" />
              ) : (
                <Copy className="size-3 shrink-0 opacity-0 transition-opacity group-hover/path:opacity-100" />
              )}
            </button>
            <span className="shrink-0 whitespace-pre">
              {session.model ? ` · ${session.model}` : ""} · pid {session.processId}
            </span>
          </p>
        </div>
        </div>

        {/* Controls row: view switcher + session actions. Sits below the title on mobile, right side
            of the header on desktop. */}
        <div className="flex items-center gap-2">
        {/* Terminal is the primary surface; Files is the secondary view of the working directory.
            Split shows both side by side (desktop only). */}
        <div className="flex items-center rounded-md border p-0.5">
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

        {session.state === "Running" && (
          <>
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleWatchdog}
              title={
                wdEnabled
                  ? "Hang watchdog on — auto-sends “continue” on API errors. Click to disable."
                  : "Hang watchdog off. Click to enable auto-recovery."
              }
              aria-pressed={wdEnabled}
            >
              {wdEnabled ? (
                <ShieldCheck className="size-4" />
              ) : (
                <ShieldOff className="size-4 text-muted-foreground" />
              )}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={sendContinue}
              title="Send “continue” to this session now"
            >
              <Play className="size-4" />
              <span className="hidden sm:inline">Continue</span>
            </Button>
          </>
        )}
        {session.remoteControl && session.state === "Running" && (
          <Button asChild variant="outline" size="sm" className="hidden lg:inline-flex">
            <a href={session.remoteUrl ?? "https://claude.ai/code"} target="_blank" rel="noreferrer">
              <ExternalLink className="size-4" /> Open in app
            </a>
          </Button>
        )}
        <Button variant="destructive" size="sm" onClick={stop} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Square className="size-4" />}
          <span className="hidden sm:inline">{session.state === "Running" ? "Stop" : "Remove"}</span>
        </Button>
        </div>
      </header>

      {session.remoteControl && session.state === "Running" && (
        <div className="flex items-center gap-1.5 border-b bg-emerald-500/5 px-4 py-1.5 text-xs text-muted-foreground">
          <Radio className="size-3 text-emerald-500" />
          Registered for Remote Control — drive{" "}
          <span className="font-medium text-foreground">{session.name}</span> from the Claude Code app.
        </div>
      )}

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
              sessionId={session.id}
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

        <div className={cn("min-h-0 min-w-0 flex-1", view === "files" && "hidden")}>
          <TerminalPane
            key={session.id}
            sessionId={session.id}
            onRenameDetected={(name) => onTerminalRename?.(session.id, name)}
          />
        </div>
      </div>
    </div>
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
        "flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors",
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
        className
      )}
    >
      {children}
    </button>
  );
}
