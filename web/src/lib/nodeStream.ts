import { useCallback, useEffect, useRef, useState } from "react";
import type { Project, SessionInfo } from "@/types";
import { apiFor } from "./api";
import type { ActivityDetail } from "./sessionActivity";
import type { ShellActivity } from "./shellActivity";

/**
 * A peer's live picture, as its own /hub/events tells it through this node (/n/{id}/hub/events) — what
 * App needs to show one of that node's sessions: the session itself as it changes, what it is doing,
 * and the node's projects.
 *
 * One socket per peer being looked at, opened by the browser. It is the phase-3 way to it: phase 4's
 * server-side mesh (plans/multi-node.md §5) puts every peer's snapshot on this node's own stream, and
 * this hook is then fed from there instead.
 */
export interface NodeSnapshot {
  /** The node this is the picture of. */
  node: string | null;
  /** Whether a snapshot has arrived since this node was asked for. */
  loaded: boolean;
  /** Why the node can't be reached, when it can't: "unknown node", "node offline", "node unauthorized"… */
  error: string | null;
  sessions: SessionInfo[];
  busy: Set<string>;
  waiting: Set<string>;
  compacting: Set<string>;
  failed: Set<string>;
  drafts: Set<string>;
  activity: Record<string, ActivityDetail>;
  shellsRev: number;
  shellActivity: Record<string, ShellActivity> | null;
  projects: Project[];
}

/** The fields of a /hub/events message this reads. The same snapshot the home stream parses in App. */
interface HubMessage {
  sessions: SessionInfo[];
  busy: string[];
  waiting?: string[];
  compacting?: string[];
  failed?: string[];
  drafts?: string[];
  activity?: Record<string, ActivityDetail>;
  shellsRev?: number;
  projectsRev?: number;
  shells?: Record<string, ShellActivity>;
}

const EMPTY: NodeSnapshot = {
  node: null,
  loaded: false,
  error: null,
  sessions: [],
  busy: new Set(),
  waiting: new Set(),
  compacting: new Set(),
  failed: new Set(),
  drafts: new Set(),
  activity: {},
  shellsRev: 0,
  shellActivity: null,
  projects: [],
};

// Silence longer than this on a socket the server keeps alive every few seconds means it is dead.
const STALE_MS = 15000;

export function useNodeSnapshot(nodeId: string | null) {
  const [snap, setSnap] = useState<NodeSnapshot>(EMPTY);
  const projectsRev = useRef<number | null>(null);

  useEffect(() => {
    setSnap({ ...EMPTY, node: nodeId });
    projectsRev.current = null;
    if (!nodeId) return;
    const api = apiFor(nodeId);
    let closed = false;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let lastFrame = Date.now();
    let delay = 1000;

    const loadProjects = () =>
      api.getProjects().then(
        (projects) => !closed && setSnap((s) => ({ ...s, projects })),
        () => {}
      );

    // A socket that fails says nothing about why — the proxy's answer (unknown node, offline, not
    // accepted) only comes back on a plain request. Asked once per failure, and only for the words. A
    // node that answers that and still won't keep a socket is said so too, rather than left loading.
    const explain = () =>
      api.listSessions().then(
        () => !closed && setSnap((s) => ({ ...s, error: "the node answers, but its live updates don't get through" })),
        (e) => !closed && setSnap((s) => ({ ...s, error: (e instanceof Error && e.message) || "node offline" }))
      );

    const connect = () => {
      ws = new WebSocket(api.sessionsStreamUrl());
      lastFrame = Date.now();
      ws.onmessage = (e) => {
        lastFrame = Date.now();
        delay = 1000;
        let msg: HubMessage;
        try {
          msg = JSON.parse(e.data) as HubMessage;
        } catch {
          return;
        }
        const shells = msg.shells ?? {};
        setSnap((s) => ({
          ...s,
          loaded: true,
          error: null,
          // Which node each session is on travels with it from here on (plans/multi-node.md §6).
          sessions: [...msg.sessions]
            .map((x) => ({ ...x, nodeId }))
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
          busy: new Set(msg.busy),
          waiting: new Set(msg.waiting ?? []),
          compacting: new Set(msg.compacting ?? []),
          failed: new Set(msg.failed ?? []),
          drafts: new Set(msg.drafts ?? []),
          activity: msg.activity ?? {},
          shellsRev: msg.shellsRev ?? 0,
          shellActivity: s.shellActivity && JSON.stringify(s.shellActivity) === JSON.stringify(shells) ? s.shellActivity : shells,
        }));
        // The projects travel as a revision, like on this node's own stream: a move is the cue to re-read.
        const rev = msg.projectsRev ?? 0;
        if (projectsRev.current !== rev) {
          projectsRev.current = rev;
          void loadProjects();
        }
      };
      ws.onclose = () => {
        if (closed) return;
        void explain();
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 15000);
      };
      ws.onerror = () => ws?.close();
    };
    connect();

    // A half-open socket never fires onclose; silence is the only sign.
    const watchdog = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN && Date.now() - lastFrame > STALE_MS) ws.close();
    }, 5000);

    return () => {
      closed = true;
      clearInterval(watchdog);
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, [nodeId]);

  /** Take a session's row as an action on it answered, without waiting for the stream's next frame. */
  const patchSession = useCallback(
    (info: SessionInfo) =>
      setSnap((s) => ({
        ...s,
        sessions: s.sessions.some((x) => x.id === info.id)
          ? s.sessions.map((x) => (x.id === info.id ? { ...info, nodeId } : x))
          : [{ ...info, nodeId }, ...s.sessions],
      })),
    [nodeId]
  );

  /** Change a session's row in place (a rename typed in its terminal, say). */
  const updateSession = useCallback(
    (id: string, change: Partial<SessionInfo>) =>
      setSnap((s) => ({ ...s, sessions: s.sessions.map((x) => (x.id === id ? { ...x, ...change } : x)) })),
    []
  );

  const setProjects = useCallback((projects: Project[]) => setSnap((s) => ({ ...s, projects })), []);

  // The render right after the node changes still holds the last one's state, until the effect above
  // has run; it is nothing of this node's.
  const current = snap.node === nodeId ? snap : { ...EMPTY, node: nodeId };
  return { ...current, patchSession, updateSession, setProjects };
}
