// Per-session "postponed messages" pool, persisted in the browser so messages stashed while Claude is
// busy survive a refresh and stay scoped to their session. Each session gets its own storage key
// (`claudeweb.postponed.<sessionId>`) holding a plain array — separate from the sessionUi bag so a
// large pool never bloats that map. Only image *paths* are stored (the bytes live server-side in
// `.claudeweb/uploads/`); never base64, which would blow the ~5MB localStorage quota.

const PREFIX = "claudeweb.postponed.";
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

function keyFor(sessionId: string): string {
  return PREFIX + sessionId;
}

/** Load a session's stashed messages (empty array if none or unparseable). */
export function loadPostponed(sessionId: string): PostponedMessage[] {
  try {
    const raw = localStorage.getItem(keyFor(sessionId));
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? (parsed as PostponedMessage[]) : [];
  } catch {
    return [];
  }
}

/** Persist a session's stashed messages (best-effort; drops the oldest past the cap). */
export function savePostponed(sessionId: string, msgs: PostponedMessage[]) {
  try {
    const bounded = msgs.length > MAX ? msgs.slice(msgs.length - MAX) : msgs;
    localStorage.setItem(keyFor(sessionId), JSON.stringify(bounded));
  } catch {
    /* storage full or unavailable — non-fatal, the pool is best-effort */
  }
}

/** Remove a session's stashed messages entirely. */
export function clearPostponed(sessionId: string) {
  try {
    localStorage.removeItem(keyFor(sessionId));
  } catch {
    /* ignore */
  }
}

/** Create a new stashed message with a unique id. */
export function newMessage(text: string, images: PostponedImage[]): PostponedMessage {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return { id, text, images, createdAt: Date.now() };
}
