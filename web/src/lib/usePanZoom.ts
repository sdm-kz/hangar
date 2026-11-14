import { useEffect, useRef, useState, type RefObject } from "react";

const MIN = 0.2;
const MAX = 8;

type Point = { x: number; y: number };

/**
 * Zoom and pan for a picture in a box: the full-page image viewer and an image's own tab. The picture
 * sits in the middle of `areaRef`, moved by the view's offset and scaled by its scale (see
 * {@link panZoomTransform}); `imgRef` is the picture, whose natural size decides the fit.
 *
 * It opens with the whole picture in view: one bigger than the box is scaled down to fit it, a smaller
 * one is shown at its own size. `reset` goes back to that, and so does any change in the box's size
 * while the view is still the fitted one. The wheel and a trackpad pinch zoom about the pointer,
 * keeping the spot under it in place; `zoom` with no point zooms about the middle of the box. A drag
 * pans, and on a touch screen two fingers pinch.
 */
export function usePanZoom(areaRef: RefObject<HTMLElement | null>, imgRef: RefObject<HTMLImageElement | null>) {
  // The zoom and the picture's offset from the middle of the box, together: zooming about a point
  // moves both, and two wheel events in one frame must each start from where the last one left them.
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  // The scale that fits the picture in the box, 1 at most. Zooming out may go below it, for a picture
  // so big that it fits only under the usual floor.
  const [fit, setFit] = useState(1);
  // Hidden until it has loaded and been fitted, so a big one doesn't flash up at full size first.
  const [ready, setReady] = useState(false);
  const clamp = (s: number) => Math.min(MAX, Math.max(Math.min(MIN, fit), s));
  // Still showing the fitted view, untouched: a resize of the box fits it again.
  const fitted = useRef(true);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  const fitScale = () => {
    const img = imgRef.current;
    const area = areaRef.current;
    if (!img?.naturalWidth || !area?.clientWidth) return 1;
    return Math.min(1, area.clientWidth / img.naturalWidth, area.clientHeight / img.naturalHeight);
  };
  /** Measure the fit again (on the picture's load, or the box's resize), and take it if still fitted. */
  const refit = () => {
    const f = fitScale();
    setFit(f);
    if (fitted.current) setView((v) => ({ ...v, scale: f }));
    setReady(true);
  };
  const reset = () => {
    fitted.current = true;
    setView({ scale: fitScale(), x: 0, y: 0 });
  };
  /** Another picture is on its way into the box: fitted afresh once it has loaded. */
  const restart = () => {
    fitted.current = true;
    setReady(false);
    setView((v) => ({ ...v, x: 0, y: 0 }));
  };
  // `to` gives the new scale from the one before. `at` is the point to hold still, from the middle of
  // the box: the spot of the picture under it is under it again after. The middle itself by default.
  const zoomTo = (to: (scale: number) => number, at: Point = { x: 0, y: 0 }) => {
    fitted.current = false;
    setView((v) => {
      const s = clamp(to(v.scale));
      const r = s / v.scale;
      return { scale: s, x: at.x - (at.x - v.x) * r, y: at.y - (at.y - v.y) * r };
    });
  };
  const zoom = (by: number, at?: Point) => zoomTo((s) => s * by, at);

  // The box's size, not just the window's: an image's tab narrows when a pane opens beside it. Set
  // up once, through a ref to this render's refit: an observer reports as soon as it starts watching,
  // so one made afresh on every render would refit, and so render, forever. Nothing to fit before the
  // picture has loaded; its load fits it.
  const refitRef = useRef(refit);
  refitRef.current = refit;
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const ro = new ResizeObserver(() => {
      if (imgRef.current?.naturalWidth) refitRef.current();
    });
    ro.observe(area);
    return () => ro.disconnect();
  }, [areaRef, imgRef]);

  // The wheel and pinch, on the element itself rather than through React: React's wheel listener is
  // passive, so it can't stop a Ctrl+wheel (which a trackpad pinch is) from zooming the page as well.
  const scaleRef = useRef(view.scale);
  scaleRef.current = view.scale;
  // The scale a Safari pinch began at. Kept outside the effect, which runs again on every render — so
  // after every step of the pinch.
  const pinchFrom = useRef(1);
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const from = (e: { clientX: number; clientY: number }) => {
      const r = area.getBoundingClientRect();
      return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      // A mouse wheel's notch (about 100px) is one step; a trackpad sends a pinch or a swipe as many
      // small deltas, zoomed in proportion so it follows the fingers.
      zoom(Math.abs(d) >= 50 ? (d < 0 ? 1.1 : 1 / 1.1) : Math.exp(-d * 0.01), from(e));
    };
    // Safari sends a trackpad pinch as gesture events instead, with the scale since the pinch began.
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      pinchFrom.current = scaleRef.current;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      zoomTo(() => pinchFrom.current * g.scale, from(g));
    };
    area.addEventListener("wheel", onWheel, { passive: false });
    area.addEventListener("gesturestart", onGestureStart);
    area.addEventListener("gesturechange", onGestureChange);
    return () => {
      area.removeEventListener("wheel", onWheel);
      area.removeEventListener("gesturestart", onGestureStart);
      area.removeEventListener("gesturechange", onGestureChange);
    };
  });

  // The fingers on a touch screen, by pointer: two of them pinch, zooming about the point between them
  // and moving the picture with it, as a phone's own photo viewer does.
  const touches = useRef(new Map<number, Point>());
  const pinch = useRef<{ dist: number; scale: number; mid: Point } | null>(null);
  const twoFingers = () => {
    const [a, b] = [...touches.current.values()];
    const area = areaRef.current!.getBoundingClientRect();
    return {
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      mid: { x: (a.x + b.x) / 2 - area.left - area.width / 2, y: (a.y + b.y) / 2 - area.top - area.height / 2 },
    };
  };
  const lift = (e: React.PointerEvent) => {
    touches.current.delete(e.pointerId);
    if (touches.current.size < 2) pinch.current = null;
    drag.current = null;
  };

  /** Spread onto the box: a drag on it pans the picture, and two fingers pinch it. */
  const panHandlers = {
    onPointerDown(e: React.PointerEvent) {
      try {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
      } catch {
        /* a pointer that is already gone: nothing to hold on to */
      }
      if (e.pointerType === "touch") touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.current.size === 2) {
        drag.current = null;
        pinch.current = { ...twoFingers(), scale: view.scale };
        return;
      }
      drag.current = { x: e.clientX, y: e.clientY, px: view.x, py: view.y };
    },
    onPointerMove(e: React.PointerEvent) {
      if (touches.current.has(e.pointerId)) touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const p = pinch.current;
      if (p && touches.current.size === 2) {
        fitted.current = false;
        const { dist, mid } = twoFingers();
        const from = p.mid;
        p.mid = mid;
        // The spot of the picture that was between the fingers is between them again.
        setView((v) => {
          const s = clamp((p.scale * dist) / p.dist);
          const r = s / v.scale;
          return { scale: s, x: mid.x - (from.x - v.x) * r, y: mid.y - (from.y - v.y) * r };
        });
        return;
      }
      const d = drag.current;
      if (!d) return;
      fitted.current = false; // moved off the fitted view: a resize leaves it where it was put
      setView((v) => ({ ...v, x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) }));
    },
    onPointerUp: lift,
    onPointerCancel: lift,
    onPointerLeave: lift,
  };

  return { view, fit, ready, setReady, refit, reset, restart, zoom, panHandlers };
}

/** The picture's transform for a view: centred in its box, then moved and scaled. */
export function panZoomTransform(view: { scale: number; x: number; y: number }): string {
  return `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
}
