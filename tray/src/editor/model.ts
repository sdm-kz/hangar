import type { Rect } from "@/lib/tauri";

/** Everything here is in the capture's own pixels — the drawing scales with the picture, and exports at
 *  its full resolution whatever size the window shows it at. */

export type Tool =
  | "select"
  | "arrow"
  | "rect"
  | "ellipse"
  | "line"
  | "pen"
  | "marker"
  | "text"
  | "step"
  | "blur"
  | "crop";

export const TOOLS: { tool: Tool; key: string; label: string }[] = [
  { tool: "select", key: "v", label: "Select" },
  { tool: "arrow", key: "a", label: "Arrow" },
  { tool: "rect", key: "r", label: "Rectangle" },
  { tool: "ellipse", key: "e", label: "Ellipse" },
  { tool: "line", key: "l", label: "Line" },
  { tool: "pen", key: "p", label: "Pen" },
  { tool: "marker", key: "h", label: "Highlighter" },
  { tool: "text", key: "t", label: "Text" },
  { tool: "step", key: "n", label: "Numbered step" },
  { tool: "blur", key: "b", label: "Pixelate" },
  { tool: "crop", key: "c", label: "Crop" },
];

/** The tool for a key press, by its physical key (`KeyboardEvent.code`), so the letters work on any
 *  keyboard layout — on a Russian one `e.key` for the A key is "ф". */
export function toolForKey(code: string): Tool | undefined {
  const letter = code.match(/^Key([A-Z])$/)?.[1]?.toLowerCase();
  return letter ? TOOLS.find((t) => t.key === letter)?.tool : undefined;
}

/** Red first: it's what an annotation is for. White and black last, for marks on busy backgrounds. */
export const COLORS = ["#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#0a84ff", "#af52de", "#ffffff", "#1c1c1e"];

/** Stroke weights in logical pixels; multiplied by the capture's scale to land in its pixels. */
export const WEIGHTS = { s: 2, m: 4, l: 7 } as const;
export type Weight = keyof typeof WEIGHTS;

type Styled = { id: string; color: string; width: number };
export type Shape =
  | (Styled & { kind: "arrow" | "line"; points: [number, number, number, number] })
  | (Styled & { kind: "rect" | "ellipse"; x: number; y: number; w: number; h: number })
  | (Styled & { kind: "pen" | "marker"; points: number[] })
  | (Styled & { kind: "text"; x: number; y: number; text: string; fontSize: number })
  | (Styled & { kind: "step"; x: number; y: number; n: number })
  | { id: string; kind: "blur"; x: number; y: number; w: number; h: number };

/** `crop` is a crop being set, shaded round on the picture; `frame` is one applied, and the picture
 *  shows only that much. Applying is an edit like any other, so undo puts the rest back. */
export type Doc = { shapes: Shape[]; crop: Rect | null; frame: Rect | null };
export type History = { past: Doc[]; present: Doc; future: Doc[] };

export const emptyHistory = (): History => ({ past: [], present: { shapes: [], crop: null, frame: null }, future: [] });

/** Make `doc` the present, as one undoable step. */
export function commit(h: History, doc: Doc): History {
  if (doc === h.present) return h;
  return { past: [...h.past, h.present].slice(-200), present: doc, future: [] };
}

export function undo(h: History): History {
  const prev = h.past[h.past.length - 1];
  return prev ? { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] } : h;
}

export function redo(h: History): History {
  const next = h.future[0];
  return next ? { past: [...h.past, h.present], present: next, future: h.future.slice(1) } : h;
}

export function addShape(doc: Doc, shape: Shape): Doc {
  return { ...doc, shapes: [...doc.shapes, shape] };
}

export function replaceShape(doc: Doc, shape: Shape): Doc {
  return { ...doc, shapes: doc.shapes.map((s) => (s.id === shape.id ? shape : s)) };
}

export function removeShape(doc: Doc, id: string): Doc {
  return { ...doc, shapes: doc.shapes.filter((s) => s.id !== id) };
}

export function moveShape(shape: Shape, dx: number, dy: number): Shape {
  switch (shape.kind) {
    case "arrow":
    case "line": {
      const [x1, y1, x2, y2] = shape.points;
      return { ...shape, points: [x1 + dx, y1 + dy, x2 + dx, y2 + dy] };
    }
    case "pen":
    case "marker":
      return { ...shape, points: shape.points.map((v, i) => v + (i % 2 === 0 ? dx : dy)) };
    default:
      return { ...shape, x: shape.x + dx, y: shape.y + dy };
  }
}

/** Restyle a shape with what was just picked in the toolbar — the colour or the weight, leaving the
 *  other as the shape has it (a text resized by hand keeps its size when only its colour changes). */
export function restyle(shape: Shape, change: { color?: string; width?: number }): Shape {
  if (shape.kind === "blur") return shape;
  const color = change.color ?? shape.color;
  if (shape.kind === "text") {
    return { ...shape, color, fontSize: change.width !== undefined ? fontSizeFor(change.width) : shape.fontSize };
  }
  return { ...shape, color, width: change.width ?? shape.width };
}

/** The next numbered step: one past the highest on the picture. */
export function nextStep(doc: Doc): number {
  return doc.shapes.reduce((n, s) => (s.kind === "step" ? Math.max(n, s.n) : n), 0) + 1;
}

/** Text size follows the weight, so S/M/L mean the same thing for words as for lines. */
export function fontSizeFor(width: number): number {
  return Math.round(Math.max(12, width * 5));
}

export function stepRadius(width: number): number {
  return Math.max(10, width * 3.2);
}

/** A rectangle from a drag between two corners, either way round; `square` holds it to the shorter side. */
export function dragRect(x1: number, y1: number, x2: number, y2: number, square = false) {
  let dx = x2 - x1;
  let dy = y2 - y1;
  if (square) {
    const side = Math.min(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * side;
    dy = Math.sign(dy || 1) * side;
  }
  return { x: Math.min(x1, x1 + dx), y: Math.min(y1, y1 + dy), w: Math.abs(dx), h: Math.abs(dy) };
}

/** Snap a line's end to the nearest 45°, as Shift does in every drawing app. */
export function snapAngle(x1: number, y1: number, x2: number, y2: number): [number, number] {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(y2 - y1, x2 - x1) / step) * step;
  return [x1 + Math.cos(angle) * len, y1 + Math.sin(angle) * len];
}

/**
 * The outline of a tapered arrow from (x1, y1) to (x2, y2): a shaft that thickens towards a solid
 * head, as one polygon (flat list of x, y). Drawn filled rather than stroked, it reads at any weight
 * and the head never comes out blunt the way a stroked line's join does.
 */
export function arrowPolygon(x1: number, y1: number, x2: number, y2: number, width: number): number[] {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len === 0) return [];
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const px = -uy;
  const py = ux;
  // Bolder than a line of the same weight: an arrow is the mark meant to be seen first.
  const headLen = Math.min(len * 0.6, Math.max(width * 4.5, 14));
  const headHalf = Math.max(width * 2.4, headLen * 0.6);
  const shaftHalf = width * 0.75;
  const tailHalf = Math.max(0.5, width * 0.3);
  const bx = x2 - ux * headLen;
  const by = y2 - uy * headLen;
  return [
    x1 + px * tailHalf, y1 + py * tailHalf,
    bx + px * shaftHalf, by + py * shaftHalf,
    bx + px * headHalf, by + py * headHalf,
    x2, y2,
    bx - px * headHalf, by - py * headHalf,
    bx - px * shaftHalf, by - py * shaftHalf,
    x1 - px * tailHalf, y1 - py * tailHalf,
  ];
}

/** Black or white, whichever stands out against `hex` — for outlining text and numbering steps. */
export function contrastOn(hex: string): string {
  const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return "#ffffff";
  const [r, g, b] = m.slice(1).map((c) => {
    const v = parseInt(c, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.45 ? "#000000" : "#ffffff";
}

/** Whether a finished drag drew anything worth keeping — a click shouldn't leave a dot of an arrow. */
export function isMeaningful(shape: Shape, minSize: number): boolean {
  switch (shape.kind) {
    case "arrow":
    case "line": {
      const [x1, y1, x2, y2] = shape.points;
      return Math.hypot(x2 - x1, y2 - y1) >= minSize;
    }
    case "rect":
    case "ellipse":
    case "blur":
      return shape.w >= minSize && shape.h >= minSize;
    case "pen":
    case "marker":
      return shape.points.length >= 4;
    case "text":
      return shape.text.trim().length > 0;
    case "step":
      return true;
  }
}

/**
 * Where a crop the person just moved (`moved`) or resized ends up, in whole pixels inside `bounds` (the
 * picture, or the crop already applied to it). Moved, it keeps its size and stops at the edges; resized,
 * whatever went past an edge is cut off. Edges are rounded rather than position and size, so the two
 * can't round apart into a column of nothing past the picture. Null when nothing of it is left.
 */
export function placeCrop(r: Rect, moved: boolean, bounds: Rect): Rect | null {
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;
  const w = Math.min(r.width, bounds.width);
  const h = Math.min(r.height, bounds.height);
  const x0 = moved ? Math.min(Math.max(r.x, bounds.x), right - w) : Math.max(bounds.x, r.x);
  const y0 = moved ? Math.min(Math.max(r.y, bounds.y), bottom - h) : Math.max(bounds.y, r.y);
  const x1 = Math.min(right, (moved ? x0 : r.x) + w);
  const y1 = Math.min(bottom, (moved ? y0 : r.y) + h);
  const left = Math.round(x0);
  const top = Math.round(y0);
  const out = { x: left, y: top, width: Math.round(x1) - left, height: Math.round(y1) - top };
  return out.width > 0 && out.height > 0 ? out : null;
}

/** The part of the picture on show: the crop applied to it, or all of it. */
export function frameOf(doc: Doc, width: number, height: number): Rect {
  return doc.frame ?? { x: 0, y: 0, width, height };
}

/** The area that will be exported: the crop being set, or what is on show. */
export function exportArea(doc: Doc, width: number, height: number): Rect {
  return doc.crop ?? frameOf(doc, width, height);
}

/** The crop being set made the picture's edges. */
export function applyCrop(doc: Doc): Doc {
  return doc.crop ? { ...doc, frame: doc.crop, crop: null } : doc;
}

let counter = 0;
export const newId = () => `s${Date.now().toString(36)}${(counter++).toString(36)}`;
