import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { prettyInput, toolSummary, type ChatItem } from "@/lib/chat";
import { escapeRegExp, reveal } from "@/lib/codeNav";
import { chord } from "@/lib/shortcuts";

// Past this many matches the rest aren't marked or counted, the earliest first to go: a letter or two
// would otherwise put a range on most of the page, each one kept up to date as the chat changes.
const MAX_MATCHES = 5000;

// Painted with the Custom Highlight API (see index.css), as the code views' marks are: the chat's own
// nodes are never touched, so React's rendering of them is left alone.
const ALL = "chat-find";
const CURRENT = "chat-find-current";

const registry = (): HighlightRegistry | null =>
  typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights : null;

// The chat whose marks are in the registry. Two chats on screen share the two names, so the one that
// searches last takes them, and the other's bar closes.
let owner: (() => void) | null = null;

/** One place the text was found: the n-th time in an item. Its range only once the item is drawn. */
interface Match {
  item: number;
  key: string;
  n: number;
  range: Range | null;
}

// Where text runs on into the next node and where it stops: a match doesn't span two paragraphs, or a
// tool's input and its output.
const BLOCKS = new Set([
  "P", "DIV", "PRE", "LI", "UL", "OL", "TABLE", "TR", "TD", "TH", "BLOCKQUOTE", "SUMMARY", "DETAILS",
  "H1", "H2", "H3", "H4", "H5", "H6", "HR", "BR", "SECTION",
]);

function blockOf(node: Node, root: Element): Element {
  let el = node.parentElement;
  while (el && el !== root && !BLOCKS.has(el.tagName)) el = el.parentElement;
  return el ?? root;
}

/** The matches of `re` in the text under `root`, up to `limit`, as ranges over its text nodes. */
function textRanges(root: Element, re: RegExp, limit: number): Range[] {
  const out: Range[] = [];
  // Labels the chat adds of its own ("Sent while Claude was working") are marked to be passed over.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.nodeType === Node.TEXT_NODE
        ? NodeFilter.FILTER_ACCEPT
        : (n as Element).hasAttribute("data-find-skip")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_SKIP,
  });
  let nodes: Text[] = [];
  let starts: number[] = [];
  let text = "";
  let block: Element | null = null;
  // The node an offset into the block's text falls in: for an end, the one it closes.
  const at = (offset: number, end: boolean): [Text, number] => {
    let i = nodes.length - 1;
    while (i > 0 && (end ? starts[i] >= offset : starts[i] > offset)) i--;
    return [nodes[i], offset - starts[i]];
  };
  const flush = () => {
    if (text)
      for (const m of text.matchAll(re)) {
        if (!m[0] || out.length >= limit) continue;
        const from = m.index ?? 0;
        const [sn, so] = at(from, false);
        const [en, eo] = at(from + m[0].length, true);
        const r = document.createRange();
        r.setStart(sn, so);
        r.setEnd(en, eo);
        out.push(r);
      }
    nodes = [];
    starts = [];
    text = "";
  };
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    const b = blockOf(t, root);
    if (b !== block) {
      flush();
      block = b;
    }
    starts.push(text.length);
    nodes.push(t);
    text += t.data;
  }
  flush();
  return out;
}

/** An item's text as last laid out, and what it was laid out from. */
interface ItemText {
  input: string | null;
  source: string | undefined;
  text: string;
}

// The text an item not drawn yet would show, near enough to count its matches by. Kept by the item's
// key — every read of the transcript makes the items anew, from the same strings — since a tool's input
// is parsed to lay it out, and a long session has thousands.
function itemText(item: ChatItem, cache: Map<string, ItemText>): string {
  const input = item.kind === "tool" ? item.input : null;
  const source = item.kind === "tool" ? item.result?.text : item.text;
  const hit = cache.get(item.key);
  if (hit && hit.input === input && hit.source === source) return hit.text;
  const text =
    item.kind === "tool"
      ? [item.name, toolSummary(item.input), prettyInput(item.input), item.result?.text ?? ""].join("\n")
      : item.text;
  cache.set(item.key, { input, source, text });
  return text;
}

/** The folded cards and thinking blocks a range is out of sight in: its summary line shows, the rest doesn't. */
export function foldsAround(range: Range): HTMLDetailsElement[] {
  const folds: HTMLDetailsElement[] = [];
  const start = range.startContainer;
  for (let el = start.parentElement; el; el = el.parentElement) {
    if (!(el instanceof HTMLDetailsElement) || el.open) continue;
    const summary = el.querySelector(":scope > summary");
    if (!summary?.contains(start)) folds.push(el);
  }
  return folds;
}

/** Where a range is on screen; one in a closed fold is where the fold is. */
function rectOf(range: Range): DOMRect {
  const folds = foldsAround(range);
  return folds.length ? folds[folds.length - 1].getBoundingClientRect() : range.getBoundingClientRect();
}

function lastIndex<T>(list: T[], pred: (t: T) => unknown): number {
  for (let i = list.length - 1; i >= 0; i--) if (pred(list[i])) return i;
  return -1;
}

export interface ChatFind {
  open: boolean;
  /** Open the bar, or take the keyboard back to it: with what is selected in the chat, if anything. */
  start: () => void;
  close: () => void;
  /** The bar itself, for the chat's corner. */
  bar: ReactNode;
}

/**
 * Find in the chat: Ctrl/⌘+F while it has focus. The transcript's items are what is searched, not only
 * the ones drawn — the chat draws the latest and "show earlier" adds more — so a match further back is
 * counted, and going to it draws it. One in a folded tool card or thinking block opens the fold.
 */
export function useChatFind({
  items,
  extraKeys,
  shownFrom,
  contentRef,
  scrollRef,
  revealItem,
  onScrolled,
}: {
  items: ChatItem[];
  /** Keys of what is drawn after the items (the queued messages), searched in the page only. */
  extraKeys: string[];
  /** The first item drawn: the ones before it are searched in the transcript. */
  shownFrom: number;
  /** What holds the drawn items, each in an element with its key as data-find-key. */
  contentRef: RefObject<HTMLElement | null>;
  scrollRef: RefObject<HTMLElement | null>;
  /** Draw the items from this one on. */
  revealItem: (index: number) => void;
  /** The chat was scrolled to a match: it is no longer at the latest, whatever the scroll event says later. */
  onScrolled: () => void;
}): ChatFind {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState({ index: 0, count: 0, more: false });
  const inputRef = useRef<HTMLInputElement>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const queryRef = useRef(query);
  queryRef.current = query;
  const opts = useRef({ items, extraKeys, shownFrom, revealItem, onScrolled });
  opts.current = { items, extraKeys, shownFrom, revealItem, onScrolled };

  const matches = useRef<Match[]>([]);
  const current = useRef(-1);
  // A match in an item that wasn't drawn: gone to once it is. `dir` is the way the step went.
  const pending = useRef<{ key: string; item: number; n: number; dir: number } | null>(null);
  const texts = useRef(new Map<string, ItemText>());
  // Matches past MAX_MATCHES were left out.
  const more = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  // Folds opened to show a match. Moving on closes them again, so typing doesn't leave a trail of cards
  // open behind it; the one the search ends on stays open.
  const opened = useRef(new Set<HTMLDetailsElement>());
  const self = useRef<() => void>(() => {});

  const show = useCallback((index: number, count: number) => {
    // Only when it changed: every redraw of the bar is one of the whole chat.
    const m = more.current;
    setPos((p) => (p.index === index && p.count === count && p.more === m ? p : { index, count, more: m }));
  }, []);

  const unpaint = useCallback(() => {
    if (owner !== self.current) return;
    owner = null;
    registry()?.delete(ALL);
    registry()?.delete(CURRENT);
  }, []);

  const paint = useCallback(() => {
    const reg = registry();
    if (!reg) return;
    if (owner !== self.current) {
      owner?.();
      owner = self.current;
    }
    const cur = matches.current[current.current];
    // Added one by one: thousands spread into the constructor's arguments can overflow the stack.
    const all = new Highlight();
    for (const m of matches.current) if (m.range && m !== cur) all.add(m.range);
    reg.set(ALL, all);
    if (cur?.range) reg.set(CURRENT, new Highlight(cur.range));
    else reg.delete(CURRENT);
  }, []);

  const go = useCallback(
    (i: number, dir = 1) => {
      const list = matches.current;
      if (!list.length) return;
      const at = ((i % list.length) + list.length) % list.length;
      const m = list[at];
      current.current = at;
      show(at, list.length);
      if (!m.range) {
        // Further back than the chat has drawn: draw it, and the search that follows goes on to it.
        pending.current = { key: m.key, item: m.item, n: m.n, dir };
        opts.current.revealItem(m.item);
        return;
      }
      for (const fold of opened.current)
        if (!fold.contains(m.range.startContainer)) {
          fold.open = false;
          opened.current.delete(fold);
        }
      for (const fold of foldsAround(m.range)) {
        fold.open = true;
        opened.current.add(fold);
      }
      paint();
      reveal(m.range);
      opts.current.onScrolled();
    },
    [paint, show]
  );

  /**
   * Find the text again. "query": it changed (or the bar opened) — go to the match nearest where the
   * last one was, or the first in view. "keep": what is drawn changed — the same match stays current.
   */
  const collect = useCallback(
    (mode: "query" | "keep") => {
      const content = contentRef.current;
      const q = queryRef.current;
      const prev = matches.current[current.current];
      if (!openRef.current || !q || !content) {
        matches.current = [];
        current.current = -1;
        pending.current = null;
        unpaint();
        show(0, 0);
        return;
      }
      const { items, extraKeys, shownFrom } = opts.current;
      const re = new RegExp(escapeRegExp(q), "giu");
      const drawn = new Map<string, Element>();
      for (const el of content.querySelectorAll("[data-find-key]")) drawn.set(el.getAttribute("data-find-key")!, el);
      // From the latest back, so a search with too many matches keeps the ones nearest the end.
      const found: Match[][] = [];
      let total = 0;
      const add = (key: string, item: number, text: string | null) => {
        const left = MAX_MATCHES + 1 - total;
        const el = drawn.get(key);
        const ms: Match[] = el
          ? textRanges(el, re, left).map((range, n) => ({ item, key, n, range }))
          : text !== null
            ? Array.from({ length: Math.min(text.match(re)?.length ?? 0, left) }, (_, n) => ({ item, key, n, range: null }))
            : [];
        if (ms.length) found.push(ms);
        total += ms.length;
      };
      for (let j = extraKeys.length - 1; j >= 0 && total <= MAX_MATCHES; j--) add(extraKeys[j], items.length + j, null);
      for (let i = items.length - 1; i >= 0 && total <= MAX_MATCHES; i--)
        add(items[i].key, i, i < shownFrom ? itemText(items[i], texts.current) : null);
      const list = found.reverse().flat();
      more.current = list.length > MAX_MATCHES;
      if (more.current) list.splice(0, list.length - MAX_MATCHES);
      matches.current = list;

      if (!list.length) {
        current.current = -1;
        pending.current = null;
        unpaint();
        show(0, 0);
        return;
      }
      const after = (item: number) => list.findIndex((m) => m.item >= item);
      const p = pending.current;
      pending.current = null;
      let at: number;
      if (p) {
        // The item counted in the transcript is drawn now: its n-th match. The transcript's text isn't
        // quite the page's — a link's address, Markdown's own marks — so it may have none, and then the
        // nearest drawn one the way the step went. Never another draw for it: that one could miss too.
        const same = list.filter((m) => m.key === p.key && m.range);
        if (same.length) at = list.indexOf(same[Math.min(p.n, same.length - 1)]);
        else {
          const fwd = list.findIndex((m) => m.range && m.item > p.item);
          const back = lastIndex(list, (m) => m.range && m.item < p.item);
          at = p.dir < 0 ? (back >= 0 ? back : fwd) : fwd >= 0 ? fwd : back;
        }
        if (at < 0) {
          // Nothing drawn matches: the count stays, on the nearest match further back.
          current.current = Math.max(0, lastIndex(list, (m) => m.item < p.item));
          show(current.current, list.length);
          paint();
        } else go(at);
        return;
      } else if (mode === "keep" && prev) {
        at = list.findIndex((m) => m.key === prev.key && m.n === prev.n);
        if (at < 0) at = after(prev.item);
      } else if (prev) {
        at = after(prev.item);
      } else {
        const top = scrollRef.current?.getBoundingClientRect().top ?? 0;
        at = list.findIndex((m) => m.range && rectOf(m.range).bottom > top);
      }
      // Nothing from there on: the last one, the nearest going back.
      if (at < 0) at = list.length - 1;
      if (mode === "keep") {
        current.current = at;
        show(at, list.length);
        paint();
      } else go(at);
    },
    [contentRef, scrollRef, go, paint, show, unpaint]
  );

  const shut = useCallback(() => {
    setOpen(false);
    openRef.current = false;
    matches.current = [];
    current.current = -1;
    pending.current = null;
    opened.current.clear();
    unpaint();
  }, [unpaint]);
  // Another chat taking the marks closes this one's bar, and leaves the keyboard where it is.
  self.current = shut;

  const close = useCallback(() => {
    shut();
    const back = returnFocus.current;
    returnFocus.current = null;
    if (back?.isConnected && back.matches("textarea, input, [tabindex]")) back.focus();
    else scrollRef.current?.focus();
  }, [shut, scrollRef]);

  const start = useCallback(() => {
    const sel = window.getSelection();
    const picked =
      sel && !sel.isCollapsed && contentRef.current?.contains(sel.anchorNode) ? sel.toString().trim() : "";
    if (!openRef.current) {
      const active = document.activeElement;
      returnFocus.current = active instanceof HTMLElement ? active : null;
    }
    if (picked && !picked.includes("\n") && picked.length <= 200) setQuery(picked);
    setOpen(true);
    // Open already: the box is there to take the keyboard back. Otherwise the effect below does, once it is.
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [contentRef]);
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open]);

  // The text or the bar changed: find again, and go to it.
  useLayoutEffect(() => collect("query"), [open, query, collect]);
  // What is drawn changed — Claude wrote more, earlier items were drawn: find again, in the same place.
  useLayoutEffect(() => {
    if (openRef.current) collect("keep");
  }, [items, extraKeys, shownFrom, collect]);
  // And what changes in the page on its own: a reply growing, Markdown settling after it is drawn.
  useEffect(() => {
    const content = contentRef.current;
    if (!open || !content) return;
    let raf = 0;
    const mo = new MutationObserver(() => {
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          collect("keep");
        });
    });
    mo.observe(content, { childList: true, subtree: true, characterData: true });
    return () => {
      mo.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [open, collect, contentRef]);
  useEffect(() => unpaint, [unpaint]);

  const step = (delta: number) => go(current.current + delta, delta);
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      step(e.key === "ArrowUp" || (e.key === "Enter" && e.shiftKey) ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  // A press on a button keeps the keyboard in the box, so Enter goes on from where the button went.
  const keep = (e: React.MouseEvent) => e.preventDefault();

  const bar = open ? (
    <div
      data-chat-find
      className="flex max-w-full items-center gap-0.5 rounded-md border bg-background/90 p-0.5 pl-2 shadow-sm backdrop-blur"
    >
      <Search className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Find in the chat"
        aria-label="Find in the chat"
        spellCheck={false}
        className="h-7 w-36 min-w-0 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
      />
      <span className="shrink-0 px-1 text-xs tabular-nums text-muted-foreground" aria-live="polite">
        {query ? (pos.count ? `${pos.index + 1} of ${pos.count}${pos.more ? "+" : ""}` : "No matches") : ""}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        title={`Previous match (${chord("shift", "Enter")})`}
        disabled={!pos.count}
        onMouseDown={keep}
        onClick={() => step(-1)}
      >
        <ChevronUp className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        title="Next match (Enter)"
        disabled={!pos.count}
        onMouseDown={keep}
        onClick={() => step(1)}
      >
        <ChevronDown className="size-4" />
      </Button>
      <Button variant="ghost" size="icon" className="size-7" title="Close (Esc)" onClick={close}>
        <X className="size-4" />
      </Button>
    </div>
  ) : null;

  return { open, start, close, bar };
}
