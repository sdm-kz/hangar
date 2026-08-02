import { useCallback, useEffect, useRef, useState } from "react";
import { api, getToken, setToken, sessionsStreamUrl } from "@/lib/api";
import { type RecentSession } from "@/lib/recentSessions";
import { migrateLegacyRecents } from "@/lib/migrateRecents";
import { readUrlState, patchUrlState } from "@/lib/urlState";
import { move } from "@/lib/sessionOrder";
import type { SessionInfo } from "@/types";
import { Login } from "@/components/Login";
import { SessionSidebar, type SessionListTab } from "@/components/SessionSidebar";
import { AppSidebar, type SidebarTab } from "@/components/AppSidebar";
import { FilesSidebar } from "@/components/FilesSidebar";
import { ServerFileViewer } from "@/components/ServerFileViewer";
import { SessionView } from "@/components/SessionView";
import { NewSessionDialog } from "@/components/NewSessionDialog";
import { SessionSearchDialog } from "@/components/SessionSearch";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { cn } from "@/lib/utils";
import { Bot, Loader2, Menu, PanelLeftOpen, Plus } from "lucide-react";

type AuthStatus = "loading" | "authed" | "anon";

// Desktop sidebar width bounds (px). Default matches the old fixed w-72 (18rem).
const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 560;
const SIDEBAR_DEFAULT = 288;

function readSidebarWidth() {
  const n = Number(localStorage.getItem("claudeweb.sidebarWidth"));
  return Number.isFinite(n) && n > 0
    ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, n))
    : SIDEBAR_DEFAULT;
}

export function App() {
  const confirm = useConfirm();
  const [auth, setAuth] = useState<AuthStatus>("loading");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const [waitingIds, setWaitingIds] = useState<Set<string>>(() => new Set()); // waiting on a prompt
  const [streamUp, setStreamUp] = useState(false); // is the live session stream connected?
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>(() =>
    readUrlState().panel === "files" ? "files" : "sessions"
  );
  const [listTab, setListTab] = useState<SessionListTab>("sessions"); // Sessions vs Recent list
  const [openFile, setOpenFile] = useState<string | null>(null); // server file open in the main area
  const [activeId, setActiveId] = useState<string | null>(() => readUrlState().session ?? null);
  const [newOpen, setNewOpen] = useState(false);
  const [newPreset, setNewPreset] = useState<RecentSession | null>(null);
  // Restorable session the create dialog was opened from (see reopenAsNew): once the replacement
  // launches, that stale entry is forgotten so the same conversation isn't listed twice.
  const [newFromId, setNewFromId] = useState<string | null>(null);
  const [recents, setRecents] = useState<RecentSession[]>([]);
  // Search popup over sessions + recents. Owned here (not by the sidebar) so the hotkey below works
  // with the sidebar collapsed, and so the two sidebar instances don't each mount a dialog.
  const [searching, setSearching] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false); // mobile drawer
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("claudeweb.sidebarCollapsed") === "1"
  ); // desktop sidebar collapsed
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth); // desktop sidebar width (px)

  // Drag the right edge of the desktop sidebar to resize it; persist the result.
  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = readSidebarWidth();
    let width = startW;
    const onMove = (ev: PointerEvent) => {
      width = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startW + ev.clientX - startX));
      setSidebarWidth(width);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem("claudeweb.sidebarWidth", String(width));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const toggleCollapsed = () =>
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem("claudeweb.sidebarCollapsed", next ? "1" : "0");
      return next;
    });

  // Determine whether we're authenticated (or auth is disabled) on load.
  useEffect(() => {
    (async () => {
      try {
        const cfg = await api.authConfig();
        if (!cfg.authRequired) {
          setToken("dev"); // any token passes when auth is disabled
          setAuth("authed");
        } else {
          setAuth(getToken() ? "authed" : "anon");
        }
      } catch {
        setAuth(getToken() ? "authed" : "anon");
      }
    })();
  }, []);

  const loadRecents = useCallback(async () => {
    try {
      const r = await api.getRecents();
      setRecents(r.sessions);
    } catch {
      /* ignore — recents are non-critical */
    }
  }, []);

  // Apply a fresh session list (from a poll or a stream push): sort newest-first and keep the
  // selection valid. Shared by refresh() and the live stream so both paths behave identically.
  const applySessions = useCallback((incoming: SessionInfo[]) => {
    // Newest sessions first (top), oldest last — by creation time.
    const list = [...incoming].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    setSessions(list);
    // Keep a valid current selection (e.g. restored from the URL); otherwise auto-select the
    // first live session, never a Restorable placeholder (it has no terminal yet).
    setActiveId((cur) =>
      cur && list.some((s) => s.id === cur)
        ? cur
        : list.find((s) => s.state !== "Restorable")?.id ?? null
    );
  }, []);

  const refresh = useCallback(async () => {
    try {
      applySessions(await api.listSessions());
    } catch {
      // 401 handled by api layer clearing token; flip to login.
      if (!getToken()) setAuth("anon");
    }
  }, [applySessions]);

  // A /rename detected in a session's terminal: apply the new name to that session directly (same
  // path as a UI rename, so it repaints immediately) rather than waiting on a refetch/poll.
  const onTerminalRename = useCallback((id: string, name: string) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, name } : s)));
  }, []);

  // A /color detected in a session's terminal: apply it directly so the sessions list recolors
  // immediately (the server also persists it, arriving on the next poll).
  const onTerminalColor = useCallback((id: string, color: string) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, color } : s)));
  }, []);

  // Mirror the active session into the URL so a refresh/shared link restores it. On a real switch
  // (not the initial restore) also drop `file` — a lingering deep-link file belongs to the previous
  // session and would otherwise open in the new one; its own tabs still restore from sessionUi.
  const urlSessionRef = useRef(activeId);
  useEffect(() => {
    const switched = urlSessionRef.current !== activeId;
    urlSessionRef.current = activeId;
    patchUrlState({ session: activeId ?? undefined, ...(switched && { file: undefined }) });
  }, [activeId]);

  // Mirror the sidebar tab so a refresh (or a new-tab deep link) restores the Files view.
  useEffect(() => {
    patchUrlState({ panel: sidebarTab === "files" ? "files" : undefined });
  }, [sidebarTab]);

  // Live session stream: the server pushes the full { sessions, busy } snapshot whenever it changes
  // (new/renamed/exited sessions, Claude going active/idle, watchdog status), so the UI stays current
  // without polling. If the socket drops, the interval polls below take over until it reconnects.
  const wsRef = useRef<WebSocket | null>(null);
  const lastHubMsgRef = useRef<number>(0); // wall-clock of the last frame, for the liveness watchdog
  useEffect(() => {
    if (auth !== "authed") return;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false; // set on unmount so a pending reconnect doesn't fire

    const connect = () => {
      const ws = new WebSocket(sessionsStreamUrl());
      wsRef.current = ws;
      lastHubMsgRef.current = Date.now();
      ws.onopen = () => {
        lastHubMsgRef.current = Date.now();
        setStreamUp(true);
      };
      ws.onmessage = (e) => {
        lastHubMsgRef.current = Date.now();
        try {
          const msg = JSON.parse(e.data) as {
            sessions: SessionInfo[];
            busy: string[];
            waiting?: string[];
          };
          applySessions(msg.sessions);
          setBusyIds(new Set(msg.busy));
          setWaitingIds(new Set(msg.waiting ?? []));
        } catch {
          /* ignore a malformed frame (e.g. a keepalive ping) */
        }
      };
      ws.onclose = () => {
        setStreamUp(false);
        if (!closed) retry = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws.close();
    };
    connect();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [auth, applySessions]);

  // Liveness watchdog: a WebSocket can go half-open (e.g. after a server restart) without ever firing
  // onclose, which leaves streamUp stuck true and the UI silently stale — updates then only arrive on a
  // manual refetch (tab focus, a resize). The server sends a keepalive frame every few seconds, so if
  // we've heard nothing for a while the socket is dead: force-close it to trigger the reconnect path.
  useEffect(() => {
    if (auth !== "authed" || !streamUp) return;
    const t = setInterval(() => {
      if (Date.now() - lastHubMsgRef.current > 15000) wsRef.current?.close();
    }, 5000);
    return () => clearInterval(t);
  }, [auth, streamUp]);

  // Poll the session list as a backstop so the badges/names can't get stuck stale. The hub WebSocket
  // normally keeps this live, but a half-open socket or a dropped frame would otherwise strand the list
  // until the next manual refetch — so keep a gentle poll running even while the stream looks up, and
  // poll faster when it's down. Always do one immediate fetch for a fast first paint.
  useEffect(() => {
    if (auth !== "authed") return;
    refresh();
    const t = setInterval(refresh, streamUp ? 3000 : 2000);
    return () => clearInterval(t);
  }, [auth, refresh, streamUp]);

  // Browsers throttle/pause setInterval in a backgrounded tab, so the poll above stalls while you're
  // away (e.g. renaming in the terminal from another window). Refetch immediately on return so the
  // list is current without needing a full page reload.
  useEffect(() => {
    if (auth !== "authed") return;
    const onWake = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    return () => {
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, [auth, refresh]);

  // Poll which sessions Claude is actively working in — only while the stream is down (the stream's
  // snapshot carries the busy set). Separate from the list poll so the "active" dot can update
  // quickly without re-fetching (and re-sorting) the whole list.
  useEffect(() => {
    if (auth !== "authed" || streamUp) return;
    let alive = true;
    const tick = async () => {
      try {
        const ids = await api.sessionActivity();
        if (alive) setBusyIds(new Set(ids));
      } catch {
        /* ignore — the dot is non-critical */
      }
    };
    tick();
    const t = setInterval(tick, 1200);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [auth, streamUp]);

  // Raise a browser (OS) notification when a session newly flips to "attention" (the watchdog gave
  // up auto-recovering it). Compare against the previous poll so we only notify on the transition,
  // and seed on first run so pre-existing attention states don't alert on page load.
  const wdStatusRef = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    if (auth !== "authed") return;
    const prev = wdStatusRef.current;
    const next = new Map(sessions.map((s) => [s.id, s.watchdogStatus]));
    wdStatusRef.current = next;
    if (prev === null) return; // first run: seed only, don't fire for already-stuck sessions

    const newlyStuck = sessions.filter(
      (s) => s.watchdogStatus === "attention" && prev.get(s.id) !== "attention"
    );
    if (newlyStuck.length === 0 || !("Notification" in window)) return;

    const fire = () => {
      for (const s of newlyStuck) {
        try {
          const n = new Notification(`${s.name} — needs attention`, {
            body: "Claude stopped recovering after repeated API errors.",
            tag: `watchdog-${s.id}`,
          });
          // Click the notification to jump to that session.
          n.onclick = () => {
            window.focus();
            setActiveId(s.id);
            setOpenFile(null);
            n.close();
          };
        } catch {
          /* ignore — notifications are best-effort */
        }
      }
    };
    if (Notification.permission === "granted") fire();
    else if (Notification.permission !== "denied")
      Notification.requestPermission().then((p) => p === "granted" && fire());
  }, [sessions, auth]);

  // Notify when a session newly starts waiting on a prompt (idle -> waiting), mirroring the watchdog
  // "attention" alert. Compare against the previous set so we only fire on the transition, and seed
  // on first run so a session already waiting at page load doesn't alert.
  const prevWaitingRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (auth !== "authed") return;
    const prev = prevWaitingRef.current;
    prevWaitingRef.current = new Set(waitingIds);
    if (prev === null) return; // first run: seed only

    const newly = [...waitingIds].filter((id) => !prev.has(id));
    if (newly.length === 0 || !("Notification" in window)) return;

    const fire = () => {
      for (const id of newly) {
        const s = sessions.find((x) => x.id === id);
        try {
          const n = new Notification(`${s?.name ?? "Session"} — Claude needs your input`, {
            body: "Waiting on a prompt.",
            tag: `waiting-${id}`,
          });
          // Click the notification to jump to that session.
          n.onclick = () => {
            window.focus();
            setActiveId(id);
            setOpenFile(null);
            n.close();
          };
        } catch {
          /* ignore — notifications are best-effort */
        }
      }
    };
    if (Notification.permission === "granted") fire();
    else if (Notification.permission !== "denied")
      Notification.requestPermission().then((p) => p === "granted" && fire());
  }, [waitingIds, sessions, auth]);

  // When a push notification is tapped while a window is already open, the service worker posts the
  // session id here so we can jump to it (the cold-open case is handled by readUrlState's ?session=).
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "open-session" && typeof e.data.sessionId === "string") {
        window.focus();
        setActiveId(e.data.sessionId);
        setOpenFile(null);
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  // Ctrl+Shift+F (⌘⇧F on Mac) opens the session search popup from anywhere. Capture phase with
  // stopPropagation so it wins even while the terminal has focus (the keystroke would otherwise go
  // to the pty); a shifted combo because plain Ctrl+letter chords belong to the shell and the TUI —
  // and a terminal can't encode Ctrl+Shift+F distinctly anyway, so intercepting it costs nothing.
  useEffect(() => {
    if (auth !== "authed") return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        e.stopPropagation();
        setSearching(true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [auth]);

  // Load the server-backed recents once authed, migrating any left over in this browser's
  // localStorage from older builds first.
  useEffect(() => {
    if (auth !== "authed") return;
    (async () => {
      await migrateLegacyRecents().catch(() => {});
      loadRecents();
    })();
  }, [auth, loadRecents]);

  // A Restorable entry has no live terminal, so never treat it as the active view.
  const active = sessions.find((s) => s.id === activeId && s.state !== "Restorable") ?? null;

  function openNew(preset: RecentSession | null = null) {
    setNewPreset(preset);
    setNewOpen(true);
  }

  function reuseRecent(r: RecentSession) {
    openNew(r);
    setSidebarOpen(false);
  }

  // Reopen a Restorable session through the create dialog instead of relaunching it straight away, so
  // the model/prompt/permissions can be adjusted first. The preset carries its conversation id, so the
  // dialog's "continue" resumes that exact conversation; the stale entry is forgotten once it starts.
  const reopenAsNew = useCallback((s: SessionInfo, preset: RecentSession) => {
    setNewPreset(preset);
    setNewFromId(s.id);
    setNewOpen(true);
    setSidebarOpen(false);
  }, []);

  // Open a server file (from the Files tab) in the main content area; close the mobile drawer.
  const openServerFile = useCallback((path: string) => {
    setOpenFile(path);
    setSidebarOpen(false);
  }, []);

  // Reveal the open file in the Files tree: switch the sidebar to the Files tab (which expands and
  // scrolls to openFile) and open the mobile drawer so it's visible on small screens.
  const revealInFiles = useCallback(() => {
    setSidebarTab("files");
    setSidebarOpen(true);
  }, []);

  // Clone a session: open the create dialog prefilled with its settings (the one-time initial prompt
  // can't be recovered, so it starts empty) for the user to adjust before launching.
  const cloneSession = useCallback((s: SessionInfo) => {
    setNewPreset({
      workingDirectory: s.workingDirectory,
      name: s.name,
      command: "",
      model: s.model ?? "",
      remoteControl: s.remoteControl,
      permissionMode: s.permissionMode || "auto",
    });
    setNewOpen(true);
    setSidebarOpen(false);
  }, []);

  // Start a new session in a folder picked from the Files tab: open the create dialog prefilled with
  // that working directory (defaults for everything else).
  const newSessionInFolder = useCallback((path: string) => {
    setNewPreset({
      workingDirectory: path,
      name: "",
      command: "",
      model: "",
      remoteControl: true,
      permissionMode: "auto",
    });
    setNewOpen(true);
    setSidebarOpen(false);
  }, []);

  // Selecting a session takes over the main area, so drop any open server file.
  const selectSession = useCallback((id: string) => {
    setActiveId(id);
    setOpenFile(null);
  }, []);

  async function removeRecent(r: RecentSession) {
    const next = await api.removeRecentSession(r).catch(() => null);
    if (next) setRecents(next.sessions);
  }

  function onCreated(s: SessionInfo) {
    // Reopened a Restorable entry through the dialog: the new session took its place, so forget it.
    const replaced = newFromId;
    setNewFromId(null);
    if (replaced) api.deleteSession(replaced).catch(() => {});
    // Idempotent add: the live stream may already have pushed this new session before the create
    // response returns, so drop any existing copy of its id before appending to avoid a duplicate row.
    setSessions((prev) => [...prev.filter((x) => x.id !== s.id && x.id !== replaced), s]);
    setActiveId(s.id);
    setOpenFile(null); // the new session takes over the main area, like selecting one does
    // Launching can start from the Files tab or the Recent list; pull both sidebar levels back to the
    // session list so the new session is visible and shown as selected.
    setSidebarTab("sessions");
    setListTab("sessions");
    setSidebarOpen(false);
    loadRecents(); // the dialog just saved this launch as a recent preset (server-side)
  }

  async function onClose(id: string) {
    const s = sessions.find((x) => x.id === id);
    const running = s?.state === "Running";
    // Only confirm when stopping a running session; closing an inactive one is cheap to undo.
    if (running) {
      const ok = await confirm({
        title: "Stop session?",
        description: (
          <>
            This kills the <span className="font-medium text-foreground">{s?.name}</span> process
            {s?.remoteControl && " and ends its Remote Control session in the Claude Code app"}.
          </>
        ),
        confirmLabel: "Stop",
      });
      if (!ok) return;
    }
    await api.deleteSession(id).catch(() => {});
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setActiveId((cur) => (cur === id ? null : cur));
    loadRecents(); // the server saved the removed session as a preset — show it in the Recent tab
  }

  // Drag-to-reorder the recent presets. These are server-backed, so persist the new order there.
  const reorderRecents = useCallback(
    (from: number, to: number) => {
      const next = move(recents, from, to);
      setRecents(next);
      api.reorderRecentSessions(next).catch(() => {});
    },
    [recents]
  );

  // Reopen a Restorable session: it relaunches (resuming its conversation) and returns a fresh live
  // session. Uses --resume <id> for the exact conversation when we captured Claude's session id,
  // otherwise --continue (the folder's most recent).
  async function onRestore(id: string) {
    const s = sessions.find((x) => x.id === id);
    const ok = await confirm({
      title: "Reopen session?",
      description: (
        <>
          Relaunch <span className="font-medium text-foreground">{s?.name}</span> and resume{" "}
          {s?.resumeExact ? (
            <>
              this exact conversation (<span className="font-mono">--resume</span>).
            </>
          ) : (
            <>
              the folder&rsquo;s most recent conversation (<span className="font-mono">--continue</span>).
            </>
          )}
        </>
      ),
      confirmLabel: "Reopen",
    });
    if (!ok) return;
    const created = await api.restoreSession(id).catch(() => null);
    if (!created) return;
    // Drop the old Restorable entry AND any copy of the new session the live stream may have already
    // pushed (the push can beat this response), so the reopened session appears exactly once.
    setSessions((prev) => [...prev.filter((s) => s.id !== id && s.id !== created.id), created]);
    setActiveId(created.id);
    setSidebarOpen(false);
  }

  // Bulk-remove sessions (from a folder group's remove popup). The popup is the confirmation, so we
  // just delete each and prune local state. deleteSession stops running processes and forgets the rest.
  async function onRemoveSessions(ids: string[]) {
    if (ids.length === 0) return;
    const set = new Set(ids);
    await Promise.all(ids.map((id) => api.deleteSession(id).catch(() => {})));
    setSessions((prev) => prev.filter((s) => !set.has(s.id)));
    setActiveId((cur) => (cur && set.has(cur) ? null : cur));
    loadRecents(); // each removed session is saved as a preset server-side; refresh the Recent tab
  }

  // Rename a session from the sidebar or the details header. Optimistically update the name, then
  // persist; the server also injects `/rename` into the live terminal so Claude renames itself too.
  async function onRename(id: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, name: trimmed } : s)));
    await api.renameSession(id, trimmed).catch(() => {});
  }

  async function onLogout() {
    await api.logout();
    setAuth("anon");
    setSessions([]);
    setActiveId(null);
  }

  if (auth === "loading") {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (auth === "anon") {
    return <Login onSuccess={() => setAuth("authed")} />;
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Sidebar: static column on desktop (collapsible + resizable), slide-over drawer on mobile. */}
      <aside
        className={cn("relative hidden shrink-0 border-r md:block", collapsed && "md:hidden")}
        style={{ width: sidebarWidth }}
      >
        <AppSidebar
          tab={sidebarTab}
          onTabChange={setSidebarTab}
          onCollapse={toggleCollapsed}
          sessions={
            <SessionSidebar
              sessions={sessions}
              busyIds={busyIds}
              waitingIds={waitingIds}
              activeId={activeId}
              onSelect={selectSession}
              onNew={() => openNew()}
              onClose={onClose}
              onClone={cloneSession}
              onRestore={onRestore}
              onRename={onRename}
              onRemoveSessions={onRemoveSessions}
              onLogout={onLogout}
              recents={recents}
              onReuse={reuseRecent}
              onRemoveRecent={removeRecent}
              onReorderRecent={reorderRecents}
              onSearch={() => setSearching(true)}
              tab={listTab}
              onTabChange={setListTab}
            />
          }
          files={<FilesSidebar openPath={openFile} onOpenFile={openServerFile} onNewSession={newSessionInFolder} />}
        />
        {/* Drag handle straddling the right border. */}
        <div
          onPointerDown={startResize}
          onDoubleClick={() => {
            setSidebarWidth(SIDEBAR_DEFAULT);
            localStorage.setItem("claudeweb.sidebarWidth", String(SIDEBAR_DEFAULT));
          }}
          title="Drag to resize · double-click to reset"
          className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-primary/20 active:bg-primary/30"
        />
      </aside>

      {sidebarOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setSidebarOpen(false)} />
          <aside className="absolute left-0 top-0 h-full w-72 border-r shadow-xl">
            <AppSidebar
              tab={sidebarTab}
              onTabChange={setSidebarTab}
              sessions={
                <SessionSidebar
                  sessions={sessions}
                  busyIds={busyIds}
                  waitingIds={waitingIds}
                  activeId={activeId}
                  onSelect={(id) => {
                    selectSession(id);
                    setSidebarOpen(false);
                  }}
                  onNew={() => {
                    openNew();
                    setSidebarOpen(false);
                  }}
                  onClose={onClose}
                  onClone={cloneSession}
                  onRestore={onRestore}
                  onRename={onRename}
                  onRemoveSessions={onRemoveSessions}
                  onLogout={onLogout}
                  recents={recents}
                  onReuse={reuseRecent}
                  onRemoveRecent={removeRecent}
                  onReorderRecent={reorderRecents}
                  onSearch={() => setSearching(true)}
                  tab={listTab}
                  onTabChange={setListTab}
                />
              }
              files={<FilesSidebar openPath={openFile} onOpenFile={openServerFile} onNewSession={newSessionInFolder} />}
            />
          </aside>
        </div>
      )}

      <main className="min-w-0 flex-1">
        {openFile ? (
          <ServerFileViewer
            path={openFile}
            onClose={() => setOpenFile(null)}
            onReveal={revealInFiles}
            onToggleSidebar={() => setSidebarOpen(true)}
            collapsed={collapsed}
            onToggleCollapsed={toggleCollapsed}
          />
        ) : active ? (
          <SessionView
            session={active}
            busy={busyIds.has(active.id)}
            onToggleSidebar={() => setSidebarOpen(true)}
            collapsed={collapsed}
            onToggleCollapsed={toggleCollapsed}
            onStopped={(id) => setSessions((prev) => prev.filter((s) => s.id !== id))}
            onRename={onRename}
            onTerminalRename={onTerminalRename}
            onTerminalColor={onTerminalColor}
          />
        ) : (
          <EmptyState
            onNew={() => openNew()}
            onOpenSidebar={() => setSidebarOpen(true)}
            collapsed={collapsed}
            onToggleCollapsed={toggleCollapsed}
          />
        )}
      </main>

      {searching && (
        <SessionSearchDialog
          sessions={sessions}
          recents={recents}
          activeId={activeId}
          // Opening a session from search also pulls the list back to the Sessions tab (so the row
          // just picked is the one shown selected) and closes the mobile drawer.
          onSelect={(id) => {
            setListTab("sessions");
            selectSession(id);
            setSidebarOpen(false);
          }}
          onReopen={reopenAsNew}
          onReuse={reuseRecent}
          onClose={() => setSearching(false)}
        />
      )}

      <NewSessionDialog
        open={newOpen}
        onOpenChange={(o) => {
          setNewOpen(o);
          if (!o) {
            setNewPreset(null); // clear preset so the next plain "New session" starts fresh
            setNewFromId(null); // dismissed without launching — keep the Restorable entry as it is
          }
        }}
        onCreated={onCreated}
        preset={newPreset}
      />
    </div>
  );
}

function EmptyState({
  onNew,
  onOpenSidebar,
  collapsed,
  onToggleCollapsed,
}: {
  onNew: () => void;
  onOpenSidebar: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  return (
    <div className={cn("flex h-full flex-col")}>
      <header className={cn("flex items-center gap-2 border-b px-3 py-2.5", !collapsed && "md:hidden")}>
        <Button variant="ghost" size="icon" className="md:hidden" onClick={onOpenSidebar}>
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
        <span className="font-semibold">Claude Web</span>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
          <Bot className="size-7" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">No session selected</h2>
          <p className="text-sm text-muted-foreground">Start a Claude Code session in a working folder.</p>
        </div>
        <Button onClick={onNew}>
          <Plus className="size-4" /> New session
        </Button>
      </div>
    </div>
  );
}
