/**
 * Hotkeys as the Rust side parses them (global-hotkey's format): modifiers and one key joined by "+",
 * where the key is a `KeyboardEvent.code` or its short form ("1" for Digit1, "A" for KeyA).
 */

type KeyLike = Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;

/** The key part of a hotkey for a `KeyboardEvent.code`, or null for a modifier on its own. */
export function keyName(code: string): string | null {
  if (/^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/.test(code) || code === "CapsLock" || code === "Fn") return null;
  const digit = code.match(/^Digit(\d)$/);
  if (digit) return digit[1];
  const letter = code.match(/^Key([A-Z])$/);
  if (letter) return letter[1];
  const numpad = code.match(/^Numpad(\d)$/);
  if (numpad) return `Num${numpad[1]}`;
  return code || null;
}

/** Keys that are fine as a hotkey with no modifier: nobody types them. */
const STANDALONE = /^(F\d{1,2}|PrintScreen|Pause|ScrollLock|Insert)$/;

/** The hotkey a key press makes, or null while it's still only modifiers (or a bare letter). */
export function comboFrom(e: KeyLike, mac: boolean): string | null {
  const key = keyName(e.code);
  if (!key) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push(mac ? "Option" : "Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push(mac ? "Cmd" : "Super");
  if (mods.length === 0 && !STANDALONE.test(key)) return null;
  return [...mods, key].join("+");
}

const MAC_SYMBOLS: Record<string, string> = {
  ctrl: "⌃",
  control: "⌃",
  option: "⌥",
  alt: "⌥",
  shift: "⇧",
  cmd: "⌘",
  command: "⌘",
  super: "⌘",
};

/** A hotkey as people read it on this platform: "⌃⇧1" on a Mac, "Ctrl + Shift + 1" elsewhere. */
export function displayCombo(combo: string, mac: boolean): string {
  if (!combo.trim()) return "";
  const parts = combo.split("+").map((p) => p.trim());
  if (mac) return parts.map((p) => MAC_SYMBOLS[p.toLowerCase()] ?? p).join("");
  return parts.join(" + ");
}
