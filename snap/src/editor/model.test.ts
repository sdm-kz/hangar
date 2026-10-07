import { describe, expect, it } from "vitest";
import {
  addShape,
  arrowPolygon,
  commit,
  contrastOn,
  dragRect,
  emptyHistory,
  isMeaningful,
  moveShape,
  nextStep,
  placeCrop,
  redo,
  removeShape,
  restyle,
  snapAngle,
  toolForKey,
  undo,
  type Shape,
} from "./model";

const rect = (id: string): Shape => ({ id, kind: "rect", x: 0, y: 0, w: 10, h: 10, color: "#f00", width: 4 });

describe("history", () => {
  it("undoes and redoes, and a new step drops the redo trail", () => {
    let h = emptyHistory();
    h = commit(h, addShape(h.present, rect("a")));
    h = commit(h, addShape(h.present, rect("b")));
    expect(h.present.shapes.map((s) => s.id)).toEqual(["a", "b"]);
    h = undo(h);
    expect(h.present.shapes.map((s) => s.id)).toEqual(["a"]);
    h = redo(h);
    expect(h.present.shapes.map((s) => s.id)).toEqual(["a", "b"]);
    h = undo(undo(h));
    expect(h.present.shapes).toEqual([]);
    expect(undo(h)).toBe(h);
    h = commit(h, addShape(h.present, rect("c")));
    expect(redo(h)).toBe(h);
  });
  it("removes by id", () => {
    const doc = addShape(addShape(emptyHistory().present, rect("a")), rect("b"));
    expect(removeShape(doc, "a").shapes.map((s) => s.id)).toEqual(["b"]);
  });
});

describe("shapes", () => {
  it("moves every kind", () => {
    const arrow: Shape = { id: "x", kind: "arrow", points: [0, 0, 10, 10], color: "", width: 1 };
    expect(moveShape(arrow, 5, -5)).toMatchObject({ points: [5, -5, 15, 5] });
    const pen: Shape = { id: "x", kind: "pen", points: [1, 2, 3, 4], color: "", width: 1 };
    expect(moveShape(pen, 10, 20)).toMatchObject({ points: [11, 22, 13, 24] });
    expect(moveShape(rect("r"), 3, 4)).toMatchObject({ x: 3, y: 4 });
  });
  it("restyles, sizing text from the weight, and leaves pixelation alone", () => {
    expect(restyle(rect("r"), { color: "#00f" })).toMatchObject({ color: "#00f", width: 4 });
    expect(restyle(rect("r"), { width: 8 })).toMatchObject({ color: "#f00", width: 8 });
    const text: Shape = { id: "t", kind: "text", x: 0, y: 0, text: "hi", fontSize: 37, color: "#000", width: 2 };
    expect(restyle(text, { color: "#fff" })).toMatchObject({ color: "#fff", fontSize: 37 });
    expect(restyle(text, { width: 4 })).toMatchObject({ color: "#000", fontSize: 20 });
    const blur: Shape = { id: "b", kind: "blur", x: 0, y: 0, w: 5, h: 5 };
    expect(restyle(blur, { color: "#fff", width: 4 })).toBe(blur);
  });
  it("numbers steps one past the highest", () => {
    let doc = emptyHistory().present;
    expect(nextStep(doc)).toBe(1);
    doc = addShape(doc, { id: "1", kind: "step", x: 0, y: 0, n: 1, color: "", width: 1 });
    doc = addShape(doc, { id: "5", kind: "step", x: 0, y: 0, n: 5, color: "", width: 1 });
    expect(nextStep(doc)).toBe(6);
  });
  it("throws away clicks that drew nothing", () => {
    expect(isMeaningful({ id: "a", kind: "arrow", points: [0, 0, 1, 1], color: "", width: 1 }, 4)).toBe(false);
    expect(isMeaningful({ id: "a", kind: "arrow", points: [0, 0, 10, 0], color: "", width: 1 }, 4)).toBe(true);
    expect(isMeaningful({ ...rect("r"), w: 2 } as Shape, 4)).toBe(false);
    expect(isMeaningful({ id: "t", kind: "text", x: 0, y: 0, text: "  ", fontSize: 10, color: "", width: 1 }, 4)).toBe(false);
  });
});

describe("geometry", () => {
  it("drags rectangles either way, and squares them", () => {
    expect(dragRect(10, 10, 0, 30)).toEqual({ x: 0, y: 10, w: 10, h: 20 });
    expect(dragRect(10, 10, 0, 30, true)).toEqual({ x: 0, y: 10, w: 10, h: 10 });
  });
  it("snaps lines to 45 degrees", () => {
    const [x, y] = snapAngle(0, 0, 100, 10);
    expect(x).toBeCloseTo(Math.hypot(100, 10));
    expect(y).toBeCloseTo(0);
    const [dx, dy] = snapAngle(0, 0, 50, 45);
    expect(dx).toBeCloseTo(dy);
  });
  it("draws an arrow ending exactly at its tip", () => {
    const poly = arrowPolygon(0, 0, 100, 0, 4);
    expect(poly).toHaveLength(14);
    expect([poly[6], poly[7]]).toEqual([100, 0]);
    // Symmetric about the shaft.
    expect(poly[5]).toBeCloseTo(-poly[9]);
    expect(arrowPolygon(5, 5, 5, 5, 4)).toEqual([]);
  });
  it("keeps a short arrow's head inside its length", () => {
    const poly = arrowPolygon(0, 0, 10, 0, 8);
    expect(poly[2]).toBeGreaterThanOrEqual(0);
  });
});

describe("placeCrop", () => {
  const bounds = { width: 1000, height: 500 };
  it("keeps a moved crop's size, stopping at the edges", () => {
    expect(placeCrop({ x: 800, y: 100, width: 400, height: 100 }, true, bounds)).toEqual({ x: 600, y: 100, width: 400, height: 100 });
    expect(placeCrop({ x: -50, y: -20, width: 400, height: 100 }, true, bounds)).toEqual({ x: 0, y: 0, width: 400, height: 100 });
  });
  it("cuts a resized crop at the edges", () => {
    expect(placeCrop({ x: 800, y: 400, width: 400, height: 300 }, false, bounds)).toEqual({ x: 800, y: 400, width: 200, height: 100 });
    expect(placeCrop({ x: -100, y: 0, width: 300, height: 50 }, false, bounds)).toEqual({ x: 0, y: 0, width: 200, height: 50 });
  });
  it("never rounds past the picture", () => {
    const r = placeCrop({ x: 10.5, y: 0, width: 989.5, height: 500 }, false, bounds)!;
    expect(r.x + r.width).toBeLessThanOrEqual(1000);
  });
  it("gives nothing for a crop entirely outside", () => {
    expect(placeCrop({ x: 1200, y: 0, width: 100, height: 100 }, false, bounds)).toBeNull();
  });
});

describe("misc", () => {
  it("picks a readable outline colour", () => {
    expect(contrastOn("#ffffff")).toBe("#000000");
    expect(contrastOn("#ffcc00")).toBe("#000000");
    expect(contrastOn("#1c1c1e")).toBe("#ffffff");
    expect(contrastOn("#ff3b30")).toBe("#ffffff");
  });
  it("maps tool keys by physical key, whatever the layout", () => {
    expect(toolForKey("KeyA")).toBe("arrow");
    expect(toolForKey("KeyZ")).toBeUndefined();
    expect(toolForKey("Digit1")).toBeUndefined();
  });
});
