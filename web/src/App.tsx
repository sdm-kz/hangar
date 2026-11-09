import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, apiFor, getToken, setToken, sessionsStreamUrl } from "@/lib/api";
import { NodeProvider, sessionKey, setHomeNodeId, splitSessionKey } from "@/lib/node";
import {
  EMPTY_SNAPSHOT,
  liveSnap,
  peerError,
  usePeers,
  type MeshNodeMessage,
  type SelfNode,
} from "@/lib/nodeStream";
import { presetFromSession, type RecentSession } from "@/lib/recentSessions";
import { migrateLegacyRecents } from "@/lib/migrateRecents";
import { carryChatView, chatViewOf } from "@/lib/chatView";
import { guardFileDrops } from "@/lib/attach";
import { readUrlState, patchUrlState, SSH_SHELLS } from "@/lib/urlState";
import { migratePinnedSessions, move } from "@/lib/sessionOrder";
import { forkDescendants } from "@/lib/sessionTree";
import { countsInTotals, failureLine, useDoneSessions, type ActivityDetail, type ActivityIds } from "@/lib/sessionActivity";
import { osNotify } from "@/lib/osNotify";
import { setFaviconStatus } from "@/lib/favicon";
import { projectForDir } from "@/lib/projects";
import type { Project, RemoteConnection, SessionInfo, SessionNotice, SessionRemote, ShellInfo, UpdateStatus } from "@/types";
import { Login } from "@/components/Login";
import {
  SessionSidebar,
  type PeerSidebar,
  type SessionListTab,
  type SessionReveal,
  folderProgress,
} from "@/components/SessionSidebar";
import { ACTIVITY_MARK, activityDetail as activityDetailOf, sessionActivity } from "@/components/ActivityMark";
import { AppSidebar, type SidebarTab } from "@/components/AppSidebar";
import { UpdateButton, UpdatingOverlay } from "@/components/UpdateButton";
import { FilesSidebar } from "@/components/FilesSidebar";
import { remoteFileSource, ServerFileViewer } from "@/components/ServerFileViewer";
import { FilesTab } from "@/components/FilesTab";
import { ShellView, type ShellFocus, type ShellTarget } from "@/components/ShellView";
import { ShellsPanel, useAllShells } from "@/components/ShellsPanel";
import { SshShellDialog } from "@/components/SshShellDialog";
import { SessionView } from "@/components/SessionView";
import { NewSessionDialog } from "@/components/NewSessionDialog";
import { ForkSessionDialog } from "@/components/ForkSessionDialog";
import { CarryDialog, type CarryMode } from "@/components/CarryDialog";
import { matchFolder } from "@/lib/carry";
import { ScheduleDialog } from "@/components/ScheduleDialog";
import { type LaunchNode } from "@/components/NodePicker";
import { isOverdue } from "@/lib/schedules";
import { SessionSearchDialog } from "@/components/SessionSearch";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { cn } from "@/lib/utils";
import { Loader2, Menu, Plus } from "lucide-react";
import { MobileSessionsProgress, ShowSidebarButton } from "@/components/ShowSidebarButton";
import { SessionsProgressContext, SessionsProgressMenu } from "@/components/SessionsProgressMenu";
import { combineShellMarks, shellMark, useShellsSeen, type ShellActivity, type ShellMark } from "@/lib/shellActivity";
import logo from "@/assets/hangar-logo.png";

type AuthStatus = "loading" | "authed" | "anon";

// Desktop sidebar width bounds (px). Default matches the old fixed w-72 (18rem).
const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 560;
const SIDEBAR_DEFAULT = 288;
// The machine the Files tab was left on: a peer's id, absent for this one.
const FILES_NODE_KEY = "hangar.filesNode";
const FILES_REMOTE_KEY = "hangar.filesRemote";

function readSidebarWidth() {
  const n = Number(localStorage.getItem("hangar.sidebarWidth"));
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
  // Shells Claude left running when its turn ended, by session, with how many.
  const [backgroundIds, setBackgroundIds] = useState<Map<string, number>>(() => new Map());
  // Something typed into claude's input box and not sent. Not an activity, so not in the bag below.
  const [draftIds, setDraftIds] = useState<Set<string>>(() => new Set());
  // What the waiting/failed marks are about, keyed by session id — see SessionActivityDetail on the
  // server. Only the sessions with something to say are in here.
  const [activityDetail, setActivityDetail] = useState<Record<string, ActivityDetail>>({});
  const [streamUp, setStreamUp] = useState(false); // is the live session stream connected?
  // This node as its stream names it, and every peer's live picture riding the same stream: the server's
  // NodeMesh follows each peer and passes its snapshot on (plans/multi-node.md §5).
  const [selfNode, setSelfNode] = useState<SelfNode | null>(null);
  const mesh = usePeers();
  const ingestPeers = mesh.ingest;
  // The updater's view of itself, from the hub snapshot (or the poll below when it's down).
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  // Revision of the server's shell set, pushed on the events hub. The open session watches it to
  // notice a shell opened or closed somewhere else — another browser, or the phone.
  const [shellsRev, setShellsRev] = useState(0);
  // Same for the projects. They change under this browser without it asking — the server files a
  // child session into its host's project as it launches — and the list itself is too rarely touched
  // to be worth pushing in full, so the revision is the signal to re-read it.
  const [projectsRev, setProjectsRev] = useState(0);
  // What the commands in the session shells are doing, from the same snapshot: a running command, or
  // how the last one ended. Null until the first snapshot, so nothing is pruned on an empty guess.
  const [shellActivity, setShellActivity] = useState<Record<string, ShellActivity> | null>(null);
  // What this node's sessions asked to tell you lately (POST /api/self/notify).
  const [notices, setNotices] = useState<SessionNotice[]>([]);
  // Latched once an update starts installing, so the overlay survives the server going away — the
  // hub and the polls both fail while it's down, and this is what says "that's expected, wait".
  const [installing, setInstalling] = useState<string | null>(null); // build id being installed
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>(() => readUrlState().panel ?? "sessions");
  const [listTab, setListTab] = useState<SessionListTab>("sessions"); // Sessions vs Recent list
  // Server file open in the main area, restored from the URL so a refresh comes back to it.
  const [openFile, setOpenFile] = useState<string | null>(() => readUrlState().open ?? null);
  // The node `openFile` is on: a peer's, when it was opened from one of that node's sessions or from its
  // disk in the Files tab. Only this
  // node's files go into the URL — `open` has no node of its own to say which disk it means.
  const [openFileNode, setOpenFileNode] = useState<string | null>(null);
  // Or the SSH connection `openFile` is on, when it was opened from one in the Files tab. Kept out of the
  // URL like a peer's file: a refresh would have to connect again before it could show it.
  const [openFileRemote, setOpenFileRemote] = useState<SessionRemote | null>(null);
  // Its source, made once per connection: the viewer reloads the file whenever the source changes.
  const openRemoteId = openFileRemote?.id;
  const openRemoteSource = useMemo(() => (openRemoteId ? remoteFileSource(api, openRemoteId) : null), [openRemoteId]);
  // The machine whose disk the Files tab shows: null for this one. A per-browser preference, like the
  // tree's own state, so the tab comes back on the machine it was left on.
  const [filesNode, setFilesNode] = useState<string | null>(() => {
    try {
      return localStorage.getItem(FILES_NODE_KEY);
    } catch {
      return null;
    }
  });
  // Or the saved SSH connection it shows instead of a machine's disk (see FilesTab); remembered the same way.
  const [filesRemote, setFilesRemote] = useState<string | null>(() => {
    try {
      return localStorage.getItem(FILES_REMOTE_KEY);
    } catch {
      return null;
    }
  });
  // Shells filling the main area: a folder's (opened from the Files tree or the Shells tab), or the
  // SSH connections. Restored from the URL like openFile is, and mutually exclusive with it — each
  // takes the main area from the other. `focus` is a tab to bring forward, picked in the Shells tab.
  const [shellView, setShellView] = useState<{ target: ShellTarget; focus: ShellFocus | null } | null>(() => {
    const v = readUrlState().shell;
    return v ? { target: v === SSH_SHELLS ? { ssh: true } : { folder: v }, focus: null } : null;
  });
  // A session's shell picked in the Shells tab, to be brought forward in that session's tab bar.
  const [revealShell, setRevealShell] = useState<{ sessionId: string; focus: ShellFocus } | null>(null);
  // A session just started, reopened or forked, for the sessions list to unfold down to and scroll to.
  const [revealSession, setRevealSession] = useState<SessionReveal | null>(null);
  const showInList = (node: string | null, id: string) =>
    setRevealSession((cur) => ({ node, id, n: (cur?.n ?? 0) + 1 }));
  const focusSeq = useRef(0);
  const [sshDialog, setSshDialog] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(() => readUrlState().session ?? null);
  // The node `activeId` is on: null for this one, a peer's id for a session reached through it
  // (plans/multi-node.md). Every way of picking one of this node's sessions puts it back to null.
  const [activeNode, setActiveNode] = useState<string | null>(() => readUrlState().node ?? null);
  const activeNodeRef = useRef(activeNode);
  activeNodeRef.current = activeNode;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  // The selection as this node's own lists see it: a peer's session isn't one of their rows, even when
  // its id happens to match one.
  const homeActiveId = activeNode ? null : activeId;
  // Tell the rest of the page this node's id, for what it says to other nodes about this one.
  useEffect(() => setHomeNodeId(selfNode?.id ?? null), [selfNode]);
  // A link naming this node by its own id (one copied from a peer's page, where this node is a peer) is a
  // link to one of this node's sessions: it opens here, as if it named no node at all.
  useEffect(() => {
    if (!selfNode || activeNode !== selfNode.id) return;
    // Not a switch to another session — the same one, named the way this node names it — so the URL keeps
    // whatever else the link said (the file to open in it).
    urlSessionRef.current = activeIdRef.current ?? "";
    setActiveNode(null);
  }, [selfNode, activeNode]);
  // A file dropped where nothing takes it would otherwise open in place of the app.
  useEffect(() => guardFileDrops(), []);
  const [newOpen, setNewOpen] = useState(false);
  const [newPreset, setNewPreset] = useState<RecentSession | null>(null);
  // Override for the dialog's "continue conversation" default; undefined = the dialog's own default.
  const [newDefaultContinue, setNewDefaultContinue] = useState<boolean | undefined>(undefined);
  // The view the dialog's session opens on, when it reopens one (see reopenAsNew); undefined = the dialog's own.
  const [newDefaultChat, setNewDefaultChat] = useState<boolean | undefined>(undefined);
  // Project the create dialog was opened from ("+" on a project heading): its linked folders are
  // offered as picks in the dialog. Held by id and resolved from the live list, so a folder linked
  // in the meantime shows up.
  const [newProjectId, setNewProjectId] = useState<string | null>(null);
  // Restorable session the create dialog was opened from (see reopenAsNew): once the replacement
  // launches, that stale entry is forgotten so the same conversation isn't listed twice.
  const [newFromId, setNewFromId] = useState<string | null>(null);
  // The machine the create dialog launches on (null: this one) — where it was opened from, until another
  // is picked in it. The project and the restorable entry above are of the machine they came from.
  const [newNode, setNewNode] = useState<string | null>(null);
  const [newOrigin, setNewOrigin] = useState<string | null>(null);
  // Id of the session the fork popup is open for (it asks for a name, then branches its conversation).
  const [forkFromId, setForkFromId] = useState<string | null>(null);
  // A session's work being taken to another machine: the session (by id, on `from`), and the machine picked.
  const [carry, setCarry] = useState<{ id: string; from: string | null; mode: CarryMode; node: string | null } | null>(null);
  // ...and its node: a fork stays on the parent's node, where its conversation's transcript is.
  const [forkFromNode, setForkFromNode] = useState<string | null>(null);
  const [recents, setRecents] = useState<RecentSession[]>([]);
  // Projects (server-backed groupings of folders). Owned here rather than by the sidebar because the
  // sidebar is mounted twice — desktop column and mobile drawer — and both have to show the same set.
  const [projects, setProjects] = useState<Project[]>([]);
  // Search popup over sessions + recents. Owned here (not by the sidebar) so the hotkey below works
  // with the sidebar collapsed, and so the two sidebar instances don't each mount a dialog.
  const [searching, setSearching] = useState(false);
  // The schedules popup. Owned here for the same reason the search one is: the sidebar is mounted
  // twice (desktop column + mobile drawer), so a dialog it owned would exist twice over. A non-null
  // `target` opens it straight on a new schedule that continues that conversation.
  // ...and the machine whose schedules it shows (null: this one).
  const [scheduling, setScheduling] = useState<
    { target: { conversationId: string; name: string } | null; node: string | null } | null
  >(null);
  const [sidebarOpen, setSidebarOpen] = useState(false); // mobile drawer
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("hangar.sidebarCollapsed") === "1"
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
      localStorage.setItem("hangar.sidebarWidth", String(width));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const toggleCollapsed = () =>
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem("hangar.sidebarCollapsed", next ? "1" : "0");
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
    // Keep a valid current selection (e.g. restored from the URL) — a closed session included: it
    // opens on its files and its diff, with the terminal replaced by the button that reopens it, so
    // a session stopped from its own tab stays where it was instead of throwing the main area back
    // to the empty state. Nothing is picked on anyone's behalf: the app opened on its bare address,
    // or a selection that has gone away, leaves the main area empty until a session is chosen.
    // A peer's session is not in this list, and isn't this list's to correct.
    if (activeNodeRef.current) return;
    setActiveId((cur) => (cur && list.some((s) => s.id === cur) ? cur : null));
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
  const urlSessionRef = useRef(sessionKey(activeNode, activeId ?? ""));
  useEffect(() => {
    const key = sessionKey(activeNode, activeId ?? "");
    const switched = urlSessionRef.current !== key;
    urlSessionRef.current = key;
    patchUrlState({
      node: activeNode ?? undefined,
      session: activeId ?? undefined,
      ...(switched && { file: undefined }),
    });
  }, [activeId, activeNode]);

  // Mirror the sidebar tab so a refresh (or a new-tab deep link) restores the Files view.
  useEffect(() => {
    patchUrlState({ panel: sidebarTab === "sessions" ? undefined : sidebarTab });
  }, [sidebarTab]);

  // Mirror the server file open in the main area, so a refresh reopens it (and keeps it highlighted
  // in the Files tree). Per-tab state, hence the URL rather than localStorage.
  useEffect(() => {
    patchUrlState({ open: (!openFileNode && !openFileRemote && openFile) || undefined });
  }, [openFile, openFileNode, openFileRemote]);

  // Same for a folder's shells (or the SSH ones), so a refresh comes back to the shell that was open.
  const shellParam = shellView ? ("folder" in shellView.target ? shellView.target.folder : SSH_SHELLS) : undefined;
  useEffect(() => {
    patchUrlState({ shell: shellParam });
  }, [shellParam]);

  // Reflect the active session in the page title so browser tabs are tellable apart.
  // (`active`, below, is whichever node's session is open.)

  // Sessions that finished something you haven't seen yet — the gap the green pulse leaves behind
  // when it simply stops. Owned here, beside the sets it is derived from, because the sidebar is
  // mounted twice (desktop column and mobile drawer) and a mark cleared in one has been seen in both.
  // Which session's terminal is on screen, as its view reports it. Selecting a session is not the
  // same as looking at its terminal: on its pull request or a file, the terminal is a tab away, and a
  // turn that finished there has not been seen.
  // Held as a sessionKey: a peer's session view reports it too.
  const [terminalShownKey, setTerminalShownKey] = useState<string | null>(null);
  const onTerminalShown = useCallback((key: string, shown: boolean) => {
    setTerminalShownKey((cur) => (shown ? key : cur === key ? null : cur));
  }, []);
  const onPeerTerminalShown = useCallback(
    (id: string, shown: boolean) => onTerminalShown(sessionKey(activeNode, id), shown),
    [activeNode, onTerminalShown]
  );
  const activeKey = activeId ? sessionKey(activeNode, activeId) : null;

  // Every machine's sessions as one list, each under its sessionKey (a session of this node keeps its
  // bare id) — what the finished ticks, the alerts, the favicon and the sessions-progress menu are worked
  // out over, so a peer's session ticks, alerts and counts like one of this node's.
  const everywhere = useMemo(() => {
    const out = {
      sessions: [...sessions],
      busy: new Set(busyIds),
      waiting: new Set(waitingIds),
      compacting: new Set(compactingIds),
      failed: new Set(failedIds),
      background: new Map(backgroundIds),
      detail: { ...activityDetail } as Record<string, ActivityDetail>,
      // Each with its session keyed as the rest are, and its own id prefixed the same way: a notice id is
      // only unique on the machine that minted it.
      notices: notices.map((n) => ({ ...n, key: n.id })),
      // The machines whose sessions are in it: "" for this one, and every peer online.
      nodes: new Set([""]),
    };
    for (const p of mesh.peers) {
      const snap = liveSnap(p);
      if (!snap) continue;
      out.nodes.add(p.id);
      const key = (id: string) => sessionKey(p.id, id);
      for (const s of snap.sessions) out.sessions.push({ ...s, id: key(s.id) });
      for (const id of snap.busy) out.busy.add(key(id));
      for (const id of snap.waiting) out.waiting.add(key(id));
      for (const id of snap.compacting) out.compacting.add(key(id));
      for (const id of snap.failed) out.failed.add(key(id));
      for (const [id, n] of snap.background) out.background.set(key(id), n);
      for (const n of snap.notices) out.notices.push({ ...n, sessionId: key(n.sessionId), key: key(n.id) });
      for (const [id, d] of Object.entries(snap.activity)) out.detail[key(id)] = d;
    }
    return out;
  }, [sessions, busyIds, waitingIds, compactingIds, failedIds, backgroundIds, activityDetail, notices, mesh.peers]);

  // A session's machine is in `everywhere` — this one always; a peer once the stream has named the peers and
  // it is online.
  const peersKnown = mesh.known;
  const isListed = useCallback(
    (key: string) => {
      const { node } = splitSessionKey(key);
      return node === null || (peersKnown && everywhere.nodes.has(node));
    },
    [peersKnown, everywhere]
  );
  const { done: doneKeys, markSeen } = useDoneSessions({
    sessions: everywhere.sessions,
    busyIds: everywhere.busy,
    waitingIds: everywhere.waiting,
    compactingIds: everywhere.compacting,
    failedIds: everywhere.failed,
    backgroundIds: everywhere.background,
    // A file or a folder's shells take the main area from the session pane without touching the
    // selection, so `activeId` alone would clear the mark of a session you never actually saw.
    shownSessionId: openFile || shellView || terminalShownKey !== activeKey ? null : activeKey,
    streamUp,
    isListed,
  });
  // This node's ticks are the keys without a node in them.
  const doneIds = useMemo(() => new Set([...doneKeys].filter((k) => !k.includes(":"))), [doneKeys]);
  // One bag for the sets, so the sidebar takes a single prop instead of five parallel ones.
  const activityIds = useMemo(
    () => ({
      busy: busyIds,
      waiting: waitingIds,
      compacting: compactingIds,
      failed: failedIds,
      background: backgroundIds,
      done: doneIds,
      detail: activityDetail,
    }),
    [busyIds, waitingIds, compactingIds, failedIds, backgroundIds, doneIds, activityDetail]
  );

  // Every shell there is, for the Shells tab and the count on it.
  const allShells = useAllShells(shellsRev, auth === "authed");

  // The same bag over every machine, keyed as `everywhere` is.
  const everywhereIds = useMemo(
    () => ({
      busy: everywhere.busy,
      waiting: everywhere.waiting,
      compacting: everywhere.compacting,
      failed: everywhere.failed,
      background: everywhere.background,
      done: doneKeys,
      detail: everywhere.detail,
    }),
    [everywhere, doneKeys]
  );

  // Each peer's bag, by node id, in its own ids — what its tree in the sidebar and its open session read.
  const peerActivity = useMemo(() => {
    const map = new Map<string, ActivityIds>();
    for (const p of mesh.peers) {
      const snap = liveSnap(p);
      if (!snap) continue;
      const prefix = `${p.id}:`;
      map.set(p.id, {
        busy: snap.busy,
        waiting: snap.waiting,
        compacting: snap.compacting,
        failed: snap.failed,
        background: snap.background,
        done: new Set([...doneKeys].flatMap((k) => (k.startsWith(prefix) ? [k.slice(prefix.length)] : []))),
        detail: snap.activity,
      });
    }
    return map;
  }, [mesh.peers, doneKeys]);

  // How much of everything running has finished — the count the headings carry, taken over the whole
  // list, every machine's. It rides the Sessions tab, which is where it stays readable with the list
  // scrolled away from the work, or the sidebar showing Files.
  const totalProgress = useMemo(
    () => folderProgress(everywhere.sessions, everywhereIds),
    [everywhere, everywhereIds]
  );
  const nodeNames = useMemo(() => Object.fromEntries(mesh.peers.map((p) => [p.id, p.name])), [mesh.peers]);

  // Badge the favicon with the busiest state across *all* sessions, so a backgrounded tab shows at a
  // glance that something is happening. Waiting-on-you (amber) outranks working (green) here — unlike
  // the per-session sidebar dot — because it's the one asking for you to come back.
  // Compacting counts as busy here: a manual /compact runs from an idle prompt, so the hook-derived
  // busy set is empty throughout and the tab would otherwise claim nothing is happening.
  // A session whose activity is paused is left out, as the headings leave it out (countsInTotals).
  useEffect(() => {
    const counted = new Set(everywhere.sessions.filter(countsInTotals).map((s) => s.id));
    const any = (ids: Set<string>) => [...ids].some((id) => counted.has(id));
    const { waiting, busy, compacting } = everywhere;
    setFaviconStatus(any(waiting) ? "waiting" : any(busy) || any(compacting) ? "busy" : "idle");
  }, [everywhere]);

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
            background?: Record<string, number>;
            drafts?: string[];
            activity?: Record<string, ActivityDetail>;
            update?: UpdateStatus;
            shellsRev?: number;
            projectsRev?: number;
            shells?: Record<string, ShellActivity>;
            notices?: SessionNotice[];
            node?: SelfNode;
            nodes?: MeshNodeMessage[];
          };
          applySessions(msg.sessions);
          // Who this node is, and its peers as the mesh holds them. A server from before nodes sends
          // neither, which reads as "no peers".
          const me = msg.node;
          if (me?.id)
            setSelfNode((cur) =>
              cur && cur.id === me.id && cur.name === me.name && cur.color === (me.color ?? null) && cur.os === (me.os ?? null)
                ? cur
                : { id: me.id, name: me.name, color: me.color ?? null, os: me.os ?? null }
            );
          ingestPeers(msg.nodes);
          setBusyIds(new Set(msg.busy));
          setWaitingIds(new Set(msg.waiting ?? []));
          setCompactingIds(new Set(msg.compacting ?? []));
          setFailedIds(new Set(msg.failed ?? []));
          setBackgroundIds(new Map(Object.entries(msg.background ?? {})));
          setDraftIds(new Set(msg.drafts ?? []));
          setActivityDetail(msg.activity ?? {});
          // Kept as the same array while nothing new arrives, so the effect that raises them stays put.
          const nextNotices = msg.notices ?? [];
          setNotices((cur) =>
            cur.length === nextNotices.length && cur.every((n, i) => n.id === nextNotices[i].id) ? cur : nextNotices
          );
          // Only the revision travels; the open session re-fetches its own tabs when it moves (see
          // SessionView). A server that predates shells sends none, which reads as "never changed".
          setShellsRev(msg.shellsRev ?? 0);
          setProjectsRev(msg.projectsRev ?? 0);
          // Kept as the same object while nothing in it changes: every snapshot is a fresh parse, and
          // the marks it feeds sit on every sidebar row.
          const shells = msg.shells ?? {};
          setShellActivity((cur) => (cur && JSON.stringify(cur) === JSON.stringify(shells) ? cur : shells));
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
  }, [auth, applySessions, ingestPeers]);

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
  //
  // Over every machine's sessions, keyed as `everywhere` is. A peer is seeded the way the page is: what it
  // already had going when it came online (or when this page first heard of it) isn't news.
  //
  // None before the stream has said which node this is: the tag carries it (see alertTag), and an alert
  // tagged without it wouldn't replace the push about the same thing on this device.
  const wdStatusRef = useRef<{ status: Map<string, string>; nodes: Set<string> } | null>(null);
  useEffect(() => {
    if (auth !== "authed" || !selfNode) return;
    const prev = wdStatusRef.current;
    wdStatusRef.current = {
      status: new Map(everywhere.sessions.map((s) => [s.id, s.watchdogStatus])),
      nodes: everywhere.nodes,
    };
    if (prev === null) return; // first run: seed only, don't fire for already-stuck sessions

    const newlyStuck = everywhere.sessions.filter(
      (s) => s.watchdogStatus === "attention" && prev.status.get(s.id) !== "attention" && wasListed(s.id, prev.nodes)
    );
    osNotify(
      newlyStuck.map((s) => ({
        id: s.id,
        title: `${alertName(s)} — needs attention`,
        body: "Claude stopped recovering after repeated API errors.",
        tag: alertTag("watchdog", s.id),
      })),
      openFromNotification
    );
  }, [everywhere, auth, selfNode]);

  // Notify when a session newly starts waiting on a prompt (idle -> waiting), mirroring the watchdog
  // "attention" alert. Compare against the previous set so we only fire on the transition, and seed
  // on first run so a session already waiting at page load doesn't alert.
  const prevWaitingRef = useRef<{ ids: Set<string>; nodes: Set<string> } | null>(null);
  useEffect(() => {
    if (auth !== "authed" || !selfNode) return;
    const prev = prevWaitingRef.current;
    prevWaitingRef.current = { ids: new Set(everywhere.waiting), nodes: everywhere.nodes };
    if (prev === null) return; // first run: seed only

    const newly = [...everywhere.waiting].filter((key) => !prev.ids.has(key) && wasListed(key, prev.nodes));
    osNotify(
      newly.map((key) => {
        const s = everywhere.sessions.find((x) => x.id === key);
        return {
          id: key,
          title: `${s ? alertName(s) : "Session"} — Claude needs your input`,
          // What it is blocked on, when the permission hook said — "Wants to run Bash: git push
          // --force" is a decision you can take from the notification itself.
          body: everywhere.detail[key]?.waitingOn ?? "Waiting on a prompt.",
          tag: alertTag("waiting", key),
        };
      }),
      openFromNotification
    );
  }, [everywhere, auth, selfNode]);

  // Notify when a turn newly ends on an API error rather than on an answer. It is the one ending
  // that looks exactly like nothing happening — the session goes quiet and stays quiet — so it is
  // also the one worth saying out loud; everything else you find by looking.
  const prevFailedRef = useRef<{ ids: Set<string>; nodes: Set<string> } | null>(null);
  useEffect(() => {
    if (auth !== "authed" || !selfNode) return;
    const prev = prevFailedRef.current;
    prevFailedRef.current = { ids: new Set(everywhere.failed), nodes: everywhere.nodes };
    if (prev === null) return; // first run: seed only

    // A session the watchdog is minding is about to retry the error by itself, so an alert here would
    // be about a problem already in hand — it has its own for when it gives up. Same rule as the push
    // notifier's, so the phone and the tab agree about which failures are worth interrupting you for.
    const newly = [...everywhere.failed]
      .filter((key) => !prev.ids.has(key) && wasListed(key, prev.nodes))
      .map((key) => everywhere.sessions.find((s) => s.id === key))
      .filter((s): s is SessionInfo => s !== undefined && !s.watchdogEnabled);
    osNotify(
      newly.map((s) => ({
        id: s.id,
        title: `${alertName(s)} — Claude stopped early`,
        body: failureLine(everywhere.detail[s.id]),
        tag: alertTag("failed", s.id),
      })),
      openFromNotification
    );
  }, [everywhere, auth, selfNode]);

  // Raise what a session asked to tell you (POST /api/self/notify), each notice once. Seeded on the first
  // frame like the alerts above, so a reload doesn't replay the last few minutes' worth; a peer's are
  // seeded the same way when it comes online. Tagged like the push of the same notice, so a device that
  // gets both shows one.
  const shownNoticesRef = useRef<{ keys: Set<string>; nodes: Set<string> } | null>(null);
  useEffect(() => {
    if (auth !== "authed" || !selfNode) return;
    const prev = shownNoticesRef.current;
    // Only the notices in this frame: one that has aged out of the hub's few minutes never comes back.
    shownNoticesRef.current = { keys: new Set(everywhere.notices.map((n) => n.key)), nodes: everywhere.nodes };
    if (prev === null) return; // first run: seed only

    const fresh = everywhere.notices.filter((n) => !prev.keys.has(n.key) && wasListed(n.key, prev.nodes));
    osNotify(
      fresh.map((n) => {
        const s = everywhere.sessions.find((x) => x.id === n.sessionId);
        const name = s ? alertName(s) : "Session";
        const { node, id } = splitSessionKey(n.key);
        return {
          id: n.sessionId,
          title: n.title ? `${name} — ${n.title}` : name,
          body: n.message,
          tag: `notice-${node ?? selfNode.id}:${id}`,
        };
      }),
      openFromNotification
    );
  }, [everywhere, auth, selfNode]);

  // When a push notification is tapped while a window is already open, the service worker posts the
  // session id here so we can jump to it (the cold-open case is handled by readUrlState's ?session=).
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "open-session" && typeof e.data.sessionId === "string") {
        window.focus();
        // A peer's session, when this node relayed the alert for it (see sw.js); taken only as a node id.
        const node = typeof e.data.node === "string" && /^[A-Za-z0-9]{1,64}$/.test(e.data.node) ? e.data.node : null;
        setActiveNode(node);
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

  // Re-read the projects whenever the server says they moved (see ProjectStore.Revision). Mostly they
  // move because this browser asked — and it replaced its own list from that response already, so the
  // re-read agrees with what is on screen — but a child session joining its host's project is the
  // server's own doing, and nothing else would tell this list about it. The first snapshot after a
  // connect carries whatever the revision is now, which is why this skips the value it starts at.
  const knownProjectsRev = useRef<number | null>(null);
  useEffect(() => {
    if (auth !== "authed" || projectsRev === knownProjectsRev.current) return;
    const first = knownProjectsRev.current === null;
    knownProjectsRev.current = projectsRev;
    // The first snapshot only says where the revision stands; the load above already read the list at
    // that point. Anything after it is a change this browser has to go and read. (A server restart
    // takes the revision back to 0, which reads as a change and re-reads — which is right: the list
    // it holds came from the server that went away.)
    if (!first) loadProjects();
  }, [auth, projectsRev, loadProjects]);

  // A closed session is a view like any other — the folder it worked in outlives the process, and
  // that is what the Files tree, the diff and the reviews are reading. Only the terminal is missing,
  // and SessionView puts the Reopen button where it would have been.
  // A peer's session comes from that node's snapshot on this node's own stream; this node's from the list above.
  const activePeer = activeNode ? mesh.peers.find((p) => p.id === activeNode) : undefined;
  // Its last snapshot while it is away, so an open session isn't torn down by a blip.
  const remote = {
    ...(activePeer?.snap ?? EMPTY_SNAPSHOT),
    loaded: !!activePeer?.snap,
    // Until the stream has said who the peers are, a node not among them isn't "unknown" yet.
    error: activeNode && mesh.known ? peerError(activePeer) : null,
  };
  const remoteActivityIds = (activeNode && peerActivity.get(activeNode)) || NO_ACTIVITY;
  // The shells' marks: which finished commands this browser has looked at, and from that what each
  // session's shells together have to say on its sidebar row.
  const { seen: shellsSeen, markSeen: markShellSeen } = useShellsSeen(
    shellActivity,
    activeNode,
    remote.shellActivity
  );
  const shellMarks = useMemo(() => marksBySession(shellActivity, (id) => shellsSeen[id]), [shellActivity, shellsSeen]);
  // The same for each peer's rows: its shells' activity off its snapshot, what was seen of them kept here
  // under node:id.
  const peerShellMarks = useMemo(
    () =>
      new Map(
        mesh.peers.map((p) => [
          p.id,
          marksBySession(p.snap?.shellActivity ?? null, (id) => shellsSeen[sessionKey(p.id, id)]),
        ])
      ),
    [mesh.peers, shellsSeen]
  );
  // A peer's shells, as its open session's view knows them: by their own ids, kept here under node:id.
  const peerShellsSeen = useMemo(() => {
    if (!activeNode) return shellsSeen;
    const prefix = `${activeNode}:`;
    return Object.fromEntries(
      Object.entries(shellsSeen).flatMap(([k, v]) => (k.startsWith(prefix) ? [[k.slice(prefix.length), v]] : []))
    );
  }, [activeNode, shellsSeen]);
  const markPeerShellSeen = useCallback(
    (id: string, endedAt: number) => markShellSeen(sessionKey(activeNode, id), endedAt),
    [activeNode, markShellSeen]
  );
  const viewSessions = activeNode ? remote.sessions : sessions;
  const viewActivityIds = activeNode ? remoteActivityIds : activityIds;
  const active = viewSessions.find((s) => s.id === activeId) ?? null;
  useEffect(() => {
    document.title = active?.name ? `${active.name} - Hangar` : "Hangar";
  }, [active?.name]);
  // The open session's own mark, for its Terminal tab -- the same reading as its row's corner, and
  // like the row, none for a closed session. Its branch's activity stays in the sidebar: the tab is
  // this session's terminal, not its forks'.
  const activeActivity = active && active.state !== "Restorable" ? sessionActivity(active, viewActivityIds) : null;
  const activeActivityLabel = activeActivity
    ? (activityDetailOf(activeActivity, active!.id, viewActivityIds) ?? ACTIVITY_MARK[activeActivity].label)
    : undefined;
  // The session the fork popup is open for, and — for the active session's header link — the one it
  // was forked from. Both resolved from the live list, so they stay current (or drop to null once the
  // session is gone).
  const forkSessions = forkFromNode ? sessionsOf(forkFromNode) : sessions;
  const forkFrom = forkSessions.find((s) => s.id === forkFromId) ?? null;
  const carrySource = carry ? (sessionsOf(carry.from).find((s) => s.id === carry.id) ?? null) : null;
  const activeParent = active?.parentSessionId
    ? viewSessions.find((s) => s.id === active.parentSessionId) ?? null
    : null;

  /** Open the create dialog on a machine (null: this one) — the one whatever it was opened from is on. */
  const openOn = (node: string | null) => {
    setNewNode(node);
    setNewOrigin(node);
  };

  function openNew(preset: RecentSession | null = null, node: string | null = null) {
    openOn(node);
    setNewPreset(preset);
    setNewProjectId(null);
    setNewDefaultContinue(undefined);
    setNewDefaultChat(undefined);
    setNewOpen(true);
  }

  // "+" on a project heading. No preset: a project isn't a launch preset, it's a set of folders to
  // choose between — the dialog fills the folder in itself when there is only one to choose.
  const newSessionInProject = useCallback((project: Project, node: string | null = null) => {
    openOn(node);
    setNewPreset(null);
    setNewProjectId(project.id);
    setNewDefaultContinue(false); // starting fresh, not resuming whatever ran there last
    setNewDefaultChat(undefined);
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
    openOn(s.nodeId ?? null);
    setNewProjectId(null);
    setNewPreset(preset);
    setNewDefaultContinue(undefined);
    setNewDefaultChat(chatViewOf(sessionKey(s.nodeId ?? null, s.id)));
    setNewFromId(s.id);
    setNewOpen(true);
    setSidebarOpen(false);
  }, []);

  // Whatever the main area was showing — a server file, a folder's shells — gives way. Both are
  // opened from the Files tree and neither survives the other, or a session being selected.
  const clearMainArea = useCallback(() => {
    setOpenFile(null);
    setOpenFileNode(null);
    setShellView(null);
  }, []);

  // Where a notification's click lands: the session it was about, with whatever had the main area
  // out of the way — the alert is asking you to look at that session, not at a file you left open.
  // Given the session's key: the alerts are raised over every machine's.
  const openFromNotification = useCallback(
    (key: string) => {
      const { node, id } = splitSessionKey(key);
      setActiveNode(node);
      setActiveId(id);
      clearMainArea();
    },
    [clearMainArea]
  );

  // A notification's tag: by node as well as session, the same as the server's push (PushNotifier), so the
  // one a phone gets from the server and the one this tab raises are the same notification.
  function alertTag(kind: string, key: string): string {
    const { node, id } = splitSessionKey(key);
    return `${kind}-${node ?? selfNode!.id}:${id}`;
  }
  // A peer's session says which machine it is on.
  function alertName(s: SessionInfo): string {
    const { node } = splitSessionKey(s.id);
    return node ? `${nodeNames[node] ?? "Another machine"} · ${s.name}` : s.name;
  }

  /**
   * The machines something can be started on, this one first: a peer only while it is online and has a
   * claude to start (plans/multi-node.md §7). Just this one when there are no peers, and the pickers hide.
   */
  const launchNodes = useMemo<LaunchNode[]>(
    () => [
      { id: null, name: selfNode?.name ?? "This machine", color: selfNode?.color ?? null, os: selfNode?.os ?? null, unavailable: null },
      ...mesh.peers.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        os: p.os,
        unavailable:
          p.status !== "online"
            ? p.status === "connecting"
              ? "connecting…"
              : "not reachable right now"
            : p.canLaunch === false
              ? "claude isn't found there"
              : null,
      })),
    ],
    [selfNode, mesh.peers]
  );

  // Which machines have a schedule overdue, asked of each once the schedules popup opens: the one the
  // popup shows says so in its list, but one machine's broken autologin must not hide behind another's
  // green while it shows the other.
  const [overdueNodes, setOverdueNodes] = useState<Set<string>>(() => new Set());
  const schedulesOpen = !!scheduling;
  // The machines to ask: asked again when one comes online with the popup open (just after the page
  // loads, say). None to ask on a single machine, whose popup shows its one list anyway.
  const onlinePeers = mesh.peers.filter((p) => p.status === "online").map((p) => p.id).join(",");
  useEffect(() => {
    if (!schedulesOpen || !onlinePeers) return;
    let gone = false;
    const ids = [null, ...onlinePeers.split(",")];
    void Promise.all(
      ids.map((id) =>
        attempt(() => apiFor(id).getSchedules()).then((list) => (list?.some(isOverdue) ? [id ?? ""] : []))
      )
    ).then((found) => !gone && setOverdueNodes(new Set(found.flat())));
    return () => {
      gone = true;
    };
  }, [schedulesOpen, onlinePeers]);
  const scheduleNodes = useMemo(
    () =>
      launchNodes.map((n) => ({
        ...n,
        // Its schedules can be read and fixed whether or not its claude is found — only a machine that
        // can't be reached has none to show.
        unavailable: n.id && mesh.peers.find((p) => p.id === n.id)?.status !== "online" ? n.unavailable : null,
        warning: overdueNodes.has(n.id ?? "") ? "a schedule is overdue" : null,
      })),
    [launchNodes, overdueNodes, mesh.peers]
  );

  /**
   * The machines a session's work can be taken to: any but its own. From a peer, only to this one — the
   * machine it goes to reads the session's through its own pairing, and asked from here it reads back from
   * here only (one hop); another peer can be reached from that peer's own page.
   */
  const carryNodes = useMemo<LaunchNode[]>(() => {
    const from = carry?.from ?? null;
    return launchNodes
      .filter((n) => n.id !== from)
      .map((n) => ({
        ...n,
        unavailable: n.unavailable ?? (from && n.id ? `only from ${n.name}'s own page` : null),
      }));
  }, [launchNodes, carry?.from]);

  const carrySession = useCallback(
    (s: SessionInfo, mode: CarryMode) => {
      const from = s.nodeId ?? null;
      // To the first machine it can go to; this one first, as the pickers list it.
      const to = launchNodes.find((n) => n.id !== from && !n.unavailable && (!from || !n.id));
      setCarry({ id: s.id, from, mode, node: to ? to.id : (launchNodes.find((n) => n.id !== from)?.id ?? null) });
      setSidebarOpen(false);
    },
    [launchNodes]
  );
  // Offered only with somewhere to take it.
  const onCarry = mesh.peers.length > 0 ? carrySession : undefined;

  /** A node's projects: this one's, or a peer's off the mesh. */
  function projectsOf(node: string | null): Project[] {
    return node ? (mesh.peers.find((p) => p.id === node)?.snap?.projects ?? []) : projects;
  }

  /** A node's sessions: this one's list, or a peer's off the mesh (none while it can't be reached). */
  function sessionsOf(node: string | null): SessionInfo[] {
    return node ? (mesh.peers.find((p) => p.id === node)?.snap?.sessions ?? []) : sessions;
  }

  // Open a server file (from the Files tab, on the machine it shows) in the main content area; close the
  // mobile drawer.
  const openServerFile = useCallback((path: string, node: string | null = null) => {
    setShellView(null);
    setOpenFileNode(node);
    setOpenFileRemote(null);
    setOpenFile(path);
    setSidebarOpen(false);
  }, []);

  // The same from a session's view: the file is on that session's node.
  const openSessionServerFile = useCallback((path: string) => {
    setShellView(null);
    setOpenFileNode(activeNodeRef.current);
    setOpenFileRemote(null);
    setOpenFile(path);
    setSidebarOpen(false);
  }, []);

  // A file of an SSH connection picked in the Files tab, read over that connection (this node holds it).
  const openRemoteFile = useCallback((remote: SessionRemote, path: string) => {
    setShellView(null);
    setOpenFileNode(null);
    setOpenFileRemote(remote);
    setOpenFile(path);
    setSidebarOpen(false);
  }, []);

  // Open a folder's shells (the terminal action on a Files-tree folder) in the main content area.
  const openFolderShell = useCallback((path: string) => {
    setOpenFile(null);
    setShellView({ target: { folder: path }, focus: null });
    setSidebarOpen(false);
  }, []);

  // Reveal the open file in the Files tree: switch the sidebar to the Files tab, on the file's machine
  // (which expands and scrolls to openFile), and open the mobile drawer so it's visible on small screens.
  const revealInFiles = useCallback(() => {
    if (openFileRemote) pickFilesRemote(openFileRemote.connection.id);
    else pickFilesNode(openFileNode);
    setSidebarTab("files");
    setSidebarOpen(true);
  }, [openFileNode, openFileRemote]);

  // The same move for a session's folder, from its row menu. The Files tab lists every drive, so
  // walking down to a session's working directory by hand is the long way round to somewhere the
  // app already knows. The token makes a second ask for the same folder count: by then the tree has
  // usually been scrolled somewhere else, and going back is the whole point of asking again.
  const [revealDir, setRevealDir] = useState<string | null>(null);
  const [revealDirToken, setRevealDirToken] = useState(0);
  const revealFolderInFiles = useCallback((dir: string, node: string | null = null) => {
    pickFilesNode(node);
    setRevealDir(dir);
    setRevealDirToken((n) => n + 1);
    setSidebarTab("files");
    setSidebarOpen(true);
  }, []);

  // Switch the Files tab to a machine's disk, and remember it.
  function pickFilesNode(node: string | null) {
    pickFilesRemote(null);
    setFilesNode(node);
    try {
      if (node) localStorage.setItem(FILES_NODE_KEY, node);
      else localStorage.removeItem(FILES_NODE_KEY);
    } catch {
      /* storage disabled — preference is best-effort */
    }
  }

  // Or to a saved SSH connection (null: back to the machine), likewise remembered.
  const pickFilesRemote = useCallback((id: string | null) => {
    setFilesRemote(id);
    try {
      if (id) localStorage.setItem(FILES_REMOTE_KEY, id);
      else localStorage.removeItem(FILES_REMOTE_KEY);
    } catch {
      /* storage disabled — preference is best-effort */
    }
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
    openOn(s.nodeId ?? null);
    setNewProjectId(null);
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
    setNewDefaultChat(undefined);
    setNewOpen(true);
    setSidebarOpen(false);
  }, []);

  // Fork a session: open the popup that asks what to call the branch. Tracked by id (not the object)
  // so the popup keeps seeing the session as the live stream updates it.
  const forkSession = useCallback((s: SessionInfo) => {
    setForkFromId(s.id);
    setForkFromNode(s.nodeId ?? null);
    setSidebarOpen(false);
  }, []);

  // Start a new session in a folder picked from the Files tab: open the create dialog prefilled with
  // that working directory (defaults for everything else).
  const newSessionInFolder = useCallback((path: string, node: string | null = null) => {
    openOn(node);
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
    setNewDefaultChat(undefined);
    setNewOpen(true);
    setSidebarOpen(false);
  }, []);

  // Selecting a session takes over the main area, so drop whatever was filling it.
  const selectSession = useCallback((id: string, node: string | null = null) => {
    setActiveNode(node);
    setActiveId(id);
    clearMainArea();
  }, [clearMainArea]);

  // The running-sessions fraction and the sessions behind it, for its dropdown wherever it is worn —
  // every machine's, under their keys.
  const sessionsProgress = useMemo(
    () => ({
      ...totalProgress,
      sessions: everywhere.sessions,
      nodeNames,
      activityIds: everywhereIds,
      activeId: activeKey,
      // From the phone's drawer too, where picking a session puts the drawer away as a row does.
      onSelect: (key: string) => {
        const { node, id } = splitSessionKey(key);
        selectSession(id, node);
        setSidebarOpen(false);
      },
      onMarkSeen: markSeen,
    }),
    [totalProgress, everywhere, nodeNames, everywhereIds, activeKey, selectSession, markSeen]
  );

  // A shell picked in the Shells tab, brought forward wherever it lives: its session's tab bar, its
  // folder's shell view, or the SSH view.
  const openShell = useCallback(
    (s: ShellInfo) => {
      const focus = { id: s.id, n: ++focusSeq.current };
      if (s.sessionId) {
        setActiveNode(null);
        setActiveId(s.sessionId);
        clearMainArea();
        setRevealShell({ sessionId: s.sessionId, focus });
      } else {
        setOpenFile(null);
        setShellView({ target: s.kind === "ssh" ? { ssh: true } : { folder: s.workingDirectory }, focus });
      }
      setSidebarOpen(false);
    },
    [clearMainArea]
  );

  const closeShellView = useCallback(() => setShellView(null), []);
  // Done with once the session has shown it: SessionView remounts on every return to the session,
  // and a request still standing would drag it back to that shell each time.
  const clearRevealShell = useCallback(() => setRevealShell(null), []);

  // Open an SSH connection as a terminal (the Shells tab, or the SSH view's "+") and show it. A
  // failure is thrown back to the dialog, which says why and stays open.
  const connectSsh = useCallback(
    async (connection: RemoteConnection) => {
      const created = await api.createShell({ workingDirectory: "", ssh: connection });
      setSshDialog(false);
      openShell(created);
    },
    [openShell]
  );

  async function removeRecent(r: RecentSession) {
    const next = await api.removeRecentSession(r).catch(() => null);
    if (next) setRecents(next.sessions);
  }

  /** A session launched on `node` (null: this one) — from the create dialog, or a fork of one of this node's. */
  function onCreated(s: SessionInfo, node: string | null = null) {
    // Reopened a Restorable entry through the dialog: the new session took its place, so forget it — on
    // the machine it is on, and only if the new one went there too (one launched elsewhere took nothing's
    // place: the conversation it would resume is on the first machine).
    const replaced = newOrigin === node ? newFromId : null;
    setNewFromId(null);
    if (replaced) void attempt(() => apiFor(node).deleteSession(replaced));
    // Idempotent add: the live stream may already have pushed this new session before the create
    // response returns, so drop any existing copy of its id before appending to avoid a duplicate row.
    if (node) {
      if (replaced) mesh.dropSessions(node, [replaced]);
      mesh.patchSession(node, s);
    } else setSessions((prev) => [...prev.filter((x) => x.id !== s.id && x.id !== replaced), s]);
    setActiveNode(node);
    setActiveId(s.id);
    showInList(node, s.id);
    clearMainArea(); // the new session takes over the main area, like selecting one does
    // Launching can start from the Files tab or the Recent list; pull both sidebar levels back to the
    // session list so the new session is visible and shown as selected.
    setSidebarTab("sessions");
    setListTab("sessions");
    setSidebarOpen(false);
    if (!node) loadRecents(); // the dialog just saved this launch as a recent preset (server-side)
  }

  /**
   * Close a session, leaving the row where it is: still in its project and folder, still reopenable.
   * Stopping is about the process, not about the place the work happened — so this is also how a
   * session that already died on its own is put away, which is the only way such a row keeps its
   * place in the list. Taking it out of the list altogether is `onRemove` below, from the same menu,
   * once it is sitting there closed.
   *
   * `withChildren` closes every session nested under it too, at any depth — the ones a closed parent
   * still has running included.
   */
  async function onStop(id: string, node: string | null = null, withChildren = false) {
    const all = sessionsOf(node);
    const s = all.find((x) => x.id === id);
    if (!s) return;
    const targets = (withChildren ? [s, ...forkDescendants(all, id)] : [s]).filter((x) => x.state !== "Restorable");
    if (targets.length === 0) return;
    // Only a live process is worth asking about. A session that has already exited loses nothing
    // here — the row stays, and Reopen is one click away — so the click is the whole decision.
    const running = targets.filter((x) => x.state === "Running");
    if (running.length > 0) {
      const name = <span className="font-medium text-foreground">{s.name}</span>;
      const under = running.filter((x) => x.id !== s.id).length;
      const nestedRunning = under === 1 ? "the session" : `the ${under} sessions`;
      const ok = await confirm({
        title: running.length === 1 ? "Stop session?" : `Stop ${running.length} sessions?`,
        description: withChildren ? (
          <>
            This kills the processes of{" "}
            {s.state !== "Running" ? (
              <>
                {nestedRunning} running under {name}
              </>
            ) : under > 0 ? (
              <>
                {name} and {nestedRunning} running under it
              </>
            ) : (
              name
            )}
            {running.some((x) => x.remoteControl) && ", and ends their Remote Control sessions in the Claude Code app"}.
            They stay in the list and can be reopened.
          </>
        ) : (
          <>
            This kills the {name} process
            {s.remoteControl && " and ends its Remote Control session in the Claude Code app"}. The
            session stays in the list and can be reopened.
          </>
        ),
        confirmLabel: "Stop",
      });
      if (!ok) return;
    }
    const client = apiFor(node);
    const stopped = (await Promise.all(targets.map((x) => attempt(() => client.stopSession(x.id))))).filter(
      (x): x is SessionInfo => !!x
    );
    // Only the ones that succeeded. Drawing a row as closed after a failed call would be a lie with
    // claude still running behind it, and the row would then offer a Reopen that does nothing. A failed
    // one is left as it is; the stream and the poll both carry the truth within a few seconds.
    if (stopped.length === 0) return;
    // The rest take the server's own row straight away rather than waiting for the hub's next frame,
    // so they settle the moment the dialog goes.
    if (node) for (const x of stopped) mesh.patchSession(node, x);
    else {
      const byId = new Map(stopped.map((x) => [x.id, x]));
      setSessions((prev) => prev.map((x) => byId.get(x.id) ?? x));
    }
  }

  /**
   * Remove a session from the list for good. It lands in the Recent tab as a launch preset.
   * `withChildren` takes every session nested under it out too, at any depth.
   */
  async function onRemove(id: string, node: string | null = null, withChildren = false) {
    const all = sessionsOf(node);
    const s = all.find((x) => x.id === id);
    if (withChildren && s) {
      const branch = [s, ...forkDescendants(all, id)];
      const running = branch.filter((x) => x.state === "Running").length;
      // Always asked, unlike one closed row: it is several at once, and some of them may be off
      // screen in a folded branch or behind the active-only filter.
      const ok = await confirm({
        title: `Remove ${branch.length} sessions?`,
        description: (
          <>
            This takes <span className="font-medium text-foreground">{s.name}</span> and the{" "}
            {branch.length - 1 === 1 ? "session" : `${branch.length - 1} sessions`} nested under it out of
            the list{running > 0 && `, killing the ${running === 1 ? "one" : running} still running`}. They
            stay in the Recent tab.
          </>
        ),
        confirmLabel: "Remove",
      });
      if (ok) await onRemoveSessions(branch.map((x) => x.id), node);
      return;
    }
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
    await attempt(() => apiFor(node).deleteSession(id));
    if (node) mesh.dropSessions(node, [id]);
    else setSessions((prev) => prev.filter((s) => s.id !== id));
    // That node's session only: another node's open one with the same id stays open.
    if (activeNodeRef.current === node) leaveRemoved(new Set([id]));
    // The server saved the removed session as a preset — show it in the Recent tab (this node's).
    if (!node) loadRecents();
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
  async function onRestore(id: string, node: string | null = null) {
    const s = sessionsOf(node).find((x) => x.id === id);
    const ok = await confirm({
      title: "Reopen session?",
      description: (
        <>
          Relaunch <span className="font-medium text-foreground">{s?.name}</span>
          {node && " on its node"} and resume{" "}
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
    const created = await attempt(() => apiFor(node).restoreSession(id));
    if (!created) return;
    carryChatView(sessionKey(node, id), sessionKey(node, created.id));
    // Drop the old Restorable entry AND any copy of the new session the live stream may have already
    // pushed (the push can beat this response), so the reopened session appears exactly once.
    if (node) {
      mesh.dropSessions(node, [id]);
      mesh.patchSession(node, created);
    } else setSessions((prev) => [...prev.filter((s) => s.id !== id && s.id !== created.id), created]);
    // Node and id together: wherever the view has gone meanwhile, this is a session it can show.
    setActiveNode(node);
    setActiveId(created.id);
    showInList(node, created.id);
    setSidebarOpen(false);
  }

  // Bulk-remove sessions (from a folder group's remove popup). The popup is the confirmation, so we
  // just delete each and prune local state. deleteSession stops running processes and forgets the rest.
  async function onRemoveSessions(ids: string[], node: string | null = null) {
    if (ids.length === 0) return;
    const set = new Set(ids);
    const client = apiFor(node);
    await Promise.all(ids.map((id) => attempt(() => client.deleteSession(id))));
    if (node) mesh.dropSessions(node, ids);
    else setSessions((prev) => prev.filter((s) => !set.has(s.id)));
    if (activeNodeRef.current === node) leaveRemoved(set);
    if (!node) loadRecents(); // each removed session is saved as a preset server-side; refresh the Recent tab
  }

  // Rename a session from the sidebar or the details header. Optimistically update the name, then
  // persist; the server also injects `/rename` into the live terminal so Claude renames itself too.
  async function onRename(id: string, name: string, node: string | null = null) {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (node) mesh.updateSession(node, id, { name: trimmed });
    else setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, name: trimmed } : s)));
    await attempt(() => apiFor(node).renameSession(id, trimmed));
  }

  /**
   * The open session was among those just removed (on the node it is on): let it go. A peer's goes back to
   * this node, with nothing selected — as after removing one of its own — rather than leaving "no such
   * session" on that node where the view was.
   */
  function leaveRemoved(ids: Set<string>) {
    const cur = activeIdRef.current;
    if (!cur || !ids.has(cur)) return;
    setActiveNode(null);
    setActiveId(null);
  }

  // A session started on another machine with a conversation carried there: shown and opened there.
  function onCarried(s: SessionInfo, node: string | null) {
    if (node) mesh.patchSession(node, s);
    else setSessions((prev) => [...prev.filter((x) => x.id !== s.id), s]);
    setActiveNode(node);
    setActiveId(s.id);
    showInList(node, s.id);
    clearMainArea();
  }

  // A fork of a peer's session, made on that node.
  function onForkedRemote(s: SessionInfo) {
    if (forkFromNode) mesh.patchSession(forkFromNode, s);
    setActiveNode(forkFromNode);
    setActiveId(s.id);
    showInList(forkFromNode, s.id);
    clearMainArea();
  }

  // Each peer's tree in the sidebar, with the actions above bound to its node. `onPicked` is what else
  // picking a session does where the sidebar is mounted — the phone's drawer goes away.
  const peerSidebars = (onPicked?: () => void): PeerSidebar[] =>
    mesh.peers.map((p) => ({
      peer: p,
      // Nothing while it is away: its tree isn't drawn then, and the toolbar's counts are of what is live.
      sessions: liveSnap(p)?.sessions ?? [],
      activityIds: peerActivity.get(p.id) ?? NO_ACTIVITY,
      draftIds: p.snap?.drafts,
      shellMarks: peerShellMarks.get(p.id),
      onMarkSeen: (ids) => markSeen([...ids].map((id) => sessionKey(p.id, id))),
      activeId: activeNode === p.id ? activeId : null,
      onSelect: (id) => {
        selectSession(id, p.id);
        onPicked?.();
      },
      onStop: (id, withChildren) => void onStop(id, p.id, withChildren),
      onRemove: (id, withChildren) => void onRemove(id, p.id, withChildren),
      onFork: forkSession,
      onRestore: (id) => void onRestore(id, p.id),
      onRename: (id, name) => void onRename(id, name, p.id),
      onRemoveSessions: (ids) => void onRemoveSessions(ids, p.id),
      onNewInFolder: (dir) => newSessionInFolder(dir, p.id),
      onRevealFolder: (dir) => revealFolderInFiles(dir, p.id),
      onNewInProject: (project) => newSessionInProject(project, p.id),
      onClone: cloneSession,
      onSchedules: (target) => setScheduling({ target: target ?? null, node: p.id }),
      onCarry,
      onNew: () => {
        openNew(null, p.id);
        onPicked?.();
      },
      projects: p.snap?.projects ?? [],
      onProjectsChange: (projects) => mesh.setProjects(p.id, projects),
    }));

  async function onLogout() {
    await api.logout();
    setAuth("anon");
    setSessions([]);
    mesh.reset();
    setSelfNode(null);
    setActiveNode(null);
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

  // The Files tab, for both the desktop column and the mobile drawer: one machine's disk at a time, picked
  // above the tree once there are peers. A peer's is read through it, as its sessions' files are; one no
  // longer paired falls back to this machine's.
  const filesAt = filesNode && (!mesh.known || mesh.peers.some((p) => p.id === filesNode)) ? filesNode : null;
  const filesNodes: LaunchNode[] = launchNodes.map((n) => {
    const peer = n.id ? mesh.peers.find((p) => p.id === n.id) : null;
    return { ...n, unavailable: peer && peer.status !== "online" ? "not reachable right now" : null };
  });
  const filesPanel = (
    <FilesTab
      nodes={filesNodes}
      node={filesAt}
      onPickNode={(node) => {
        // A folder still waiting to be revealed is on the machine it was asked for, not this one.
        setRevealDir(null);
        pickFilesNode(node);
      }}
      remoteId={filesRemote}
      onPickRemote={pickFilesRemote}
      openRemote={openFile && openFileRemote ? { tab: openFileRemote.id, path: openFile } : null}
      onOpenRemoteFile={openRemoteFile}
      onCloseRemoteFile={() => setOpenFile(null)}
      machineTree={
        <NodeProvider node={filesAt}>
          <FilesSidebar
            // Each machine's tree is its own: switching mounts the other's, with its own remembered state.
            key={filesAt ?? ""}
            openPath={openFile && !openFileRemote && openFileNode === filesAt ? openFile : null}
            revealDir={revealDir}
            revealToken={revealDirToken}
            onOpenFile={(path) => openServerFile(path, filesAt)}
            onNewSession={(path) => newSessionInFolder(path, filesAt)}
            // A folder's shells are this machine's; a peer's are opened from its own page.
            onOpenShell={filesAt ? undefined : openFolderShell}
          />
        </NodeProvider>
      }
    />
  );

  // The Shells tab, for both the desktop column and the mobile drawer.
  const shellsPanel = (
    <ShellsPanel
      shells={allShells}
      sessions={sessions}
      shellActivity={shellActivity}
      shellsSeen={shellsSeen}
      shown={shellView ? shellView.target : active && !activeNode && !openFile ? { sessionId: active.id } : null}
      defaultFolder={
        shellView && "folder" in shellView.target
          ? shellView.target.folder
          : active && !activeNode && !openFile
            ? active.workingDirectory
            : undefined
      }
      onOpen={openShell}
      onOpenFolder={openFolderShell}
      onSelectSession={(id) => {
        selectSession(id);
        setSidebarOpen(false);
      }}
      onNewSsh={() => setSshDialog(true)}
    />
  );

  return (
    // Feeds the Sessions tab's fraction and, with the sidebar collapsed, each view's "Show sidebar".
    <SessionsProgressContext.Provider value={sessionsProgress}>
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
            onLogout={onLogout}
            update={<UpdateButton status={update} onApplying={setInstalling} />}
            sessionsProgress={<SessionsProgressMenu triggerClassName="px-1 py-0.5" />}
            sessions={
              <SessionSidebar
                sessions={sessions}
                activityIds={activityIds}
                draftIds={draftIds}
                shellMarks={shellMarks}
                onMarkSeen={markSeen}
                activeId={homeActiveId}
                onSelect={selectSession}
                self={selfNode}
                peers={peerSidebars()}
                onNewHere={() => openNew()}
                reveal={revealSession}
                onNewInFolder={newSessionInFolder}
                onRevealFolder={revealFolderInFiles}
                onNewInProject={newSessionInProject}
                onStop={(id, withChildren) => void onStop(id, null, withChildren)}
                onRemove={(id, withChildren) => void onRemove(id, null, withChildren)}
                onClone={cloneSession}
                onFork={forkSession}
                onRestore={onRestore}
                onRename={onRename}
                onRemoveSessions={onRemoveSessions}
                recents={recents}
                onReuse={reuseRecent}
                onRemoveRecent={removeRecent}
                onReorderRecent={reorderRecents}
                onSearch={() => setSearching(true)}
                onSchedules={(target) => setScheduling({ target: target ?? null, node: null })}
                onCarry={onCarry}
                tab={listTab}
                onTabChange={setListTab}
                projects={projects}
                onProjectsChange={setProjects}
              />
            }
            files={filesPanel}
            shells={shellsPanel}
            shellsCount={allShells?.length}
          />
          {/* Drag handle straddling the right border. */}
          <div
            onPointerDown={startResize}
            onDoubleClick={() => {
              setSidebarWidth(SIDEBAR_DEFAULT);
              localStorage.setItem("hangar.sidebarWidth", String(SIDEBAR_DEFAULT));
            }}
            title="Drag to resize · double-click to reset"
            className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-primary/20 active:bg-primary/30"
          />
        </aside>

        {sidebarOpen && (
          <div className="fixed inset-0 z-40 md:hidden">
            <div className="absolute inset-0 bg-black/60" onClick={() => setSidebarOpen(false)} />
            {/* Fixed to the viewport, so outside #root's safe-area padding: pad it itself, or the
                Home Screen app puts the sidebar's header under the status bar. */}
            <aside className="absolute left-0 top-0 h-full w-72 border-r border-popover-border bg-card pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] shadow-xl">
              <AppSidebar
                tab={sidebarTab}
                onTabChange={setSidebarTab}
                onNew={() => {
                  openNew();
                  setSidebarOpen(false);
                }}
                onLogout={onLogout}
                update={<UpdateButton status={update} onApplying={setInstalling} />}
                sessionsProgress={<SessionsProgressMenu triggerClassName="px-1 py-0.5" />}
                sessions={
                  <SessionSidebar
                    sessions={sessions}
                    activityIds={activityIds}
                    draftIds={draftIds}
                    shellMarks={shellMarks}
                    onMarkSeen={markSeen}
                    activeId={homeActiveId}
                    onSelect={(id) => {
                      selectSession(id);
                      setSidebarOpen(false);
                    }}
                    self={selfNode}
                    peers={peerSidebars(() => setSidebarOpen(false))}
                    onNewHere={() => {
                      openNew();
                      setSidebarOpen(false);
                    }}
                    reveal={revealSession}
                    onNewInFolder={newSessionInFolder}
                    onRevealFolder={revealFolderInFiles}
                    onNewInProject={newSessionInProject}
                    onStop={(id, withChildren) => void onStop(id, null, withChildren)}
                    onRemove={(id, withChildren) => void onRemove(id, null, withChildren)}
                    onClone={cloneSession}
                    onFork={forkSession}
                    onRestore={onRestore}
                    onRename={onRename}
                    onRemoveSessions={onRemoveSessions}
                    recents={recents}
                    onReuse={reuseRecent}
                    onRemoveRecent={removeRecent}
                    onReorderRecent={reorderRecents}
                    onSearch={() => setSearching(true)}
                    onSchedules={(target) => setScheduling({ target: target ?? null, node: null })}
                    onCarry={onCarry}
                    tab={listTab}
                    onTabChange={setListTab}
                    projects={projects}
                    onProjectsChange={setProjects}
                  />
                }
                files={filesPanel}
                shells={shellsPanel}
                shellsCount={allShells?.length}
              />
            </aside>
          </div>
        )}

        <main className="min-w-0 flex-1">
            {openFile && openFileRemote ? (
              <ServerFileViewer
                key={openFileRemote.id}
                path={openFile}
                source={openRemoteSource!}
                onClose={() => setOpenFile(null)}
                onReveal={revealInFiles}
                onToggleSidebar={() => setSidebarOpen(true)}
                collapsed={collapsed}
                onToggleCollapsed={toggleCollapsed}
              />
            ) : openFile ? (
              <NodeProvider node={openFileNode}>
                <ServerFileViewer
                  // A file on another node's disk; remounted rather than re-pointed when that changes.
                  key={openFileNode ?? ""}
                  path={openFile}
                  onClose={() => setOpenFile(null)}
                  onReveal={revealInFiles}
                  onToggleSidebar={() => setSidebarOpen(true)}
                  collapsed={collapsed}
                  onToggleCollapsed={toggleCollapsed}
                />
              </NodeProvider>
            ) : shellView ? (
              <ShellView
                target={shellView.target}
                focus={shellView.focus}
                onAddSsh={() => setSshDialog(true)}
                shellsRev={shellsRev}
                shellActivity={shellActivity}
                shellsSeen={shellsSeen}
                onShellSeen={markShellSeen}
                onClose={closeShellView}
                onReveal={revealFolderInFiles}
                onToggleSidebar={() => setSidebarOpen(true)}
                collapsed={collapsed}
                onToggleCollapsed={toggleCollapsed}
              />
            ) : active && activeNode ? (
              // A peer's session: the same view, inside its node, so every call in it goes there.
              <NodeProvider node={activeNode}>
                <SessionView
                  key={sessionKey(activeNode, active.id)}
                  session={active}
                  busy={remote.busy.has(active.id) || remote.compacting.has(active.id)}
                  activity={activeActivity}
                  activityLabel={activeActivityLabel}
                  onTerminalShown={onPeerTerminalShown}
                  parent={activeParent}
                  shellsRev={remote.shellsRev}
                  shellActivity={remote.shellActivity}
                  shellsSeen={peerShellsSeen}
                  onShellSeen={markPeerShellSeen}
                  onFork={forkSession}
                  onSelectSession={(id) => {
                    setActiveId(id);
                    clearMainArea();
                  }}
                  onToggleSidebar={() => setSidebarOpen(true)}
                  collapsed={collapsed}
                  onToggleCollapsed={toggleCollapsed}
                  onStopped={(info) => mesh.patchSession(activeNode, info)}
                  onReopen={() => void onRestore(active.id, activeNode)}
                  onReopenWithOptions={() => reopenAsNew(active, presetFromSession(active))}
                  onRename={(id, name) => void onRename(id, name, activeNode)}
                  onTerminalRename={(id, name) => mesh.updateSession(activeNode, id, { name })}
                  onTerminalColor={(id, color) => mesh.updateSession(activeNode, id, { color })}
                  onOpenServerFile={openSessionServerFile}
                  project={projectForDir(active.workingDirectory, remote.projects)}
                  onProjectsChange={(projects) => mesh.setProjects(activeNode, projects)}
                />
              </NodeProvider>
            ) : activeNode ? (
              <NodeUnavailable
                loading={!remote.loaded && !remote.error}
                error={remote.error}
                missing={remote.loaded}
                onBack={() => {
                  setActiveNode(null);
                  setActiveId(null);
                }}
                onOpenSidebar={() => setSidebarOpen(true)}
              />
            ) : active ? (
              <SessionView
                // One instance per session: its tabs, its layout and its terminal all belong to the
                // session, and a fresh view restores them from its saved state rather than chasing a
                // switch through every hook.
                key={active.id}
                session={active}
                // Compaction is work too: the postponed pool must not flush a stashed message into the
                // terminal mid-compact, and a manual /compact leaves the hook-derived busy set empty.
                busy={busyIds.has(active.id) || compactingIds.has(active.id)}
                activity={activeActivity}
                activityLabel={activeActivityLabel}
                onTerminalShown={onTerminalShown}
                parent={activeParent}
                shellsRev={shellsRev}
                revealShell={revealShell?.sessionId === active.id ? revealShell.focus : null}
                onShellRevealed={clearRevealShell}
                shellActivity={shellActivity}
                shellsSeen={shellsSeen}
                onShellSeen={markShellSeen}
                onFork={forkSession}
                onSelectSession={selectSession}
                onToggleSidebar={() => setSidebarOpen(true)}
                collapsed={collapsed}
                onToggleCollapsed={toggleCollapsed}
                onStopped={(info) => setSessions((prev) => prev.map((s) => (s.id === info.id ? info : s)))}
                onReopen={() => void onRestore(active.id)}
                onReopenWithOptions={() => reopenAsNew(active, presetFromSession(active))}
                onRename={onRename}
                onTerminalRename={onTerminalRename}
                onTerminalColor={onTerminalColor}
                onOpenServerFile={openSessionServerFile}
                project={projectForDir(active.workingDirectory, projects)}
                onProjectsChange={setProjects}
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

        {sshDialog && (
          <SshShellDialog projects={projects} onConnect={connectSsh} onClose={() => setSshDialog(false)} />
        )}

        {scheduling && (
          // The picked machine's schedules: everything in the dialog goes there.
          <NodeProvider node={scheduling.node}>
            <ScheduleDialog
              key={scheduling.node ?? ""}
              sessions={sessionsOf(scheduling.node)}
              initialTarget={scheduling.target}
              onClose={() => setScheduling(null)}
              nodes={scheduleNodes}
              node={scheduling.node}
              // A target is a conversation on the machine it was picked on.
              onNodeChange={(node) => setScheduling({ target: null, node })}
            />
          </NodeProvider>
        )}

        {searching && (
          <SessionSearchDialog
            sessions={everywhere.sessions}
            nodeNames={nodeNames}
            recents={recents}
            activeId={activeKey}
            // Opening a session from search also pulls the list back to the Sessions tab (so the row
            // just picked is the one shown selected) and closes the mobile drawer.
            onSelect={(key) => {
              const { node, id } = splitSessionKey(key);
              setListTab("sessions");
              selectSession(id, node);
              setSidebarOpen(false);
            }}
            onReuse={reuseRecent}
            onClose={() => setSearching(false)}
          />
        )}

        {carry && carrySource && (
          // Inside the machine it goes to: its folder picker, and the calls that write.
          <NodeProvider node={carry.node}>
            <CarryDialog
              key={carry.node ?? ""}
              session={carrySource}
              mode={carry.mode}
              from={carry.from}
              fromName={carry.from ? (nodeNames[carry.from] ?? "the other machine") : (selfNode?.name ?? "this machine")}
              sourceApi={apiFor(carry.from)}
              nodes={carryNodes}
              node={carry.node}
              onNodeChange={(node) => setCarry({ ...carry, node })}
              suggestFolder={(node) =>
                matchFolder(carrySource.workingDirectory, [
                  ...sessionsOf(node).map((s) => s.workingDirectory),
                  ...projectsOf(node).flatMap((p) => p.folders),
                ]) ?? ""
              }
              onDone={(s) => s && onCarried(s, carry.node)}
              onClose={() => setCarry(null)}
            />
          </NodeProvider>
        )}

        {forkFrom && (
          <NodeProvider node={forkFromNode}>
            <ForkSessionDialog
              parent={forkFrom}
              sessions={forkSessions}
              onForked={forkFromNode ? onForkedRemote : (s) => onCreated(s, null)}
              onClose={() => setForkFromId(null)}
            />
          </NodeProvider>
        )}

        {/* Inside the picked machine: its folder picker, recents and templates, and the launch itself. */}
        <NodeProvider node={newNode}>
          <NewSessionDialog
            open={newOpen}
            onOpenChange={(o) => {
              setNewOpen(o);
              if (!o) {
                setNewPreset(null); // clear preset so the next plain "New session" starts fresh
                setNewProjectId(null);
                setNewDefaultContinue(undefined);
                setNewDefaultChat(undefined);
                setNewFromId(null); // dismissed without launching — keep the Restorable entry as it is
              }
            }}
            onCreated={(s) => onCreated(s, newNode)}
            preset={newPreset}
            // A project is the machine's it was opened from; another machine has its own.
            project={newNode === newOrigin ? projectsOf(newNode).find((p) => p.id === newProjectId) ?? null : null}
            projects={projectsOf(newNode)}
            defaultContinue={newDefaultContinue}
            defaultChat={newDefaultChat}
            nodes={launchNodes}
            node={newNode}
            origin={newOrigin}
            onNodeChange={setNewNode}
          />
        </NodeProvider>
      </div>
    </SessionsProgressContext.Provider>
  );
}

const NO_IDS = new Set<string>();

/** A call that may fail, before or after it has a promise to fail with: null either way. */
async function attempt<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch {
    return null;
  }
}
const NO_ACTIVITY: ActivityIds = {
  busy: NO_IDS,
  waiting: NO_IDS,
  compacting: NO_IDS,
  failed: NO_IDS,
  background: new Map(),
  done: NO_IDS,
  detail: {},
};

/**
 * Whether a session's machine was listed at the last look — "" for this one, which always is. A peer that
 * has only just come online brings everything it already had going, and none of that is a transition.
 */
function wasListed(key: string, nodes: Set<string>): boolean {
  return nodes.has(splitSessionKey(key).node ?? "");
}

/** What each session's shells together have to say on its row, from their activity and what was seen of it. */
function marksBySession(
  activity: Record<string, ShellActivity> | null,
  seenOf: (shellId: string) => number | undefined
): Map<string, ShellMark> {
  const bySession = new Map<string, (ShellMark | null)[]>();
  for (const [id, a] of Object.entries(activity ?? {}))
    if (a.sessionId) bySession.set(a.sessionId, [...(bySession.get(a.sessionId) ?? []), shellMark(a, seenOf(id))]);
  const out = new Map<string, ShellMark>();
  for (const [sid, marks] of bySession) {
    const m = combineShellMarks(marks);
    if (m) out.set(sid, m);
  }
  return out;
}

/** What the proxy's answers mean to someone holding a link to a peer's session. */
const UNAVAILABLE: Record<string, string> = {
  "unknown node": "This node isn't paired with that one (any more) — see Nodes at the bottom of the sidebar.",
  "node offline": "It isn't answering. The link works again as soon as it is back.",
  "node unauthorized": "It no longer accepts this node. Pair them again under Nodes.",
  "node certificate changed": "It presents a different certificate from the one trusted. Check it under Nodes.",
};

/** Where a peer's session would be, while it can't be shown: still loading, unreachable, or gone. */
function NodeUnavailable({
  loading,
  error,
  missing,
  onBack,
  onOpenSidebar,
}: {
  loading: boolean;
  error: string | null;
  missing: boolean;
  onBack: () => void;
  onOpenSidebar: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b px-3 py-2.5 md:hidden">
        <Button variant="ghost" size="icon" onClick={onOpenSidebar}>
          <Menu className="size-5" />
        </Button>
        <span className="font-semibold">Hangar</span>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        {loading ? (
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        ) : (
          <div>
            <h2 className="text-lg font-semibold">{error ? "That node can't be reached" : "No such session"}</h2>
            <p className="text-sm text-muted-foreground">
              {error
                ? (UNAVAILABLE[error] ?? `${error[0].toUpperCase()}${error.slice(1)}.`)
                : missing
                  ? "The node is there, but it has no session by that id any more."
                  : null}
            </p>
          </div>
        )}
        <Button variant="outline" onClick={onBack}>
          Back to this node
        </Button>
      </div>
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
        <MobileSessionsProgress />
        {collapsed && (
          <ShowSidebarButton onClick={onToggleCollapsed} />
        )}
        <span className="font-semibold">Hangar</span>
        {update}
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <img src={logo} alt="" className="size-14 object-contain" />
        <div>
          <h2 className="text-lg font-semibold">No session selected</h2>
          <p className="text-sm text-muted-foreground">
            Pick one from the sessions list, or start a new one in a working folder.
          </p>
        </div>
        <Button onClick={onNew}>
          <Plus className="size-4" /> New session
        </Button>
      </div>
    </div>
  );
}
