import { useCallback, useState } from "react";
import { ZoomIn, ZoomOut } from "lucide-react";
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
