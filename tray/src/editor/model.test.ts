import { describe, expect, it } from "vitest";
import {
  finishRegion,
  moveRegion,
  pixelBounds,
  reach,
  regionBounds,
  regionContains,
  type Region,
  addShape,
  arrowPolygon,
  commit,
  contrastOn,
  dragRect,
  emptyHistory,
  extendFor,
  isCropped,
  uncrop,
  isMeaningful,
  moveShape,
  nextStep,
  placeCrop,
  applyCrop,
  exportArea,
  frameOf,
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
  const bounds = { x: 0, y: 0, width: 1000, height: 500 };
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
  it("keeps inside a crop already applied", () => {
    const applied = { x: 100, y: 50, width: 300, height: 200 };
    expect(placeCrop({ x: 0, y: 0, width: 100, height: 100 }, true, applied)).toEqual({ x: 100, y: 50, width: 100, height: 100 });
    expect(placeCrop({ x: 350, y: 200, width: 100, height: 100 }, false, applied)).toEqual({ x: 350, y: 200, width: 50, height: 50 });
  });
});

describe("applyCrop", () => {
  const crop = { x: 10, y: 20, width: 30, height: 40 };
  it("makes the crop the picture's edges, and exports just that", () => {
    const doc = applyCrop({ shapes: [], crop, frame: null });
    expect(doc).toEqual({ shapes: [], crop: null, frame: crop });
    expect(frameOf(doc, 800, 600)).toEqual(crop);
    expect(exportArea(doc, 800, 600)).toEqual(crop);
  });
  it("is undone like any edit", () => {
    const set = commit(emptyHistory(), { shapes: [], crop, frame: null });
    const applied = commit(set, applyCrop(set.present));
    expect(undo(applied).present).toEqual({ shapes: [], crop, frame: null });
  });
  it("leaves a doc with no crop being set alone", () => {
    const doc = { shapes: [], crop: null, frame: crop };
    expect(applyCrop(doc)).toBe(doc);
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

describe("growing the picture to fit a shape", () => {
  const W = 100;
  const H = 50;
  const width = () => 0;
  const empty = { shapes: [], crop: null, frame: null };
  const rect = (x: number, y: number, w: number, h: number) => ({ id: "r", kind: "rect" as const, color: "#f00", width: 2, x, y, w, h });

  it("leaves a shape inside the picture alone", () => {
    expect(extendFor(empty, rect(10, 10, 20, 20), W, H, 5, width)).toBe(empty);
  });
  it("moves only the sides the shape crosses, with the margin past it", () => {
    // Reaches 1 past its edges for half its stroke: x 89..121, y -11..21.
    const doc = extendFor(empty, rect(90, -10, 30, 30), W, H, 5, width);
    expect(doc.frame).toEqual({ x: 0, y: -16, width: 126, height: 66 });
  });
  it("grows a cropped picture from its crop", () => {
    const cropped = { ...empty, frame: { x: 20, y: 10, width: 40, height: 30 } };
    expect(extendFor(cropped, rect(50, 15, 20, 5), W, H, 0, width).frame).toEqual({ x: 20, y: 10, width: 51, height: 30 });
  });
  it("measures text with the measure it is given", () => {
    const text = { id: "t", kind: "text" as const, color: "#f00", width: 2, x: 90, y: 5, text: "ab\nabcd", fontSize: 10 };
    const doc = extendFor(empty, text, W, H, 0, (line) => line.length * 5);
    expect(doc.frame).toEqual({ x: 0, y: 0, width: 111, height: 50 });
  });
  it("is no crop, and showing the whole picture keeps it", () => {
    const grown = extendFor(empty, rect(90, 10, 30, 10), W, H, 0, width);
    expect(isCropped(grown, W, H)).toBe(false);
    const both = { ...grown, frame: { ...grown.frame!, x: 30, width: grown.frame!.width - 30 } };
    expect(isCropped(both, W, H)).toBe(true);
    expect(uncrop({ ...both, shapes: [rect(90, 10, 30, 10)] }, W, H, 0, width).frame).toEqual(grown.frame);
    // Cropped down to inside the picture, then back: the margin its shape was in comes back too.
    const cut = { shapes: [rect(90, 10, 30, 10)], crop: null, frame: { x: 10, y: 10, width: 20, height: 20 } };
    expect(uncrop(cut, W, H, 0, width).frame).toEqual(grown.frame);
    expect(uncrop({ ...empty, frame: { x: 10, y: 10, width: 20, height: 20 } }, W, H, 0, width).frame).toBeNull();
  });
});

describe("regions of the picture", () => {
  const square: Region = { kind: "rect", x: 10, y: 10, w: 20, h: 20 };
  // A triangle with its point at the top.
  const triangle: Region = { kind: "poly", points: [50, 0, 100, 100, 0, 100] };

  it("tells inside from outside, for a rectangle and a traced outline", () => {
    expect(regionContains(square, 15, 15)).toBe(true);
    expect(regionContains(square, 31, 15)).toBe(false);
    expect(regionContains(triangle, 50, 60)).toBe(true);
    expect(regionContains(triangle, 10, 20)).toBe(false); // inside the bounds, outside the outline
  });

  it("bounds an outline, and rounds those outwards to whole pixels", () => {
    expect(regionBounds(triangle)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(pixelBounds({ kind: "poly", points: [1.5, 2.2, 10.1, 2.2, 10.1, 9.7] })).toEqual({ x: 1, y: 2, width: 10, height: 8 });
  });

  it("moves either kind", () => {
    expect(moveRegion(square, 5, -5)).toEqual({ kind: "rect", x: 15, y: 5, w: 20, h: 20 });
    expect(moveRegion(triangle, 1, 2)).toEqual({ kind: "poly", points: [51, 2, 101, 102, 1, 102] });
  });

  it("makes a dragged rectangle whole pixels, and drops a click", () => {
    expect(finishRegion({ kind: "rect", x: 10.4, y: 10.6, w: 20.2, h: 5 }, 3)).toEqual({ kind: "rect", x: 10, y: 11, w: 21, h: 5 });
    expect(finishRegion({ kind: "rect", x: 10, y: 10, w: 2, h: 40 }, 3)).toBeNull();
    expect(finishRegion({ kind: "poly", points: [0, 0, 20, 0] }, 3)).toBeNull();
    expect(finishRegion(triangle, 3)).toBe(triangle);
  });

  it("takes fills, patches and eraser strokes into the shape operations", () => {
    const fill = { id: "f", kind: "fill" as const, region: square, color: "#fff" };
    expect(moveShape(fill, 1, 1)).toMatchObject({ region: { x: 11, y: 11 } });
    expect(restyle(fill, { color: "#000" })).toBe(fill);
    expect(reach(fill, () => 0)).toEqual({ x: 10, y: 10, width: 20, height: 20 });
    const pixels = {} as HTMLCanvasElement;
    expect(reach({ id: "p", kind: "patch", x: -5, y: 0, w: 10, h: 10, pixels }, () => 0)).toEqual({ x: -5, y: 0, width: 10, height: 10 });
    const eraser = { id: "e", kind: "eraser" as const, points: [5, 5], width: 20 };
    expect(isMeaningful(eraser, 3)).toBe(true);
    expect(reach(eraser, () => 0)).toBeNull();
  });
});
