// How the picture sits in the editor: fitted to the window, or zoomed and panned. Kept apart from the
// canvas so the arithmetic can be tested without one.

export interface Size {
  width: number;
  height: number;
}

/** `zoom` is CSS pixels per capture pixel, or null to fit the window. `cx`/`cy` is the capture point
 *  at the middle of the view — what stays put when the window is resized. */
export interface View {
  zoom: number | null;
  cx: number;
  cy: number;
}

/** Where the picture is drawn: at `scale`, through a viewport of `width`×`height` CSS pixels that
 *  starts `panX`/`panY` into the scaled picture, itself `left`/`top` into the area. */
export interface Placement {
  scale: number;
  width: number;
  height: number;
  left: number;
  top: number;
  panX: number;
  panY: number;
}

export const FIT: View = { zoom: null, cx: 0, cy: 0 };

/** The margin left round a fitted picture. */
const PAD = 32;
/** Zoom limits, in capture pixels per device pixel. */
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 16;
/** The stops the buttons and keys step through, in the same units. */
const STEPS = [0.05, 0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16];

/** Fit the picture to the area, never past its real size (one capture pixel per device pixel). */
export function fitScale(image: Size, area: Size, dpr: number): number {
  if (area.width === 0 || image.width === 0) return 1 / dpr;
  const fit = Math.min((area.width - PAD) / image.width, (area.height - PAD) / image.height);
  return Math.max(MIN_ZOOM / dpr, Math.min(fit, 1 / dpr));
}

export function scaleOf(view: View, image: Size, area: Size, dpr: number): number {
  return view.zoom ?? fitScale(image, area, dpr);
}

export function place(view: View, image: Size, area: Size, dpr: number): Placement {
  const scale = scaleOf(view, image, area, dpr);
  const axis = (size: number, room: number, centre: number) => {
    const full = size * scale;
    if (view.zoom === null || full <= room) return { len: full, offset: (room - full) / 2, pan: 0 };
    return { len: room, offset: 0, pan: clamp(centre * scale - room / 2, 0, full - room) };
  };
  const x = axis(image.width, area.width, view.cx);
  const y = axis(image.height, area.height, view.cy);
  return { scale, width: x.len, height: y.len, left: x.offset, top: y.offset, panX: x.pan, panY: y.pan };
}

/** The view after zooming to `scale`, keeping the capture point under `at` (area pixels) where it is. */
export function zoomTo(view: View, scale: number, at: { x: number; y: number }, image: Size, area: Size, dpr: number): View {
  const next = clamp(scale, MIN_ZOOM / dpr, MAX_ZOOM / dpr);
  const before = place(view, image, area, dpr);
  const px = (at.x - before.left + before.panX) / before.scale;
  const py = (at.y - before.top + before.panY) / before.scale;
  // Where that point has to be for the view's middle to land so it stays under `at`.
  const cx = px + (area.width / 2 - at.x) / next;
  const cy = py + (area.height / 2 - at.y) / next;
  return settle({ zoom: next, cx, cy }, image, area, dpr);
}

/** Zoom one stop in (`dir` 1) or out (-1), about the middle of the area. */
export function stepZoom(view: View, dir: 1 | -1, image: Size, area: Size, dpr: number): View {
  const now = scaleOf(view, image, area, dpr) * dpr;
  const stop = dir > 0 ? STEPS.find((s) => s > now * 1.001) : [...STEPS].reverse().find((s) => s < now / 1.001);
  const middle = { x: area.width / 2, y: area.height / 2 };
  return zoomTo(view, (stop ?? now) / dpr, middle, image, area, dpr);
}

/** The view moved by `dx`/`dy` CSS pixels, as dragging the picture the other way would. */
export function panBy(view: View, dx: number, dy: number, image: Size, area: Size, dpr: number): View {
  if (view.zoom === null) return view;
  return settle({ ...view, cx: view.cx + dx / view.zoom, cy: view.cy + dy / view.zoom }, image, area, dpr);
}

/** The zoom as a percentage of the capture's real size. */
export function percent(scale: number, dpr: number): number {
  return Math.round(scale * dpr * 100);
}

/** The middle brought back to where the view can actually show it, so a pan past the edge doesn't have
 *  to be undone before the picture moves again. */
function settle(view: View, image: Size, area: Size, dpr: number): View {
  const p = place(view, image, area, dpr);
  return { ...view, cx: (p.panX + p.width / 2) / p.scale, cy: (p.panY + p.height / 2) / p.scale };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
