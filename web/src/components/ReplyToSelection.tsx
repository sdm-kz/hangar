import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Reply } from "lucide-react";

// Room kept between the button and the selection, and between the button and the window's edges.
const GAP = 8;
const EDGE = 48;

interface Spot {
  text: string;
  x: number;
  y: number;
  /** Under the selection rather than over it. */
  below: boolean;
}

/**
 * A "Reply" button by text selected in `rootRef`, as a messenger offers one: it hands the text on to be
 * quoted in the reply. It shows once the selection is made (a mouse let go of it), follows it as the
 * conversation scrolls, and goes when the selection does. On a touch screen it sits under the selection,
 * clear of the system's own menu over it.
 */
export function ReplyToSelection({
  rootRef,
  onReply,
}: {
  rootRef: RefObject<HTMLElement | null>;
  onReply: (text: string) => void;
}) {
  const [spot, setSpot] = useState<Spot | null>(null);
  // A finger on the button: the tap can drop the selection before its click, and the button is to stay
  // under the finger for the click to reach it.
  const tapping = useRef(false);

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
      // Out of the conversation's view (scrolled away), it has nothing to stand by.
      const view = root.closest("[data-chat-scroll]")?.getBoundingClientRect();
      if (view && (box.bottom < view.top || box.top > view.bottom)) return setSpot(null);
      const below = coarse || box.top - EDGE < (view?.top ?? 0);
      const x = Math.min(Math.max(box.left + box.width / 2, EDGE), window.innerWidth - EDGE);
      setSpot({ text, x, y: below ? Math.min(box.bottom, view?.bottom ?? box.bottom) + GAP : box.top - GAP, below });
    };
    // A mouse dragging out a selection: not until it is let go, so the button doesn't chase the pointer.
    const down = (e: PointerEvent) => {
      // The button itself: the selection stays for its click to take.
      if ((e.target as Element | null)?.closest?.("[data-reply-to-selection]")) return;
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
  const take = () => {
    tapping.current = false;
    // The selection dropped before the message box takes the focus: dropped after, it can take the focus
    // (and a phone's keyboard) away with it.
    window.getSelection()?.removeAllRanges();
    setSpot(null);
    onReply(spot.text);
  };
  // On the page itself: fixed against the window, whatever pane the chat is in, and clear of its zoom.
  return createPortal(
    <button
      type="button"
      title="Reply to this (quote it in your message)"
      data-reply-to-selection
      // Taken on the click, not on the touch: the focus a phone gives the message box then is the tap's
      // own, which nothing under the finger takes back, and opens the keyboard. A tap can drop the
      // selection before its click, so the button is kept until then. A mouse's press would end the
      // selection and take the focus: kept from doing so.
      onPointerDown={(e) => {
        if (e.pointerType !== "mouse") tapping.current = true;
      }}
      onPointerCancel={() => {
        tapping.current = false;
      }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={take}
      style={{ left: spot.x, top: spot.y }}
      className={`fixed z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-full border bg-background px-3 py-1.5 text-xs font-medium shadow-md hover:bg-muted ${spot.below ? "" : "-translate-y-full"}`}
    >
      <Reply className="size-3.5" /> Reply
    </button>,
    document.body
  );
}
