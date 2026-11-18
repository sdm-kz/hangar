// Finding and ranking the file mention being typed in a message: "@" and a path, which Claude Code reads
// the file behind when the message arrives, as it does for one typed in the terminal. No React.
import type { FileEntry } from "../types";

// Most files the suggestions list at once; the rest are a few more letters away.
export const MAX_MENTIONS = 50;

/** The mention being typed at the caret: where its "@" is, and the path that follows it so far. */
export interface MentionToken {
  start: number;
  query: string;
}

/**
 * The mention at the caret: an "@" at the start of the text or after a space, then the start of a path,
 * with the caret at the end of the word. An address (me@host) has no space before its "@". Backslashes
 * are levelled to slashes, so a path typed the Windows way still finds its folder.
 */
export function mentionToken(text: string, caret: number): MentionToken | null {
  if (caret < text.length && !/\s/.test(text[caret])) return null;
  const m = text.slice(0, caret).match(/(^|\s)@([^\s@"]*)$/);
  return m ? { start: caret - m[2].length - 1, query: m[2].replace(/\\/g, "/") } : null;
}

/**
 * Where to look for what is typed. A path up to a slash (or nothing yet) is a folder to list, and what
 * follows the last slash narrows that listing; a bare name with no folder in it is looked for anywhere
 * under the session's folder.
 */
export function mentionLookup(query: string): { kind: "list"; dir: string; name: string } | { kind: "search"; name: string } {
  const slash = query.lastIndexOf("/");
  if (slash < 0) return query ? { kind: "search", name: query } : { kind: "list", dir: "", name: "" };
  return { kind: "list", dir: query.slice(0, slash), name: query.slice(slash + 1) };
}

/**
 * Entries that match `name`, best first: the name starts with it, then contains it, then (for a search
 * across the tree) the path does. Shallower paths before deeper ones, then folders before files.
 */
export function rankFiles(entries: FileEntry[], name: string): FileEntry[] {
  const q = name.toLowerCase();
  const scored: [number, FileEntry][] = [];
  for (const e of entries) {
    const n = e.name.toLowerCase();
    const score = !q || n.startsWith(q) ? 0 : n.includes(q) ? 1 : e.path.toLowerCase().includes(q) ? 2 : -1;
    if (score >= 0) scored.push([score, e]);
  }
  const depth = (p: string) => p.split("/").length;
  scored.sort(
    (a, b) =>
      a[0] - b[0] ||
      depth(a[1].path) - depth(b[1].path) ||
      Number(b[1].isDir) - Number(a[1].isDir) ||
      a[1].path.localeCompare(b[1].path)
  );
  return scored.slice(0, MAX_MENTIONS).map(([, e]) => e);
}

/** How an entry is written after its "@": a folder ends in a slash, and a path with a space is quoted. */
export function mentionText(e: FileEntry): string {
  const path = e.isDir ? `${e.path}/` : e.path;
  return /\s/.test(path) ? `"${path}"` : path;
}

/**
 * The text with `e` in place of the mention being typed (`token`, the caret at `caret`). A file gets one
 * space after it, as a picked command does; a folder gets none, so typing on goes on into it.
 */
export function insertMention(
  text: string,
  token: MentionToken,
  caret: number,
  e: FileEntry
): { text: string; caret: number } {
  const at = Math.min(caret, text.length);
  const inserted = `@${mentionText(e)}${e.isDir ? "" : " "}`;
  const rest = text.slice(at);
  return {
    text: text.slice(0, token.start) + inserted + (e.isDir ? rest : rest.replace(/^ /, "")),
    caret: token.start + inserted.length,
  };
}
