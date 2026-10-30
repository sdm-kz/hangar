import type { ElementBox, Rect, WindowBox } from "@/lib/tauri";

export type Point = { x: number; y: number };

/** The rectangle between two corners, either way round. `square` holds it to the shorter side, from `a`. */
export function rectBetween(a: Point, b: Point, square = false): Rect {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  if (square) {
    const side = Math.min(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * side;
    dy = Math.sign(dy || 1) * side;
  }
  return {
    x: Math.min(a.x, a.x + dx),
    y: Math.min(a.y, a.y + dy),
    width: Math.abs(dx),
    height: Math.abs(dy),
  };
}

/** A CSS-pixel rectangle in frame pixels: outer edges rounded outwards, so the selection never loses the
 *  pixel its border was drawn across. */
export function toFrameRect(r: Rect, ratioX: number, ratioY: number, frameW: number, frameH: number): Rect {
  const x0 = Math.max(0, Math.floor(r.x * ratioX));
  const y0 = Math.max(0, Math.floor(r.y * ratioY));
  const x1 = Math.min(frameW, Math.ceil((r.x + r.width) * ratioX));
  const y1 = Math.min(frameH, Math.ceil((r.y + r.height) * ratioY));
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

export function contains(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height;
}

/** The topmost window under a point (both in frame pixels); the list comes topmost first. */
export function windowAt(windows: WindowBox[], p: Point): WindowBox | undefined {
  return windows.find((w) => contains(w.rect, p));
}

/** What is under the pointer, innermost first and ending with the window, and which of them is picked. */
export type Pick = { boxes: ElementBox[]; level: number };

export function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** A new chain under the pointer. Whatever was picked stays picked while it is still in the chain — a
 *  card widened to stays the card as the pointer crosses the buttons in it — and otherwise the pick
 *  starts over at the innermost. */
export function nextPick(prev: Pick | null, boxes: ElementBox[]): Pick | null {
  if (boxes.length === 0) return null;
  const kept = prev?.boxes[prev.level];
  const i = kept ? boxes.findIndex((b) => sameRect(b.rect, kept.rect)) : -1;
  return { boxes, level: Math.max(0, i) };
}

/** One step outwards (`by` 1) or inwards (-1), held to the chain's ends. */
export function widen(pick: Pick, by: number): Pick {
  return { ...pick, level: Math.min(pick.boxes.length - 1, Math.max(0, pick.level + by)) };
}

/**
 * Wheel events as steps of the pick: one per notch of a mouse wheel, and one per swipe of a touchpad,
 * however many events the swipe sends and however long its momentum runs on after the fingers lift.
 *
 * A touchpad sends a stream of small deltas a few milliseconds apart; summed past `threshold` they make
 * a step, and after it the stream counts for nothing until it pauses for `quiet` ms — the momentum is
 * part of the same stream. A wheel notch is one big delta on its own (100 CSS pixels in Chromium and
 * WebKit), and one at least `notchGap` ms after the event before it steps again even mid-stream, so a
 * wheel turned notch by notch still steps every notch.
 */
export class WheelSteps {
  private sum = 0;
  private last = -Infinity;
  private spent = false;

  constructor(
    private readonly threshold = 40,
    private readonly quiet = 180,
    private readonly notchGap = 30,
  ) {}

  /** The step `deltaY` (CSS pixels) at time `now` (ms) makes: 1 outwards (the wheel turned away from
   *  you: up), -1 inwards, 0 none. */
  push(deltaY: number, now: number): number {
    const gap = now - this.last;
    this.last = now;
    if (gap > this.quiet) {
      this.sum = 0;
      this.spent = false;
    }
    if (deltaY === 0) return 0;
    const notch = Math.abs(deltaY) >= this.threshold && gap >= this.notchGap;
    if (this.spent && !notch) return 0;
    if (Math.sign(deltaY) !== Math.sign(this.sum)) this.sum = 0;
    this.sum += deltaY;
    if (Math.abs(this.sum) < this.threshold) return 0;
    const step = this.sum < 0 ? 1 : -1;
    this.sum = 0;
    this.spent = true;
    return step;
  }
}

/** A wheel event's vertical delta in CSS pixels, whatever unit it came in. */
export function wheelPixels(deltaY: number, deltaMode: number, pageHeight: number): number {
  if (deltaMode === 1) return deltaY * 16; // lines
  if (deltaMode === 2) return deltaY * pageHeight; // pages
  return deltaY;
}

/** Append `p` to a traced path unless it is within `minDistance` of the last point — a lasso at mouse
 *  rate is thousands of points, nearly all of them redundant. */
export function extendPath(path: Point[], p: Point, minDistance = 2): Point[] {
  const last = path[path.length - 1];
  if (last && Math.hypot(p.x - last.x, p.y - last.y) < minDistance) return path;
  return [...path, p];
}

/** Area of the closed polygon (shoelace), whichever way it winds. */
export function polygonArea(points: Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** How far a press may wander before it counts as a drag rather than a click. */
export const CLICK_SLOP = 4;
