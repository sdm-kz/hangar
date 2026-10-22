import { describe, expect, it } from "vitest";
import { moveItem, neighbourOf } from "./pages";
import { packImages } from "@/lib/pack";

describe("moveItem", () => {
  it("moves forwards and backwards", () => {
    expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
  });

  it("leaves the list alone for a move to where it is, or of nothing", () => {
    const items = ["a", "b"];
    expect(moveItem(items, 1, 1)).toBe(items);
    expect(moveItem(items, 5, 0)).toBe(items);
  });

  it("holds a target past either end to the end", () => {
    expect(moveItem(["a", "b", "c"], 0, 9)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], 2, -3)).toEqual(["c", "a", "b"]);
  });
});

describe("neighbourOf", () => {
  it("prefers the next one, then the one before", () => {
    expect(neighbourOf(["a", "b", "c"], 1)).toBe("c");
    expect(neighbourOf(["a", "b", "c"], 2)).toBe("b");
    expect(neighbourOf(["a"], 0)).toBeNull();
  });
});

describe("packImages", () => {
  it("puts each picture after its length, little-endian", () => {
    const packed = packImages([new Uint8Array([1, 2, 3]), new Uint8Array([9])]);
    expect(Array.from(packed)).toEqual([3, 0, 0, 0, 1, 2, 3, 1, 0, 0, 0, 9]);
  });
});
