// The session pane's layout: a tree of splits whose leaves are groups of tabs, the way an IDE lays
// out its editor groups. Every tab the session has — the Claude terminal, the Files explorer, an open
// file, a shell, a pinned page, a PR review — lives in exactly one group, and each group shows one of
// its tabs at a time. Two groups side by side is "the terminal beside the review"; four is as many as
// a screen holds and still reads.
//
// Everything here is pure: it takes a layout and returns a new one, and never touches React or the
// DOM. What a tab *is* belongs to the hooks that own each kind (useFileTabs, useShells, …); the layout
// only records where each one is placed, by a string reference to it. `reconcile` is what keeps the
// two in step when a tab appears or goes away underneath the layout.

/** A tab, by reference: "claude", "files", or `<kind>:<id>` for the kinds there can be many of. */
export type PaneRef = string;
export type PaneKind = "claude" | "files" | "file" | "shell" | "link" | "pull" | "remote";

export interface PaneGroup {
  type: "group";
  id: string;
  tabs: PaneRef[];
  /** The tab on show; null only for a group with no tabs (one just split off, waiting for a drop). */
  active: PaneRef | null;
}

export interface PaneSplit {
  type: "split";
  id: string;
  /** "row" lays the children out left to right, "col" top to bottom. */
  dir: "row" | "col";
  children: PaneNode[];
  /** Each child's share of the split, summing to 1 — fractions, so a resized window keeps the shape. */
  sizes: number[];
}

export type PaneNode = PaneGroup | PaneSplit;

export interface PaneLayout {
  root: PaneNode;
  /** The group with focus: where keyboard commands act and where a new tab lands by default. */
  active: string;
  /** A group zoomed to fill the whole pane, the others hidden behind it; null when none is. */
  max?: string | null;
}

/** As many groups as fit on a screen and still read. A split past this moves the tab instead. */
export const MAX_GROUPS = 4;

export type Edge = "left" | "right" | "top" | "bottom";

export const CLAUDE: PaneRef = "claude";
export const FILES: PaneRef = "files";
export const fileRef = (path: string): PaneRef => `file:${path}`;
export const shellRef = (id: string): PaneRef => `shell:${id}`;
export const linkRef = (id: string): PaneRef => `link:${id}`;
export const pullRef = (key: string): PaneRef => `pull:${key}`;
export const remoteRef = (id: string): PaneRef => `remote:${id}`;

export function paneKind(ref: PaneRef): PaneKind {
  if (ref === CLAUDE || ref === FILES) return ref as PaneKind;
  return ref.slice(0, ref.indexOf(":")) as PaneKind;
}

/** What follows the kind: the path, the shell or link id, the review key (see pullKey). */
export function paneArg(ref: PaneRef): string {
  return ref.slice(ref.indexOf(":") + 1);
}

let seq = 0;
function newId(prefix: string): string {
  seq = (seq + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

function group(tabs: PaneRef[], active?: PaneRef | null): PaneGroup {
  return { type: "group", id: newId("g"), tabs, active: active ?? tabs[0] ?? null };
}

/** Every group, in reading order (depth first: left before right, top before bottom). */
export function groupsOf(node: PaneNode): PaneGroup[] {
  return node.type === "group" ? [node] : node.children.flatMap(groupsOf);
}

export function findGroup(layout: PaneLayout, id: string): PaneGroup | undefined {
  return groupsOf(layout.root).find((g) => g.id === id);
}

/** The group a tab is placed in, if it is placed at all. */
export function groupOf(layout: PaneLayout, ref: PaneRef): PaneGroup | undefined {
  return groupsOf(layout.root).find((g) => g.tabs.includes(ref));
}

/** A layout with one group holding every tab — the shape a session starts in. */
export function singleLayout(tabs: PaneRef[], active: PaneRef | null = CLAUDE): PaneLayout {
  const g = group(tabs, active && tabs.includes(active) ? active : tabs[0] ?? null);
  return { root: g, active: g.id, max: null };
}

/** Two or more groups in one split, the first given focus. */
export function splitLayout(
  dir: "row" | "col",
  parts: { tabs: PaneRef[]; active: PaneRef | null }[],
  sizes: number[],
  focus = 0
): PaneLayout {
  const gs = parts.map((p) => group(p.tabs, p.active && p.tabs.includes(p.active) ? p.active : null));
  const root: PaneSplit = { type: "split", id: newId("s"), dir, children: gs, sizes: normalizeSizes(sizes, gs.length) };
  return normalize({ root, active: gs[Math.min(focus, gs.length - 1)].id, max: null });
}

// ---- Tree surgery ------------------------------------------------------------------------------

function mapNode(node: PaneNode, fn: (g: PaneGroup) => PaneGroup): PaneNode {
  if (node.type === "group") return fn(node);
  let changed = false;
  const children = node.children.map((c) => {
    const n = mapNode(c, fn);
    if (n !== c) changed = true;
    return n;
  });
  return changed ? { ...node, children } : node;
}

function mapGroups(layout: PaneLayout, fn: (g: PaneGroup) => PaneGroup): PaneLayout {
  const root = mapNode(layout.root, fn);
  return root === layout.root ? layout : { ...layout, root };
}

/** Replace the node with this id by whatever `fn` returns for it (null removes it). */
function replaceNode(node: PaneNode, id: string, fn: (n: PaneNode) => PaneNode | null): PaneNode | null {
  if (node.id === id) return fn(node);
  if (node.type === "group") return node;
  let changed = false;
  const children: PaneNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((c, i) => {
    const n = replaceNode(c, id, fn);
    if (n !== c) changed = true;
    if (n) {
      children.push(n);
      sizes.push(node.sizes[i]);
    }
  });
  return changed ? { ...node, children, sizes } : node;
}

function evenSizes(n: number): number[] {
  return Array.from({ length: n }, () => 1 / n);
}

function normalizeSizes(sizes: number[], n: number): number[] {
  const s = sizes.length === n ? sizes.map((x) => (Number.isFinite(x) && x > 0 ? x : 0)) : evenSizes(n);
  const total = s.reduce((a, b) => a + b, 0);
  return total > 0 ? s.map((x) => x / total) : evenSizes(n);
}

/**
 * Tidy the tree after surgery: a split with one child is just that child, a split directly inside
 * one running the same way is part of it, and the shares always add up to one. Then make sure the
 * focused and the zoomed group are ones that still exist.
 */
function normalizeNode(node: PaneNode): PaneNode | null {
  if (node.type === "group") return node;
  const children: PaneNode[] = [];
  const sizes: number[] = [];
  const own = normalizeSizes(node.sizes, node.children.length);
  node.children.forEach((c, i) => {
    const n = normalizeNode(c);
    if (!n) return;
    if (n.type === "split" && n.dir === node.dir) {
      // Same direction: lift the grandchildren up, sharing out the space the child had.
      n.children.forEach((gc, j) => {
        children.push(gc);
        sizes.push(own[i] * n.sizes[j]);
      });
    } else {
      children.push(n);
      sizes.push(own[i]);
    }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { ...node, children, sizes: normalizeSizes(sizes, children.length) };
}

function normalize(layout: PaneLayout): PaneLayout {
  const root = normalizeNode(layout.root) ?? group([]);
  const gs = groupsOf(root);
  const active = gs.some((g) => g.id === layout.active) ? layout.active : gs[0].id;
  const max = layout.max && gs.length > 1 && gs.some((g) => g.id === layout.max) ? layout.max : null;
  return { root, active, max };
}

/** Take a group out of the tree, unless it is the last one — a pane always has somewhere to draw. */
function dropGroup(layout: PaneLayout, id: string): PaneLayout {
  if (groupsOf(layout.root).length <= 1) return layout;
  const root = replaceNode(layout.root, id, () => null);
  return normalize({ ...layout, root: root ?? layout.root });
}

// ---- Tab operations ----------------------------------------------------------------------------

/** Show a tab in the group it is in. Does not move focus — see focusGroup. */
export function activateRef(layout: PaneLayout, ref: PaneRef): PaneLayout {
  return mapGroups(layout, (g) => (g.tabs.includes(ref) && g.active !== ref ? { ...g, active: ref } : g));
}

export function focusGroup(layout: PaneLayout, id: string): PaneLayout {
  if (layout.active === id || !findGroup(layout, id)) return layout;
  // Moving focus out of a zoomed group brings the rest back: otherwise focus would sit on a group
  // that is not on screen.
  return { ...layout, active: id, max: layout.max && layout.max !== id ? null : layout.max };
}

/** Show a tab and give its group focus. */
export function revealRef(layout: PaneLayout, ref: PaneRef): PaneLayout {
  const g = groupOf(layout, ref);
  return g ? focusGroup(activateRef(layout, ref), g.id) : layout;
}

/**
 * Take a tab out of the layout. Its group falls back to the neighbouring tab, and a group left with
 * nothing in it goes away (when there is another to take its space).
 */
export function removeRef(layout: PaneLayout, ref: PaneRef): PaneLayout {
  const g = groupOf(layout, ref);
  if (!g) return layout;
  const idx = g.tabs.indexOf(ref);
  const tabs = g.tabs.filter((t) => t !== ref);
  const active = g.active === ref ? tabs[Math.min(idx, tabs.length - 1)] ?? null : g.active;
  const next = mapGroups(layout, (x) => (x.id === g.id ? { ...x, tabs, active } : x));
  return tabs.length === 0 ? dropGroup(next, g.id) : next;
}

/**
 * Put a tab into a group — at `index`, or at the end — moving it from wherever it was. `activate`
 * shows it there. A group emptied by the move goes away.
 */
export function placeRef(
  layout: PaneLayout,
  ref: PaneRef,
  groupId: string,
  opts: { index?: number; activate?: boolean } = {}
): PaneLayout {
  const target = findGroup(layout, groupId);
  if (!target) return layout;
  const from = groupOf(layout, ref);
  // Already here, and no position asked for: nothing moves, the tab is at most shown.
  if (from?.id === groupId && opts.index === undefined)
    return opts.activate && target.active !== ref ? activateRef(layout, ref) : layout;
  let next = layout;
  if (from && from.id !== groupId) {
    // Leave the source first, but keep it even if it empties until the target has the tab — the
    // target might be the source's only sibling, and dropping it would reshape the tree mid-move.
    const idx = from.tabs.indexOf(ref);
    const tabs = from.tabs.filter((t) => t !== ref);
    const active = from.active === ref ? tabs[Math.min(idx, tabs.length - 1)] ?? null : from.active;
    next = mapGroups(next, (x) => (x.id === from.id ? { ...x, tabs, active } : x));
  }
  next = mapGroups(next, (x) => {
    if (x.id !== groupId) return x;
    const without = x.tabs.filter((t) => t !== ref);
    // Reordering within a group: an index counted with the tab still in place shifts by one once it
    // is taken out ahead of the drop point.
    const fromIdx = x.tabs.indexOf(ref);
    const raw = opts.index ?? without.length;
    const i = Math.max(0, Math.min(fromIdx !== -1 && fromIdx < raw ? raw - 1 : raw, without.length));
    const tabs = [...without.slice(0, i), ref, ...without.slice(i)];
    return { ...x, tabs, active: opts.activate || !x.active ? ref : x.active };
  });
  if (from && from.id !== groupId && findGroup(next, from.id)?.tabs.length === 0)
    next = dropGroup(next, from.id);
  return next;
}

/** Move a tab into another group and give that group focus. */
export function moveRef(layout: PaneLayout, ref: PaneRef, groupId: string, index?: number): PaneLayout {
  return focusGroup(placeRef(layout, ref, groupId, { index, activate: true }), groupId);
}

/**
 * Open a new group on one edge of another, and put `ref` in it (or nothing, leaving an empty group
 * to drop into). The new group gets focus. At MAX_GROUPS this moves the tab into the group whose
 * edge it was dropped on instead, which is the nearest thing the layout can still do.
 */
export function splitGroup(layout: PaneLayout, targetId: string, edge: Edge, ref: PaneRef | null): PaneLayout {
  const target = findGroup(layout, targetId);
  if (!target) return layout;
  if (groupsOf(layout.root).length >= MAX_GROUPS) return ref ? moveRef(layout, ref, targetId) : layout;
  // A group's only tab dropped on its own edge would leave the group empty to make room for itself.
  if (ref && target.tabs.length === 1 && target.tabs[0] === ref) return layout;

  let next = layout;
  const from = ref ? groupOf(layout, ref) : undefined;
  if (ref && from) {
    const idx = from.tabs.indexOf(ref);
    const tabs = from.tabs.filter((t) => t !== ref);
    const active = from.active === ref ? tabs[Math.min(idx, tabs.length - 1)] ?? null : from.active;
    next = mapGroups(next, (x) => (x.id === from.id ? { ...x, tabs, active } : x));
  }

  const fresh = group(ref ? [ref] : []);
  const dir: PaneSplit["dir"] = edge === "left" || edge === "right" ? "row" : "col";
  const before = edge === "left" || edge === "top";
  const parent = parentOf(next.root, targetId);
  let root: PaneNode | null;
  if (parent && parent.dir === dir) {
    // The split already runs this way: slot in beside the target, halving the space it had.
    root = replaceNode(next.root, parent.id, (p) => {
      const s = p as PaneSplit;
      const i = s.children.findIndex((c) => c.id === targetId);
      const half = s.sizes[i] / 2;
      const children = [...s.children];
      const sizes = [...s.sizes];
      children.splice(before ? i : i + 1, 0, fresh);
      sizes.splice(i, 1, half, half);
      return { ...s, children, sizes };
    });
  } else {
    root = replaceNode(next.root, targetId, (t) => ({
      type: "split",
      id: newId("s"),
      dir,
      children: before ? [fresh, t] : [t, fresh],
      sizes: [0.5, 0.5],
    }));
  }
  next = normalize({ ...next, root: root ?? next.root, active: fresh.id, max: null });
  if (from && from.id !== targetId && findGroup(next, from.id)?.tabs.length === 0)
    next = dropGroup(next, from.id);
  return next;
}

function parentOf(node: PaneNode, id: string): PaneSplit | null {
  if (node.type === "group") return null;
  if (node.children.some((c) => c.id === id)) return node;
  for (const c of node.children) {
    const p = parentOf(c, id);
    if (p) return p;
  }
  return null;
}

/**
 * Close a group: its tabs are not closed but handed to the group beside it (the one before, or
 * after for the first), the way closing an editor group keeps the files open.
 */
export function closeGroup(layout: PaneLayout, id: string): PaneLayout {
  const gs = groupsOf(layout.root);
  const i = gs.findIndex((g) => g.id === id);
  if (i === -1 || gs.length <= 1) return layout;
  const heir = gs[i === 0 ? 1 : i - 1];
  const closing = gs[i];
  let next = mapGroups(layout, (g) =>
    g.id === heir.id ? { ...g, tabs: [...g.tabs, ...closing.tabs], active: g.active ?? closing.active } : g
  );
  next = mapGroups(next, (g) => (g.id === id ? { ...g, tabs: [], active: null } : g));
  next = dropGroup(next, id);
  return focusGroup(next, heir.id);
}

export function setSplitSizes(layout: PaneLayout, splitId: string, sizes: number[]): PaneLayout {
  const root = replaceNode(layout.root, splitId, (n) =>
    n.type === "split" ? { ...n, sizes: normalizeSizes(sizes, n.children.length) } : n
  );
  return root ? { ...layout, root } : layout;
}

export function toggleMax(layout: PaneLayout, id: string = layout.active): PaneLayout {
  if (groupsOf(layout.root).length <= 1) return layout.max ? { ...layout, max: null } : layout;
  return { ...layout, active: id, max: layout.max === id ? null : id };
}

// ---- Keeping the layout in step with the tabs --------------------------------------------------

/**
 * Bring the layout in line with the tabs that exist. A tab that went away leaves its group; one that
 * appeared is put where `place` says. A file tab that was swapped for another in one step — the
 * transient preview tab reused by a single click, or a rename — takes the old one's place rather
 * than going to the end, so the strip does not reshuffle under the click.
 *
 * `known` says which kinds have finished loading: a kind still loading (the shells, fetched from the
 * server) would otherwise read as "all closed", and its tabs would lose their places.
 */
export function reconcile(
  layout: PaneLayout,
  present: PaneRef[],
  known: (kind: PaneKind) => boolean,
  place: (layout: PaneLayout, ref: PaneRef) => { group: string; activate: boolean }
): PaneLayout {
  const have = new Set(present);
  const placed = new Set(groupsOf(layout.root).flatMap((g) => g.tabs));
  const gone = [...placed].filter((r) => !have.has(r) && known(paneKind(r)));
  const added = present.filter((r) => !placed.has(r));
  if (!gone.length && !added.length) return layout;

  let next = layout;
  const goneFiles = gone.filter((r) => paneKind(r) === "file");
  const addedFiles = added.filter((r) => paneKind(r) === "file");
  const swapped = new Set<PaneRef>();
  // Pair them off in order: one out and one in is a swap, in place.
  for (let i = 0; i < Math.min(goneFiles.length, addedFiles.length); i++) {
    const out = goneFiles[i];
    const inn = addedFiles[i];
    next = mapGroups(next, (g) =>
      g.tabs.includes(out)
        ? { ...g, tabs: g.tabs.map((t) => (t === out ? inn : t)), active: g.active === out ? inn : g.active }
        : g
    );
    swapped.add(out).add(inn);
  }
  for (const r of gone) if (!swapped.has(r)) next = removeRef(next, r);
  for (const r of added) {
    if (swapped.has(r)) continue;
    const { group: gid, activate } = place(next, r);
    next = placeRef(next, r, findGroup(next, gid) ? gid : next.active, { activate });
  }
  return normalize(next);
}

// ---- Geometry ----------------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Gutter {
  splitId: string;
  /** The boundary after child `index`. */
  index: number;
  dir: "row" | "col";
  /** Where the boundary line sits, in the same 0–1 units as the group rects. */
  at: Rect;
  /** The whole split's box, which a drag measures against. */
  box: Rect;
  sizes: number[];
}

/**
 * Where each group sits, as fractions of the pane (0–1 on both axes), and where the draggable
 * boundaries between them are. Groups are drawn flat and positioned from this rather than nested in
 * the DOM, so reshaping the tree never re-parents a group — and never remounts what is inside it.
 */
export function measure(layout: PaneLayout): { rects: Map<string, Rect>; gutters: Gutter[] } {
  const rects = new Map<string, Rect>();
  const gutters: Gutter[] = [];
  const walk = (node: PaneNode, box: Rect) => {
    if (node.type === "group") {
      rects.set(node.id, box);
      return;
    }
    let offset = 0;
    node.children.forEach((c, i) => {
      const share = node.sizes[i];
      const r =
        node.dir === "row"
          ? { x: box.x + offset * box.w, y: box.y, w: share * box.w, h: box.h }
          : { x: box.x, y: box.y + offset * box.h, w: box.w, h: share * box.h };
      walk(c, r);
      offset += share;
      if (i < node.children.length - 1)
        gutters.push({
          splitId: node.id,
          index: i,
          dir: node.dir,
          at:
            node.dir === "row"
              ? { x: box.x + offset * box.w, y: box.y, w: 0, h: box.h }
              : { x: box.x, y: box.y + offset * box.h, w: box.w, h: 0 },
          box,
          sizes: node.sizes,
        });
    });
  };
  walk(layout.root, { x: 0, y: 0, w: 1, h: 1 });
  return { rects, gutters };
}

/** The group next to this one in a direction, by where they sit on screen. */
export function neighbour(layout: PaneLayout, id: string, edge: Edge): string | null {
  const { rects } = measure(layout);
  const from = rects.get(id);
  if (!from) return null;
  const cx = from.x + from.w / 2;
  const cy = from.y + from.h / 2;
  const eps = 1e-6;
  let best: { id: string; d: number } | null = null;
  for (const [gid, r] of rects) {
    if (gid === id) continue;
    const ok =
      edge === "left"
        ? r.x + r.w <= from.x + eps && r.y < from.y + from.h && r.y + r.h > from.y
        : edge === "right"
          ? r.x >= from.x + from.w - eps && r.y < from.y + from.h && r.y + r.h > from.y
          : edge === "top"
            ? r.y + r.h <= from.y + eps && r.x < from.x + from.w && r.x + r.w > from.x
            : r.y >= from.y + from.h - eps && r.x < from.x + from.w && r.x + r.w > from.x;
    if (!ok) continue;
    const d = Math.hypot(r.x + r.w / 2 - cx, r.y + r.h / 2 - cy);
    if (!best || d < best.d) best = { id: gid, d };
  }
  return best?.id ?? null;
}

// ---- Presets -----------------------------------------------------------------------------------

export type LayoutPreset = "single" | "columns" | "rows" | "main-side" | "grid";

export const PRESET_GROUPS: Record<LayoutPreset, number> = {
  single: 1,
  columns: 2,
  rows: 2,
  "main-side": 3,
  grid: 4,
};

/**
 * Re-shape the layout into a preset, keeping the tabs where they can stay: the groups are taken in
 * reading order, extra ones fold into the last group the preset has, and missing ones start empty.
 */
export function applyPreset(layout: PaneLayout, preset: LayoutPreset): PaneLayout {
  const n = PRESET_GROUPS[preset];
  const gs = groupsOf(layout.root).map((g) => ({ ...g }));
  while (gs.length > n) {
    const extra = gs.pop()!;
    const last = gs[gs.length - 1];
    last.tabs = [...last.tabs, ...extra.tabs];
    last.active = last.active ?? extra.active;
  }
  while (gs.length < n) gs.push(group([]));
  const split = (dir: "row" | "col", children: PaneNode[], sizes?: number[]): PaneSplit => ({
    type: "split",
    id: newId("s"),
    dir,
    children,
    sizes: sizes ?? evenSizes(children.length),
  });
  const root: PaneNode =
    preset === "single"
      ? gs[0]
      : preset === "columns"
        ? split("row", gs)
        : preset === "rows"
          ? split("col", gs)
          : preset === "main-side"
            ? split("row", [gs[0], split("col", [gs[1], gs[2]])], [0.6, 0.4])
            : split("col", [split("row", [gs[0], gs[1]]), split("row", [gs[2], gs[3]])]);
  const active = gs.some((g) => g.id === layout.active) ? layout.active : gs[0].id;
  return normalize({ root, active, max: null });
}

// ---- Restoring ---------------------------------------------------------------------------------

/** Check a layout read back from the saved bag — it may come from another build, or be garbage. */
export function parseLayout(raw: unknown): PaneLayout | null {
  const node = (x: unknown, depth: number): PaneNode | null => {
    if (!x || typeof x !== "object" || depth > 8) return null;
    const o = x as Record<string, unknown>;
    if (typeof o.id !== "string") return null;
    if (o.type === "group") {
      if (!Array.isArray(o.tabs) || !o.tabs.every((t) => typeof t === "string")) return null;
      const tabs = [...new Set(o.tabs as string[])];
      const active = typeof o.active === "string" && tabs.includes(o.active) ? o.active : tabs[0] ?? null;
      return { type: "group", id: o.id, tabs, active };
    }
    if (o.type === "split") {
      if ((o.dir !== "row" && o.dir !== "col") || !Array.isArray(o.children)) return null;
      const children = o.children.map((c) => node(c, depth + 1));
      if (children.some((c) => !c)) return null;
      const sizes = Array.isArray(o.sizes) ? (o.sizes as unknown[]).map(Number) : [];
      return { type: "split", id: o.id, dir: o.dir, children: children as PaneNode[], sizes };
    }
    return null;
  };
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const root = node(o.root, 0);
  if (!root) return null;
  // A tab in two groups is a layout nothing here produces; keep its first place only.
  const seen = new Set<string>();
  const dedupe = (n: PaneNode): PaneNode =>
    n.type === "group"
      ? (() => {
          const tabs = n.tabs.filter((t) => !seen.has(t) && (seen.add(t), true));
          return { ...n, tabs, active: n.active && tabs.includes(n.active) ? n.active : tabs[0] ?? null };
        })()
      : { ...n, children: n.children.map(dedupe) };
  const layout = normalize({
    root: dedupe(root),
    active: typeof o.active === "string" ? o.active : "",
    max: typeof o.max === "string" ? o.max : null,
  });
  if (groupsOf(layout.root).length > MAX_GROUPS) return null;
  return layout;
}

/** Two layouts that would draw the same. */
export function sameLayout(a: PaneLayout, b: PaneLayout): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
