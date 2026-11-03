import { useCallback, useEffect, useRef, useState } from "react";
import type { BuildStamp, Project, SessionInfo, SessionNotice, UpdateStatus } from "@/types";
import { apiFor } from "./api";
import type { ActivityDetail } from "./sessionActivity";
import type { ShellActivity } from "./shellActivity";

/**
 * Every peer's live picture, as this node's own /hub/events carries it (plans/multi-node.md §5): the
 * server's NodeMesh follows each peer's stream and passes its snapshot on whole, in `nodes`. What App needs
 * to list a peer's sessions, show one of them, and act on it: the sessions as they change, what they are
 * doing, and the node's projects — which, like on this node's own stream, travel as a revision and are
 * read through the node's client when it moves.
 */
export interface NodeSnapshot {
  sessions: SessionInfo[];
  busy: Set<string>;
  waiting: Set<string>;
  compacting: Set<string>;
  failed: Set<string>;
  /** Shells Claude left running when its turn ended, by session — see ActivityIds.background. */
  background: Map<string, number>;
  drafts: Set<string>;
  activity: Record<string, ActivityDetail>;
  shellsRev: number;
  shellActivity: Record<string, ShellActivity> | null;
  /** What its sessions asked to tell you, for the last few minutes — see SessionNotice. */
  notices: SessionNotice[];
  projects: Project[];
  /** Its updater, for the update button on its heading. */
  update: UpdateStatus | null;
}

/** A peer: who it is, whether it can be reached, and — while it can — its snapshot. */
export interface PeerNode {
  id: string;
  name: string;
  color: string | null;
  /** "online", "connecting", or why it can't be reached: "offline", "unauthorized", "incompatible", "certificate". */
  status: string;
  /** The mesh's words for why, when it isn't online. */
  error: string | null;
  version: string | null;
  os: string | null;
  /** When it was last heard from, once it has gone quiet; null while online. */
  lastSeen: string | null;
  /** Whether a session can be started there (its claude is found); null when it didn't say. */
  canLaunch: boolean | null;
  /**
   * Its snapshot — the last one heard, while it is away: a session of it left open stays on screen through
   * a blip rather than being torn down with its terminal. Anything that counts or alerts reads {@link liveSnap}.
   */
  snap: NodeSnapshot | null;
}

/** This node, as its stream names it. */
export interface SelfNode {
  id: string;
  name: string;
  color: string | null;
  /** The OS it runs: "windows", "macos", "linux"; null from a build that doesn't say. */
  os: string | null;
}

/** A peer as /hub/events carries it. */
export interface MeshNodeMessage {
  id: string;
  name: string;
  color?: string | null;
  status: string;
  error?: string | null;
  version?: string | null;
  os?: string | null;
  lastSeen?: string | null;
  canLaunch?: boolean | null;
  snapshot?: HubMessage | null;
}

/** The fields of a /hub/events message a peer's snapshot is read for. The same snapshot App parses for this node. */
interface HubMessage {
  sessions?: SessionInfo[];
  busy?: string[];
  waiting?: string[];
  compacting?: string[];
  failed?: string[];
  background?: Record<string, number>;
  drafts?: string[];
  activity?: Record<string, ActivityDetail>;
  shellsRev?: number;
  projectsRev?: number;
  shells?: Record<string, ShellActivity>;
  notices?: SessionNotice[];
  update?: unknown;
}

export const EMPTY_SNAPSHOT: NodeSnapshot = {
  sessions: [],
  busy: new Set(),
  waiting: new Set(),
  compacting: new Set(),
  failed: new Set(),
  background: new Map(),
  drafts: new Set(),
  activity: {},
  shellsRev: 0,
  shellActivity: null,
  notices: [],
  projects: [],
  update: null,
};

/** A peer's snapshot while it is online — null while it is away, when what it last said is out of date. */
export function liveSnap(peer: PeerNode): NodeSnapshot | null {
  return peer.status === "online" ? peer.snap : null;
}

/** What a peer that isn't online means for someone holding a link to one of its sessions — the proxy's words. */
export function peerError(peer: PeerNode | undefined): string | null {
  if (!peer) return "unknown node";
  switch (peer.status) {
    case "online":
    case "connecting":
      return null;
    case "unauthorized":
      return "node unauthorized";
    case "certificate":
      return "node certificate changed";
    case "incompatible":
      return "node incompatible";
    default:
      return "node offline";
  }
}

// A peer on another build may send these in another shape; one that isn't a notice is dropped here rather
// than taking the page down where they are read.
function validNotices(raw: unknown): SessionNotice[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (n): n is SessionNotice =>
      typeof n === "object" &&
      n !== null &&
      typeof n.id === "string" &&
      typeof n.sessionId === "string" &&
      typeof n.message === "string" &&
      (n.title == null || typeof n.title === "string")
  );
}

function parse(nodeId: string, msg: HubMessage, prev: NodeSnapshot | null): NodeSnapshot {
  const shells = msg.shells ?? {};
  return {
    // Which node each session is on travels with it from here on (plans/multi-node.md §6).
    sessions: [...(msg.sessions ?? [])]
      .map((x) => ({ ...x, nodeId }))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    busy: new Set(msg.busy ?? []),
    waiting: new Set(msg.waiting ?? []),
    compacting: new Set(msg.compacting ?? []),
    failed: new Set(msg.failed ?? []),
    background: new Map(Object.entries(msg.background ?? {})),
    drafts: new Set(msg.drafts ?? []),
    activity: msg.activity ?? {},
    shellsRev: msg.shellsRev ?? 0,
    shellActivity:
      prev?.shellActivity && JSON.stringify(prev.shellActivity) === JSON.stringify(shells) ? prev.shellActivity : shells,
    notices: validNotices(msg.notices),
    projects: prev?.projects ?? [],
    update: updateStatus(msg.update),
  };
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * A peer's updater, as its update button may read it. The dialog walks the release notes as a list, and a
 * peer whose snapshot says otherwise — a different build, or one that has gone wrong — must not take this
 * page down with it: whatever isn't the shape it should be is dropped.
 */
function updateStatus(raw: unknown): UpdateStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const stamp = (v: unknown): BuildStamp | null => {
    if (!v || typeof v !== "object") return null;
    const b = v as Record<string, unknown>;
    if (typeof b.buildId !== "string") return null;
    const n = b.notes && typeof b.notes === "object" ? (b.notes as Record<string, unknown>) : null;
    return {
      buildId: b.buildId,
      commit: str(b.commit),
      branch: str(b.branch),
      builtAtUtc: str(b.builtAtUtc),
      notes: n
        ? {
            summary: str(n.summary),
            changes: Array.isArray(n.changes) ? n.changes.filter((c): c is string => typeof c === "string") : null,
            since: str(n.since),
          }
        : null,
    };
  };
  return {
    enabled: u.enabled === true,
    available: u.available === true,
    current: stamp(u.current),
    staged: stamp(u.staged),
    state: u.state === "Applying" || u.state === "Failed" ? u.state : "Idle",
    error: str(u.error),
  };
}

/**
 * The peers, kept current from the `nodes` of this node's stream (`ingest`). A peer whose snapshot didn't
 * change keeps the same objects, so nothing drawn from it redraws; one that did is parsed afresh, and its
 * projects are re-read when their revision moved.
 */
export function usePeers() {
  const [peers, setPeers] = useState<PeerNode[]>([]);
  // Whether a frame has said who the peers are — until then, a node not among them isn't "unknown" yet.
  const [known, setKnown] = useState(false);
  // The list as last set, for the next change to start from. Every change goes through `commit`, computed
  // here rather than in a state updater: reading a frame records what it read, which an updater (run twice
  // over in development) must not do.
  const current = useRef<PeerNode[]>([]);
  const commit = useCallback((next: PeerNode[]) => {
    current.current = next;
    setPeers(next);
  }, []);
  const raw = useRef(new Map<string, string>());
  const projectsRev = useRef(new Map<string, number>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadProjects = useCallback((id: string) => {
    apiFor(id)
      .getProjects()
      .then(
        (projects) => {
          if (!alive.current) return;
          commit(current.current.map((p) => (p.id === id && p.snap ? { ...p, snap: { ...p.snap, projects } } : p)));
        },
        () => {}
      );
  }, [commit]);

  const ingest = useCallback(
    (nodes: MeshNodeMessage[] | undefined) => {
      setKnown(true);
      const list = Array.isArray(nodes) ? nodes : [];
      const reload: string[] = [];
      const cur = current.current;
      const next = list
        .filter((n) => n && typeof n.id === "string" && /^[A-Za-z0-9]{1,64}$/.test(n.id))
        .map((n): PeerNode => {
          const before = cur.find((p) => p.id === n.id);
          let snap: NodeSnapshot | null = null;
          if (n.status === "online" && n.snapshot && typeof n.snapshot === "object") {
            const text = JSON.stringify(n.snapshot);
            snap = before?.snap && raw.current.get(n.id) === text ? before.snap : parse(n.id, n.snapshot, before?.snap ?? null);
            raw.current.set(n.id, text);
            const rev = n.snapshot.projectsRev ?? 0;
            if (projectsRev.current.get(n.id) !== rev || !before?.snap) {
              projectsRev.current.set(n.id, rev);
              reload.push(n.id);
            }
          } else {
            // Kept as it was; a fresh one replaces it when the peer is back, and its projects are re-read then.
            snap = before?.snap ?? null;
            raw.current.delete(n.id);
            projectsRev.current.delete(n.id);
          }
          const peer: PeerNode = {
            id: n.id,
            name: n.name || n.id,
            color: n.color ?? null,
            status: n.status,
            error: n.error ?? null,
            version: n.version ?? null,
            os: n.os ?? null,
            lastSeen: n.lastSeen ?? null,
            canLaunch: typeof n.canLaunch === "boolean" ? n.canLaunch : null,
            snap,
          };
          return before && samePeer(before, peer) ? before : peer;
        });
      if (next.length !== cur.length || next.some((p, i) => p !== cur[i])) commit(next);
      for (const id of reload) loadProjects(id);
    },
    [commit, loadProjects]
  );

  // An action's answer patched in is optimistic, like on this node's own list: forgetting the frame it was
  // patched over makes the peer's next one — keep-alive or not — the truth again, so a call that failed
  // doesn't leave its result on screen.
  const patch = useCallback(
    (nodeId: string, change: (snap: NodeSnapshot) => NodeSnapshot) => {
      raw.current.delete(nodeId);
      commit(current.current.map((p) => (p.id === nodeId && p.snap ? { ...p, snap: change(p.snap) } : p)));
    },
    [commit]
  );

  /** Take a session's row as an action on it answered, without waiting for the stream's next frame. */
  const patchSession = useCallback(
    (nodeId: string, info: SessionInfo) =>
      patch(nodeId, (s) => ({
        ...s,
        sessions: s.sessions.some((x) => x.id === info.id)
          ? s.sessions.map((x) => (x.id === info.id ? { ...info, nodeId } : x))
          : [{ ...info, nodeId }, ...s.sessions],
      })),
    [patch]
  );

  /** Change a session's row in place (a rename typed in its terminal, say). */
  const updateSession = useCallback(
    (nodeId: string, id: string, change: Partial<SessionInfo>) =>
      patch(nodeId, (s) => ({ ...s, sessions: s.sessions.map((x) => (x.id === id ? { ...x, ...change } : x)) })),
    [patch]
  );

  /** Drop sessions from a node's list as their removal answered. */
  const dropSessions = useCallback(
    (nodeId: string, ids: string[]) =>
      patch(nodeId, (s) => ({ ...s, sessions: s.sessions.filter((x) => !ids.includes(x.id)) })),
    [patch]
  );

  const setProjects = useCallback(
    (nodeId: string, projects: Project[]) => patch(nodeId, (s) => ({ ...s, projects })),
    [patch]
  );

  /** Forget everything — signed out. */
  const reset = useCallback(() => {
    raw.current.clear();
    projectsRev.current.clear();
    commit([]);
    setKnown(false);
  }, [commit]);

  return { peers, known, ingest, patchSession, updateSession, dropSessions, setProjects, reset };
}

function samePeer(a: PeerNode, b: PeerNode): boolean {
  return (
    a.snap === b.snap &&
    a.name === b.name &&
    a.color === b.color &&
    a.status === b.status &&
    a.error === b.error &&
    a.version === b.version &&
    a.os === b.os &&
    a.lastSeen === b.lastSeen &&
    a.canLaunch === b.canLaunch
  );
}
