// Per-session UI preferences: which view tab was showing, which files are open as tabs, how the
// tree is expanded. These live on the **server** (see SessionUiStore), keyed by conversation id, so
// a session looks the same on every browser and device — and so the open files survive a reopen,
// which mints a new session id.
//
// The browser keeps a synchronous mirror of that state in localStorage. Reads are synchronous
// because half the app reads them from a useState initializer, and because a device that opens a
// session before the fetch lands should show the last thing it saw rather than an empty panel.
// Writes go into the mirror at once and to the server on a short debounce; the server answers with
// the merged bag, which is what the mirror then holds. Other browsers learn about the change from
// SessionInfo.uiRev on the session list and re-fetch (see noteSessionUiRev).
import { api } from "./api";
import type { TabName } from "./urlState";

const KEY = "claudeweb.sessionUi";
const MAX = 200; // cap mirrored sessions so the map can't grow without bound
const FLUSH_MS = 400; // coalesce bursts (a scroll settling, a tab open) into one request

// Fields saved for next time but not announced: they move continuously while someone scrolls, and a
// revision bump for each one would have every other browser re-fetching the bag all the way down the
// tree. A write of only these goes up quiet (see api.patchSessionUi); mixed with anything else it
// rides along with the rest.
const QUIET_FIELDS = new Set<keyof SessionUi>(["filesScroll", "changesScroll"]);

export interface SessionUi {
  view?: TabName; // active tab: terminal | files | split | file (a file tab in the session bar)
  file?: string; // path of the active file tab in the Files/Split view (relative to the working dir)
  files?: string[]; // paths of all open file tabs, in order (the active one is `file`)
  preview?: string; // path of the transient "preview" tab (reused by single-click), if any
  changes?: boolean; // Files tree showing git changes (+ history panel) instead of all files
  // Absolute path of the root the Files panel is browsing — another worktree of the session's repo,
  // or one of its linked folders ("" = the session's own working dir). Named `worktree` because
  // worktrees were the only alternate root when it was introduced.
  worktree?: string;
  changesTree?: boolean; // in the changes view, group files by folder (tree) instead of a flat list
  filesExpanded?: string[]; // Files tree: folder paths the user has expanded (all collapsed by default)
  changesExpanded?: string[]; // changes tree (grouped mode): folder paths expanded (all collapsed by default)
  // Scroll offset (px) of the tree pane. The two views share the pane but not their position, so each
  // remembers its own; search results are transient and keep neither.
  filesScroll?: number;
  changesScroll?: number;
}

type Store = Record<string, SessionUi>;

// Server revision this browser has seen for each session, so a list push carrying a higher one is
// recognised as somebody else's change. In memory only: after a reload every session starts at 0,
// and the first push re-fetches whichever one is open.
const revs = new Map<string, number>();
// Fields written locally but not yet acknowledged by the server. Re-applied on top of anything the
// server hands back, so a patch in flight is never undone by the answer to an earlier one.
const pending = new Map<string, SessionUi>();
const timers = new Map<string, number>();
// Called when a session's state was replaced by the server's — a change from another browser, or
// the seed on open. Local saves don't notify: the component that made the change already knows.
const listeners = new Map<string, Set<(seed: boolean) => void>>();

function readStore(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function writeStore(store: Store) {
  try {
    // Bound growth: drop the oldest entries (object keys keep insertion order; saveSessionUi
    // re-inserts a touched id at the end, so the front is the least-recently-used).
    const keys = Object.keys(store);
    if (keys.length > MAX) {
      const trimmed: Store = {};
      for (const k of keys.slice(keys.length - MAX)) trimmed[k] = store[k];
      store = trimmed;
    }
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* storage full or unavailable — non-fatal, the server copy is the real one */
  }
}

/** Load a session's saved UI preferences (empty object if none). */
export function loadSessionUi(id: string): SessionUi {
  return readStore()[id] ?? {};
}

/** Merge a patch into the local mirror, without touching the server. */
function mirror(id: string, patch: SessionUi) {
  const store = readStore();
  const prev = store[id];
  delete store[id]; // re-insert last so this id counts as most-recently-used for trimming
  store[id] = { ...prev, ...patch };
  writeStore(store);
}

/**
 * Replace the local mirror outright — used when adopting the server's copy. `seed` marks the copy
 * fetched because a session was just opened, as opposed to one arriving mid-session because another
 * browser wrote: a subscriber may restore the whole view from a seed, but should not let a remote
 * write move the view out from under whoever is looking at it.
 */
function adopt(id: string, state: SessionUi, rev: number, seed: boolean) {
  const store = readStore();
  delete store[id];
  store[id] = { ...state, ...(pending.get(id) ?? {}) };
  writeStore(store);
  revs.set(id, rev);
  for (const cb of listeners.get(id) ?? []) cb(seed);
}

/**
 * Merge a patch into a session's saved UI preferences: into this browser at once, and to the server
 * on a short debounce so it reaches the user's other devices. Fire-and-forget — a failed write
 * leaves the local mirror in place, which is the same state this browser used to keep on its own.
 */
export function saveSessionUi(id: string, patch: SessionUi) {
  mirror(id, patch);
  pending.set(id, { ...(pending.get(id) ?? {}), ...patch });
  window.clearTimeout(timers.get(id));
  timers.set(id, window.setTimeout(() => void flush(id), FLUSH_MS));
}

async function flush(id: string) {
  timers.delete(id);
  const patch = pending.get(id);
  if (!patch) return;
  pending.delete(id);
  try {
    const quiet = Object.keys(patch).every((f) => QUIET_FIELDS.has(f as keyof SessionUi));
    const res = await api.patchSessionUi(id, patch as Record<string, unknown>, quiet);
    // The answer is the whole merged bag, so adopting it also picks up whatever another browser
    // changed in the meantime — anything still queued here is layered back on top.
    adopt(id, res.state as SessionUi, res.rev, false);
  } catch {
    // Put the patch back so the next write retries it, unless that write already replaced the field.
    pending.set(id, { ...patch, ...(pending.get(id) ?? {}) });
  }
}

/** Send anything queued for a session right now (on unload, or before leaving the session). */
export function flushSessionUi(id: string) {
  if (timers.has(id)) {
    window.clearTimeout(timers.get(id));
    void flush(id);
  }
}

/**
 * Pull a session's state from the server and adopt it. `seed` says this is the copy fetched because
 * the session was just opened — see adopt.
 */
export async function syncSessionUi(id: string, seed = false) {
  try {
    const res = await api.getSessionUi(id);
    // A session the server has nothing for yet keeps whatever this browser remembers, and hands it
    // over on the next write — the same "this browser still holds it" handover the pins do.
    if (res.rev > 0) adopt(id, res.state as SessionUi, res.rev, seed);
    else revs.set(id, res.rev);
  } catch {
    /* offline or gone — the local mirror stands in */
  }
}

/**
 * A revision seen on the session list. Higher than what this browser holds means somebody else
 * changed the state, so re-fetch it. Cheap to call on every push: it only acts on a real advance.
 */
export function noteSessionUiRev(id: string, rev: number) {
  if (rev <= (revs.get(id) ?? 0)) return;
  revs.set(id, rev); // claim it first so a burst of pushes yields one fetch
  void syncSessionUi(id);
}

/**
 * Subscribe to server-driven changes for a session: the seed fetched when it is opened (`seed` is
 * true) or a write from another browser (false).
 */
export function subscribeSessionUi(id: string, cb: (seed: boolean) => void): () => void {
  let set = listeners.get(id);
  if (!set) listeners.set(id, (set = new Set()));
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (!set!.size) listeners.delete(id);
  };
}
