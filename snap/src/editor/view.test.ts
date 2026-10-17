import { describe, expect, it } from "vitest";
import { FIT, fitScale, panBy, percent, place, stepZoom, zoomTo, type View } from "./view";

const image = { width: 2000, height: 1000 };
const area = { width: 1032, height: 832 };

describe("fitting", () => {
  it("fits the picture inside the margin, centred", () => {
    const p = place(FIT, image, area, 1);
    expect(p.scale).toBe(0.5);
    expect(p).toMatchObject({ width: 1000, height: 500, left: 16, top: 166, panX: 0, panY: 0 });
  });

  it("never blows a small capture up past its real size", () => {
    expect(fitScale({ width: 100, height: 100 }, area, 2)).toBe(0.5);
  });
});

describe("zooming", () => {
  it("keeps the point under the pointer where it is", () => {
    const at = { x: 300, y: 400 };
    const before = place(FIT, image, area, 1);
    const under = { x: (at.x - before.left + before.panX) / before.scale, y: (at.y - before.top + before.panY) / before.scale };
    const view = zoomTo(FIT, 2, at, image, area, 1);
    const after = place(view, image, area, 1);
    expect(after.scale).toBe(2);
    expect((at.x - after.left + after.panX) / after.scale).toBeCloseTo(under.x);
    expect((at.y - after.top + after.panY) / after.scale).toBeCloseTo(under.y);
  });

  it("fills the area once the picture is bigger than it", () => {
    const p = place(zoomTo(FIT, 1, { x: 500, y: 400 }, image, area, 1), image, area, 1);
    expect(p).toMatchObject({ width: 1032, height: 832, left: 0, top: 0 });
  });

  it("can't pan past the picture's edge", () => {
    const view = zoomTo(FIT, 1, { x: 0, y: 0 }, image, area, 1);
    const p = place(view, image, area, 1);
    expect(p.panX).toBe(0);
    expect(p.panY).toBe(0);
  });

  it("steps through the stops and stops at the ends", () => {
    let v: View = FIT;
    v = stepZoom(v, 1, image, area, 1);
    expect(place(v, image, area, 1).scale).toBe(0.67);
    v = stepZoom(v, -1, image, area, 1);
    expect(place(v, image, area, 1).scale).toBe(0.5);
    for (let i = 0; i < 30; i++) v = stepZoom(v, 1, image, area, 1);
    expect(percent(place(v, image, area, 1).scale, 1)).toBe(1600);
  });

  it("counts the percentage in device pixels", () => {
    expect(percent(0.5, 2)).toBe(100);
  });
});

describe("panning", () => {
  it("moves the view and holds it at the edge", () => {
    let v = zoomTo(FIT, 1, { x: 516, y: 416 }, image, area, 1);
    const start = place(v, image, area, 1).panX;
    v = panBy(v, 100, 0, image, area, 1);
    expect(place(v, image, area, 1).panX).toBe(start + 100);
    v = panBy(v, 10_000, 0, image, area, 1);
    expect(place(v, image, area, 1).panX).toBe(2000 - 1032);
    // Straight back from the edge, not after first undoing the overshoot.
    v = panBy(v, -50, 0, image, area, 1);
    expect(place(v, image, area, 1).panX).toBe(2000 - 1032 - 50);
  });

  it("does nothing while the picture is fitted", () => {
    expect(panBy(FIT, 100, 100, image, area, 1)).toBe(FIT);
  });
});
