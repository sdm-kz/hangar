import type { SessionInfo } from "@/types";

/** Return a copy of arr with the item at `from` moved to index `to`. */
export function move<T>(arr: T[], from: number, to: number): T[] {
  const next = arr.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/**
 * Grouping key for a working directory. Windows paths are case-insensitive and mix separators, so the
 * same folder can arrive as both `C:\a\b` and `c:/a/b` (e.g. a `--continue` relaunch) — normalize
 * case, separators and any trailing slash so those collapse into one group instead of duplicating it.
 */
export function dirKey(dir: string): string {
  return dir.replace(/[/\\]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

// Pinned sessions and the manual per-folder order are per-browser view preferences, like the
// grouped/flat toggle and the collapsed folders — the server has no opinion about how one browser
// wants its list stacked. Both are keyed by session id, and ids are minted fresh on every
// reopen/auto-resume, so each write prunes entries for sessions the list no longer has (otherwise a
// long-lived browser accumulates state for every session it has ever seen).
const PINNED_KEY = "claudeweb.pinnedSessions";
const ORDER_KEY = "claudeweb.sessionOrder";

/** Manual row order per folder (see dirKey): session ids, topmost first. */
export type SessionOrder = Record<string, string[]>;

export function loadPinnedSessions(): Set<string> {
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function loadSessionOrder(): SessionOrder {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    return raw ? (JSON.parse(raw) as SessionOrder) : {};
  } catch {
    return {};
  }
}

/** Drop ids that aren't in the live list any more, then persist. Returns what was stored. */
export function savePinnedSessions(pinned: ReadonlySet<string>, alive: ReadonlySet<string>): Set<string> {
  const kept = new Set([...pinned].filter((id) => alive.has(id)));
  try {
    localStorage.setItem(PINNED_KEY, JSON.stringify([...kept]));
  } catch {
    /* storage disabled — preference is best-effort */
  }
  return kept;
}

export function saveSessionOrder(order: SessionOrder, alive: ReadonlySet<string>): SessionOrder {
  const kept: SessionOrder = {};
  for (const [dir, ids] of Object.entries(order)) {
    const live = ids.filter((id) => alive.has(id));
    if (live.length) kept[dir] = live;
  }
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(kept));
  } catch {
    /* storage disabled — preference is best-effort */
  }
  return kept;
}

/**
 * Order one folder's sessions for display: pinned rows first, then whatever the user dragged into
 * place, then the rest. `sessions` arrives newest-first, and the sort is stable, so a session the
 * manual order doesn't mention yet — a brand new one, or one created since the last drag — keeps
 * that position: at the top of its block, under the pins.
 */
export function sortFolderSessions(
  sessions: SessionInfo[],
  pinned: ReadonlySet<string>,
  order: readonly string[] | undefined
): SessionInfo[] {
  const rank = new Map((order ?? []).map((id, i) => [id, i]));
  // -1 for an unranked session: it sorts above every ranked one, which is what puts a new session
  // at the top rather than at the bottom of a folder that has been arranged by hand.
  const rankOf = (s: SessionInfo) => rank.get(s.id) ?? -1;
  return [...sessions].sort(
    (a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)) || rankOf(a) - rankOf(b)
  );
}

/** Flat (ungrouped) list: pins float to the top; everything else stays newest-first. */
export function sortPinnedFirst(sessions: SessionInfo[], pinned: ReadonlySet<string>): SessionInfo[] {
  if (!pinned.size) return sessions;
  return [...sessions].sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)));
}
