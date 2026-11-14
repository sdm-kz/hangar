import { useRef } from "react";
import { ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { panZoomTransform, usePanZoom } from "@/lib/usePanZoom";

/**
 * An image in its own tab, zoomable where it is: the wheel or a trackpad pinch zooms about the
 * pointer, a drag pans, a double-click (or the percentage in the corner box) fits it back in the tab.
 * The box's buttons zoom about the middle, as the full-page viewer's do. Opens fitted, the way the
 * plain picture it replaces was shown.
 *
 * Its own box rather than {@link ZoomControls}: those stop at a few text sizes between 50% and 200%,
 * where a picture wants anything from a fraction to many times its size. It looks the same and sits
 * where they do.
 *
 * Give it a `key` of the picture's address, so another picture starts fitted rather than at the zoom
 * the last one was left at.
 */
export function ImagePane({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const areaRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const { view, fit, ready, setReady, refit, reset, zoom, panHandlers } = usePanZoom(areaRef, imgRef);
  return (
    <div
      ref={areaRef}
      className={cn("relative h-full w-full overflow-hidden", className)}
      {...panHandlers}
      onDoubleClick={reset}
      style={{ cursor: view.scale > fit ? "grab" : "default", touchAction: "none" }}
    >
      <img
        ref={imgRef}
        onLoad={refit}
        onError={() => setReady(true)}
        src={src}
        alt={alt}
        draggable={false}
        className="pointer-events-none absolute left-1/2 top-1/2 max-h-none max-w-none select-none shadow-sm"
        style={{ transform: panZoomTransform(view), visibility: ready ? "visible" : "hidden" }}
      />
      {/* A press on the box is kept from the picture's drag, which would capture the pointer and so
          take the click away from the button. */}
      <div
        className="absolute bottom-3 right-3 z-10 flex items-center rounded-md border bg-background/90 p-0.5 shadow-sm backdrop-blur"
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <Button variant="ghost" size="icon" className="size-7" title="Zoom out" onClick={() => zoom(1 / 1.25)}>
          <ZoomOut className="size-4" />
        </Button>
        <button
          className="min-w-11 rounded px-1 py-1 text-center text-xs tabular-nums text-muted-foreground hover:bg-accent"
          title="Fit to the tab (or double-click the picture)"
          onClick={reset}
        >
          {Math.round(view.scale * 100)}%
        </button>
        <Button variant="ghost" size="icon" className="size-7" title="Zoom in" onClick={() => zoom(1.25)}>
          <ZoomIn className="size-4" />
        </Button>
      </div>
    </div>
  );
}
