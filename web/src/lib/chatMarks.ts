// The chat's marks: bookmarks, notes and to-dos put on the text of a conversation. Persisted server-side
// per conversation (in `.hangar/marks/<conversation>.json` under the session's working directory), so
// they are on every device and outlive a reopen, which carries the conversation on under a new session
// id. Never sent to Claude: they are the user's own notes on what it said.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Api } from "./api";
import { setChatView } from "./chatView";

// Far more than anyone puts on one conversation, but bounded: the file is rewritten whole on each change.
const MAX = 1000;

export interface ChatMark {
  id: string;
  /** The chat item the text is in, by its key: the transcript line's uuid (`uuid:n` for a block of Claude's reply). */
  itemKey: string;
  /** The text as it was selected. Found again with its whitespace ignored, which the page and a selection differ in. */
  quote: string;
  /** Which of the quote's occurrences in the item: a word that comes up twice marks the one it was put on. */
  n: number;
  note?: string;
  /** Set on a to-do. */
  todo?: { done: boolean };
  createdAt: number;
}

export type MarkKind = "bookmark" | "todo" | "note";

/** Where a mark goes: the item and the text in it, found from a selection. */
export type MarkAnchor = Pick<ChatMark, "itemKey" | "quote" | "n">;

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function newMark(anchor: MarkAnchor, kind: MarkKind): ChatMark {
  return { id: newId(), ...anchor, ...(kind === "todo" ? { todo: { done: false } } : {}), createdAt: Date.now() };
}

const bounded = (list: ChatMark[]) => (list.length > MAX ? list.slice(list.length - MAX) : list);

/** The marks in a stored file, the ones that make sense: a hand-edited or older file can't break the chat. */
function parseMarks(raw: unknown): ChatMark[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((m): ChatMark[] => {
    if (!m || typeof m !== "object") return [];
    const { id, itemKey, quote, n, note, todo, createdAt } = m as Record<string, unknown>;
    if (typeof id !== "string" || typeof itemKey !== "string" || typeof quote !== "string" || !quote) return [];
    return [
      {
        id,
        itemKey,
        quote,
        n: typeof n === "number" && n >= 0 ? Math.floor(n) : 0,
        ...(typeof note === "string" && note ? { note } : {}),
        ...(todo && typeof todo === "object" ? { todo: { done: !!(todo as { done?: unknown }).done } } : {}),
        createdAt: typeof createdAt === "number" ? createdAt : 0,
      },
    ];
  });
}

export interface ChatMarks {
  marks: ChatMark[];
  /** The last save didn't reach the node: what is shown is not yet what is kept. */
  unsaved: boolean;
  add: (marks: ChatMark[]) => void;
  update: (id: string, patch: Partial<Pick<ChatMark, "note" | "todo">>) => void;
  remove: (id: string) => void;
  /** Read them again, for what another device changed. */
  refresh: () => void;
}

/**
 * The conversation's marks, and the changes to them. Read when the conversation is, and again when the
 * page comes back into view — another device may have ticked something off meanwhile. Every change is
 * shown at once and saved whole, in order, the latest winning.
 */
export function useChatMarks(api: Api, sessionId: string, conversation: string | null): ChatMarks {
  const [marks, setMarks] = useState<ChatMark[]>([]);
  const [unsaved, setUnsaved] = useState(false);
  const marksRef = useRef(marks);
  marksRef.current = marks;
  // Saves go one after another, so an older one never lands over a newer. A read waits for them: it
  // would otherwise bring back what a save is about to replace.
  const saving = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef(0);
  // Whether the stored list has been read. Until it has, a save would write over what is kept with only
  // what was added here: changes wait, and are made on the stored list once it is read.
  const loaded = useRef(false);
  const queued = useRef<((cur: ChatMark[]) => ChatMark[])[]>([]);
  // Bumped by every change: a read begun before one is older than what is shown, and is let go.
  const generation = useRef(0);
  const unsavedRef = useRef(false);
  const target = useRef({ sessionId, conversation });
  target.current = { sessionId, conversation };

  const show = useCallback((list: ChatMark[]) => {
    marksRef.current = list;
    setMarks(list);
  }, []);
  const flagUnsaved = useCallback((on: boolean) => {
    unsavedRef.current = on;
    setUnsaved(on);
  }, []);

  const put = useCallback(
    (list: ChatMark[]) => {
      if (!conversation) return;
      const at = { sessionId, conversation };
      const body = JSON.stringify(list);
      const current = () => target.current.sessionId === at.sessionId && target.current.conversation === at.conversation;
      pending.current++;
      saving.current = saving.current.then(async () => {
        try {
          await api.putChatMarks(at.sessionId, at.conversation, body);
          if (current()) flagUnsaved(false);
        } catch {
          // Said only of the conversation it was for: one left behind by a /clear isn't this one's.
          if (current()) flagUnsaved(true);
        } finally {
          pending.current--;
        }
      });
    },
    [api, sessionId, conversation, flagUnsaved]
  );

  const refresh = useCallback(() => {
    if (!conversation) return;
    const at = { sessionId, conversation };
    void saving.current.then(async () => {
      if (pending.current) return;
      // A save that didn't get through is tried again, rather than read over.
      if (loaded.current && unsavedRef.current) return put(marksRef.current);
      const since = generation.current;
      try {
        const raw = await api.getChatMarks(at.sessionId, at.conversation);
        const t = target.current;
        if (pending.current || t.sessionId !== at.sessionId || t.conversation !== at.conversation) return;
        if (loaded.current && generation.current !== since) return;
        loaded.current = true;
        let next = parseMarks(raw);
        if (queued.current.length) {
          for (const change of queued.current) next = bounded(change(next));
          queued.current = [];
          show(next);
          put(next);
          return;
        }
        // Only when it changed: a new list every read would redraw the chat.
        if (JSON.stringify(next) !== JSON.stringify(marksRef.current)) show(next);
      } catch {
        /* the node dropped or is too old to keep marks: tried again with the next read */
      }
    });
  }, [api, sessionId, conversation, put, show]);

  useEffect(() => {
    loaded.current = false;
    queued.current = [];
    show([]);
    flagUnsaved(false);
    refresh();
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh, show, flagUnsaved]);

  const save = useCallback(
    (change: (cur: ChatMark[]) => ChatMark[]) => {
      if (!conversation) return;
      generation.current++;
      show(bounded(change(marksRef.current)));
      if (loaded.current) return put(marksRef.current);
      queued.current.push(change);
      refresh();
    },
    [conversation, put, refresh, show]
  );

  const add = useCallback((ms: ChatMark[]) => save((cur) => [...cur, ...ms]), [save]);
  const update = useCallback(
    (id: string, patch: Partial<Pick<ChatMark, "note" | "todo">>) =>
      save((cur) =>
        cur.map((m) => {
          if (m.id !== id) return m;
          const u = { ...m, ...patch };
          if (!u.note) delete u.note;
          if (!u.todo) delete u.todo;
          return u;
        })
      ),
    [save]
  );
  const remove = useCallback((id: string) => save((cur) => cur.filter((m) => m.id !== id)), [save]);

  return { marks, unsaved, add, update, remove, refresh };
}

// ---- Finding marked text in the page ----

// Where text stops being one run: the items' own labels ("Sent while Claude was working") are passed over,
// as find passes over them.
function textNodes(root: Node): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.nodeType === Node.TEXT_NODE
        ? NodeFilter.FILTER_ACCEPT
        : (n as Element).hasAttribute("data-find-skip")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_SKIP,
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

/**
 * An item's text with its whitespace left out, each character with the node and offset it is at. A
 * selection's text and the page's differ in nothing else that matters: a selection puts line breaks
 * between paragraphs that the page has none of, and the page keeps the indentation Markdown leaves.
 */
function flatText(root: Node): { text: string; at: [Text, number][] } {
  let text = "";
  const at: [Text, number][] = [];
  for (const node of textNodes(root)) {
    const data = node.data;
    for (let i = 0; i < data.length; i++) {
      const c = data[i];
      if (/\s/.test(c)) continue;
      text += c;
      at.push([node, i]);
    }
  }
  return { text, at };
}

const squeeze = (s: string) => s.replace(/\s+/g, "");

/** The places `needle` starts in `hay`. */
function occurrences(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/** The drawn element of an item, by its key. */
export function itemElement(content: Element, key: string): Element | null {
  return content.querySelector(`[data-find-key="${CSS.escape(key)}"]`);
}

/** An item's flattened text, kept for a pass over several marks: most of an item's marks are read together. */
export type FlatCache = Map<string, ReturnType<typeof flatText> | null>;

/** Where a mark's text is in its drawn item, or null when the item isn't drawn or no longer has it. */
export function markRange(
  content: Element,
  mark: Pick<ChatMark, "itemKey" | "quote" | "n">,
  cache: FlatCache = new Map()
): Range | null {
  if (!cache.has(mark.itemKey)) {
    const item = itemElement(content, mark.itemKey);
    cache.set(mark.itemKey, item ? flatText(item) : null);
  }
  const flat = cache.get(mark.itemKey);
  if (!flat) return null;
  const { text, at } = flat;
  const needle = squeeze(mark.quote);
  const starts = occurrences(text, needle);
  if (!starts.length) return null;
  // The one it was put on; if the text moved (a reply still being written), the last there is.
  const from = starts[Math.min(mark.n, starts.length - 1)];
  const [sn, so] = at[from];
  const [en, eo] = at[from + needle.length - 1];
  const r = document.createRange();
  r.setStart(sn, so);
  r.setEnd(en, eo + 1);
  return r;
}

/** Which occurrence of `quote` in the item's text is the one that starts where `range` does. */
function occurrenceAt({ text, at }: ReturnType<typeof flatText>, range: Range, quote: string): number {
  // The first character at or after the range's start: the positions are in page order, so halve.
  let lo = 0;
  let hi = at.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const [node, offset] = at[mid];
    if (range.comparePoint(node, offset) < 0) lo = mid + 1;
    else hi = mid;
  }
  return occurrences(text, squeeze(quote)).filter((i) => i < lo).length;
}

/** The item a node is drawn in. */
function itemOf(content: Element, node: Node): Element | null {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const item = el?.closest("[data-find-key]") ?? null;
  return item && content.contains(item) ? item : null;
}

/** A selection cut down to the item it starts in: a mark is on one message, the first it touches. */
function clipToItem(content: Element, range: Range): { item: Element; range: Range } | null {
  const item = itemOf(content, range.startContainer);
  if (!item) return null;
  const r = range.cloneRange();
  if (!item.contains(r.endContainer)) r.setEnd(item, item.childNodes.length);
  return { item, range: r };
}

// How much of a long selection a mark quotes: its start is enough to find it by, and the file is
// rewritten whole on every change.
const QUOTE_MAX = 1000;

/** The text of a range as the marks read it: without the labels the chat adds (see {@link textNodes}). */
function rangeText(item: Element, range: Range): string {
  const text = range.toString();
  const skipped = [...item.querySelectorAll("[data-find-skip]")].some((el) => range.intersectsNode(el));
  if (!skipped) return text;
  return textNodes(item)
    .filter((n) => range.intersectsNode(n))
    .map((n) =>
      n.data.slice(n === range.startContainer ? range.startOffset : 0, n === range.endContainer ? range.endOffset : undefined)
    )
    .join(" ");
}

/** Where a mark on the selected text goes, or null when the selection isn't on an item of the chat. */
export function anchorOf(content: Element, range: Range): MarkAnchor | null {
  const clip = clipToItem(content, range);
  if (!clip) return null;
  const quote = rangeText(clip.item, clip.range).trim().slice(0, QUOTE_MAX).trim();
  if (!squeeze(quote)) return null;
  const n = occurrenceAt(flatText(clip.item), clip.range, quote);
  return { itemKey: clip.item.getAttribute("data-find-key")!, quote, n };
}

// A paragraph that reads as a step: "1. Dry run", "2) …", "Step 3: …", "- …". Claude often writes its
// steps as bold paragraphs rather than a list, to put a code block under each.
const STEP = /^\s*(?:\d+[.):]|step\s+\d+\b|[-•*]\s)/i;
// How much of a long step the to-do quotes: its first sentence, or about a line.
const STEP_QUOTE = 160;

/** What a step's to-do quotes: its bold lead-in if it opens with one, else its first sentence. */
function stepQuote(block: Element): string {
  const text = (block.textContent ?? "").trim();
  const lead = block.firstElementChild;
  if (lead && /^(STRONG|B)$/.test(lead.tagName)) {
    const t = (lead.textContent ?? "").trim();
    if (t.length > 2 && text.startsWith(t)) return t;
  }
  const sentence = text.match(/^[\s\S]*?[.!?:](?=\s|$)/)?.[0] ?? text;
  if (sentence.length <= STEP_QUOTE) return sentence;
  const cut = text.slice(0, STEP_QUOTE);
  return cut.slice(0, cut.lastIndexOf(" ") > STEP_QUOTE / 2 ? cut.lastIndexOf(" ") : cut.length);
}

/**
 * The blocks a selection spans that are steps: the list items it covers (the outermost ones, a sub-list
 * being part of its step), or failing two of those, the paragraphs and headings that open as a step
 * does. Fewer than two is not a list of steps: the selection is one to-do.
 */
function stepBlocks(content: Element, range: Range): { item: Element; blocks: Element[] } | null {
  const clip = clipToItem(content, range);
  if (!clip) return null;
  const { item, range: r } = clip;
  const covered = (el: Element) => r.intersectsNode(el) && squeeze(el.textContent ?? "") !== "";
  const lis = [...item.querySelectorAll("li")].filter(covered);
  let blocks: Element[] = lis.filter((li) => !lis.some((o) => o !== li && o.contains(li)));
  if (blocks.length < 2)
    blocks = [...item.querySelectorAll("p, h1, h2, h3, h4, h5, h6")].filter(
      (el) => covered(el) && !el.closest("li") && STEP.test(el.textContent ?? "")
    );
  return blocks.length < 2 ? null : { item, blocks };
}

/**
 * How many steps a selection spans (see {@link stepBlocks}): 0 when it isn't a list of them. Cheap
 * enough for every change of a selection: nothing is anchored.
 */
export function countSteps(content: Element, range: Range): number {
  return stepBlocks(content, range)?.blocks.length ?? 0;
}

/** The anchor of a to-do for each step a selection spans (see {@link stepBlocks}). */
export function stepsOf(content: Element, range: Range): MarkAnchor[] {
  const steps = stepBlocks(content, range);
  if (!steps) return [];
  const { item, blocks } = steps;
  const key = item.getAttribute("data-find-key")!;
  const flat = flatText(item);
  return blocks.flatMap((block) => {
    const quote = stepQuote(block);
    if (!squeeze(quote)) return [];
    const at = document.createRange();
    at.selectNodeContents(block);
    return [{ itemKey: key, quote, n: occurrenceAt(flat, at, quote) }];
  });
}

// ---- Opening a session's list from elsewhere: the counter on its row ----

const OPEN_EVENT = "hangar:open-chat-marks";
// Sessions whose list was asked for and not yet opened: one not on screen opens it once it is.
const wanted = new Set<string>();

/**
 * Open the list of the session {@link sessionKey} names, in its chat: switched to the chat, and the list
 * opened by it — at once if it is on screen, or as soon as it is.
 */
export function openChatMarks(key: string) {
  wanted.add(key);
  setChatView(key, true);
  window.dispatchEvent(new CustomEvent<string>(OPEN_EVENT, { detail: key }));
}

/** Whether the session's list was asked for; answered yes once. */
export function takeChatMarksRequest(key: string): boolean {
  return wanted.delete(key);
}

/** Hear the asking. Returns the unsubscribe. */
export function onOpenChatMarks(listener: (key: string) => void): () => void {
  const on = (e: Event) => listener((e as CustomEvent<string>).detail);
  window.addEventListener(OPEN_EVENT, on);
  return () => window.removeEventListener(OPEN_EVENT, on);
}
