// What is written in a session's chat box and not sent yet. The chat view is made anew for each session
// it shows, so without this a draft went with the switch to another session; the terminal keeps its own
// half-typed input, and the chat keeps one too.
//
// Kept per session (and node) in localStorage as well as in memory, so it also survives a reload. It
// never leaves the browser.
import type { PostponedImage } from "./postponed";

export interface ChatDraft {
  text: string;
  images: PostponedImage[];
  /** A piece of the conversation the message replies to, shown over the box and sent ahead of the text. */
  quote?: string;
}

const PREFIX = "hangar.chatDraft:";
const EMPTY: ChatDraft = { text: "", images: [] };
const drafts = new Map<string, ChatDraft>();
const listeners = new Map<string, Set<(d: ChatDraft) => void>>();

/** The draft left in a session's chat box, keyed by {@link sessionKey}. */
export function loadChatDraft(key: string): ChatDraft {
  const known = drafts.get(key);
  if (known) return known;
  try {
    const raw = localStorage.getItem(PREFIX + key);
    const v = raw ? (JSON.parse(raw) as Partial<ChatDraft>) : null;
    if (v && typeof v.text === "string") {
      const draft: ChatDraft = { text: v.text, images: Array.isArray(v.images) ? v.images : [] };
      if (typeof v.quote === "string" && v.quote) draft.quote = v.quote;
      drafts.set(key, draft);
      return draft;
    }
  } catch {
    /* storage disabled or the entry unreadable — start empty */
  }
  return EMPTY;
}

/**
 * Keep what is in a session's chat box; an empty box forgets it. The box is told, so a draft taken from it
 * elsewhere (the full-size composer, which sends or postpones it) leaves it empty.
 */
export function saveChatDraft(key: string, draft: ChatDraft = EMPTY) {
  const empty = !draft.text && draft.images.length === 0 && !draft.quote;
  if (empty) drafts.delete(key);
  else drafts.set(key, draft);
  try {
    if (empty) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(draft));
  } catch {
    /* storage disabled or full — the draft still lasts while this tab is open */
  }
  for (const l of listeners.get(key) ?? []) l(draft);
}

/** Hear of every change to a session's draft. Returns the unsubscribe. */
export function onChatDraft(key: string, listener: (d: ChatDraft) => void): () => void {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(key);
  };
}

/**
 * The message a reply makes: the quoted piece as a Markdown quote, then what was written under it, as a
 * messenger's reply reads. No quote, and it is the text as it is.
 */
export function withQuote(quote: string | undefined, text: string): string {
  const lines = quote?.replace(/\r\n?/g, "\n").trim();
  if (!lines) return text;
  const block = lines
    .split("\n")
    .map((l) => (l.trim() ? `> ${l.trimEnd()}` : ">"))
    .join("\n");
  return text ? `${block}\n\n${text}` : block;
}

/**
 * A message that starts with a Markdown quote, as {@link withQuote} makes a reply, taken apart again: the
 * quoted piece without its markers, and what was written under it. Null for any other message.
 */
export function splitQuote(text: string): { quote: string; rest: string } | null {
  const m = text.match(/^((?:>[^\n]*(?:\n|$))+)/);
  if (!m) return null;
  const quote = m[1]
    .split("\n")
    .map((l) => l.replace(/^> ?/, ""))
    .join("\n")
    .trim();
  return quote ? { quote, rest: text.slice(m[1].length).replace(/^\s*\n/, "").trimEnd() } : null;
}
