import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, pictureUrl, type OverlayInit, type Rect, type Selection, type WindowBox } from "@/lib/tauri";
import { CLICK_SLOP, extendPath, polygonArea, rectBetween, toFrameRect, windowAt, type Point } from "./selection";

/**
 * The overlay page for one monitor. It stays loaded, hidden, between captures (see windows.rs): each
 * capture announces itself with `overlay-start`, and gets a fresh view of its own — keyed by its
 * generation, so nothing of the last one's drag or state carries over. `overlay-end` drops the view and
 * with it the frame's pixels.
 */
export default function Overlay({ frame }: { frame: number }) {
  const [init, setInit] = useState<OverlayInit | null>(null);

  useEffect(() => {
    document.body.classList.add("overlay");
    let latest = 0;
    const load = () =>
      api.overlayInit(frame).then(
        (i) => {
          if (i.generation <= latest) return;
          latest = i.generation;
          setInit(i);
        },
        () => {}, // no capture in progress: this is a page loaded ahead of time
      );
    const started = listen<{ frame: number; generation: number }>("overlay-start", (e) => {
      if (e.payload.frame === frame) void load();
    });
    const ended = listen("overlay-end", () => setInit(null));
    // Also ask now, for a capture that began while this page was still loading.
    void load();
    return () => {
      void started.then((f) => f());
      void ended.then((f) => f());
    };
  }, [frame]);

  return init ? <OverlayView key={init.generation} frame={frame} init={init} /> : null;
}

/**
 * One monitor's frozen screen, to pick a capture from. The picture is the frame taken when the hotkey
 * fired; the overlay dims it and lifts out whatever is being picked:
 *
 * - region: drag a rectangle (Shift squares it, Space moves it), or click to take the window under the
 *   cursor — or the whole screen when there is none;
 * - window: hover to see which window, click to take it;
 * - freeform: trace a shape; letting go closes it.
 *
 * Esc cancels from anywhere; a right-click drops a drag in progress, or cancels when there is none.
 */
function OverlayView({ frame, init }: { frame: number; init: OverlayInit }) {
  const [error, setError] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [view, setView] = useState({ width: window.innerWidth, height: window.innerHeight });
  const committed = useRef(false);
  const spaceHeld = useRef(false);
  // Set when a right-click dropped a drag: the buttons still held must not finish it when released.
  const dropped = useRef(false);

  useEffect(() => {
    // The window was just moved over its monitor, possibly resized with it.
    setView({ width: window.innerWidth, height: window.innerHeight });
    const onResize = () => setView({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Frame pixels per CSS pixel. Measured, not assumed from devicePixelRatio: on Linux the window may
  // not be exactly the monitor's size, and this keeps the picture and the picking in step regardless.
  const ratio = useMemo(
    () => (init ? { x: init.width / view.width, y: init.height / view.height } : { x: 1, y: 1 }),
    [init, view],
  );
  const toFrame = useCallback((p: Point): Point => ({ x: p.x * ratio.x, y: p.y * ratio.y }), [ratio]);
  const toView = useCallback(
    (r: Rect): Rect => ({ x: r.x / ratio.x, y: r.y / ratio.y, width: r.width / ratio.x, height: r.height / ratio.y }),
    [ratio],
  );

  const mode = init?.mode ?? "region";
  const snapsToWindows = (mode === "region" || mode === "window") && (init?.windows.length ?? 0) > 0;
  const hovered: WindowBox | undefined =
    init && cursor && snapsToWindows && (!drag || !drag.moved) ? windowAt(init.windows, toFrame(cursor)) : undefined;

  const commit = useCallback(
    (selection: Selection) => {
      if (committed.current) return;
      committed.current = true;
      void api.overlayCommit(frame, selection);
    },
    [frame],
  );
  const cancel = useCallback(() => {
    committed.current = true;
    void api.overlayCancel();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
      else if (e.key === " ") spaceHeld.current = e.type === "keydown";
      else if (e.key === "Enter" && e.type === "keydown" && !drag) commit({ kind: "full" });
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, [cancel, commit, drag]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!init || committed.current) return;
    if (e.button === 2) {
      if (drag) setDrag(null);
      else cancel();
      return;
    }
    if (e.button !== 0) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    const p = { x: e.clientX, y: e.clientY };
    setDrag({ start: p, current: p, moved: false, square: e.shiftKey, path: [p] });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = { x: e.clientX, y: e.clientY };
    setCursor(p);
    if (!drag) return;
    // A right button pressed mid-drag arrives as a move (pointerdown only fires for the first button
    // down): drop the drag, as a right-click is documented to.
    if (e.buttons & 2) {
      setDrag(null);
      dropped.current = true;
      return;
    }
    const moved = drag.moved || Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > CLICK_SLOP;
    if (mode === "window") {
      setDrag({ ...drag, current: p });
      return;
    }
    if (spaceHeld.current && drag.moved && mode === "region") {
      // Space held: slide the whole selection instead of resizing it.
      const dx = p.x - drag.current.x;
      const dy = p.y - drag.current.y;
      setDrag({ ...drag, start: { x: drag.start.x + dx, y: drag.start.y + dy }, current: p });
      return;
    }
    setDrag({
      ...drag,
      current: p,
      moved,
      square: e.shiftKey,
      path: mode === "freeform" ? extendPath(drag.path, p) : drag.path,
    });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (dropped.current) {
      if (e.buttons === 0) dropped.current = false;
      return;
    }
    if (!drag || !init || e.button !== 0) return;
    const d = drag;
    setDrag(null);
    if (mode === "freeform") {
      if (d.moved && d.path.length >= 3 && polygonArea(d.path) >= 64) {
        commit({ kind: "freeform", points: d.path.map((p) => [p.x * ratio.x, p.y * ratio.y]) });
      }
      return;
    }
    if (mode === "region" && d.moved) {
      const rect = toFrameRect(rectBetween(d.start, d.current, d.square), ratio.x, ratio.y, init.width, init.height);
      if (rect.width >= 2 && rect.height >= 2) commit({ kind: "rect", rect });
      return;
    }
    // A click: the window under it, or in region mode the whole screen when there's no window.
    const w = snapsToWindows ? windowAt(init.windows, toFrame(d.current)) : undefined;
    if (w) commit({ kind: "rect", rect: w.rect });
    else if (mode === "region" || !snapsToWindows) commit({ kind: "full" });
  };

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-white" onClick={cancel}>
        {error}
      </div>
    );
  }

  const selectionRect =
    drag?.moved && mode === "region" ? rectBetween(drag.start, drag.current, drag.square) : hovered ? toView(hovered.rect) : null;
  const lasso = mode === "freeform" && drag?.moved ? drag.path : null;
  const frameSize = selectionRect
    ? toFrameRect(selectionRect, ratio.x, ratio.y, init?.width ?? 0, init?.height ?? 0)
    : null;

  return (
    <div
      className="fixed inset-0"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerEnter={() => void getCurrentWindow().setFocus()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {init && (
        <img
          ref={imgRef}
          src={pictureUrl(`frame/${frame}?g=${init.generation}`)}
          alt=""
          draggable={false}
          className="pointer-events-none absolute inset-0 h-full w-full"
          onLoad={() => void api.overlayReady()}
          onError={() => setError("Could not load the captured screen.")}
        />
      )}
      <svg className="pointer-events-none absolute inset-0" width={view.width} height={view.height}>
        <path
          d={`M0 0H${view.width}V${view.height}H0Z ${selectionPath(selectionRect, lasso)}`}
          fill="rgba(0,0,0,0.45)"
          fillRule="evenodd"
        />
        {selectionRect && (
          <rect
            x={selectionRect.x + 0.5}
            y={selectionRect.y + 0.5}
            width={Math.max(0, selectionRect.width - 1)}
            height={Math.max(0, selectionRect.height - 1)}
            fill={hovered && !drag?.moved ? "rgba(255,122,89,0.10)" : "none"}
            stroke={hovered && !drag?.moved ? "rgb(255,122,89)" : "white"}
            strokeWidth={hovered && !drag?.moved ? 2 : 1}
          />
        )}
        {lasso && (
          <polyline
            points={lasso.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke="white"
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
        )}
        {cursor && !drag && mode !== "window" && (
          <g stroke="rgba(255,255,255,0.35)" strokeWidth={1}>
            <line x1={0} y1={cursor.y + 0.5} x2={view.width} y2={cursor.y + 0.5} />
            <line x1={cursor.x + 0.5} y1={0} x2={cursor.x + 0.5} y2={view.height} />
          </g>
        )}
      </svg>
      {selectionRect && frameSize && (
        <SizeLabel rect={selectionRect} text={`${frameSize.width} × ${frameSize.height}`} sub={hovered && !drag?.moved ? hovered.title || hovered.app : undefined} view={view} />
      )}
      {cursor && init && mode !== "window" && imgRef.current && (
        <Loupe img={imgRef.current} at={cursor} ratio={ratio} view={view} />
      )}
      {init && <Hint mode={mode} hasWindows={snapsToWindows} hidden={!!drag?.moved} />}
    </div>
  );
}

type Drag = { start: Point; current: Point; moved: boolean; square: boolean; path: Point[] };

function selectionPath(rect: Rect | null, lasso: Point[] | null): string {
  if (lasso && lasso.length > 2) return `M${lasso.map((p) => `${p.x} ${p.y}`).join("L")}Z`;
  if (rect && rect.width > 0 && rect.height > 0) return `M${rect.x} ${rect.y}h${rect.width}v${rect.height}h${-rect.width}Z`;
  return "";
}

function SizeLabel({ rect, text, sub, view }: { rect: Rect; text: string; sub?: string; view: { width: number; height: number } }) {
  // Under the selection's bottom-left corner, or inside it when that would run off the screen.
  const below = rect.y + rect.height + 28 < view.height;
  const top = below ? rect.y + rect.height + 6 : Math.max(6, rect.y + rect.height - 28);
  const left = Math.min(Math.max(6, rect.x), view.width - 240);
  return (
    <div
      className="pointer-events-none absolute flex max-w-[60vw] items-center gap-2 rounded-md bg-black/75 px-2 py-0.5 text-[12px] text-white tabular-nums"
      style={{ top, left }}
    >
      <span>{text}</span>
      {sub && <span className="truncate text-white/60">{sub}</span>}
    </div>
  );
}

const LOUPE = 120;
const ZOOM = 8;

/** A magnified view of the pixels under the cursor, with the one it's on outlined — for putting a
 *  selection's edge on exactly the right pixel. */
function Loupe({ img, at, ratio, view }: { img: HTMLImageElement; at: Point; ratio: Point; view: { width: number; height: number } }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dpr = window.devicePixelRatio || 1;
  const fx = Math.floor(at.x * ratio.x);
  const fy = Math.floor(at.y * ratio.y);

  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    const span = LOUPE / ZOOM; // frame pixels across
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, LOUPE, LOUPE);
    ctx.drawImage(img, fx - span / 2 + 0.5, fy - span / 2 + 0.5, span, span, 0, 0, LOUPE, LOUPE);
    const c = LOUPE / 2 - ZOOM / 2;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1;
    ctx.strokeRect(c + 0.5, c + 0.5, ZOOM - 1, ZOOM - 1);
    ctx.strokeStyle = "rgba(255,122,89,0.55)";
    ctx.beginPath();
    ctx.moveTo(LOUPE / 2, 0);
    ctx.lineTo(LOUPE / 2, c);
    ctx.moveTo(LOUPE / 2, c + ZOOM);
    ctx.lineTo(LOUPE / 2, LOUPE);
    ctx.moveTo(0, LOUPE / 2);
    ctx.lineTo(c, LOUPE / 2);
    ctx.moveTo(c + ZOOM, LOUPE / 2);
    ctx.lineTo(LOUPE, LOUPE / 2);
    ctx.stroke();
  }, [img, fx, fy, dpr]);

  // Below-right of the cursor, flipped to whichever side has room.
  const left = at.x + 24 + LOUPE > view.width ? at.x - 24 - LOUPE : at.x + 24;
  const top = at.y + 24 + LOUPE + 22 > view.height ? at.y - 24 - LOUPE - 22 : at.y + 24;
  return (
    <div className="pointer-events-none absolute overflow-hidden rounded-lg shadow-lg ring-1 ring-white/40" style={{ left, top }}>
      <canvas ref={ref} width={LOUPE * dpr} height={LOUPE * dpr} style={{ width: LOUPE, height: LOUPE, display: "block" }} />
      <div className="bg-black/80 py-0.5 text-center text-[11px] text-white tabular-nums">
        {fx}, {fy}
      </div>
    </div>
  );
}

function Hint({ mode, hasWindows, hidden }: { mode: string; hasWindows: boolean; hidden: boolean }) {
  const text =
    mode === "window"
      ? hasWindows
        ? "Click a window"
        : "No window list here — click to take the whole screen"
      : mode === "freeform"
        ? "Trace the area to capture"
        : hasWindows
          ? "Drag to select · click a window or the desktop · Shift squares · Space moves"
          : "Drag to select · click for the whole screen";
  return (
    <div
      className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full bg-black/75 px-3 py-1 text-[12px] text-white/90 shadow transition-opacity"
      style={{ opacity: hidden ? 0 : 1 }}
    >
      {text} · <span className="text-white/60">Esc to cancel</span>
    </div>
  );
}
