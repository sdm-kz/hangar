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

// The manual per-folder order is a per-browser view preference, like the grouped/flat toggle and the
// collapsed folders. It is keyed by session id, and ids are minted fresh on every reopen/auto-resume,
// so each write prunes entries for sessions the list no longer has (otherwise a long-lived browser
// accumulates state for every session it has ever seen).
//
// Pins used to live here on the same terms and no longer do: a pin is a statement about the
// conversation, not about this browser's view of it, so it belongs to the server (keyed by
// conversation id, which survives the reopen that mints a new session id) and arrives on the session
// list as SessionInfo.pinned. PINNED_KEY remains only to hand the old per-browser pins over once.
const PINNED_KEY = "claudeweb.pinnedSessions";
const ORDER_KEY = "claudeweb.sessionOrder";

/** Manual row order per folder (see dirKey): session ids, topmost first. */
export type SessionOrder = Record<string, string[]>;

/**
 * Hand this browser's leftover pins to the server, once. Each id is sent as a pin on that session,
 * which the server re-keys onto its conversation; ids it no longer knows (long-closed sessions) are
 * simply refused, which is the same as the pruning this file used to do. The key is cleared either
 * way, so a browser that fails to reach the server keeps its pins for the next attempt only if the
 * whole call throws before the clear.
 */
export async function migratePinnedSessions(pin: (id: string) => Promise<void>): Promise<boolean> {
  let ids: string[];
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    if (!raw) return false;
    ids = JSON.parse(raw) as string[];
  } catch {
    return false;
  }
  await Promise.all(ids.map((id) => pin(id).catch(() => {})));
  try {
    localStorage.removeItem(PINNED_KEY);
  } catch {
    /* storage disabled — the pins are on the server now either way */
  }
  return ids.length > 0;
}

export function loadSessionOrder(): SessionOrder {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    return raw ? (JSON.parse(raw) as SessionOrder) : {};
  } catch {
    return {};
  }
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

/**
 * The pin a row should be left carrying once it has been dragged to `to` — the index it is inserted
 * at in the list with itself taken out, which is what `move` does with the same argument.
 *
 * Pinned rows sort above unpinned ones no matter what the manual order says, so a drag that crosses
 * the line between the two blocks used to be written to the order and then quietly undone by the
 * next sort: the row sprang back and the whole gesture read as broken. Refusing those drops would be
 * honest but useless — a mostly-pinned folder would have almost nowhere left to drop a row. So the
 * pin travels with the drag instead: a row takes the state of the row it lands under (or, dropped at
 * the very top, of the row it lands above), which is the only reading of "put it here" that leaves
 * the row where it was put. The pin icon appearing or vanishing is what says so.
 */
export function pinAfterMove(
  ids: readonly string[],
  from: number,
  to: number,
  pinned: ReadonlySet<string>
): boolean {
  const others = ids.filter((_, i) => i !== from);
  // Landing at the top there is no row above, so the one it displaces speaks for the block instead.
  const neighbour = to > 0 ? others[to - 1] : others[0];
  // A list of one has no neighbour to take a state from: nothing moved, so nothing changes.
  return neighbour === undefined ? pinned.has(ids[from]) : pinned.has(neighbour);
}
