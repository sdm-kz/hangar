import { useRef, useState } from "react";

/**
 * Native drag-to-reorder for a vertical list. `onReorder(from, to, list)` receives indices within
 * one list; `isOver` reports the item currently hovered, for a drop indicator.
 *
 * `list` scopes a drag: the sessions sidebar draws one list per folder, a project draws one list of
 * virtual folders, and an item dragged out of its own list has no meaningful index in the one it
 * lands on — so a cross-list drop is simply ignored. Single-list callers can leave it out.
 *
 * Three sets of props rather than one, because the two ends of the gesture don't always sit on the
 * same element. A session row is both — you grab the row and you drop on the row — and takes
 * `rowProps`. A virtual folder is not: you grab its header, but the thing worth aiming at is the
 * whole box, header and sessions together, so the header takes `handleProps` and the box takes
 * `targetProps`. Splitting them also keeps the drop from being answered twice, once by the handle
 * and again by the box around it.
 *
 * Shared between the sidebar and the project settings popup. What the two share here is the
 * gesture; what a drop then *means* — the order it produces — is groupIdsAfterMove in lib/projects.
 */
export function useDragReorder(onReorder: (from: number, to: number, list: string) => void) {
  const dragged = useRef<{ index: number; list: string } | null>(null);
  const [over, setOver] = useState<{ index: number; list: string } | null>(null);

  const end = () => {
    dragged.current = null;
    setOver(null);
  };

  /** The end you grab: makes an element the drag source for the item at `index`. */
  const handleProps = (index: number, list = "") => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      dragged.current = { index, list };
      e.dataTransfer.effectAllowed = "move";
    },
    onDragEnd: end,
  });

  /** The end you aim at: makes an element the place the dragged item lands. */
  const targetProps = (index: number, list = "") => ({
    onDragOver: (e: React.DragEvent) => {
      if (dragged.current?.list !== list) return; // from another list — not a drop target
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (over?.index !== index || over.list !== list) setOver({ index, list });
    },
    // Without this the indicator would stay on the last item the pointer crossed while it sits over
    // something that isn't a target at all. Rows never showed it — leaving one enters the next, whose
    // dragover overwrites the mark — but a project's boxes have gaps between them and dead space
    // below them, and a line promising a drop that won't happen is worse than no line. Guarded like
    // the sidebar's other two drags: crossing between a target's own children fires this too, and
    // leaving for *another* target is already handled, since its dragover has claimed `over` by then.
    onDragLeave: (e: React.DragEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setOver((cur) => (cur?.index === index && cur.list === list ? null : cur));
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const from = dragged.current;
      end();
      if (from && from.list === list && from.index !== index) onReorder(from.index, index, list);
    },
  });

  return {
    isOver: (index: number, list = "") => over?.index === index && over.list === list,
    /**
     * Drop the pending indicator because something else is answering for this drag — a target drawn
     * over a row takes the event before the row sees it, and the line the row drew on the way in
     * would otherwise stay up beside the other target's own mark. A no-op when nothing is showing:
     * the same state back means React has no render to do, and dragover fires continuously.
     */
    clearOver: () => setOver((cur) => (cur === null ? cur : null)),
    handleProps,
    targetProps,
    /** Both ends on one element, for a list whose items are grabbed and dropped on in the same place. */
    rowProps: (index: number, list = "") => ({ ...handleProps(index, list), ...targetProps(index, list) }),
  };
}
