import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Bookmark, ListChecks, ListTodo, MessageSquareText, Reply } from "lucide-react";
import type { MarkKind } from "@/lib/chatMarks";

// Room kept between the buttons and the selection, and between the buttons and the window's edges.
const GAP = 8;
const EDGE = 8;

interface Spot {
  text: string;
  /** The selection as it was: a tap can drop it before the button's click. */
  range: Range;
  /** How many steps it spans, each a to-do of its own: 0 when it isn't a list of them. */
  steps: number;
  x: number;
  y: number;
  /** Under the selection rather than over it. */
  below: boolean;
}

export type SelectionAction = MarkKind | "steps";

/**
 * Buttons by text selected in `rootRef`, as a messenger offers them: "Reply" hands the text on to be
 * quoted in the reply, and the rest put a mark on it — a bookmark, a to-do, a note, or a to-do for each
 * step of a list it spans. They show once the selection is made (a mouse let go of it), follow it as
 * the conversation scrolls, and go when the selection does. On a touch screen they sit under the
 * selection, clear of the system's own menu over it.
 */
export function SelectionActions({
  rootRef,
  onReply,
  onMark,
  countSteps,
}: {
  rootRef: RefObject<HTMLElement | null>;
  /** Left out where there is nothing to reply in: a closed session's chat. */
  onReply?: (text: string) => void;
  onMark: (action: SelectionAction, range: Range) => void;
  countSteps: (range: Range) => number;
}) {
  const [spot, setSpot] = useState<Spot | null>(null);
  // A finger on a button: the tap can drop the selection before its click, and the buttons are to stay
  // under the finger for the click to reach them.
  const tapping = useRef(false);
  const countRef = useRef(countSteps);
  countRef.current = countSteps;
  // The row's width, once drawn: kept clear of the window's edges by it, whatever buttons it has.
  const pillRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const w = pillRef.current?.offsetWidth ?? 0;
    if (w !== width) setWidth(w);
  });

  useEffect(() => {
    const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
    let held = false;
    const update = () => {
      if (tapping.current) return;
      const sel = window.getSelection();
      const root = rootRef.current;
      if (held || !root || !sel || sel.isCollapsed || !sel.rangeCount) return setSpot(null);
      const range = sel.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) return setSpot(null);
      const text = sel.toString().trim();
      const box = range.getBoundingClientRect();
      if (!text || (!box.width && !box.height)) return setSpot(null);
      // Out of the conversation's view (scrolled away), they have nothing to stand by.
      const view = root.closest("[data-chat-scroll]")?.getBoundingClientRect();
      if (view && (box.bottom < view.top || box.top > view.bottom)) return setSpot(null);
      const below = coarse || box.top - EDGE < (view?.top ?? 0);
      const x = box.left + box.width / 2;
      const y = below ? Math.min(box.bottom, view?.bottom ?? box.bottom) + GAP : box.top - GAP;
      setSpot((cur) => ({
        text,
        range: range.cloneRange(),
        // Worked out again only for another selection: a scroll moves the buttons, not what they'd do.
        steps: cur?.text === text ? cur.steps : countRef.current(range),
        x,
        y,
        below,
      }));
    };
    // A mouse dragging out a selection: not until it is let go, so the buttons don't chase the pointer.
    const down = (e: PointerEvent) => {
      // The buttons themselves: the selection stays for their click to take.
      if ((e.target as Element | null)?.closest?.("[data-selection-actions]")) return;
      tapping.current = false;
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      held = true;
      setSpot(null);
    };
    const up = () => {
      if (!held) return;
      held = false;
      // After the click that ends a selection has had its say (a click in it collapses it).
      window.setTimeout(update, 0);
    };
    document.addEventListener("selectionchange", update);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [rootRef]);

  if (!spot) return null;
  // The selection dropped before the message box takes the focus: dropped after, it can take the focus
  // (and a phone's keyboard) away with it.
  const take = (then: () => void) => () => {
    tapping.current = false;
    window.getSelection()?.removeAllRanges();
    setSpot(null);
    then();
  };
  const button = (title: string, onClick: () => void, children: ReactNode) => (
    <button
      type="button"
      title={title}
      onClick={take(onClick)}
      className="flex items-center gap-1.5 px-2.5 py-1.5 first:pl-3 last:pr-3 hover:bg-muted"
    >
      {children}
    </button>
  );
  const mark = (action: SelectionAction) => () => onMark(action, spot.range);
  const half = width / 2 + EDGE;
  const left = Math.max(half, Math.min(spot.x, window.innerWidth - half));
  // On the page itself: fixed against the window, whatever pane the chat is in, and clear of its zoom.
  return createPortal(
    <div
      ref={pillRef}
      data-selection-actions
      // Taken on the click, not on the touch: the focus a phone gives the message box then is the tap's
      // own, which nothing under the finger takes back, and opens the keyboard. A tap can drop the
      // selection before its click, so the buttons are kept until then. A mouse's press would end the
      // selection and take the focus: kept from doing so.
      onPointerDown={(e) => {
        if (e.pointerType !== "mouse") tapping.current = true;
      }}
      onPointerCancel={() => {
        tapping.current = false;
      }}
      onMouseDown={(e) => e.preventDefault()}
      style={{ left, top: spot.y }}
      className={`fixed z-50 flex -translate-x-1/2 items-stretch divide-x overflow-hidden rounded-full border bg-background text-xs font-medium shadow-md ${spot.below ? "" : "-translate-y-full"}`}
    >
      {onReply &&
        button("Reply to this (quote it in your message)", () => onReply(spot.text), <><Reply className="size-3.5" /> Reply</>)}
      {button("Bookmark this", mark("bookmark"), <Bookmark className="size-3.5" />)}
      {button("Make this a to-do", mark("todo"), <ListTodo className="size-3.5" />)}
      {spot.steps > 1 &&
        button(`A to-do for each of the ${spot.steps} steps`, mark("steps"), <><ListChecks className="size-3.5" /> {spot.steps} steps</>)}
      {button("Put a note on this", mark("note"), <MessageSquareText className="size-3.5" />)}
    </div>,
    document.body
  );
}
