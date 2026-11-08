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
      const draft = { text: v.text, images: Array.isArray(v.images) ? v.images : [] };
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
  const empty = !draft.text && draft.images.length === 0;
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
