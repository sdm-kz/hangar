import { createContext, useContext, type ReactNode } from "react";
import { apiFor, type Api } from "@/lib/api";

/**
 * Which node the views inside are about: null for the one this page was loaded from, a node id for a
 * peer reached through it (plans/multi-node.md). A session's whole view sits inside one, so the dozens of
 * calls in it — files, git, shells, pull requests, the terminal's socket — need no node argument and
 * can't forget it: they ask {@link useApi} for their client.
 */
const NodeContext = createContext<string | null>(null);

export function NodeProvider({ node, children }: { node: string | null | undefined; children: ReactNode }) {
  return <NodeContext.Provider value={node ?? null}>{children}</NodeContext.Provider>;
}

/** The node the calling view is about: null for this one. */
export function useNodeId(): string | null {
  return useContext(NodeContext);
}

/** The API client for the node the calling view is about. Stable per node, so safe in dependency lists. */
export function useApi(): Api {
  return apiFor(useContext(NodeContext));
}

/**
 * The key a session is known by across nodes. Two machines can in principle mint the same id, and
 * anything keyed by session — a map, a set, a React key, a stored preference — must never mix them up.
 * A session of this node keeps its bare id, so everything keyed before nodes existed still matches.
 */
export function sessionKey(nodeId: string | null | undefined, id: string): string {
  return nodeId ? `${nodeId}:${id}` : id;
}

/** The node and the id a {@link sessionKey} was made from. Neither ever contains a colon. */
export function splitSessionKey(key: string): { node: string | null; id: string } {
  const at = key.indexOf(":");
  return at < 0 ? { node: null, id: key } : { node: key.slice(0, at), id: key.slice(at + 1) };
}

/** The API client for the node a {@link sessionKey} names — for the stores keyed by it. */
export function apiForKey(key: string): Api {
  return apiFor(splitSessionKey(key).node);
}

/** The {@link sessionKey} of session `id` on the node the calling view is about. */
export function useSessionKey(id: string): string {
  return sessionKey(useContext(NodeContext), id);
}
