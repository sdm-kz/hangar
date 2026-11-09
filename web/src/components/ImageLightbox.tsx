import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Minus, Plus, RotateCcw, X } from "lucide-react";

const MIN = 0.2;
const MAX = 8;

/**
 * Full-page image viewer with wheel/button zoom and drag-to-pan. Esc / +/- / 0 shortcuts. Opens with the
 * whole image in view: a picture bigger than the page is scaled down to fit it, a smaller one is shown at
 * its own size. Reset (and 0, and a double-click) goes back to that.
 */
export function ImageLightbox({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  // The scale that fits the image in the area, 1 at most. Zooming out may go below it, for a picture so
  // big that it fits only under the usual floor.
  const [fit, setFit] = useState(1);
  // Hidden until it has loaded and been fitted, so a big one doesn't flash up at full size first.
  const [ready, setReady] = useState(false);
  const clamp = (s: number) => Math.min(MAX, Math.max(Math.min(MIN, fit), s));
  // Still showing the fitted view, untouched: a resize of the window fits it again.
  const fitted = useRef(true);

  const fitScale = () => {
    const img = imgRef.current;
    const area = areaRef.current;
    if (!img?.naturalWidth || !area?.clientWidth) return 1;
    return Math.min(1, area.clientWidth / img.naturalWidth, area.clientHeight / img.naturalHeight);
  };
  const refit = () => {
    const f = fitScale();
    setFit(f);
    if (fitted.current) setScale(f);
    setReady(true);
  };
  const reset = () => {
    fitted.current = true;
    setScale(fitScale());
    setPos({ x: 0, y: 0 });
  };
  const zoom = (by: number) => {
    fitted.current = false;
    setScale((s) => clamp(s * by));
  };

  useEffect(() => {
    window.addEventListener("resize", refit);
    return () => window.removeEventListener("resize", refit);
  });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "+" || e.key === "=") zoom(1.2);
      else if (e.key === "-" || e.key === "_") zoom(1 / 1.2);
      else if (e.key === "0") reset();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function onWheel(e: React.WheelEvent) {
    zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
  }
  function onPointerDown(e: React.PointerEvent) {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y };
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current) return;
    fitted.current = false; // moved off the fitted view: a resize leaves it where it was put
    setPos({ x: drag.current.px + (e.clientX - drag.current.x), y: drag.current.py + (e.clientY - drag.current.y) });
  }
  function onPointerUp() {
    drag.current = null;
  }

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-black/90 safe-area-pad backdrop-blur-sm">
      <div className="flex items-center justify-between gap-2 px-4 py-2 text-white">
        <span className="truncate text-sm">{name}</span>
        <div className="flex items-center gap-1">
          <IconBtn title="Zoom out" onClick={() => zoom(1 / 1.2)}>
            <Minus className="size-4" />
          </IconBtn>
          <span className="w-12 text-center text-xs tabular-nums">{Math.round(scale * 100)}%</span>
          <IconBtn title="Zoom in" onClick={() => zoom(1.2)}>
            <Plus className="size-4" />
          </IconBtn>
          <IconBtn title="Fit to the page (0)" onClick={reset}>
            <RotateCcw className="size-4" />
          </IconBtn>
          <IconBtn title="Close (Esc)" onClick={onClose}>
            <X className="size-5" />
          </IconBtn>
        </div>
      </div>

      <div
        ref={areaRef}
        className="relative flex-1 overflow-hidden"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onDoubleClick={reset}
        style={{ cursor: scale > fit ? "grab" : "default", touchAction: "none" }}
      >
        <img
          ref={imgRef}
          onLoad={refit}
          onError={() => setReady(true)}
          src={src}
          alt={name}
          draggable={false}
          className="pointer-events-none absolute left-1/2 top-1/2 max-h-none max-w-none select-none"
          style={{
            transform: `translate(-50%, -50%) translate(${pos.x}px, ${pos.y}px) scale(${scale})`,
            visibility: ready ? "visible" : "hidden",
          }}
        />
      </div>
    </div>
  );
}

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      title={title}
      onClick={onClick}
      className="text-white hover:bg-white/15 hover:text-white"
    >
      {children}
    </Button>
  );
}
