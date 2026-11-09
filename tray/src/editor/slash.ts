import { useEffect, useId, useMemo, useState, type RefObject } from "react";
import type { SlashCommand } from "@web/types";
import { insertCommand, rankCommands, slashToken, startsWithQuery } from "@web/lib/slash";

/**
 * Where the commands come from: the chosen session's folder, or the folder a new session is to start in.
 * `key` tells one apart from another, so the list read for one is not offered for the next.
 */
export interface SlashSource {
  key: string;
  load(): Promise<SlashCommand[]>;
}

export interface SlashInput {
  open: boolean;
  /** Read from the server and not answered yet. */
  loading: boolean;
  matches: SlashCommand[];
  active: number;
  listId: string;
  optionId(i: number): string;
  /** Put the suggestion in place of the command being typed, with a space after it. */
  complete(c: SlashCommand): void;
  /** The keys the list answers to: ↑ ↓, Esc, Tab, and Enter when it takes a suggestion. True if taken. */
  onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean;
  /** For the box's onChange and onSelect: where the caret is. */
  track(el: HTMLTextAreaElement): void;
  /** For the box's onFocus and onBlur: the list is the box's only while it has the keyboard. */
  focus(has: boolean): void;
}

/**
 * Slash-command suggestions for the message box, as the Hangar web UI's message boxes have them: the
 * command at the caret, wherever it is in the text. The list is read once something is being typed after
 * a "/", for the source the box is writing to; with nothing to read it from, there are no suggestions.
 */
export function useSlashInput(
  source: SlashSource | null,
  text: string,
  setText: (text: string) => void,
  areaRef: RefObject<HTMLTextAreaElement | null>,
): SlashInput {
  const id = useId();
  const [caret, setCaret] = useState(text.length);
  // The lists read so far, by source: going back to a session doesn't read its list again.
  const [lists, setLists] = useState<Record<string, SlashCommand[]>>({});
  const [active, setActive] = useState(0);
  const [chosen, setChosen] = useState(false);
  // The text the list was closed on (Esc, or a pick): it stays closed until that changes.
  const [closedOn, setClosedOn] = useState<string | null>(null);
  // Not while the folder or the search is being typed in: the box's command stays where it was.
  const [focused, setFocused] = useState(false);
  const token = useMemo(() => slashToken(text, Math.min(caret, text.length)), [text, caret]);
  const query = focused ? (token?.query ?? null) : null;
  const commands = source ? lists[source.key] : undefined;
  const wanted = !!source && query !== null && !commands;

  useEffect(() => {
    if (!wanted || !source) return;
    let stale = false;
    source
      .load()
      // A server too old to list them, or one that didn't answer: no suggestions, and typing goes on.
      .catch(() => [] as SlashCommand[])
      .then((list) => {
        if (!stale) setLists((l) => ({ ...l, [source.key]: list }));
      });
    return () => {
      stale = true;
    };
    // By key: the source is made afresh on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, source?.key]);

  const matches = useMemo(() => (query === null || !commands ? [] : rankCommands(commands, query)), [commands, query]);
  useEffect(() => {
    setActive(0);
    setChosen(false);
  }, [query]);

  const loading = !!source && query !== null && !commands;
  const open = query !== null && text !== closedOn && (matches.length > 0 || loading);
  const current = Math.min(active, Math.max(0, matches.length - 1));
  const pick = open ? matches[current] : undefined;
  // As in the web UI: a whole command typed out is left alone by Enter, and so is a suggestion that only
  // contains what was typed (/new is not /fork), unless it was picked with the arrows.
  const enterCompletes = !!pick && query !== pick.name && (chosen || startsWithQuery(pick, query ?? ""));

  const complete = (c: SlashCommand) => {
    if (!token) return;
    const { text: next, caret: end } = insertCommand(text, token, caret, c);
    setText(next);
    setClosedOn(next);
    setCaret(end);
    requestAnimationFrame(() => {
      const el = areaRef.current;
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = end;
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || e.nativeEvent.isComposing) return false;
    // Alt+↑↓ still picks the session.
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.altKey) {
      e.preventDefault();
      setChosen(true);
      setActive((i) => (matches.length ? (i + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length : 0));
      return true;
    }
    if (e.key === "Escape") {
      // Closes the list, rather than leaving the box as Esc otherwise does.
      e.preventDefault();
      e.stopPropagation();
      setClosedOn(text);
      return true;
    }
    if (pick && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && enterCompletes))) {
      e.preventDefault();
      complete(pick);
      return true;
    }
    return false;
  };

  return {
    open,
    loading,
    matches,
    active: current,
    listId: `${id}-slash`,
    optionId: (i) => `${id}-slash-${i}`,
    complete,
    onKeyDown,
    track: (el) => setCaret(el.selectionEnd),
    focus: setFocused,
  };
}
