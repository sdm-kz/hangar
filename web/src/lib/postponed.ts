// Per-session "postponed messages" pool. Persisted server-side (in `.hangar/postponed/<id>.json`
// under the session's working directory) so a pool stashed while Claude is busy survives a reload AND
// is shared across devices. Keyed by session id, so sessions that share a folder each keep their own
// pool (a resume gets a fresh session id → empty). Only image *paths* are stored (the bytes live
// server-side in `.hangar/uploads/`); never base64.

import type { Api } from "./api";

const LEGACY_PREFIX = "hangar.postponed."; // pre-server-storage browser key, migrated on first load
const MAX = 100; // cap stashed messages per session so storage can't grow without bound

export interface PostponedImage {
  path: string; // working-dir-relative path (for thumbnails via sessionFileUrl)
  fullPath: string; // absolute path injected into the terminal
}

export interface PostponedMessage {
  id: string;
  text: string;
  images: PostponedImage[];
  createdAt: number;
}

function legacyKey(sessionId: string): string {
  return LEGACY_PREFIX + sessionId;
}

/** Read a browser-local pool left by the pre-server-storage version (empty if none/unparseable). */
function readLegacy(sessionId: string): PostponedMessage[] {
  try {
    const raw = localStorage.getItem(legacyKey(sessionId));
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? (parsed as PostponedMessage[]) : [];
  } catch {
    return [];
  }
}

/** Load a session's stashed messages from its node (empty array on error/none). */
export async function loadPostponed(api: Api, sessionId: string): Promise<PostponedMessage[]> {
  let server: PostponedMessage[] = [];
  try {
    const raw = await api.getPostponed(sessionId);
    if (Array.isArray(raw)) server = raw as PostponedMessage[];
  } catch {
    /* offline / unauthorized — fall through to legacy, then empty */
  }
  if (server.length) return server;

  // One-time migration: push any browser-local pool up to the server, dropping the local copy ONLY
  // once the server accepted it (so a missing endpoint / offline server can't lose the pool). Only for
  // this node's sessions: the browser-local pool predates nodes, so it can only have been one of those.
  if (api.base) return server;
  const legacy = readLegacy(sessionId);
  if (legacy.length) {
    const saved = await savePostponed(api, sessionId, legacy);
    if (saved) try { localStorage.removeItem(legacyKey(sessionId)); } catch { /* ignore */ }
    return legacy;
  }
  return server;
}

/** Persist a session's stashed messages to the server. Returns true iff the server accepted the save;
 *  best-effort (drops the oldest past the cap) — a failed save is swallowed and reported as false. */
export async function savePostponed(api: Api, sessionId: string, msgs: PostponedMessage[]): Promise<boolean> {
  const bounded = msgs.length > MAX ? msgs.slice(msgs.length - MAX) : msgs;
  try {
    await api.putPostponed(sessionId, JSON.stringify(bounded));
    return true;
  } catch {
    return false; // server unreachable — non-fatal, the pool tolerates a lost save
  }
}

/** Remove a session's stashed messages entirely. */
export async function clearPostponed(api: Api, sessionId: string): Promise<void> {
  await savePostponed(api, sessionId, []);
}

/** Create a new stashed message with a unique id. */
export function newMessage(text: string, images: PostponedImage[]): PostponedMessage {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return { id, text, images, createdAt: Date.now() };
}
