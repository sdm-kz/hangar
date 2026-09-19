import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, getToken, setToken, sessionsStreamUrl } from "@/lib/api";
import { type RecentSession } from "@/lib/recentSessions";
import { migrateLegacyRecents } from "@/lib/migrateRecents";
import { readUrlState, patchUrlState } from "@/lib/urlState";
import { migratePinnedSessions, move } from "@/lib/sessionOrder";
import { failureLine, useDoneSessions, type ActivityDetail } from "@/lib/sessionActivity";
import { osNotify } from "@/lib/osNotify";
import { setFaviconStatus } from "@/lib/favicon";
import type { Project, SessionInfo, UpdateStatus } from "@/types";
import { Login } from "@/components/Login";
import { SessionSidebar, type SessionListTab, folderProgress, HeadingProgress } from "@/components/SessionSidebar";
import { AppSidebar, type SidebarTab } from "@/components/AppSidebar";
import { UpdateButton, UpdatingOverlay } from "@/components/UpdateButton";
import { FilesSidebar } from "@/components/FilesSidebar";
import { ServerFileViewer } from "@/components/ServerFileViewer";
import { ShellView } from "@/components/ShellView";
import { SessionView } from "@/components/SessionView";
import { NewSessionDialog } from "@/components/NewSessionDialog";
import { ForkSessionDialog } from "@/components/ForkSessionDialog";
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
  const [compactingIds, setCompactingIds] = useState<Set<string>>(() => new Set()); // compacting the conversation
  const [failedIds, setFailedIds] = useState<Set<string>>(() => new Set()); // last turn died on an API error
  // What the waiting/failed marks are about, keyed by session id — see SessionActivityDetail on the
  // server. Only the sessions with something to say are in here.
  const [activityDetail, setActivityDetail] = useState<Record<string, ActivityDetail>>({});
  const [streamUp, setStreamUp] = useState(false); // is the live session stream connected?
  // The updater's view of itself, from the hub snapshot (or the poll below when it's down).
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  // Revision of the server's shell set, pushed on the events hub. The open session watches it to
  // notice a shell opened or closed somewhere else — another browser, or the phone.
  const [shellsRev, setShellsRev] = useState(0);
  // Latched once an update starts installing, so the overlay survives the server going away — the
  // hub and the polls both fail while it's down, and this is what says "that's expected, wait".
  const [installing, setInstalling] = useState<string | null>(null); // build id being installed
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>(() =>
    readUrlState().panel === "files" ? "files" : "sessions"
  );
  const [listTab, setListTab] = useState<SessionListTab>("sessions"); // Sessions vs Recent list
  // Server file open in the main area, restored from the URL so a refresh comes back to it.
  const [openFile, setOpenFile] = useState<string | null>(() => readUrlState().open ?? null);
  // Folder whose shells fill the main area, opened from the Files tree. Restored from the URL like
  // openFile is, and mutually exclusive with it — each takes the main area from the other.
  const [shellFolder, setShellFolder] = useState<string | null>(() => readUrlState().shell ?? null);
  const [activeId, setActiveId] = useState<string | null>(() => readUrlState().session ?? null);
  const [newOpen, setNewOpen] = useState(false);
  const [newPreset, setNewPreset] = useState<RecentSession | null>(null);
  // Override for the dialog's "continue conversation" default; undefined = the dialog's own default.
  const [newDefaultContinue, setNewDefaultContinue] = useState<boolean | undefined>(undefined);
  // Project the create dialog was opened from ("+" on a project heading): its linked folders are
  // offered as picks in the dialog. Held by id and resolved from the live list, so a folder linked
  // in the meantime shows up.
  const [newProjectId, setNewProjectId] = useState<string | null>(null);
  // Restorable session the create dialog was opened from (see reopenAsNew): once the replacement
  // launches, that stale entry is forgotten so the same conversation isn't listed twice.
  const [newFromId, setNewFromId] = useState<string | null>(null);
  // Id of the session the fork popup is open for (it asks for a name, then branches its conversation).
  const [forkFromId, setForkFromId] = useState<string | null>(null);
  const [recents, setRecents] = useState<RecentSession[]>([]);
  // Projects (server-backed groupings of folders). Owned here rather than by the sidebar because the
  // sidebar is mounted twice — desktop column and mobile drawer — and both have to show the same set.
  const [projects, setProjects] = useState<Project[]>([]);
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

  const loadProjects = useCallback(async () => {
    try {
      setProjects(await api.getProjects());
    } catch {
      /* ignore — an unreachable project list just means no headings */
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
    // first live session, never a Restorable placeholder (it has no terminal yet). "Valid" has to
    // mean live, not merely present: a session stopped from its own tab stays in the list as a
    // closed row, and leaving the selection on it would strand the main area on the empty state —
    // with the row unhighlighted and ?session= still naming it, so a refresh landed there too.
    setActiveId((cur) =>
      cur && list.some((s) => s.id === cur && s.state !== "Restorable")
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

  // Mirror the server file open in the main area, so a refresh reopens it (and keeps it highlighted
  // in the Files tree). Per-tab state, hence the URL rather than localStorage.
  useEffect(() => {
    patchUrlState({ open: openFile ?? undefined });
  }, [openFile]);

  // Same for a folder's shells, so a refresh comes back to the shell that was open.
  useEffect(() => {
    patchUrlState({ shell: shellFolder ?? undefined });
  }, [shellFolder]);

  // Reflect the active session in the page title so browser tabs are tellable apart.
  useEffect(() => {
    const name = sessions.find((s) => s.id === activeId)?.name;
    document.title = name ? `${name} - Claude Web` : "Claude Web";
  }, [activeId, sessions]);

  // Sessions that finished something you haven't seen yet — the gap the green pulse leaves behind
  // when it simply stops. Owned here, beside the sets it is derived from, because the sidebar is
  // mounted twice (desktop column and mobile drawer) and a mark cleared in one has been seen in both.
  const { done: doneIds, markSeen } = useDoneSessions({
    sessions,
    busyIds,
    waitingIds,
    compactingIds,
    failedIds,
    // A file or a folder's shells take the main area from the session pane without touching the
    // selection, so `activeId` alone would clear the mark of a session you never actually saw.
    shownSessionId: openFile || shellFolder ? null : activeId,
    streamUp,
  });
  // One bag for the sets, so the sidebar takes a single prop instead of five parallel ones.
  const activityIds = useMemo(
    () => ({
      busy: busyIds,
      waiting: waitingIds,
      compacting: compactingIds,
      failed: failedIds,
      done: doneIds,
      detail: activityDetail,
    }),
    [busyIds, waitingIds, compactingIds, failedIds, doneIds, activityDetail]
  );

  // How much of everything running has finished — the count the headings carry, taken over the whole
  // list. It rides the Sessions tab, which is where it stays readable with the list scrolled away
  // from the work, or the sidebar showing Files.
  const totalProgress = useMemo(() => folderProgress(sessions, activityIds), [sessions, activityIds]);

  // Badge the favicon with the busiest state across *all* sessions, so a backgrounded tab shows at a
  // glance that something is happening. Waiting-on-you (amber) outranks working (green) here — unlike
  // the per-session sidebar dot — because it's the one asking for you to come back.
  // Compacting counts as busy here: a manual /compact runs from an idle prompt, so the hook-derived
  // busy set is empty throughout and the tab would otherwise claim nothing is happening.
  useEffect(() => {
    setFaviconStatus(
      waitingIds.size > 0 ? "waiting" : busyIds.size > 0 || compactingIds.size > 0 ? "busy" : "idle"
    );
  }, [busyIds, waitingIds, compactingIds]);

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
            compacting?: string[];
            failed?: string[];
            activity?: Record<string, ActivityDetail>;
            update?: UpdateStatus;
            shellsRev?: number;
          };
          applySessions(msg.sessions);
          setBusyIds(new Set(msg.busy));
          setWaitingIds(new Set(msg.waiting ?? []));
          setCompactingIds(new Set(msg.compacting ?? []));
          setFailedIds(new Set(msg.failed ?? []));
          setActivityDetail(msg.activity ?? {});
          // Only the revision travels; the open session re-fetches its own tabs when it moves (see
          // SessionView). A server that predates shells sends none, which reads as "never changed".
          setShellsRev(msg.shellsRev ?? 0);
          if (msg.update) {
            setUpdate(msg.update);
            // Another tab (or the tray) started the install: show the overlay here too rather than
            // letting this tab sit on a server that's about to disappear.
            if (msg.update.state === "Applying" && msg.update.staged)
              setInstalling(msg.update.staged.buildId);
          }
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

  // Updater status normally rides the hub snapshot. Read it once for a fast first paint, and keep a
  // slow poll going while the stream is down so a build staged meanwhile still surfaces. Stands down
  // once an install starts: the overlay owns the polling from there (and the server is going away).
  useEffect(() => {
    if (auth !== "authed" || installing) return;
    let alive = true;
    const load = async () => {
      try {
        const status = await api.getUpdate();
        if (alive) setUpdate(status);
      } catch {
        /* ignore — the button is non-critical */
      }
    };
    load();
    if (streamUp) return () => { alive = false; };
    const t = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [auth, streamUp, installing]);

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
    osNotify(
      newlyStuck.map((s) => ({
        id: s.id,
        title: `${s.name} — needs attention`,
        body: "Claude stopped recovering after repeated API errors.",
        tag: `watchdog-${s.id}`,
      })),
      openFromNotification
    );
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
    osNotify(
      newly.map((id) => ({
        id,
        title: `${sessions.find((x) => x.id === id)?.name ?? "Session"} — Claude needs your input`,
        // What it is blocked on, when the permission hook said — "Wants to run Bash: git push
        // --force" is a decision you can take from the notification itself.
        body: activityDetail[id]?.waitingOn ?? "Waiting on a prompt.",
        tag: `waiting-${id}`,
      })),
      openFromNotification
    );
  }, [waitingIds, sessions, activityDetail, auth]);

  // Notify when a turn newly ends on an API error rather than on an answer. It is the one ending
  // that looks exactly like nothing happening — the session goes quiet and stays quiet — so it is
  // also the one worth saying out loud; everything else you find by looking.
  const prevFailedRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (auth !== "authed") return;
    const prev = prevFailedRef.current;
    prevFailedRef.current = new Set(failedIds);
    if (prev === null) return; // first run: seed only

    // A session the watchdog is minding is about to retry the error by itself, so an alert here would
    // be about a problem already in hand — it has its own for when it gives up. Same rule as the push
    // notifier's, so the phone and the tab agree about which failures are worth interrupting you for.
    const newly = [...failedIds]
      .filter((id) => !prev.has(id))
      .map((id) => sessions.find((s) => s.id === id))
      .filter((s): s is SessionInfo => s !== undefined && !s.watchdogEnabled);
    osNotify(
      newly.map((s) => ({
        id: s.id,
        title: `${s.name} — Claude stopped early`,
        body: failureLine(activityDetail[s.id]),
        tag: `failed-${s.id}`,
      })),
      openFromNotification
    );
  }, [failedIds, sessions, activityDetail, auth]);

  // When a push notification is tapped while a window is already open, the service worker posts the
  // session id here so we can jump to it (the cold-open case is handled by readUrlState's ?session=).
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "open-session" && typeof e.data.sessionId === "string") {
        window.focus();
        setActiveId(e.data.sessionId);
        clearMainArea();
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
      // Pins used to be per-browser; hand any this browser still holds to the server, once. refresh()
      // then picks them up as SessionInfo.pinned like any other change.
      if (await migratePinnedSessions((id) => api.setPinned(id, true)).catch(() => false)) refresh();
    })();
    loadProjects();
  }, [auth, loadRecents, loadProjects, refresh]);

  // A Restorable entry has no live terminal, so never treat it as the active view.
  const active = sessions.find((s) => s.id === activeId && s.state !== "Restorable") ?? null;
  // The session the fork popup is open for, and — for the active session's header link — the one it
  // was forked from. Both resolved from the live list, so they stay current (or drop to null once the
  // session is gone).
  const forkFrom = sessions.find((s) => s.id === forkFromId) ?? null;
  const activeParent = active?.parentSessionId
    ? sessions.find((s) => s.id === active.parentSessionId) ?? null
    : null;

  function openNew(preset: RecentSession | null = null) {
    setNewPreset(preset);
    setNewProjectId(null);
    setNewDefaultContinue(undefined);
    setNewOpen(true);
  }

  // "+" on a project heading. No preset: a project isn't a launch preset, it's a set of folders to
  // choose between — the dialog fills the folder in itself when there is only one to choose.
  const newSessionInProject = useCallback((project: Project) => {
    setNewPreset(null);
    setNewProjectId(project.id);
    setNewDefaultContinue(false); // starting fresh, not resuming whatever ran there last
    setNewOpen(true);
    setSidebarOpen(false);
  }, []);

  function reuseRecent(r: RecentSession) {
    openNew(r);
    setSidebarOpen(false);
  }

  // Reopen a Restorable session through the create dialog instead of relaunching it straight away, so
  // the model/prompt/permissions can be adjusted first. The preset carries its conversation id, so the
  // dialog's "continue" resumes that exact conversation; the stale entry is forgotten once it starts.
  const reopenAsNew = useCallback((s: SessionInfo, preset: RecentSession) => {
    setNewPreset(preset);
    setNewDefaultContinue(undefined);
    setNewFromId(s.id);
    setNewOpen(true);
    setSidebarOpen(false);
  }, []);

  // Whatever the main area was showing — a server file, a folder's shells — gives way. Both are
  // opened from the Files tree and neither survives the other, or a session being selected.
  const clearMainArea = useCallback(() => {
    setOpenFile(null);
    setShellFolder(null);
  }, []);

  // Where a notification's click lands: the session it was about, with whatever had the main area
  // out of the way — the alert is asking you to look at that session, not at a file you left open.
  const openFromNotification = useCallback(
    (id: string) => {
      setActiveId(id);
      clearMainArea();
    },
    [clearMainArea]
  );

  // Open a server file (from the Files tab) in the main content area; close the mobile drawer.
  const openServerFile = useCallback((path: string) => {
    setShellFolder(null);
    setOpenFile(path);
    setSidebarOpen(false);
  }, []);

  // Open a folder's shells (the terminal action on a Files-tree folder) in the main content area.
  const openFolderShell = useCallback((path: string) => {
    setOpenFile(null);
    setShellFolder(path);
    setSidebarOpen(false);
  }, []);

  // Reveal the open file in the Files tree: switch the sidebar to the Files tab (which expands and
  // scrolls to openFile) and open the mobile drawer so it's visible on small screens.
  const revealInFiles = useCallback(() => {
    setSidebarTab("files");
    setSidebarOpen(true);
  }, []);

  // The same move for a session's folder, from its row menu. The Files tab lists every drive, so
  // walking down to a session's working directory by hand is the long way round to somewhere the
  // app already knows. The token makes a second ask for the same folder count: by then the tree has
  // usually been scrolled somewhere else, and going back is the whole point of asking again.
  const [revealDir, setRevealDir] = useState<string | null>(null);
  const [revealDirToken, setRevealDirToken] = useState(0);
  const revealFolderInFiles = useCallback((dir: string) => {
    setRevealDir(dir);
    setRevealDirToken((n) => n + 1);
    setSidebarTab("files");
    setSidebarOpen(true);
  }, []);

  // The request lives only as long as the visit it was made for. The Files panel unmounts whenever
  // the sidebar shows Sessions, so a request left standing would fire again on the way back and drag
  // the tree off whatever the user had since selected.
  useEffect(() => {
    if (sidebarTab !== "files") setRevealDir(null);
  }, [sidebarTab]);

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
    // The clone runs alongside the original, so it should start a fresh conversation, not steal
    // (or fork) the live session's one.
    setNewDefaultContinue(false);
    setNewOpen(true);
    setSidebarOpen(false);
  }, []);

  // Fork a session: open the popup that asks what to call the branch. Tracked by id (not the object)
  // so the popup keeps seeing the session as the live stream updates it.
  const forkSession = useCallback((s: SessionInfo) => {
    setForkFromId(s.id);
    setSidebarOpen(false);
  }, []);

  // Start a new session in a folder picked from the Files tab: open the create dialog prefilled with
  // that working directory (defaults for everything else).
  const newSessionInFolder = useCallback((path: string) => {
    setNewProjectId(null);
    setNewPreset({
      workingDirectory: path,
      name: "",
      command: "",
      model: "",
      remoteControl: true,
      permissionMode: "auto",
    });
    // "New session in this folder" means starting fresh there, not resuming whatever ran last.
    setNewDefaultContinue(false);
    setNewOpen(true);
    setSidebarOpen(false);
  }, []);

  // Selecting a session takes over the main area, so drop whatever was filling it.
  const selectSession = useCallback((id: string) => {
    setActiveId(id);
    clearMainArea();
  }, [clearMainArea]);

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
    clearMainArea(); // the new session takes over the main area, like selecting one does
    // Launching can start from the Files tab or the Recent list; pull both sidebar levels back to the
    // session list so the new session is visible and shown as selected.
    setSidebarTab("sessions");
    setListTab("sessions");
    setSidebarOpen(false);
    loadRecents(); // the dialog just saved this launch as a recent preset (server-side)
  }

  /**
   * Close a session, leaving the row where it is: still in its project and folder, still reopenable.
   * Stopping is about the process, not about the place the work happened — so this is also how a
   * session that already died on its own is put away, which is the only way such a row keeps its
   * place in the list. Taking it out of the list altogether is `onRemove` below, from the same menu,
   * once it is sitting there closed.
   */
  async function onStop(id: string) {
    const s = sessions.find((x) => x.id === id);
    if (!s || s.state === "Restorable") return;
    // Only a live process is worth asking about. A session that has already exited loses nothing
    // here — the row stays, and Reopen is one click away — so the click is the whole decision.
    if (s.state === "Running") {
      const ok = await confirm({
        title: "Stop session?",
        description: (
          <>
            This kills the <span className="font-medium text-foreground">{s.name}</span> process
            {s.remoteControl && " and ends its Remote Control session in the Claude Code app"}. The
            session stays in the list and can be reopened.
          </>
        ),
        confirmLabel: "Stop",
      });
      if (!ok) return;
    }
    const stopped = await api.stopSession(id).catch(() => null);
    // Only on success. Drawing the row as closed after a failed call would be a lie with claude still
    // running behind it, and the row would then offer a Reopen that does nothing. On failure the list
    // is left as it is; the stream and the poll both carry the truth within a few seconds.
    if (!stopped) return;
    // Otherwise take the server's own row straight away rather than waiting for the hub's next frame,
    // so it settles the moment the dialog goes.
    setSessions((prev) => prev.map((x) => (x.id === id ? stopped : x)));
  }

  /** Remove a session from the list for good. It lands in the Recent tab as a launch preset. */
  async function onRemove(id: string) {
    const s = sessions.find((x) => x.id === id);
    // A session still running has to be stopped to be removed, and that is worth asking about; an
    // already-closed row is cheap to undo from the Recent tab, so it just goes.
    if (s?.state === "Running") {
      const ok = await confirm({
        title: "Remove session?",
        description: (
          <>
            This kills the <span className="font-medium text-foreground">{s?.name}</span> process
            {s?.remoteControl && " and ends its Remote Control session in the Claude Code app"}, and
            takes the session out of the list. It stays in the Recent tab.
          </>
        ),
        confirmLabel: "Remove",
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
      {/* Covers the app while the server is replaced and restarted; reloads once the new build answers. */}
      {installing && <UpdatingOverlay targetBuildId={installing} />}
      {/* Sidebar: static column on desktop (collapsible + resizable), slide-over drawer on mobile. */}
      <aside
        className={cn("relative hidden shrink-0 border-r md:block", collapsed && "md:hidden")}
        style={{ width: sidebarWidth }}
      >
        <AppSidebar
          tab={sidebarTab}
          onTabChange={setSidebarTab}
          onNew={() => openNew()}
          onCollapse={toggleCollapsed}
          update={<UpdateButton status={update} onApplying={setInstalling} />}
          sessionsProgress={<HeadingProgress done={totalProgress.done} active={totalProgress.active} />}
          sessions={
            <SessionSidebar
              sessions={sessions}
              activityIds={activityIds}
              onMarkSeen={markSeen}
              activeId={activeId}
              onSelect={selectSession}
              onNewInFolder={newSessionInFolder}
              onRevealFolder={revealFolderInFiles}
              onNewInProject={newSessionInProject}
              onStop={onStop}
              onRemove={onRemove}
              onClone={cloneSession}
              onFork={forkSession}
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
              projects={projects}
              onProjectsChange={setProjects}
            />
          }
          files={
            <FilesSidebar
              openPath={openFile}
              revealDir={revealDir}
              revealToken={revealDirToken}
              onOpenFile={openServerFile}
              onNewSession={newSessionInFolder}
              onOpenShell={openFolderShell}
            />
          }
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
          <aside className="absolute left-0 top-0 h-full w-72 border-r border-popover-border shadow-xl">
            <AppSidebar
              tab={sidebarTab}
              onTabChange={setSidebarTab}
              onNew={() => {
                openNew();
                setSidebarOpen(false);
              }}
              update={<UpdateButton status={update} onApplying={setInstalling} />}
              sessionsProgress={<HeadingProgress done={totalProgress.done} active={totalProgress.active} />}
              sessions={
                <SessionSidebar
                  sessions={sessions}
                  activityIds={activityIds}
                  onMarkSeen={markSeen}
                  activeId={activeId}
                  onSelect={(id) => {
                    selectSession(id);
                    setSidebarOpen(false);
                  }}
                  onNewInFolder={newSessionInFolder}
                  onRevealFolder={revealFolderInFiles}
                  onNewInProject={newSessionInProject}
                  onStop={onStop}
                  onRemove={onRemove}
                  onClone={cloneSession}
                  onFork={forkSession}
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
                  projects={projects}
                  onProjectsChange={setProjects}
                />
              }
              files={
                <FilesSidebar
                  openPath={openFile}
                  revealDir={revealDir}
                  revealToken={revealDirToken}
                  onOpenFile={openServerFile}
                  onNewSession={newSessionInFolder}
                  onOpenShell={openFolderShell}
                />
              }
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
        ) : shellFolder ? (
          <ShellView
            folder={shellFolder}
            shellsRev={shellsRev}
            onClose={() => setShellFolder(null)}
            onReveal={revealFolderInFiles}
            onToggleSidebar={() => setSidebarOpen(true)}
            collapsed={collapsed}
            onToggleCollapsed={toggleCollapsed}
          />
        ) : active ? (
          <SessionView
            session={active}
            // Compaction is work too: the postponed pool must not flush a stashed message into the
            // terminal mid-compact, and a manual /compact leaves the hook-derived busy set empty.
            busy={busyIds.has(active.id) || compactingIds.has(active.id)}
            parent={activeParent}
            shellsRev={shellsRev}
            onFork={forkSession}
            onSelectSession={selectSession}
            onToggleSidebar={() => setSidebarOpen(true)}
            collapsed={collapsed}
            onToggleCollapsed={toggleCollapsed}
            onStopped={(info) => setSessions((prev) => prev.map((s) => (s.id === info.id ? info : s)))}
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
            update={<UpdateButton status={update} onApplying={setInstalling} />}
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

      {forkFrom && (
        <ForkSessionDialog
          parent={forkFrom}
          sessions={sessions}
          onForked={onCreated}
          onClose={() => setForkFromId(null)}
        />
      )}

      <NewSessionDialog
        open={newOpen}
        onOpenChange={(o) => {
          setNewOpen(o);
          if (!o) {
            setNewPreset(null); // clear preset so the next plain "New session" starts fresh
            setNewProjectId(null);
            setNewDefaultContinue(undefined);
            setNewFromId(null); // dismissed without launching — keep the Restorable entry as it is
          }
        }}
        onCreated={onCreated}
        preset={newPreset}
        project={projects.find((p) => p.id === newProjectId) ?? null}
        projects={projects}
        defaultContinue={newDefaultContinue}
      />
    </div>
  );
}

function EmptyState({
  onNew,
  onOpenSidebar,
  collapsed,
  onToggleCollapsed,
  update,
}: {
  onNew: () => void;
  onOpenSidebar: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  update?: ReactNode; // "Update available" button; renders nothing unless a build is staged
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
        {update}
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
