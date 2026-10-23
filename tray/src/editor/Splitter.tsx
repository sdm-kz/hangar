import { useRef } from "react";
import clsx from "clsx";

/** How big the composer is, and how much of it the session list takes — as they were last left. */
export const LAYOUT_KEY = "snap.editor.layout";
export const COMPOSER_HEIGHT = 196;
export const PICKER_WIDTH = 340;
/** Below these a part stops being usable: the message box and Send bar, the list, the picture. */
export const COMPOSER_MIN = 132;
export const PICKER_MIN = 220;
export const MESSAGE_MIN = 280;
export const CANVAS_MIN = 120;
/** The toolbar above the picture (its h-12), which the composer can't grow into either. */
export const TOOLBAR_HEIGHT = 48;

export function loadLayout(): { composer: number; picker: number } {
  const fallback = { composer: COMPOSER_HEIGHT, picker: PICKER_WIDTH };
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null");
    const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
    return saved ? { composer: num(saved.composer, fallback.composer), picker: num(saved.picker, fallback.picker) } : fallback;
  } catch {
    return fallback;
  }
}

export function saveLayout(layout: { composer: number; picker: number }) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    /* a convenience only */
  }
}

/**
 * A drag handle between two parts of the editor. `size` is the part it resizes (as asked for;
 * `current` measures it as drawn, which CSS may have held smaller), which grows as the pointer moves
 * by `sign` along `axis` (-1 when the part is on the far side: the composer under the
 * handle grows as it is dragged up). `room` is asked once, as a drag starts, how far that part can
 * grow before its neighbour hits its own minimum — measured then, so a size saved on a bigger window
 * can't leave a stretch of drag that does nothing. Double-click puts back `reset`; the arrow keys
 * move it too.
 */
export function Splitter({
  axis,
  sign,
  size,
  current,
  min,
  room,
  reset,
  onSize,
  label,
  className,
}: {
  axis: "x" | "y";
  sign: 1 | -1;
  size: number;
  current(): number;
  min: number;
  room(): number;
  reset: number;
  onSize(size: number): void;
  label: string;
  className?: string;
}) {
  const drag = useRef<{ pos: number; size: number; max: number } | null>(null);
  const at = (e: React.PointerEvent) => (axis === "x" ? e.clientX : e.clientY);
  const clamp = (v: number, max: number) => Math.round(Math.max(min, Math.min(v, Math.max(min, max))));

  return (
    <div
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuenow={Math.round(size)}
      aria-valuemin={min}
      tabIndex={0}
      title={`${label} · double-click to reset`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        // What is on screen, not what was asked for: a saved size may be more than fits right now.
        const shown = current();
        drag.current = { pos: at(e), size: shown, max: shown + room() };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) onSize(clamp(d.size + sign * (at(e) - d.pos), d.max));
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onDoubleClick={() => onSize(clamp(reset, current() + room()))}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 16;
        const grow = axis === "x" ? { ArrowLeft: -1, ArrowRight: 1 } : { ArrowUp: -1, ArrowDown: 1 };
        const dir = grow[e.key as keyof typeof grow];
        if (!dir) return;
        e.preventDefault();
        const shown = current();
        onSize(clamp(shown + sign * dir * step, shown + room()));
      }}
      className={clsx(
        "group relative shrink-0 touch-none outline-none",
        axis === "x" ? "cursor-col-resize" : "cursor-row-resize",
        className,
      )}
    >
      {/* The line that shows on hover, drag or focus, centred in the handle. */}
      <span
        className={clsx(
          "pointer-events-none absolute rounded-full bg-accent/60 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-active:opacity-100",
          axis === "x" ? "inset-y-1 left-1/2 w-0.5 -translate-x-1/2" : "inset-x-0 top-1/2 h-0.5 -translate-y-1/2",
        )}
      />
    </div>
  );
}
