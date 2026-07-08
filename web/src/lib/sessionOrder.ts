import type { SessionInfo } from "@/types";

// The active-session list comes from the server (and is re-fetched every few seconds), so any
// user-chosen ordering is kept client-side here, keyed by session id, and re-applied on each poll.
const KEY = "claudeweb.sessionOrder";

export function loadSessionOrder(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function saveSessionOrder(ids: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    /* storage full / disabled — ordering is best-effort */
  }
}

/** Sort the server list by the saved order; ids not in the order keep their server order at the end. */
export function sortByOrder(sessions: SessionInfo[], order: string[]): SessionInfo[] {
  const pos = new Map(order.map((id, i) => [id, i]));
  // Array.sort is stable, so unknown ids (both mapped to Infinity) preserve their incoming order.
  return [...sessions].sort(
    (a, b) => (pos.get(a.id) ?? Infinity) - (pos.get(b.id) ?? Infinity)
  );
}

/** Return a copy of arr with the item at `from` moved to index `to`. */
export function move<T>(arr: T[], from: number, to: number): T[] {
  const next = arr.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
