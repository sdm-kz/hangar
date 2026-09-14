import type { SessionInfo } from "@/types";

/** A session placed in the tree: its nesting depth, plus whether anything hangs off it. */
export interface ForkNode {
  session: SessionInfo;
  depth: number;
  /** True when this row has sessions nested under it (drives the row's tree affordances). */
  hasChildren: boolean;
  /** How many descendants this row is currently hiding; 0 unless it's collapsed. */
  hiddenCount: number;
}

/**
 * The session a row is drawn under: where the user put it by dragging it onto another row, and
 * otherwise the session it was forked from. The two are separate facts — a fork says where the
 * conversation came from, which no amount of rearranging changes — and only this one is about the
 * list, so it is the only one the tree is built from.
 */
export function parentOf(s: SessionInfo): string | null {
  return s.nestedUnderId ?? s.parentSessionId;
}

/**
 * Flatten sessions into tree order: each session followed by the sessions nested under it, one level
 * deeper. Roots keep the order they arrived in (the list is already sorted newest-first), and a row
 * whose parent isn't in `sessions` — closed, forgotten, or hidden by the active-only filter — becomes
 * a root itself rather than disappearing.
 *
 * Ids in `collapsed` keep their row but drop their whole subtree, reporting how many rows that hid.
 *
 * Cycles can't arise from forking (a fork's parent always predates it) and the server refuses to
 * draw one by hand, but re-parenting after a reopen writes ids in place, so the walk guards against
 * revisiting a node regardless.
 */
export function forkTree(sessions: SessionInfo[], collapsed?: ReadonlySet<string>): ForkNode[] {
  const present = new Set(sessions.map((s) => s.id));
  const childrenOf = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    const parent = parentOf(s);
    if (!parent || parent === s.id || !present.has(parent)) continue;
    const siblings = childrenOf.get(parent);
    if (siblings) siblings.push(s);
    else childrenOf.set(parent, [s]);
  }

  const out: ForkNode[] = [];
  const seen = new Set<string>();

  // Swallow a collapsed row's whole subtree, returning its size. Marking the descendants as seen also
  // keeps the cycle-recovery pass below from resurrecting them as roots.
  const swallow = (s: SessionInfo): number => {
    let n = 0;
    for (const c of childrenOf.get(s.id) ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      n += 1 + swallow(c);
    }
    return n;
  };

  const walk = (s: SessionInfo, depth: number) => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    const children = childrenOf.get(s.id) ?? [];
    const isCollapsed = children.length > 0 && collapsed?.has(s.id) === true;
    out.push({
      session: s,
      depth,
      hasChildren: children.length > 0,
      hiddenCount: isCollapsed ? swallow(s) : 0,
    });
    if (isCollapsed) return;
    for (const c of children) walk(c, depth + 1);
  };

  for (const s of sessions) {
    const parent = parentOf(s);
    if (!parent || !present.has(parent)) walk(s, 0);
  }
  // Anything left is part of a cycle the roots pass never reached — show it rather than drop it.
  for (const s of sessions) walk(s, 0);
  return out;
}

/**
 * Every session nested under `id`, at any depth, parents before their own children.
 *
 * The tree a row is drawn with is built from the sessions currently on screen; this is built from
 * all of them, because moving a session somewhere has to take the whole branch — including the rows
 * the active-only filter is hiding, which would otherwise be left behind where nothing shows them.
 *
 * Guarded against cycles for the same reason forkTree is: re-parenting after a reopen writes ids in
 * place, and a session is never its own descendant here regardless of what the ids say.
 */
export function forkDescendants(sessions: SessionInfo[], id: string): SessionInfo[] {
  const childrenOf = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    const parent = parentOf(s);
    if (!parent || parent === s.id) continue;
    const siblings = childrenOf.get(parent);
    if (siblings) siblings.push(s);
    else childrenOf.set(parent, [s]);
  }

  const out: SessionInfo[] = [];
  const seen = new Set<string>([id]);
  const walk = (parentId: string) => {
    for (const c of childrenOf.get(parentId) ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
      walk(c.id);
    }
  };
  walk(id);
  return out;
}
