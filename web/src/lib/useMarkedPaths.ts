import { useCallback, useRef, useState, type RefObject } from "react";

// Multi-selection for the file trees: the set of marked paths, and the range gesture that fills in
// everything between two of them.
//
// Which rows lie between is a question the DOM already answers. The trees mark their rows with
// data-nav-row for the arrow keys (see useTreeKeyNav) in the order they are drawn, so reading the
// order back from there gives ranges to every shape of tree at once -- the lazy directory tree, a
// flat search result, the changes view -- without any of them having to flatten itself for it.
const ROW_SELECTOR = "[data-nav-row]";

export type MarkedPaths = {
  /**
   * Select mode: rows mark themselves instead of opening, and every row shows its box. Entered by
   * marking a first row (the hover box) or by the toolbar toggle, which is the way in where there
   * is no hover to speak of.
   */
  selecting: boolean;
  /** The marked paths, each remembering whether it was a directory. */
  marked: ReadonlyMap<string, boolean>;
  count: number;
  has: (path: string) => boolean;
  /** Mark or unmark one row; `range` extends from the last one touched instead. */
  toggle: (path: string, isDir: boolean, range?: boolean) => void;
  /** Enter select mode with nothing marked yet. */
  start: () => void;
  /** Unmark everything and leave select mode. */
  clear: () => void;
};

/** The rows from one path to another in drawn order, each with whether it is a directory. */
function rowsBetween(root: HTMLElement | null, from: string, to: string): [string, boolean][] | null {
  if (!root) return null;
  const rows = Array.from(root.querySelectorAll<HTMLElement>(ROW_SELECTOR));
  const a = rows.findIndex((r) => r.dataset.navRow === from);
  const b = rows.findIndex((r) => r.dataset.navRow === to);
  // The anchor can be gone -- its folder collapsed, a search narrowed the list -- and then there is
  // no span to speak of; the click falls back to marking the one row it landed on.
  if (a < 0 || b < 0) return null;
  return rows
    .slice(Math.min(a, b), Math.max(a, b) + 1)
    .map((r) => [r.dataset.navRow!, r.dataset.navDir === "1"] as [string, boolean]);
}

export function useMarkedPaths(containerRef: RefObject<HTMLElement | null>): MarkedPaths {
  const [marked, setMarked] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [selecting, setSelecting] = useState(false);
  // Where a range starts: the row the last mark was made on, not the first of the run, which is how
  // shift-click behaves everywhere else -- you can walk the end of a range back and forth.
  const anchor = useRef<string | null>(null);

  const toggle = useCallback(
    (path: string, isDir: boolean, range = false) => {
      // Both the anchor and the rows are read here, before the update is queued, and the answer is
      // carried into it. A state updater does not run when it is called -- React decides that, and
      // it decided differently depending on what else was already queued -- so a range worked out
      // in there would sometimes be measured from an anchor this very click had already moved, and
      // collapse to the one row under the pointer.
      const from = anchor.current;
      anchor.current = path;
      const span = range && from ? rowsBetween(containerRef.current, from, path) : null;
      setSelecting(true);
      setMarked((prev) => {
        const next = new Map(prev);
        // A range marks; it never unmarks. Dragging a selection open and finding it had rubbed out
        // the rows it passed over would be its own kind of surprise.
        if (span) {
          for (const [p, dir] of span) next.set(p, dir);
          return next;
        }
        if (next.has(path)) next.delete(path);
        else next.set(path, isDir);
        return next;
      });
    },
    [containerRef]
  );

  const start = useCallback(() => setSelecting(true), []);

  const clear = useCallback(() => {
    anchor.current = null;
    setSelecting(false);
    setMarked(new Map());
  }, []);

  return {
    selecting,
    marked,
    count: marked.size,
    has: useCallback((path: string) => marked.has(path), [marked]),
    toggle,
    start,
    clear,
  };
}

/**
 * Drop any path that already lies inside another one in the list.
 *
 * Deleting a folder takes its contents with it, so a marked file inside a marked folder is not a
 * second thing to delete -- it is a request that has already been served by the time its turn comes
 * round, and sending it anyway buys nothing but a failure to report. Both separators are honoured:
 * these panels carry session-relative paths in one and absolute Windows paths in the other.
 */
export function withoutDescendants(paths: string[]): string[] {
  const trim = (p: string) => p.replace(/[\\/]+$/, "");
  // Shortest first, so a folder is always seen before anything it could contain.
  const sorted = [...paths].sort((a, b) => trim(a).length - trim(b).length);
  const kept: string[] = [];
  for (const path of sorted) {
    const p = trim(path);
    const inside = kept.some((k) => {
      const parent = trim(k);
      return p.length > parent.length && p.startsWith(parent) && /[\\/]/.test(p[parent.length]);
    });
    if (!inside) kept.push(path);
  }
  return kept;
}
