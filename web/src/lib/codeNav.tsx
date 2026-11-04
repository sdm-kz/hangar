// Navigation inside one file, for the read-only code views: the Files preview, a diff, a pull
// request's file. A click on a name marks every place it appears; Ctrl/⌘+click (or the button on
// the bar that shows up) jumps to where it is declared. There is no language server behind this —
// "declared" is read off the line the name sits on (see declScore) — so it is right for the names
// people mostly click, and the bar's arrows cover the rest by walking every occurrence.
//
// The marks are CSS Custom Highlights rather than spans wrapped around the text. The text belongs to
// someone else — React's rows in a pull request, highlight.js' innerHTML in the Files preview — and
// a highlight is painted over ranges without touching a node of it. One registry per document, so
// one view owns it at a time (see `owner`).
//
// Past the file, a view can hand in a `search` — git grep over the rest of the code — and a name the
// file does not declare is looked for there: one clear declaration is opened straight away, anything
// less certain is listed, declarations first (see rankMatches).
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp, Loader2, LocateFixed, Search, X } from "lucide-react";
import type { GrepMatch, GrepResult } from "@/types";

export interface CodeNavOptions {
  /** Elements that each hold one line of code. Set where the view draws a line per element (a
   *  diff, a numbered listing): text outside them — numbers, headers, buttons — is not code. Unset,
   *  the whole container is code and its own newlines divide it. */
  lineSelector?: string;
  /** Each line starts with a unified diff's +, - or space, which is not part of the code. */
  diffPrefix?: boolean;
  /** Called when the file in view declares nothing by that name. True means the caller took it
   *  from there (a pull request swaps its diff for the whole file and asks again). */
  onNoDefinition?: (word: string) => boolean;
  /** Looks a name up across the rest of the code. Given, a name with no declaration in this file is
   *  looked for there, and the bar offers the search for any name. */
  search?: (word: string) => Promise<GrepResult>;
  /** Goes to a place the search found: another file, or a line of this one (see `path`). */
  onOpen?: (match: GrepMatch, word: string) => void;
  /** This file's path as the search names it, so its own lines are marked as such in the list. */
  path?: string;
}

export interface CodeNav {
  /** The callback ref for the element holding the code. */
  ref: (el: HTMLElement | null) => void;
  /** The bar — word, count, arrows — while something is marked. Render it anywhere; it portals. */
  overlay: ReactNode;
  /** Jump to the declaration of a name, as Ctrl+click on it would. False when there is none. */
  goToDefinition: (word: string) => boolean;
  /** Bring a line into view with `word` marked on it — where a search result points. False while
   *  there is no code to do it in (the caller tries again once there is). */
  revealAt: (line: number, word?: string) => boolean;
}

const WORD_CHAR = /[\p{L}\p{N}_$]/u;
// Where a name means nothing: a doc comment naming the method it sits on is not its declaration.
const NOT_CODE = ".hljs-comment, .hljs-quote, .hljs-string, .hljs-regexp";
const MAX_HITS = 5000;
const NAMES = { all: "code-nav", current: "code-nav-current", link: "code-nav-link" };

/** The view whose marks are in the registry now, so the next one to mark something can take over. */
let owner: { clear: () => void } | null = null;

interface Scan {
  text: string;
  nodes: Text[];
  /** Where each node's text starts in `text`. */
  starts: number[];
}

/** The code as one string, with the text node each part came from — what both matching and ranges need. */
function scan(root: HTMLElement, lineSelector?: string): Scan {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  let lastLine: Element | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (lineSelector) {
      const line = n.parentElement?.closest(lineSelector);
      if (!line || !root.contains(line)) continue;
      // Lines drawn as separate elements have no newline between them; one is put back, so a line
      // reads as a line when it comes to deciding what it declares.
      if (line !== lastLine) {
        if (lastLine) text += "\n";
        lastLine = line;
      }
    }
    nodes.push(n);
    starts.push(text.length);
    text += n.data;
  }
  return { text, nodes, starts };
}

/** The text node and offset in it for a position in the scanned string. */
function locate(s: Scan, offset: number, isEnd: boolean): [Text, number] | null {
  let lo = 0;
  let hi = s.starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    // An end belongs to the node it closes, not to the one that starts right there.
    if (isEnd ? s.starts[mid] < offset : s.starts[mid] <= offset) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0) return null;
  const node = s.nodes[found];
  const at = offset - s.starts[found];
  return at <= node.data.length ? [node, at] : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A keyword that introduces a declaration, then the name — maybe after modifiers and, for the
// delegate/event kind, a type — and, for SQL, a schema. Case-insensitive for SQL's CREATE and VB's
// Sub/Function.
const KEYWORD_DECL = new RegExp(
  String.raw`(?:^|[^\w$.])(?:class|interface|struct|record|enum|namespace|trait|impl|type|typedef|def|fn|func|function\*?|sub|let|const|var|val|object|protocol|module|package|union|delegate|event|alias|newtype|defmodule|defp|my|our|local|create\s+(?:or\s+replace\s+)?(?:table|view|procedure|proc|function|index|trigger|type))\s+(?:(?:mut|async|static|readonly|unsafe|pub|override|partial|sealed|abstract|public|private|protected|internal)\s+)*(?:[\w$.<>[\],?]+\s+)?(?:[\w$"[\]]+\.)*$`,
  "i"
);
// Go's method: `func (r *Repo) Name(`.
const GO_METHOD = /\bfunc\s*\([^)]*\)\s*$/;
// `Type Name` — a C-family member, local, or parameter — where what precedes the name is a type.
const TYPED_BEFORE = /(?:^|[\s(,[<{])([A-Za-z_$][\w$.]*)(?:<[^()=;]*>)?(?:\[[\],\s]*\])*[?*&]*\s+$/;
const TYPED_AFTER = /^\s*(?:$|[;,)\]{(<:]|=(?!=))/;
// Words that sit before a name the way a type would, and are not one.
const NOT_TYPE = new Set(
  (
    "return await new throw else case yield in of is as goto typeof sizeof nameof echo print not and or " +
    "delete using import from export default if while for foreach switch catch when where select extends " +
    "implements throws instanceof keyof satisfies infer unique do then elif except raise assert lambda " +
    "with by into on join group order include require use"
  ).split(" ")
);
// A name at the start of its line being given something: `Name = …`, `Name: …`, `Name(a, b) {`.
const LINE_START_BEFORE =
  /^\s*(?:(?:export|default|public|private|protected|internal|static|async|readonly|override|abstract|virtual|get|set|pub)\s+)*(?:(?:self|this)\.)?$/;
const LINE_START_AFTER = /^\s*(?:=(?![=>])|:(?!:)|(?:<[^>]*>)?\([^)]*\)\s*(?::[^{]*)?\{\s*$)/;

/**
 * How surely the name at `col` in this line is being declared there: 3 for a declaring keyword
 * (`class`, `def`, `function`, `var`…), 2 for a type in front of it (`Task<Result> Name(`), 1 for a
 * name at the start of the line being assigned or given a body, 0 for a use.
 */
export function declScore(line: string, col: number, length: number): number {
  const before = line.slice(0, col);
  const after = line.slice(col + length);
  if (KEYWORD_DECL.test(before) || GO_METHOD.test(before)) return 3;
  const typed = before.match(TYPED_BEFORE);
  if (typed && !NOT_TYPE.has(typed[1].toLowerCase()) && TYPED_AFTER.test(after) && !/^\s*==/.test(after))
    return 2;
  if (LINE_START_BEFORE.test(before) && LINE_START_AFTER.test(after)) return 1;
  return 0;
}

interface Hit {
  start: number;
  range: Range;
  /** Declaration score (see declScore), less a little for the old side of a diff. */
  score: number;
  /** The diff side it is on, where the view has two: "old" or "new". */
  side?: string;
}

// How much of a line either side of a name is read to score it. A declaration says what it is well
// inside this; a minified file's one long line would otherwise be read whole for every occurrence.
const CONTEXT = 200;
// Stands in for the part of a line cut off before the window: neither a space nor a word, so a
// pattern anchored to the line's start cannot mistake the window's start for it.
const CUT = "\u0000";

/** Offsets of every newline, for finding a position's line without scanning back through it. */
function newlines(text: string): number[] {
  const at: number[] = [];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) at.push(i);
  return at;
}

/** The start and end of the line holding `offset`, by binary search over `breaks`. */
function lineAround(text: string, breaks: number[], offset: number): [number, number] {
  let lo = 0;
  let hi = breaks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (breaks[mid] < offset) lo = mid + 1;
    else hi = mid;
  }
  return [lo > 0 ? breaks[lo - 1] + 1 : 0, lo < breaks.length ? breaks[lo] : text.length];
}

/**
 * Every whole-word occurrence of `word`, in document order, each scored as a declaration. Past
 * MAX_HITS the rest are dropped — except the one at `keep`, the occurrence that was clicked.
 */
function findHits(root: HTMLElement, s: Scan, word: string, diffPrefix: boolean, keep?: number): Hit[] {
  const re = wordRe(word, "gu");
  const breaks = newlines(s.text);
  const hits: Hit[] = [];
  for (const m of s.text.matchAll(re)) {
    if (hits.length >= MAX_HITS && m.index !== keep) {
      if (keep === undefined || m.index > keep) break;
      continue;
    }
    const a = locate(s, m.index, false);
    const b = locate(s, m.index + word.length, true);
    if (!a || !b) continue;
    const range = document.createRange();
    range.setStart(a[0], a[1]);
    range.setEnd(b[0], b[1]);

    let score = 0;
    const el = a[0].parentElement;
    const side = el?.closest("[data-side]")?.getAttribute("data-side") ?? undefined;
    const skip = el?.closest(NOT_CODE);
    if (!skip || !root.contains(skip)) {
      const [lineStart, lineEnd] = lineAround(s.text, breaks, m.index);
      const from = Math.max(lineStart, m.index - CONTEXT);
      const to = Math.min(lineEnd, m.index + word.length + CONTEXT);
      const cut = from > lineStart;
      let line = (cut ? CUT : "") + s.text.slice(from, to);
      let col = m.index - from + (cut ? 1 : 0);
      let isMeta = false;
      if (diffPrefix && !cut) {
        // Headers and hunk markers are the diff talking, not the code; the marker on a code line
        // is blanked rather than cut, so the column stays where it was.
        isMeta = /^(?:@@|diff |index |\+\+\+|---|new file|deleted|similarity|rename )/.test(line);
        if (!isMeta && col > 0) line = " " + line.slice(1);
        else if (!isMeta) col = -1;
      }
      if (!isMeta && col >= 0) score = declScore(line, col, word.length);
      // A pull request's old side is what the change replaces; the new one is what to read.
      if (score > 0 && side === "old") score -= 0.5;
    }
    hits.push({ start: m.index, range, score, side });
  }
  return hits;
}

/** The word under a point, as the text node's own range, or null over anything that isn't one. */
function wordAt(
  root: HTMLElement,
  x: number,
  y: number,
  lineSelector?: string
): { node: Text; from: number; to: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  let node: Node | null = null;
  let offset = 0;
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    if (p) [node, offset] = [p.offsetNode, p.offset];
  } else if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (r) [node, offset] = [r.startContainer, r.startOffset];
  }
  if (!node || node.nodeType !== Node.TEXT_NODE || !root.contains(node)) return null;
  if (lineSelector && !node.parentElement?.closest(lineSelector)) return null;
  const text = (node as Text).data;
  let at = offset;
  if (!WORD_CHAR.test(text[at] ?? "")) at--;
  if (!WORD_CHAR.test(text[at] ?? "")) return null;
  let from = at;
  let to = at + 1;
  while (from > 0 && WORD_CHAR.test(text[from - 1])) from--;
  while (to < text.length && WORD_CHAR.test(text[to])) to++;
  const word = text.slice(from, to);
  // A bare number is not a name, and `$` alone is punctuation.
  if (!/[\p{L}_]/u.test(word)) return null;

  // The caret snaps to the nearest character, so a click in the blank space past the end of a line
  // lands on its last word. Only a click that is on the word counts.
  const range = document.createRange();
  range.setStart(node, from);
  range.setEnd(node, to);
  const on = Array.from(range.getClientRects()).some(
    (r) => x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1
  );
  return on ? { node: node as Text, from, to } : null;
}

/** Scroll whatever needs scrolling to put a range in view, centred, once it is out of it. */
function reveal(range: Range) {
  const start = range.startContainer;
  let el: HTMLElement | null = start.nodeType === Node.TEXT_NODE ? start.parentElement : (start as HTMLElement);
  for (; el; el = el.parentElement) {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const r = range.getBoundingClientRect();
    if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight) {
      // Room for a sticky header at the top, which would otherwise sit on the line it was brought to.
      if (r.top < box.top + 48 || r.bottom > box.top + el.clientHeight - 8)
        el.scrollTop += r.top - (box.top + el.clientHeight / 2);
    }
    if (/(auto|scroll)/.test(style.overflowX) && el.scrollWidth > el.clientWidth) {
      if (r.left < box.left || r.right > box.left + el.clientWidth)
        el.scrollLeft += r.left - (box.left + el.clientWidth / 3);
    }
  }
}

const registry = (): HighlightRegistry | null =>
  typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights : null;

/** Whether an event came from somewhere typing happens, where F3 and Escape belong to the field. */
function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']");
}

/** A search result with how surely it declares the name (see declScore). */
export interface RankedMatch extends GrepMatch {
  score: number;
}

// A line that opens with a comment says nothing is declared on it, whatever the words after look like.
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|<!--|--\s|#(?!\s*define\b|\[|!))/;

/** A whole-word matcher for a name, the way findHits reads one. */
function wordRe(word: string, flags: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_$])${escapeRegExp(word)}(?![\\p{L}\\p{N}_$])`, flags);
}

// Prose: a README's "Foo: does this" or a fenced `class Foo` reads like a declaration and isn't one.
const PROSE_FILE = /\.(?:md|markdown|mdx|txt|rst|adoc|log|csv)$/i;

/**
 * Search results best first: declarations — by how surely — ahead of uses, then by path and line. The
 * same reading of a line the in-file jump does, applied to lines that come back from a search.
 */
export function rankMatches(matches: GrepMatch[], word: string): RankedMatch[] {
  const re = wordRe(word, "gu");
  return matches
    .map((m) => {
      let score = 0;
      if (!COMMENT_LINE.test(m.text) && !PROSE_FILE.test(m.path))
        for (const hit of m.text.matchAll(re)) score = Math.max(score, declScore(m.text, hit.index, word.length));
      return { ...m, score };
    })
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);
}

/** What a search across the code found, for the list above the bar. */
interface Found {
  word: string;
  loading: boolean;
  error?: string;
  matches: RankedMatch[];
  truncated: boolean;
}

interface Shown {
  word: string;
  index: number;
  count: number;
  /** A message in place of the count, for a moment: nothing declared that name here. */
  note?: string;
}

export function useCodeNav(options: CodeNavOptions = {}): CodeNav {
  const [root, setRoot] = useState<HTMLElement | null>(null);
  // The same element, for the calls a caller makes right after a render that put it there — before
  // the state above has caught up with it.
  const rootRef = useRef<HTMLElement | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    rootRef.current = el;
    setRoot(el);
  }, []);
  const [shown, setShown] = useState<Shown | null>(null);
  const [found, setFound] = useState<Found | null>(null);
  const searchSeq = useRef(0);
  /** Close the list of search results — and call off a search still on its way to it. */
  const dropFound = useCallback(() => {
    searchSeq.current++;
    setFound(null);
  }, []);
  const [place, setPlace] = useState<{ right: number; bottom: number } | null>(null);
  const opts = useRef(options);
  opts.current = options;

  const word = useRef<string | null>(null);
  const hits = useRef<Hit[]>([]);
  const index = useRef(0);
  const noteTimer = useRef(0);
  const self = useRef<{ clear: () => void }>({ clear: () => {} });

  const paint = useCallback(() => {
    const reg = registry();
    if (!reg) return;
    const current = hits.current[index.current];
    reg.set(NAMES.all, new Highlight(...hits.current.filter((h) => h !== current).map((h) => h.range)));
    if (current) reg.set(NAMES.current, new Highlight(current.range));
    else reg.delete(NAMES.current);
  }, []);

  const clear = useCallback(() => {
    if (owner === self.current) {
      owner = null;
      registry()?.delete(NAMES.all);
      registry()?.delete(NAMES.current);
    }
    word.current = null;
    hits.current = [];
    window.clearTimeout(noteTimer.current);
    searchSeq.current++;
    setShown(null);
    setFound(null);
  }, []);
  self.current.clear = clear;

  const show = useCallback((note?: string) => {
    if (!word.current) return;
    setShown({ word: word.current, index: index.current, count: hits.current.length, note });
    window.clearTimeout(noteTimer.current);
    // A note that has nothing marked under it — the name is not in this code at all — goes with it.
    if (note) noteTimer.current = window.setTimeout(() => (hits.current.length ? show() : self.current.clear()), 2500);
  }, []);

  /** Mark `w` throughout the file; with `at`, the occurrence there is the current one. */
  const mark = useCallback((w: string, at?: number): boolean => {
    const el = rootRef.current;
    if (!el) return false;
    const s = scan(el, opts.current.lineSelector);
    const all = findHits(el, s, w, !!opts.current.diffPrefix, at);
    if (!all.length) return false;
    take(self.current);
    word.current = w;
    hits.current = all;
    const i = at === undefined ? -1 : all.findIndex((h) => h.start === at);
    index.current = Math.max(0, i);
    return true;
  }, []);

  const go = useCallback(
    (i: number) => {
      const n = hits.current.length;
      if (!n) return;
      index.current = ((i % n) + n) % n;
      paint();
      reveal(hits.current[index.current].range);
      show();
    },
    [paint, show]
  );

  /**
   * Look a name up across the rest of the code. `auto` is the Ctrl+click that found no declaration
   * here: one declaration that is plainly the one is gone to, without a list to pick it from.
   */
  const findElsewhere = useCallback(
    async (w: string, auto: boolean) => {
      const search = opts.current.search;
      if (!search) return;
      const seq = ++searchSeq.current;
      // The note that says so stays until the answer, however long the search takes: its timer would
      // otherwise drop everything — this search included — when nothing in the file is marked.
      window.clearTimeout(noteTimer.current);
      if (!auto) setFound({ word: w, loading: true, matches: [], truncated: false });
      let r: GrepResult;
      try {
        r = await search(w);
      } catch {
        r = { matches: [], truncated: false, error: "Could not reach the server." };
      }
      if (seq !== searchSeq.current) return; // cleared, or another search since
      if (r.error) {
        setFound({ word: w, loading: false, error: r.error, matches: [], truncated: false });
        show();
        return;
      }
      const ranked = rankMatches(r.matches, w);
      if (auto) {
        // Gone to without asking only when it is plainly the one: the single best declaration, in a
        // search that read everything, somewhere other than this file (whose own lines the in-file
        // pass has already read more carefully, and turned down).
        const best = ranked.filter((m) => m.score > 0 && m.score === ranked[0].score);
        if (best.length === 1 && !r.truncated && best[0].path !== opts.current.path) {
          setFound(null);
          opts.current.onOpen?.(best[0], w);
          return;
        }
        if (!ranked.length) {
          show("not found elsewhere");
          return;
        }
      }
      setFound({ word: w, loading: false, matches: ranked, truncated: r.truncated });
      show();
    },
    [show]
  );

  /** From the current occurrence to its declaration — or, standing on one, to the next. */
  const jump = useCallback((): boolean => {
    const w = word.current;
    if (!w) return false;
    const list = hits.current
      .map((h, i) => ({ h, i }))
      .filter(({ h }) => h.score > 0)
      .sort((a, b) => b.h.score - a.h.score || a.i - b.i);
    if (!list.length) {
      // Handed over: the caller is about to redraw the code and ask again, so nothing stays marked
      // in the meantime.
      if (opts.current.onNoDefinition?.(w)) {
        clear();
        return false;
      }
      index.current = Math.max(0, index.current);
      paint();
      if (opts.current.search) {
        show("searching…");
        void findElsewhere(w, true);
      } else show("no declaration here");
      return false;
    }
    if (!list.some(({ i }) => i === index.current)) {
      go(list[0].i);
      return true;
    }
    // Already on a declaration: overloads take turns, and a lone one hands over to its uses. Only
    // the ones on its own side count — a split diff draws an unchanged line on both, and the copy
    // across from it is the same declaration rather than another.
    const side = hits.current[index.current].side;
    const same = list.filter(({ h }) => h.side === side);
    const here = same.findIndex(({ i }) => i === index.current);
    if (same.length > 1) go(same[(here + 1) % same.length].i);
    else go(index.current + 1);
    return true;
  }, [go, paint, show, clear, findElsewhere]);

  const goToDefinition = useCallback(
    (w: string) => {
      if (!mark(w)) {
        // Not in this code at all — a name only the removed lines had, say. Looked for elsewhere
        // where that can be done, and otherwise said, briefly, rather than leaving the reader to
        // wonder whether anything happened.
        if (!rootRef.current) return false;
        take(self.current);
        registry()?.delete(NAMES.all);
        registry()?.delete(NAMES.current);
        word.current = w;
        hits.current = [];
        index.current = 0;
        if (opts.current.search) {
          show("searching…");
          void findElsewhere(w, true);
        } else show("not in this file");
        return false;
      }
      // Starting from nowhere, so a declaration that happens to be the first occurrence is gone to
      // rather than stepped past.
      index.current = -1;
      return jump();
    },
    [mark, jump, show, findElsewhere]
  );

  const revealAt = useCallback(
    (line: number, w?: string): boolean => {
      const el = rootRef.current;
      // A view kept mounted out of sight (another tab's) is no place to bring a line into view — and
      // the one on screen is left the chance to.
      if (!el || !el.getClientRects().length) return false;
      const lineSelector = opts.current.lineSelector;
      // A line's number: the element it is drawn in says so where the view numbers its lines; where
      // the code is one block, it is counted.
      const s = scan(el, lineSelector);
      const breaks = newlines(s.text);
      const lineOf = (start: number, node: Node) => {
        if (lineSelector) return Number(node.parentElement?.closest("[data-line]")?.getAttribute("data-line") ?? 0);
        let lo = 0;
        let hi = breaks.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (breaks[mid] < start) lo = mid + 1;
          else hi = mid;
        }
        return lo + 1;
      };
      if (w && mark(w)) {
        const i = hits.current.findIndex((h) => lineOf(h.start, h.range.startContainer) === line);
        if (i >= 0) {
          go(i);
          return true;
        }
      } else if (owner === self.current) {
        // Not marked here, so whatever was marked before has nothing to do with this line.
        registry()?.delete(NAMES.all);
        registry()?.delete(NAMES.current);
        word.current = null;
        hits.current = [];
      }
      // No mark on that line — the word is not on it after all — so the line itself is brought in.
      let range: Range | null = null;
      if (lineSelector) {
        const cell = el.querySelector(`[data-line="${line}"]`);
        if (cell) {
          range = document.createRange();
          range.selectNodeContents(cell);
        }
      } else {
        const at = locate(s, line <= 1 ? 0 : (breaks[line - 2] ?? s.text.length) + 1, false);
        if (at) {
          range = document.createRange();
          range.setStart(at[0], at[1]);
        }
      }
      if (range) reveal(range);
      if (hits.current.length) {
        index.current = -1;
        paint();
        show();
      }
      return true;
    },
    [mark, go, paint, show]
  );

  // Clicks and Ctrl-hover inside the code.
  useEffect(() => {
    if (!root) return;
    let frame = 0;
    const reg = registry();
    const unlink = () => {
      reg?.delete(NAMES.link);
      root.style.cursor = "";
    };

    const click = (e: MouseEvent) => {
      if (e.button !== 0 || e.altKey || e.shiftKey) return;
      if ((e.target as Element | null)?.closest?.("a, button, input, textarea, select")) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return; // the end of a drag selecting text
      const at = wordAt(root, e.clientX, e.clientY, opts.current.lineSelector);
      if (!at) {
        if (owner === self.current) clear();
        return;
      }
      const s = scan(root, opts.current.lineSelector);
      const idx = s.nodes.indexOf(at.node);
      dropFound();
      if (idx < 0) return;
      const w = at.node.data.slice(at.from, at.to);
      if (!mark(w, s.starts[idx] + at.from)) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        unlink();
        jump();
      } else {
        paint();
        show();
      }
    };

    // Held Ctrl/⌘ underlines the name under the pointer, the way an editor shows what is a link.
    const move = (e: MouseEvent) => {
      cancelAnimationFrame(frame);
      if (!(e.ctrlKey || e.metaKey) || !reg) return unlink();
      const { clientX: x, clientY: y } = e;
      frame = requestAnimationFrame(() => {
        const at = wordAt(root, x, y, opts.current.lineSelector);
        if (!at) return unlink();
        const range = document.createRange();
        range.setStart(at.node, at.from);
        range.setEnd(at.node, at.to);
        reg.set(NAMES.link, new Highlight(range));
        root.style.cursor = "pointer";
      });
    };
    const keyUp = (e: KeyboardEvent) => {
      if (e.key === "Control" || e.key === "Meta") unlink();
    };
    // A tap marks a word now, and iOS would flash its grey tap highlight over the whole block for it.
    root.style.setProperty("-webkit-tap-highlight-color", "transparent");

    root.addEventListener("click", click);
    root.addEventListener("mousemove", move);
    root.addEventListener("mouseleave", unlink);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", unlink);
    return () => {
      cancelAnimationFrame(frame);
      unlink();
      root.style.removeProperty("-webkit-tap-highlight-color");
      root.removeEventListener("click", click);
      root.removeEventListener("mousemove", move);
      root.removeEventListener("mouseleave", unlink);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", unlink);
    };
  }, [root, mark, jump, paint, show, clear, dropFound]);

  const active = shown !== null;

  // F3 / Shift+F3 step through the marks, Escape drops them — the list of search results first,
  // where one is open: it takes its own keys (see ResultsPanel).
  useEffect(() => {
    if (!active) return;
    const key = (e: KeyboardEvent) => {
      if (owner !== self.current || typing(e.target)) return;
      // A view in a tab that is not showing keeps its marks for when it is, but not the keys.
      if (!root?.isConnected || !root.getClientRects().length) return;
      if (e.key === "F3") {
        e.preventDefault();
        go(index.current + (e.shiftKey ? -1 : 1));
      } else if (e.key === "Escape") clear();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [root, active, go, clear]);

  // The code under the marks is redrawn — a reload, the wrap toggle, a diff swapped for the whole
  // file — and the ranges go with the nodes they pointed into. Marked again on the new text.
  useEffect(() => {
    if (!root || !active) return;
    let frame = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const w = word.current;
        if (!w || owner !== self.current) return;
        const keep = index.current;
        if (!mark(w)) return clear();
        index.current = Math.min(keep, hits.current.length - 1);
        paint();
        show();
      });
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [root, active, mark, paint, show, clear]);

  // Gone with the view, or with the element it marked in: the marks would otherwise outlive both.
  useEffect(() => () => clear(), [clear]);
  useEffect(() => {
    if (!root) clear();
  }, [root, clear]);

  // The bar sits in the bottom-right corner of the pane the code scrolls in — found once it shows,
  // and followed as that pane is resized.
  useLayoutEffect(() => {
    if (!root || !active) return;
    // The first ancestor that actually scrolls: a <pre> is overflow-auto too, but only sideways —
    // its height is the file's, and its bottom corner can be far below the pane's.
    let pane: HTMLElement | null = null;
    let fallback: HTMLElement = root;
    for (let el: HTMLElement | null = root; el && !pane; el = el.parentElement) {
      if (!/(auto|scroll)/.test(getComputedStyle(el).overflowY)) continue;
      if (el.scrollHeight > el.clientHeight) pane = el;
      else if (fallback === root) fallback = el;
    }
    const anchor = pane ?? fallback;
    const measure = () => {
      const r = anchor.getBoundingClientRect();
      setPlace({
        right: Math.max(8, window.innerWidth - Math.min(r.right, window.innerWidth) + 16),
        bottom: Math.max(8, window.innerHeight - Math.min(r.bottom, window.innerHeight) + 16),
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(anchor);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [root, active]);

  const overlay =
    shown && place
      ? createPortal(
          <>
            {found && (
              <ResultsPanel
                found={found}
                place={place}
                path={options.path}
                onOpen={(m) => {
                  dropFound();
                  opts.current.onOpen?.(m, found.word);
                }}
                onClose={dropFound}
              />
            )}
            <NavBar
              shown={shown}
              place={place}
              onPrev={() => go(index.current - 1)}
              onNext={() => go(index.current + 1)}
              onDefinition={jump}
              onFind={options.search ? () => void findElsewhere(shown.word, false) : undefined}
              onClose={clear}
            />
          </>,
          document.body
        )
      : null;

  return { ref, overlay, goToDefinition, revealAt };
}

/** Make `view` the one whose marks are in the registry, clearing whichever was. */
function take(view: { clear: () => void }) {
  if (owner && owner !== view) owner.clear();
  owner = view;
}

function NavBar({
  shown,
  place,
  onPrev,
  onNext,
  onDefinition,
  onFind,
  onClose,
}: {
  shown: Shown;
  place: { right: number; bottom: number };
  onPrev: () => void;
  onNext: () => void;
  onDefinition: () => void;
  /** Where the view can search the rest of the code. */
  onFind?: () => void;
  onClose: () => void;
}) {
  const btn =
    "flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground";
  return (
    <div
      style={{ right: place.right, bottom: place.bottom }}
      className="popover-edge fixed z-40 flex max-w-[calc(100vw-16px)] items-center gap-1 rounded-md bg-popover py-0.5 pl-2 pr-0.5 text-xs text-popover-foreground shadow-md"
      // A press here must not move focus or drop a selection the reader is keeping.
      onMouseDown={(e) => e.preventDefault()}
    >
      <span className="min-w-0 truncate font-mono font-medium" title={shown.word}>
        {shown.word}
      </span>
      <span className="shrink-0 tabular-nums text-muted-foreground">
        {shown.note ?? (shown.count ? `${shown.index + 1} of ${shown.count}` : "not in this file")}
      </span>
      <button type="button" className={btn} onClick={onPrev} title="Previous occurrence (Shift+F3)">
        <ChevronUp className="size-3.5" />
      </button>
      <button type="button" className={btn} onClick={onNext} title="Next occurrence (F3)">
        <ChevronDown className="size-3.5" />
      </button>
      <button type="button" className={btn} onClick={onDefinition} title="Go to declaration (Ctrl+click)">
        <LocateFixed className="size-3.5" />
      </button>
      {onFind && (
        <button type="button" className={btn} onClick={onFind} title="Find everywhere it is used">
          <Search className="size-3.5" />
        </button>
      )}
      <button type="button" className={btn} onClick={onClose} title="Clear (Esc)">
        <X className="size-3.5" />
      </button>
    </div>
  );
}

// Focus that has keys of its own to answer: the list leaves Enter, Esc and the arrows to it.
const OWN_KEYS = 'button, a[href], select, [role="button"], [role="dialog"], [role="menu"], [role="listbox"]';

/**
 * What a search across the code found, above the bar: declarations, then uses, each a file and line
 * with the line itself. ↑/↓ and Enter pick one, Esc closes the list and leaves the marks.
 */
function ResultsPanel({
  found,
  place,
  path,
  onOpen,
  onClose,
}: {
  found: Found;
  place: { right: number; bottom: number };
  /** The file the search was made from, whose own lines are labelled as such. */
  path?: string;
  onOpen: (m: RankedMatch) => void;
  onClose: () => void;
}) {
  const [sel, setSel] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { matches } = found;
  const declared = matches.filter((m) => m.score > 0).length;

  useEffect(() => setSel(0), [found]);

  // Ahead of the page's own keys (the capture phase, on the window) — Esc here closes the list and
  // nothing else, and the arrows move through it rather than the pane behind.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      // Something else with focus — a button, a link, a dialog — keeps its own keys.
      const t = e.target as HTMLElement | null;
      if (t && t !== document.body && !panelRef.current?.contains(t) && t.closest?.(OWN_KEYS)) return;
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowDown") setSel((i) => Math.min(i + 1, matches.length - 1));
      else if (e.key === "ArrowUp") setSel((i) => Math.max(i - 1, 0));
      else if (e.key === "Enter" && matches[sel]) onOpen(matches[sel]);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [matches, sel, onOpen, onClose]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-row="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  // Split on the word, kept: the odd parts are the word itself.
  const splitter = new RegExp(`(${wordRe(found.word, "u").source})`, "u");
  const summary = found.loading
    ? "Searching…"
    : found.error
      ? null
      : matches.length === 0
        ? "Found nowhere else"
        : `${declared ? `${declared} declaration${declared === 1 ? "" : "s"}` : "no declaration"} · ${matches.length}${
            found.truncated ? "+" : ""
          } line${matches.length === 1 ? "" : "s"}`;

  return (
    <div
      ref={panelRef}
      style={{ right: place.right, bottom: place.bottom + 34 }}
      className="popover-edge fixed z-40 flex max-h-[min(60vh,480px)] w-[min(640px,calc(100vw-16px))] flex-col overflow-hidden rounded-md bg-popover text-xs text-popover-foreground shadow-lg"
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="flex shrink-0 items-center gap-2 border-b px-2 py-1">
        <span className="min-w-0 truncate font-mono font-medium">{found.word}</span>
        <span className="flex min-w-0 flex-1 items-center gap-1 truncate text-muted-foreground">
          {found.loading && <Loader2 className="size-3 animate-spin" />}
          {summary}
        </span>
        <button
          type="button"
          onClick={onClose}
          title="Close the list (Esc)"
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {found.error && <div className="break-words px-3 py-2 text-muted-foreground">{found.error}</div>}
      <div ref={listRef} className="min-h-0 overflow-y-auto py-0.5">
        {matches.map((m, i) => {
          const slash = m.path.lastIndexOf("/");
          const parts = m.text.trim().split(splitter);
          const heading = i === 0 && m.score > 0 ? "Declarations" : i === declared ? "Uses" : null;
          return (
            <div key={`${m.path}:${m.line}`}>
              {heading && (
                <div className="px-2 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {heading}
                </div>
              )}
              <button
                type="button"
                data-row={i}
                onClick={() => onOpen(m)}
                onMouseMove={() => setSel(i)}
                className={`block w-full px-2 py-1 text-left ${i === sel ? "bg-accent" : ""}`}
              >
                <div className="flex min-w-0 items-baseline gap-1">
                  <span className="shrink-0 font-medium">{m.path.slice(slash + 1)}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">:{m.line}</span>
                  {/* Right-to-left so a long folder is cut at its start, where it says least. */}
                  <span className="min-w-0 truncate text-muted-foreground/70" dir="rtl">
                    <bdi>{slash > 0 ? m.path.slice(0, slash) : ""}</bdi>
                  </span>
                  {m.path === path && <span className="shrink-0 text-muted-foreground">· this file</span>}
                </div>
                <div className="truncate font-mono text-[11px] text-foreground/80">
                  {parts.map((part, k) =>
                    k % 2 === 1 ? (
                      <span key={k} className="rounded-sm bg-yellow-400/40 font-semibold">
                        {part}
                      </span>
                    ) : (
                      <Fragment key={k}>{part}</Fragment>
                    )
                  )}
                </div>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
