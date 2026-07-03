import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Minus, Plus, RotateCcw, X } from "lucide-react";

const MIN = 0.2;
const MAX = 8;
const clamp = (s: number) => Math.min(MAX, Math.max(MIN, s));

/** Full-page image viewer with wheel/button zoom and drag-to-pan. Esc / +/- / 0 shortcuts. */
export function ImageLightbox({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  const reset = () => {
    setScale(1);
    setPos({ x: 0, y: 0 });
  };

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "+" || e.key === "=") setScale((s) => clamp(s * 1.2));
      else if (e.key === "-" || e.key === "_") setScale((s) => clamp(s / 1.2));
      else if (e.key === "0") reset();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function onWheel(e: React.WheelEvent) {
    setScale((s) => clamp(s * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
  }
  function onPointerDown(e: React.PointerEvent) {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y };
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current) return;
    setPos({ x: drag.current.px + (e.clientX - drag.current.x), y: drag.current.py + (e.clientY - drag.current.y) });
  }
  function onPointerUp() {
    drag.current = null;
  }

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-black/90 backdrop-blur-sm">
      <div className="flex items-center justify-between gap-2 px-4 py-2 text-white">
        <span className="truncate text-sm">{name}</span>
        <div className="flex items-center gap-1">
          <IconBtn title="Zoom out" onClick={() => setScale((s) => clamp(s / 1.2))}>
            <Minus className="size-4" />
          </IconBtn>
          <span className="w-12 text-center text-xs tabular-nums">{Math.round(scale * 100)}%</span>
          <IconBtn title="Zoom in" onClick={() => setScale((s) => clamp(s * 1.2))}>
            <Plus className="size-4" />
          </IconBtn>
          <IconBtn title="Reset" onClick={reset}>
            <RotateCcw className="size-4" />
          </IconBtn>
          <IconBtn title="Close (Esc)" onClick={onClose}>
            <X className="size-5" />
          </IconBtn>
        </div>
      </div>

      <div
        className="relative flex-1 overflow-hidden"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onDoubleClick={reset}
        style={{ cursor: scale > 1 ? "grab" : "default", touchAction: "none" }}
      >
        <img
          src={src}
          alt={name}
          draggable={false}
          className="pointer-events-none absolute left-1/2 top-1/2 max-h-none max-w-none select-none"
          style={{
            transform: `translate(-50%, -50%) translate(${pos.x}px, ${pos.y}px) scale(${scale})`,
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
