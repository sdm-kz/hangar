import { useCallback, useEffect, useState, type ReactNode, type RefObject } from "react";
import { ArrowDown, ArrowUp, FoldHorizontal, UnfoldHorizontal, WrapText, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Discrete zoom stops shared by every zoomable preview; 1 is the always-present default.
export const ZOOM_LEVELS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

/** The zoom last chosen under `key` (see {@link usePersistentZoom}), for a view that only follows it. */
export function storedZoom(key: string): number {
  try {
    const v = Number(localStorage.getItem(`hangar.zoom:${key}`));
    return ZOOM_LEVELS.includes(v) ? v : 1;
  } catch {
    return 1;
  }
}

/**
 * Zoom state persisted in localStorage under `hangar.zoom:<key>`, so a chosen size survives
 * page reloads (and is shared across tabs). Previews with different natural sizes use different
 * keys — e.g. text previews vs Word documents — so one doesn't inherit the other's level.
 */
export function usePersistentZoom(key: string): [number, (zoom: number) => void] {
  const storageKey = `hangar.zoom:${key}`;
  const [zoom, setZoom] = useState(() => storedZoom(key));
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

/**
 * Reading-width stops for text previews: `null` fills the viewer (the default), the numbers cap the
 * content and center it, so a full-page preview on a wide screen gets symmetric left/right margins
 * instead of lines running the whole monitor. Measured *inside* the zoomed content box, so a line
 * keeps the same character count at any zoom level.
 */
export const READING_WIDTHS: (number | null)[] = [null, 1200, 960, 760];
const READING_WIDTH_LABELS = ["full width", "wide", "medium", "narrow"];

/**
 * Reading width persisted in localStorage under `hangar.readingWidth:<key>` — same key space as
 * usePersistentZoom, so the text previews across the app share one chosen width and it survives a
 * reload (and the standalone preview tab picks up what was set in the app).
 */
export function usePersistentReadingWidth(key: string): [number | null, (width: number | null) => void] {
  const storageKey = `hangar.readingWidth:${key}`;
  const [width, setWidth] = useState<number | null>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw === null) return null;
      const v = Number(raw);
      return READING_WIDTHS.includes(v) ? v : null;
    } catch {
      return null;
    }
  });
  const set = useCallback(
    (w: number | null) => {
      setWidth(w);
      try {
        if (w === null) localStorage.removeItem(storageKey);
        else localStorage.setItem(storageKey, String(w));
      } catch {
        /* storage unavailable — persistence is best-effort */
      }
    },
    [storageKey]
  );
  return [width, set];
}

/**
 * Word wrap for text previews, persisted under `hangar.wordWrap:<key>` beside the zoom and the
 * reading width. Off by default: source is laid out in lines by whoever wrote it, and wrapping quietly
 * changes what a line looks like, so it is something you turn on for the file that needs it -- a log,
 * a minified bundle, prose in a .txt -- rather than the resting state.
 */
export function usePersistentWordWrap(key: string): [boolean, (wrap: boolean) => void] {
  const storageKey = `hangar.wordWrap:${key}`;
  const [wrap, setWrap] = useState(() => {
    try {
      return localStorage.getItem(storageKey) === "1";
    } catch {
      return false;
    }
  });
  const set = useCallback(
    (w: boolean) => {
      setWrap(w);
      try {
        if (w) localStorage.setItem(storageKey, "1");
        else localStorage.removeItem(storageKey);
      } catch {
        /* storage unavailable — persistence is best-effort */
      }
    },
    [storageKey]
  );
  return [wrap, set];
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
 *
 * Pass `width`/`onWidthChange` to prepend the reading-width toggle (see READING_WIDTHS): one button
 * that cycles full width → wide → medium → narrow, applied by the caller as a `maxWidth` on the
 * centered content. Hidden on phones, where nothing is wide enough to need margins.
 *
 * Pass `wrap`/`onWrapChange` to lead with the word-wrap toggle. Unlike the width toggle it stays on
 * phones: a narrow screen is exactly where a long line runs off the edge.
 *
 * `leading` goes first of all, set off by a divider: a button of the viewer's own that belongs with these.
 */
export function ZoomControls({
  zoom,
  onChange,
  width,
  onWidthChange,
  wrap,
  onWrapChange,
  leading,
  className = "right-3 top-3",
}: {
  zoom: number;
  onChange: (zoom: number) => void;
  /** Current reading width; pass together with onWidthChange to show the margins toggle. */
  width?: number | null;
  onWidthChange?: (width: number | null) => void;
  /** Whether long lines wrap; pass together with onWrapChange to show the toggle. */
  wrap?: boolean;
  onWrapChange?: (wrap: boolean) => void;
  leading?: ReactNode;
  /** Position within the nearest relative ancestor, e.g. "bottom-3 right-3". */
  className?: string;
}) {
  const step = (dir: 1 | -1) => {
    const i = ZOOM_LEVELS.indexOf(zoom) + dir;
    onChange(ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, i))]);
  };
  const widthIndex = Math.max(0, READING_WIDTHS.indexOf(width ?? null));
  const nextWidthIndex = (widthIndex + 1) % READING_WIDTHS.length;
  return (
    // The margin is the scrollbar's, not spacing: `right-3` measures from the pane's padding edge,
    // which runs under the scrollbar track, so without it the box sits a couple of pixels on top of
    // the track it is parked beside. --scrollbar-w is 0 where scrollbars overlay the content, and
    // margin-right does nothing at all where the caller pins the box by its left edge instead.
    <div
      className={cn(
        "absolute z-10 mr-[var(--scrollbar-w,0px)] flex items-center rounded-md border bg-background/90 p-0.5 shadow-sm backdrop-blur",
        className
      )}
    >
      {leading && (
        <>
          {leading}
          <span aria-hidden className="mx-0.5 h-5 w-px bg-border" />
        </>
      )}
      {onWrapChange && (
        <>
          <Button
            variant="ghost"
            size="icon"
            aria-pressed={!!wrap}
            // Highlighted while on, the same way a capped reading width is: a mode that changes how
            // the text is laid out should look switched on, not just have been clicked once.
            className={cn("size-7 text-muted-foreground", wrap && "bg-accent text-foreground")}
            title={wrap ? "Word wrap: on — click to turn off" : "Word wrap: off — click to wrap long lines"}
            onClick={() => onWrapChange(!wrap)}
          >
            <WrapText className="size-4" />
          </Button>
          <span aria-hidden className="mx-0.5 h-5 w-px bg-border" />
        </>
      )}
      {onWidthChange && (
        <div className="hidden items-center sm:flex">
          <Button
            variant="ghost"
            size="icon"
            // Each stop has to be tellable apart at a glance: full width is a plain unfold icon,
            // while a capped width folds the icon, highlights the button and spells out the cap.
            className={cn(
              "h-7 w-7 text-muted-foreground",
              width != null && "w-auto gap-1 bg-accent px-1.5 text-foreground"
            )}
            title={`Reading width: ${READING_WIDTH_LABELS[widthIndex]} — click for ${READING_WIDTH_LABELS[nextWidthIndex]}`}
            onClick={() => onWidthChange(READING_WIDTHS[nextWidthIndex])}
          >
            {width == null ? (
              <UnfoldHorizontal className="size-4" />
            ) : (
              <>
                <FoldHorizontal className="size-4" />
                <span className="text-[10px] tabular-nums">{width}</span>
              </>
            )}
          </Button>
          <span aria-hidden className="mx-0.5 h-5 w-px bg-border" />
        </div>
      )}
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
