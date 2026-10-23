import { useCallback, useEffect, useRef, useState } from "react";
import type { TransferResult } from "@/types";
import { withoutDescendants, type MarkedPaths } from "./useMarkedPaths";

// Moving files by dragging them within a file tree: a row is picked up, and let go over a folder it
// moves into that folder. Shared by the session's Files panel and the sidebar's whole-disk one.
//
// The rows already say what they are for the arrow keys (data-nav-row, data-nav-dir, data-nav-open
// -- see useTreeKeyNav), so the tree's scroll container answers the whole gesture and reads the row
// under the pointer back from there, the way the remote panel takes a drop of files from the
// desktop. A row only has to be draggable and say so with data-drag="1", on itself or on a box
// around it.

const OPEN_AFTER_MS = 700; // how long a closed folder has to be hovered before it opens
// Carried by every drag a tree starts. The ref below says what is being moved; this says the drag
// under the pointer is that one -- the ref outlives a drag whose dragend never arrived (its row
// unmounted mid-drag), and a later drop of desktop files must not move what it still holds.
const DRAG_TYPE = "application/x-hangar-tree-move";

/** Whether `path` is `dir` or under it, in either slash. */
function covers(dir: string, path: string): boolean {
  const d = dir.replace(/[\\/]+$/, "");
  return path === dir || path === d || (path.startsWith(d) && /[\\/]/.test(path[d.length] ?? ""));
}

/**
 * Each moved path paired with where it went, read from a move's answer -- or null when the answer
 * can't be read that way. The server lists where each one that went now is, in the order they were
 * sent, and what could not go. But one copied across whose original then refused to be deleted is
 * in both lists, and a target folder that has vanished is a single error naming the folder: pairing
 * by position would then hand a tab someone else's file, so an answer that doesn't line up exactly
 * is left unfollowed.
 */
export function movedPairs(paths: string[], r: TransferResult): [string, string][] | null {
  const failed = new Set(r.errors.map((x) => x.path));
  const moved = paths.filter((p) => !failed.has(p));
  if (moved.length !== r.paths.length || r.errors.some((x) => !paths.includes(x.path))) return null;
  return moved.map((p, i) => [p, r.paths[i]]);
}

export type TreeDrag = {
  /** The folder a drop would land in right now, for its row (or the tree, for the root) to show it. */
  over: string | null;
  /** Spread onto the tree's scroll container. */
  areaProps: {
    onDragStart: (e: React.DragEvent<HTMLElement>) => void;
    onDragOver: (e: React.DragEvent<HTMLElement>) => void;
    onDragLeave: (e: React.DragEvent<HTMLElement>) => void;
    onDrop: (e: React.DragEvent<HTMLElement>) => void;
    onDragEnd: () => void;
  };
};

export function useTreeDrag({
  mark,
  parentOf,
  root,
  onMove,
  onOpenDir,
}: {
  mark: MarkedPaths;
  /** The folder holding a path, in the tree's own spelling; null above the top. */
  parentOf: (path: string) => string | null;
  /** What a drop on the tree's empty space lands in: the session's root (""), or nothing at all. */
  root: string | null;
  onMove: (paths: string[], folder: string) => void;
  /** Open a folder the drag has been held over, so a drop can reach into it. */
  onOpenDir?: (dir: string) => void;
}): TreeDrag {
  // What is being carried. A ref, not state: dragover cannot read the drag's own data, and only a
  // drag that started in this tree is one it can move -- anything else (a file from the desktop, a
  // tab, a row of another panel) passes through untouched.
  const dragged = useRef<string[] | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const opening = useRef<{ dir: string; timer: number } | null>(null);

  const stopOpening = useCallback(() => {
    if (opening.current) window.clearTimeout(opening.current.timer);
    opening.current = null;
  }, []);
  const end = useCallback(() => {
    dragged.current = null;
    stopOpening();
    setOver(null);
  }, [stopOpening]);
  useEffect(() => stopOpening, [stopOpening]);

  // The folder under the pointer: a folder row is itself, a file row stands for the folder it is in,
  // and the space below the rows is the root.
  const targetOf = (e: React.DragEvent<HTMLElement>): { dir: string | null; row: HTMLElement | null } => {
    const el = e.target as HTMLElement;
    // A row's hover actions sit beside its nav element rather than in it, inside the row's box.
    const row =
      el.closest<HTMLElement>("[data-nav-row]") ??
      el.closest<HTMLElement>('[data-drag="1"]')?.querySelector<HTMLElement>("[data-nav-row]") ??
      null;
    if (!row || !e.currentTarget.contains(row)) return { dir: root, row: null };
    const path = row.dataset.navRow!;
    return { dir: row.dataset.navDir === "1" ? path : parentOf(path) ?? root, row };
  };

  // Not into itself or anything inside it, and not where every one of them already is.
  const canDrop = (dir: string | null): dir is string => {
    const items = dragged.current;
    if (!items || dir === null) return false;
    if (items.some((p) => covers(p, dir))) return false;
    return !items.every((p) => (parentOf(p) ?? root) === dir);
  };

  return {
    over,
    areaProps: {
      onDragStart: (e) => {
        // The element picked up is the row's box, which is the nav row itself or holds it: not every
        // browser starts a drag from a <button>, so where the row is one its wrapper is what drags.
        const src = (e.target as HTMLElement).closest<HTMLElement>('[data-drag="1"]');
        const row = src?.matches("[data-nav-row]") ? src : src?.querySelector<HTMLElement>("[data-nav-row]");
        if (!row) return;
        const path = row.dataset.navRow!;
        // A marked row carries the whole selection with it; any other row goes on its own.
        dragged.current = mark.has(path) ? withoutDescendants([...mark.marked.keys()]) : [path];
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(DRAG_TYPE, "");
        e.dataTransfer.setData("text/plain", dragged.current.join("\n"));
      },
      onDragOver: (e) => {
        if (!dragged.current || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
        const { dir, row } = targetOf(e);
        if (!canDrop(dir)) {
          e.dataTransfer.dropEffect = "none";
          stopOpening();
          setOver((cur) => (cur === null ? cur : null));
          return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver((cur) => (cur === dir ? cur : dir));
        // Held over a closed folder for a moment, it opens -- the only way to reach a folder that
        // is further down than the ones on screen, without letting go.
        const closedDir = row && row.dataset.navDir === "1" && row.dataset.navOpen !== "1" ? dir : null;
        if (opening.current?.dir === closedDir) return;
        stopOpening();
        if (closedDir && onOpenDir)
          opening.current = {
            dir: closedDir,
            timer: window.setTimeout(() => {
              opening.current = null;
              onOpenDir(closedDir);
            }, OPEN_AFTER_MS),
          };
      },
      onDragLeave: (e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        stopOpening();
        setOver(null);
      },
      onDrop: (e) => {
        const items = dragged.current;
        if (!items) return;
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return end();
        const { dir } = targetOf(e);
        if (!canDrop(dir)) return end();
        end();
        e.preventDefault();
        onMove(items, dir);
      },
      onDragEnd: end,
    },
  };
}
