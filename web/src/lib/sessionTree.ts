import type { SessionInfo } from "@/types";

/** A session placed in the fork tree: its nesting depth, plus whether anything hangs off it. */
export interface ForkNode {
  session: SessionInfo;
  depth: number;
  /** True when this row has forks nested under it (drives the row's tree affordances). */
  hasChildren: boolean;
  /** How many descendants this row is currently hiding; 0 unless it's collapsed. */
  hiddenCount: number;
}

/**
 * Flatten sessions into fork-tree order: each session followed by the sessions forked from it, one
 * level deeper. Roots keep the order they arrived in (the list is already sorted newest-first), and
 * a fork whose parent isn't in `sessions` — closed, forgotten, or hidden by the active-only filter —
 * becomes a root itself rather than disappearing.
 *
 * Ids in `collapsed` keep their row but drop their whole subtree, reporting how many rows that hid.
 *
 * Cycles can't arise from forking (a fork's parent always predates it), but re-parenting after a
 * reopen writes ids in place, so the walk guards against revisiting a node regardless.
 */
export function forkTree(sessions: SessionInfo[], collapsed?: ReadonlySet<string>): ForkNode[] {
  const present = new Set(sessions.map((s) => s.id));
  const childrenOf = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    const parent = s.parentSessionId;
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

  for (const s of sessions)
    if (!s.parentSessionId || !present.has(s.parentSessionId)) walk(s, 0);
  // Anything left is part of a cycle the roots pass never reached — show it rather than drop it.
  for (const s of sessions) walk(s, 0);
  return out;
}
