import { describe, expect, it } from "vitest";
import { extendPath, nextPick, polygonArea, rectBetween, toFrameRect, widen, windowAt } from "./selection";

describe("rectBetween", () => {
  it("normalises a drag in any direction", () => {
    expect(rectBetween({ x: 50, y: 40 }, { x: 10, y: 100 })).toEqual({ x: 10, y: 40, width: 40, height: 60 });
  });
  it("squares to the shorter side, keeping the drag's direction", () => {
    expect(rectBetween({ x: 100, y: 100 }, { x: 40, y: 180 }, true)).toEqual({ x: 40, y: 100, width: 60, height: 60 });
  });
});

describe("toFrameRect", () => {
  it("scales and rounds outwards", () => {
    expect(toFrameRect({ x: 10.2, y: 5.5, width: 20, height: 10 }, 1.5, 1.5, 1000, 1000)).toEqual({
      x: 15,
      y: 8,
      width: 31,
      height: 16,
    });
  });
  it("clips to the frame", () => {
    expect(toFrameRect({ x: -5, y: 90, width: 20, height: 20 }, 2, 2, 100, 200)).toEqual({
      x: 0,
      y: 180,
      width: 30,
      height: 20,
    });
  });
});

describe("windowAt", () => {
  const box = (x: number, y: number, w: number, h: number, title: string) => ({
    title,
    app: "",
    rect: { x, y, width: w, height: h },
  });
  it("finds the topmost window under the point", () => {
    const windows = [box(100, 100, 50, 50, "dialog"), box(0, 0, 500, 500, "main")];
    expect(windowAt(windows, { x: 120, y: 120 })?.title).toBe("dialog");
    expect(windowAt(windows, { x: 10, y: 10 })?.title).toBe("main");
    expect(windowAt(windows, { x: 600, y: 10 })).toBeUndefined();
  });
});

describe("paths", () => {
  it("drops points too close to the last one", () => {
    let path = extendPath([], { x: 0, y: 0 });
    path = extendPath(path, { x: 1, y: 1 });
    path = extendPath(path, { x: 5, y: 0 });
    expect(path).toEqual([
      { x: 0, y: 0 },
      { x: 5, y: 0 },
    ]);
  });
  it("measures area either way round", () => {
    const square = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(polygonArea(square)).toBe(100);
    expect(polygonArea([...square].reverse())).toBe(100);
  });
});

describe("element picking", () => {
  const box = (x: number, w: number, label: string) => ({ rect: { x, y: x, width: w, height: w }, label });
  const button = box(100, 40, "Save");
  const card = box(50, 300, "card");
  const win = box(0, 1000, "Docs");
  const other = box(400, 30, "Cancel");

  it("starts at the innermost and widens within the chain", () => {
    const p = nextPick(null, [button, card, win])!;
    expect(p.level).toBe(0);
    expect(widen(p, 1).level).toBe(1);
    expect(widen(widen(widen(p, 1), 1), 1).level).toBe(2);
    expect(widen(p, -1).level).toBe(0);
  });

  it("keeps a widened pick while it is still under the pointer", () => {
    const onCard = widen(nextPick(null, [button, card, win])!, 1);
    expect(nextPick(onCard, [other, card, win])!.level).toBe(1);
    expect(nextPick(onCard, [box(2000, 10, "x"), box(1900, 500, "elsewhere")])!.level).toBe(0);
  });

  it("has nothing to pick off every window", () => {
    expect(nextPick(null, [])).toBeNull();
  });
});
