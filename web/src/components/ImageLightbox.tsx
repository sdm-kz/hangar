import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Check, ChevronLeft, ChevronRight, Copy, Maximize, Minus, Plus, X } from "lucide-react";

const MIN = 0.2;
const MAX = 8;

/** One picture the viewer can show. */
export interface LightboxImage {
  src: string;
  name: string;
}

/**
 * Full-page image viewer with wheel/button zoom and drag-to-pan. Esc / +/- / 0 / Ctrl+C shortcuts. Opens with the
 * whole image in view: a picture bigger than the page is scaled down to fit it, a smaller one is shown at
 * its own size. Reset (and 0, and a double-click) goes back to that.
 *
 * `gallery` is the set the image was opened from (a message's images, the ones attached to a draft): with
 * more than one, ← and → and the buttons at the sides go through them, round from the last to the first.
 */
export function ImageLightbox({
  src,
  name,
  gallery,
  onClose,
}: {
  src: string;
  name: string;
  gallery?: LightboxImage[];
  onClose: () => void;
}) {
  const [at, setAt] = useState(() => gallery?.findIndex((g) => g.src === src) ?? -1);
  const many = !!gallery && gallery.length > 1 && at >= 0;
  const shown = (at >= 0 && gallery?.[at]) || { src, name };
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
  // How the last copy went, shown on its button for a moment.
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

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
  // Another of the set, fitted afresh: its own size decides the fit, so it shows once it has loaded.
  const step = (by: number) => {
    if (!many) return;
    setAt((i) => (i + by + gallery!.length) % gallery!.length);
    fitted.current = true;
    setReady(false);
    setPos({ x: 0, y: 0 });
  };

  // The picture on show, onto the clipboard as a PNG — the one image type every browser writes there.
  const copy = () => {
    const done = (how: "ok" | "failed") => {
      setCopied(how);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(null), 1500);
    };
    // Not on a page served over plain http from another machine: browsers keep the clipboard from those.
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") return done("failed");
    // The item takes the picture still to come, so the write is made within the click that asked for it.
    void navigator.clipboard
      .write([new ClipboardItem({ "image/png": pngOf(shown.src) })])
      .then(
        () => done("ok"),
        () => done("failed")
      );
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
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && !String(window.getSelection())) {
        e.preventDefault();
        copy();
      }
      // Kept from whatever has the keyboard under the viewer (a text box's caret).
      else if (e.key === "ArrowLeft" && many) {
        e.preventDefault();
        step(-1);
      } else if (e.key === "ArrowRight" && many) {
        e.preventDefault();
        step(1);
      }
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
        <span className="truncate text-sm">
          {shown.name}
          {many && (
            <span className="ml-2 tabular-nums text-white/60">
              {at + 1} / {gallery!.length}
            </span>
          )}
        </span>
        <div className="flex items-center gap-1">
          <IconBtn title="Zoom out" onClick={() => zoom(1 / 1.2)}>
            <Minus className="size-4" />
          </IconBtn>
          <span className="w-12 text-center text-xs tabular-nums">{Math.round(scale * 100)}%</span>
          <IconBtn title="Zoom in" onClick={() => zoom(1.2)}>
            <Plus className="size-4" />
          </IconBtn>
          <IconBtn title="Fit to the page (0)" onClick={reset}>
            <Maximize className="size-4" />
          </IconBtn>
          <IconBtn
            title={
              copied === "ok"
                ? "Copied"
                : copied === "failed"
                  ? "The browser didn't let the image be copied"
                  : `Copy image (${/Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘C" : "Ctrl+C"})`
            }
            onClick={copy}
          >
            {copied === "ok" ? (
              <Check className="size-4 text-emerald-400" />
            ) : copied === "failed" ? (
              // Not an X: that is the close button's, beside it.
              <Copy className="size-4 text-red-400" />
            ) : (
              <Copy className="size-4" />
            )}
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
          // A fresh element for each of the set, so its load (and the fit that follows it) is its own — by
          // place as well, for a set that holds the same picture twice.
          key={`${at}:${shown.src}`}
          ref={imgRef}
          onLoad={refit}
          onError={() => setReady(true)}
          src={shown.src}
          alt={shown.name}
          draggable={false}
          className="pointer-events-none absolute left-1/2 top-1/2 max-h-none max-w-none select-none"
          style={{
            transform: `translate(-50%, -50%) translate(${pos.x}px, ${pos.y}px) scale(${scale})`,
            visibility: ready ? "visible" : "hidden",
          }}
        />
        {many && (
          <>
            <SideBtn side="left" title="Previous image (←)" onClick={() => step(-1)}>
              <ChevronLeft className="size-6" />
            </SideBtn>
            <SideBtn side="right" title="Next image (→)" onClick={() => step(1)}>
              <ChevronRight className="size-6" />
            </SideBtn>
          </>
        )}
      </div>
    </div>
  );
}

/** The picture at `src` as a PNG: as it is when it is one, drawn out again when it is another type. */
async function pngOf(src: string): Promise<Blob> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't make a PNG"))), "image/png")
  );
}

/**
 * A button at one side of the picture. A press on it is kept from the area under it, whose drag would
 * capture the pointer and so take the click away from the button.
 */
function SideBtn({
  side,
  title,
  onClick,
  children,
}: {
  side: "left" | "right";
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={onClick}
      className={`absolute top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-black/50 text-white hover:bg-black/70 ${side === "left" ? "left-3" : "right-3"}`}
    >
      {children}
    </button>
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
