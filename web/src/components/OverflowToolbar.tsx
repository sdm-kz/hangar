import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { cn } from "@/lib/utils";
import { ToolbarMore, type ToolAction } from "./ToolbarMore";

/**
 * One thing on a toolbar: how it is drawn inline while there is room, and the menu rows it turns
 * into once there isn't. Usually one control and one row, but a segmented switch is one control
 * and a row per option.
 */
export interface OverflowItem {
  id: string;
  inline: ReactNode;
  menu: ToolAction[];
}

/**
 * A row of toolbar controls that keeps as many as fit and moves the rest, from the end, into a
 * "more" menu (ToolbarMore, the one the sidebars use). The room it has is the container's width less `reserve` -- what the rest of the row
 * (a file name, a close button) needs to keep -- so the controls give way before the name does.
 *
 * Widths are measured, not guessed: an invisible copy of every control is laid out alongside, so a
 * segmented switch counts for what it actually takes and a control that changes (a tick replacing a
 * copy icon) is re-measured as it does.
 */
export function OverflowToolbar({
  items,
  container,
  reserve,
  gap = 8,
  className,
  menuVariant,
  menuButtonClassName,
  menuButtonWidth = MORE_WIDTH,
}: {
  items: OverflowItem[];
  container: RefObject<HTMLElement | null>;
  reserve: number;
  gap?: number;
  className?: string;
  /** The "more" button dressed like the controls beside it, and its width when that isn't 28px. */
  menuVariant?: "ghost" | "outline";
  menuButtonClassName?: string;
  menuButtonWidth?: number;
}) {
  const measureRef = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<number | null>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});

  // The room: the container's content width, less what the rest of the row keeps. Read once before
  // the first paint, so a narrow pane never shows every control for a frame and then drops them;
  // the observer below keeps it current after that.
  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const width = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    setRoom(width - reserve);
  }, [container, reserve]);
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setRoom(entry.contentRect.width - reserve));
    ro.observe(el);
    return () => ro.disconnect();
  }, [container, reserve]);

  // Each control's own width, from the invisible copy -- read before paint, and again whenever the
  // copy changes size.
  const measure = useCallback(() => {
    const box = measureRef.current;
    if (!box) return;
    const next: Record<string, number> = {};
    for (const el of Array.from(box.children) as HTMLElement[]) {
      const id = el.dataset.overflowId;
      if (id) next[id] = el.offsetWidth;
    }
    setWidths((prev) => {
      const same =
        Object.keys(next).length === Object.keys(prev).length && Object.keys(next).every((k) => prev[k] === next[k]);
      return same ? prev : next;
    });
  }, []);
  useLayoutEffect(measure);
  useEffect(() => {
    const box = measureRef.current;
    if (!box) return;
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, [measure]);

  // How many fit, in order. Until the first measurement every control shows -- the common case.
  let shown = items.length;
  if (room !== null) {
    const w = (it: OverflowItem) => widths[it.id] ?? 28;
    const total = items.reduce((sum, it, i) => sum + w(it) + (i ? gap : 0), 0);
    if (total > room) {
      let used = menuButtonWidth; // the menu button takes a place of its own
      shown = 0;
      for (const it of items) {
        if (used + gap + w(it) > room) break;
        used += gap + w(it);
        shown++;
      }
    }
  }
  const inline = items.slice(0, shown);
  const overflow = items.slice(shown).flatMap((it) => it.menu);

  return (
    <div className={cn("relative flex shrink-0 items-center", className)} style={{ gap }}>
      {inline.map((it) => (
        <span key={it.id} className="flex shrink-0 items-center">
          {it.inline}
        </span>
      ))}
      {overflow.length > 0 && (
        <ToolbarMore actions={overflow} variant={menuVariant} buttonClassName={menuButtonClassName} />
      )}
      {/* The measuring copy: laid out at its natural width inside a box of no size at all, so it is
          never seen, never reached, and never widens the pane it sits in. */}
      <div aria-hidden inert className="pointer-events-none invisible absolute right-0 top-0 size-0 overflow-hidden">
        <div ref={measureRef} className="flex w-max items-center">
          {items.map((it) => (
            <span key={it.id} data-overflow-id={it.id} className="flex shrink-0 items-center">
              {it.inline}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Width of the "more" button: a 28px square, the size of the controls it stands in for. */
const MORE_WIDTH = 28;
