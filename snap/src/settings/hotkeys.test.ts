import { describe, expect, it } from "vitest";
import { comboFrom, displayCombo, keyName } from "./hotkeys";

const press = (code: string, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) => ({
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

describe("keyName", () => {
  it("shortens digits, letters and the numpad, and ignores lone modifiers", () => {
    expect(keyName("Digit3")).toBe("3");
    expect(keyName("KeyS")).toBe("S");
    expect(keyName("Numpad7")).toBe("Num7");
    expect(keyName("F12")).toBe("F12");
    expect(keyName("ShiftLeft")).toBeNull();
    expect(keyName("MetaRight")).toBeNull();
  });
});

describe("comboFrom", () => {
  it("builds the parser's format", () => {
    expect(comboFrom(press("Digit1", { ctrlKey: true, shiftKey: true }), false)).toBe("Ctrl+Shift+1");
    expect(comboFrom(press("KeyA", { metaKey: true, altKey: true }), true)).toBe("Option+Cmd+A");
    expect(comboFrom(press("KeyA", { metaKey: true }), false)).toBe("Super+A");
  });
  it("waits for a real key, and refuses a bare letter", () => {
    expect(comboFrom(press("ControlLeft", { ctrlKey: true }), false)).toBeNull();
    expect(comboFrom(press("KeyA"), false)).toBeNull();
    expect(comboFrom(press("PrintScreen"), false)).toBe("PrintScreen");
    expect(comboFrom(press("F9"), false)).toBe("F9");
  });
});

describe("displayCombo", () => {
  it("reads naturally per platform", () => {
    expect(displayCombo("Ctrl+Shift+1", true)).toBe("⌃⇧1");
    expect(displayCombo("Ctrl+Shift+1", false)).toBe("Ctrl + Shift + 1");
    expect(displayCombo("", false)).toBe("");
  });
});
