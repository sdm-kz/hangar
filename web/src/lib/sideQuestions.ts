// Side questions: a /btw is answered in an overlay on Claude's screen, and neither the question nor the
// answer goes into the transcript the chat is drawn from. The chat reads the overlay off the terminal
// underneath it, has Claude copy the answer (its "c to copy", which hands over the Markdown as written),
// and keeps the exchange on the node, per conversation (`.hangar/btw/<conversation>.json`), so it is shown
// in the conversation on every device and after a reload.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Api } from "./api";

export interface SideQuestion {
  id: string;
  /** As the overlay showed it; null when it couldn't be read off the screen. */
  question: string | null;
  /** Claude's answer, as Markdown. */
  answer: string;
  /** The chat item it was asked after, by its key; null when it came before anything. */
  after: string | null;
  createdAt: number;
}

/** The /btw overlay as the screen shows it. */
export interface SideOverlay {
  question: string | null;
  /** The answer is all there, and can be copied; until then Claude is still answering. */
  answered: boolean;
}

// The overlay's last line, its keys: "↑/↓ to scroll · c to copy · f to fork · Esc to close" once answered,
// without the copy while answering, with "⇧↑/↓ to browse" when there are earlier questions to go back to.
const FOOTER = /(?:^|·)\s*Esc to close\s*$/;
// The rule the overlay opens under, across the screen.
const RULE = /^\s*[─━]{8}/;
// A question in it: the earlier ones dimmed above, the one being answered last.
const QUESTION = /^\s*\/btw\s+(.*)$/;

/** The /btw overlay, if it is what the screen's lines (top to bottom, as plain text) show, or null. */
export function readSideOverlay(lines: string[]): SideOverlay | null {
  let foot = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (FOOTER.test(lines[i])) {
      foot = i;
      break;
    }
  }
  if (foot < 0) return null;
  let start = 0;
  for (let i = foot - 1; i >= 0; i--) {
    if (RULE.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  let at = -1;
  for (let i = start; i < foot; i++) if (QUESTION.test(lines[i])) at = i;
  // Another dialog that closes with Esc: no question in it.
  if (at < 0) return null;
  // A long question wraps onto the lines under it, up to the blank line before the answer.
  const parts = [lines[at].match(QUESTION)![1].trim()];
  for (let i = at + 1; i < foot && lines[i].trim() && !QUESTION.test(lines[i]); i++) parts.push(lines[i].trim());
  const question = parts.join(" ").trim();
  return { question: question || null, answered: /\bc to copy\b/.test(lines[foot]) };
}

function parse(raw: unknown): SideQuestion[] {
  if (!Array.isArray(raw)) return [];
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return raw.flatMap((e): SideQuestion[] => {
    if (!e || typeof e !== "object") return [];
    const o = e as Record<string, unknown>;
    const id = str(o.id);
    const answer = str(o.answer);
    if (!id || !answer) return [];
    return [
      {
        id,
        answer,
        question: str(o.question),
        after: str(o.after),
        createdAt: typeof o.createdAt === "number" ? o.createdAt : 0,
      },
    ];
  });
}

export interface SideQuestions {
  list: SideQuestion[];
  /** Read the kept list again: another device may have added to it. */
  refresh: () => void;
  /** Keep one; resolves with it as kept (an exchange already there is not added twice), or null. */
  add: (q: Omit<SideQuestion, "id" | "createdAt">) => Promise<SideQuestion | null>;
}

/** The conversation's side questions, kept on the node. */
export function useSideQuestions(api: Api, sessionId: string, conversation: string | null): SideQuestions {
  const [list, setList] = useState<SideQuestion[]>([]);
  const target = useRef({ sessionId, conversation });
  target.current = { sessionId, conversation };

  const show = useCallback(
    (at: { sessionId: string; conversation: string }, raw: unknown) => {
      const t = target.current;
      if (t.sessionId !== at.sessionId || t.conversation !== at.conversation) return null;
      const next = parse(raw);
      // Only when it changed: a new list every read would redraw the chat.
      setList((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
      return next;
    },
    []
  );

  const refresh = useCallback(() => {
    if (!conversation) return;
    const at = { sessionId, conversation };
    api.getSideQuestions(sessionId, conversation).then(
      (raw) => show(at, raw),
      () => {
        /* the node dropped or is too old to keep them: tried again with the next read */
      }
    );
  }, [api, sessionId, conversation, show]);

  useEffect(() => {
    setList([]);
    refresh();
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  const add = useCallback(
    async (q: Omit<SideQuestion, "id" | "createdAt">) => {
      if (!conversation) return null;
      const at = { sessionId, conversation };
      try {
        const kept = show(at, await api.addSideQuestion(sessionId, conversation, q)) ?? [];
        return kept.find((k) => k.question === q.question && k.answer === q.answer) ?? null;
      } catch {
        return null;
      }
    },
    [api, sessionId, conversation, show]
  );

  return { list, refresh, add };
}
