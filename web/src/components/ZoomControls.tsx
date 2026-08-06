import { useCallback, useEffect, useState, type RefObject } from "react";
import { ArrowDown, ArrowUp, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Discrete zoom stops shared by every zoomable preview; 1 is the always-present default.
export const ZOOM_LEVELS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

/**
 * Zoom state persisted in localStorage under `claudeweb.zoom:<key>`, so a chosen size survives
 * page reloads (and is shared across tabs). Previews with different natural sizes use different
 * keys — e.g. text previews vs Word documents — so one doesn't inherit the other's level.
 */
export function usePersistentZoom(key: string): [number, (zoom: number) => void] {
  const storageKey = `claudeweb.zoom:${key}`;
  const [zoom, setZoom] = useState(() => {
    try {
      const v = Number(localStorage.getItem(storageKey));
      return ZOOM_LEVELS.includes(v) ? v : 1;
    } catch {
      return 1;
    }
  });
  const set = useCallback(
    (z: number) => {
      setZoom(z);
      try {
        localStorage.setItem(storageKey, String(z));
      } catch {
        /* storage unavailable — persistence is best-effort */
      }
    },
    [storageKey]
  );
  return [zoom, set];
}

// Hide the jump buttons this close to the respective end — a jump that saves less than half a
// screen isn't worth the visual noise.
const JUMP_SLACK = 200;

/**
 * Floating jump-to-top/bottom buttons for a scrollable preview. Position them via `className`
 * inside a `relative` ancestor. Each button only appears when there is meaningfully far to go in
 * its direction, so nothing shows on short content, at the top only ↓ shows, and so on.
 */
export function ScrollJumpButtons({
  containerRef,
  watch,
  className = "bottom-14 right-3",
}: {
  /** The scrollable element the buttons act on. */
  containerRef: RefObject<HTMLElement | null>;
  /** Any value that changes when the container's content is swapped, to re-measure and re-observe. */
  watch?: unknown;
  className?: string;
}) {
  const [canUp, setCanUp] = useState(false);
  const [canDown, setCanDown] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      setCanUp(el.scrollTop > JUMP_SLACK);
      setCanDown(el.scrollTop + el.clientHeight < el.scrollHeight - JUMP_SLACK);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    el.addEventListener("scroll", schedule, { passive: true });
    // The container itself never resizes when content grows — watch its child (late images,
    // mermaid diagrams, zoom changes) so the buttons appear/disappear as scrollHeight changes.
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", schedule);
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [containerRef, watch]);

  const jump = (top: number) => containerRef.current?.scrollTo({ top, behavior: "smooth" });

  if (!canUp && !canDown) return null;
  return (
    <div className={cn("absolute z-10 flex flex-col gap-1", className)}>
      {canUp && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 rounded-md border bg-background/90 shadow-sm backdrop-blur"
          title="Scroll to top"
          onClick={() => jump(0)}
        >
          <ArrowUp className="size-4" />
        </Button>
      )}
      {canDown && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 rounded-md border bg-background/90 shadow-sm backdrop-blur"
          title="Scroll to bottom"
          onClick={() => jump(containerRef.current?.scrollHeight ?? 0)}
        >
          <ArrowDown className="size-4" />
        </Button>
      )}
    </div>
  );
}

/**
 * Floating −/percent/+ overlay for the corner of a viewer (position it via `className` inside a
 * relative ancestor). Clicking the percentage resets to 100%. The value is applied by the caller
 * via CSS `zoom`, which (unlike `transform: scale`) participates in layout so scrollbars stay
 * correct at any level.
 */
export function ZoomControls({
  zoom,
  onChange,
  className = "right-3 top-3",
}: {
  zoom: number;
  onChange: (zoom: number) => void;
  /** Position within the nearest relative ancestor, e.g. "bottom-3 right-3". */
  className?: string;
}) {
  const step = (dir: 1 | -1) => {
    const i = ZOOM_LEVELS.indexOf(zoom) + dir;
    onChange(ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, i))]);
  };
  return (
    <div className={cn("absolute z-10 flex items-center rounded-md border bg-background/90 p-0.5 shadow-sm backdrop-blur", className)}>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        title="Zoom out"
        disabled={zoom === ZOOM_LEVELS[0]}
        onClick={() => step(-1)}
      >
        <ZoomOut className="size-4" />
      </Button>
      <button
        className="min-w-11 rounded px-1 py-1 text-center text-xs tabular-nums text-muted-foreground hover:bg-accent"
        title="Reset zoom"
        onClick={() => onChange(1)}
      >
        {Math.round(zoom * 100)}%
      </button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        title="Zoom in"
        disabled={zoom === ZOOM_LEVELS[ZOOM_LEVELS.length - 1]}
        onClick={() => step(1)}
      >
        <ZoomIn className="size-4" />
      </Button>
    </div>
  );
}
