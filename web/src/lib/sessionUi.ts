// Per-session UI preferences, persisted in the browser so switching sessions restores how each one
// was last viewed. Deliberately a small merge-able bag (not just the view mode) so more per-session
// settings can be added later without touching the storage shape.
import type { TabName } from "./urlState";

const KEY = "claudeweb.sessionUi";
const MAX = 200; // cap stored sessions so the map can't grow without bound

export interface SessionUi {
  view?: TabName; // active tab: terminal | files | split
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
}

type Store = Record<string, SessionUi>;

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
    /* storage full or unavailable — non-fatal, preferences are best-effort */
  }
}

/** Load a session's saved UI preferences (empty object if none). */
export function loadSessionUi(id: string): SessionUi {
  return readStore()[id] ?? {};
}

/** Merge a patch into a session's saved UI preferences. */
export function saveSessionUi(id: string, patch: SessionUi) {
  const store = readStore();
  const prev = store[id];
  delete store[id]; // re-insert last so this id counts as most-recently-used for trimming
  store[id] = { ...prev, ...patch };
  writeStore(store);
}
