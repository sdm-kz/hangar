// Finding and ranking the slash command being typed in a message. No React and no imports through "@": the
// tray app's message box uses it too (as "@web/lib/slash"), with its own list and its own way of reading
// the commands.
import type { SlashCommand } from "../types";

// Most slash commands the suggestions list at once; the rest are a few more letters away.
export const MAX_SUGGESTIONS = 50;

/** The slash command being typed at the caret: where its "/" is, and what follows it so far. */
export interface SlashToken {
  start: number;
  query: string;
}

/**
 * The command at the caret: a "/" at the start of the text or after a space, then the start of a name,
 * with the caret at the end of the word. Anywhere in the text, so a command can be asked for mid-sentence
 * ("then run /review"). A path (/usr/bin, C:/x) has another slash in it, or no space before it.
 */
export function slashToken(text: string, caret: number): SlashToken | null {
  if (caret < text.length && !/\s/.test(text[caret])) return null;
  const m = text.slice(0, caret).match(/(^|\s)\/([^\s/]*)$/);
  return m ? { start: caret - m[2].length - 1, query: m[2] } : null;
}

/** Something that could be a command: a "/" at the start or after a space, and a name. */
export const SLASH_WORD = /(^|\s)\/[^\s/]/;

/** Where a known command stands in the text, whole: "/review" in "then /review it", not "/rev" or "/usr/bin". */
export interface SlashRange {
  start: number;
  end: number;
}

export function commandRanges(text: string, commands: SlashCommand[]): SlashRange[] {
  if (!commands.length) return [];
  const names = new Set(commands.map((c) => c.name.toLowerCase()));
  const ranges: SlashRange[] = [];
  for (const m of text.matchAll(/(^|\s)\/([^\s/]+)(?=\s|$)/g)) {
    if (!names.has(m[2].toLowerCase())) continue;
    const start = (m.index ?? 0) + m[1].length;
    ranges.push({ start, end: start + 1 + m[2].length });
  }
  return ranges;
}

/** The command's name, or a plugin command's own part, starts with what was typed. */
export function startsWithQuery(c: SlashCommand, query: string): boolean {
  const name = c.name.toLowerCase();
  const q = query.toLowerCase();
  return name.startsWith(q) || name.slice(name.indexOf(":") + 1).startsWith(q);
}

/**
 * Commands that match what follows the slash, best first: the name starts with it, then a plugin
 * command's own part does (design:critique for "crit"), then the name contains it, then the description.
 */
export function rankCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  const scored: [number, SlashCommand][] = [];
  for (const c of commands) {
    const name = c.name.toLowerCase();
    const own = name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
    const score = name.startsWith(q)
      ? 0
      : own.startsWith(q)
        ? 1
        : name.includes(q)
          ? 2
          : q.length > 1 && c.description?.toLowerCase().includes(q)
            ? 3
            : -1;
    if (score >= 0) scored.push([score, c]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].name.length - b[1].name.length || a[1].name.localeCompare(b[1].name));
  return scored.slice(0, MAX_SUGGESTIONS).map(([, c]) => c);
}

/**
 * The text with `c` in place of the command being typed (`token`, the caret at `caret`), one space after
 * it: the one already there, or a new one. Returns the new text and where the caret goes.
 */
export function insertCommand(
  text: string,
  token: SlashToken,
  caret: number,
  c: SlashCommand
): { text: string; caret: number } {
  const at = Math.min(caret, text.length);
  const inserted = `/${c.name} `;
  return {
    text: text.slice(0, token.start) + inserted + text.slice(at).replace(/^ /, ""),
    caret: token.start + inserted.length,
  };
}
