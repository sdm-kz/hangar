import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { Loader2, TerminalSquare } from "lucide-react";
import type { SlashCommand } from "@/types";
import { useApi } from "@/lib/node";
import { cn } from "@/lib/utils";
import { Textarea } from "@/components/ui/textarea";

// Most slash commands the suggestions list at once; the rest are a few more letters away.
const MAX_SUGGESTIONS = 50;
// How long the command list is trusted before it is read again (a skill added in the meantime).
const COMMANDS_TTL_MS = 30_000;

/** The slash command being typed at the caret: where its "/" is, and what follows it so far. */
interface SlashToken {
  start: number;
  query: string;
}

/**
 * The command at the caret: a "/" at the start of the text or after a space, then the start of a name,
 * with the caret at the end of the word. Anywhere in the text, so a command can be asked for mid-sentence
 * ("then run /review"). A path (/usr/bin, C:/x) has another slash in it, or no space before it.
 */
function slashToken(text: string, caret: number): SlashToken | null {
  if (caret < text.length && !/\s/.test(text[caret])) return null;
  const m = text.slice(0, caret).match(/(^|\s)\/([^\s/]*)$/);
  return m ? { start: caret - m[2].length - 1, query: m[2] } : null;
}

/** Something that could be a command: a "/" at the start or after a space, and a name. */
const SLASH_WORD = /(^|\s)\/[^\s/]/;

/** Where a known command stands in the text, whole: "/review" in "then /review it", not "/rev" or "/usr/bin". */
export interface SlashRange {
  start: number;
  end: number;
}

function commandRanges(text: string, commands: SlashCommand[]): SlashRange[] {
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

export interface SlashInput {
  commands: SlashCommand[] | null;
  matches: SlashCommand[];
  /** The known commands in the text, to be marked in the box (see {@link SlashTextarea}). */
  highlights: SlashRange[];
  open: boolean;
  active: number;
  /** Enter takes the highlighted suggestion rather than doing what Enter does in the box. */
  enterCompletes: boolean;
  listId: string;
  optionId: (i: number) => string;
  /** Put the suggestion in place of the command being typed, with a space after it. */
  complete: (c: SlashCommand) => void;
  /** The keys the list answers to: arrows, Esc, Tab, and Enter when it takes a suggestion. True if taken. */
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** For the box's onChange and onSelect: where the caret is. */
  track: (el: HTMLTextAreaElement) => void;
  /** Close the list until the text changes (an Esc that something else would take). */
  dismiss: () => void;
  /** Props for the box: the combobox it is to a screen reader, and the caret tracking. */
  inputProps: {
    role: "combobox";
    "aria-expanded": boolean;
    "aria-controls": string | undefined;
    "aria-activedescendant": string | undefined;
    onSelect: (e: React.SyntheticEvent<HTMLTextAreaElement>) => void;
  };
}

/**
 * Slash-command suggestions for a text box: the command at the caret, wherever it is in the text. The list
 * is read from the session's node the first time it is wanted, and again once it is old.
 */
export function useSlashInput(
  sessionId: string,
  text: string,
  setText: (text: string) => void,
  areaRef: RefObject<HTMLTextAreaElement | null>
): SlashInput {
  const api = useApi();
  const id = useId();
  const [commands, setCommands] = useState<SlashCommand[] | null>(null);
  const [caret, setCaret] = useState(text.length);
  const [active, setActive] = useState(0);
  // The text the list was closed on (Esc, or a pick): it stays closed until that changes.
  const [closedOn, setClosedOn] = useState<string | null>(null);
  const fetchedAt = useRef(0);
  const token = useMemo(() => slashToken(text, Math.min(caret, text.length)), [text, caret]);
  const query = token?.query ?? null;
  // The list is wanted for the suggestions, and for marking the commands already in the text — a draft
  // brought back, a message opened for editing — which nothing typed asked for.
  const wanted = query !== null || SLASH_WORD.test(text);

  useEffect(() => {
    if (!wanted || Date.now() - fetchedAt.current < COMMANDS_TTL_MS) return;
    fetchedAt.current = Date.now();
    let stale = false;
    let settled = false;
    api
      .getSessionCommands(sessionId)
      .then((list) => {
        if (!stale) setCommands(list);
      })
      .catch(() => {
        // A node too old to have the list, or one that dropped: no suggestions, and typing goes on.
        if (!stale) setCommands((cur) => cur ?? []);
      })
      .finally(() => {
        settled = true;
      });
    return () => {
      stale = true;
      // Dropped before it answered (the slash typed past, or deleted): the next "/" asks again rather
      // than waiting out the TTL on a list that never arrived.
      if (!settled) fetchedAt.current = 0;
    };
  }, [wanted, api, sessionId]);

  const matches = useMemo(() => (query === null || !commands ? [] : rankCommands(commands, query)), [commands, query]);
  // Whether the highlight was moved by hand since the query last changed.
  const [chosen, setChosen] = useState(false);
  useEffect(() => {
    setActive(0);
    setChosen(false);
  }, [query]);

  const highlights = useMemo(() => (commands ? commandRanges(text, commands) : []), [text, commands]);

  const open = query !== null && text !== closedOn && (matches.length > 0 || !commands);
  const current = Math.min(active, Math.max(0, matches.length - 1));
  const pick = open ? matches[current] : undefined;
  // A suggestion that only contains what was typed, or mentions it in its description, is not what was
  // meant by a whole command typed out — /new is not /fork — so Enter takes it only when it starts with
  // what was typed, or was picked with the arrows.
  const enterCompletes = !!pick && query !== pick.name && (chosen || startsWithQuery(pick, query ?? ""));
  const listId = `${id}-slash`;
  const optionId = (i: number) => `${id}-slash-${i}`;

  const complete = (c: SlashCommand) => {
    if (!token) return;
    const at = Math.min(caret, text.length);
    // One space after the command: the one already there, or a new one.
    const rest = text.slice(at);
    const inserted = `/${c.name} `;
    const next = text.slice(0, token.start) + inserted + rest.replace(/^ /, "");
    const end = token.start + inserted.length;
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
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setChosen(true);
      setActive((i) => (matches.length ? (i + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length : 0));
      return true;
    }
    if (e.key === "Escape") {
      // Closes the list, not whatever the box sits in (a drop-up, a dialog).
      e.preventDefault();
      e.stopPropagation();
      setClosedOn(text);
      return true;
    }
    // Tab takes the suggestion; so does Enter, unless what is typed is already that command — then
    // Enter does what it does in the box, as it would in the terminal.
    if (pick && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && enterCompletes))) {
      e.preventDefault();
      complete(pick);
      return true;
    }
    return false;
  };

  const track = (el: HTMLTextAreaElement) => setCaret(el.selectionEnd);

  return {
    commands,
    matches,
    highlights,
    open,
    active: current,
    enterCompletes,
    listId,
    optionId,
    complete,
    onKeyDown,
    track,
    dismiss: () => setClosedOn(text),
    inputProps: {
      role: "combobox",
      "aria-expanded": open,
      "aria-controls": open ? listId : undefined,
      "aria-activedescendant": open && matches.length ? optionId(current) : undefined,
      onSelect: (e) => track(e.currentTarget),
    },
  };
}

/** The command's name, or a plugin command's own part, starts with what was typed. */
function startsWithQuery(c: SlashCommand, query: string): boolean {
  const name = c.name.toLowerCase();
  const q = query.toLowerCase();
  return name.startsWith(q) || name.slice(name.indexOf(":") + 1).startsWith(q);
}

/**
 * Commands that match what follows the slash, best first: the name starts with it, then a plugin
 * command's own part does (design:critique for "crit"), then the name contains it, then the description.
 */
function rankCommands(commands: SlashCommand[], query: string): SlashCommand[] {
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

// Where a command comes from, where that is worth saying: a plugin's is in its name, Claude's goes unsaid.
const SOURCE_LABEL: Record<SlashCommand["source"], string | null> = {
  builtin: null,
  project: "project",
  user: "user",
  plugin: null,
};

/** The suggestions, over the box: placed against the nearest positioned ancestor, which spans the box. */
export function SlashSuggestions({ slash, className }: { slash: SlashInput; className?: string }) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${slash.active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [slash.active, slash.matches]);
  if (!slash.open) return null;
  return (
    <div
      ref={listRef}
      id={slash.listId}
      role="listbox"
      className={cn(
        "absolute inset-x-0 bottom-full z-30 mb-2 max-h-72 overflow-y-auto overflow-x-hidden rounded-lg border bg-background p-1 shadow-lg",
        className
      )}
    >
      {slash.matches.length === 0 ? (
        <p className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Reading the commands…
        </p>
      ) : (
        slash.matches.map((c, i) => (
          <div
            key={c.name}
            id={slash.optionId(i)}
            data-index={i}
            role="option"
            aria-selected={i === slash.active}
            // mousedown, not click: taking the pick must not take the focus out of the box first.
            onMouseDown={(e) => {
              e.preventDefault();
              slash.complete(c);
            }}
            className={cn(
              "flex cursor-pointer items-baseline gap-2 rounded-md px-2 py-1 text-sm",
              i === slash.active ? "bg-accent text-accent-foreground" : "hover:bg-muted"
            )}
          >
            <span className="shrink-0 font-mono">/{c.name}</span>
            {c.hint && (
              <span className="hidden max-w-[40%] shrink-0 truncate font-mono text-xs text-muted-foreground sm:block">{c.hint}</span>
            )}
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{c.description}</span>
            {c.dialog && (
              <span title="Answers in the terminal" className="shrink-0 self-center text-muted-foreground">
                <TerminalSquare className="size-3.5" />
              </span>
            )}
            {SOURCE_LABEL[c.source] && (
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                {SOURCE_LABEL[c.source]}
              </span>
            )}
          </div>
        ))
      )}
    </div>
  );
}

// A zero-width space: something after a trailing newline in the layer (see SlashTextarea).
const ZERO_WIDTH = String.fromCharCode(0x200b);

// What the marks' layer copies from the box, so its text wraps line for line with the box's own.
const MIRRORED = [
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-indent",
  "text-transform",
  "tab-size",
  "padding-top",
  "padding-bottom",
  "padding-left",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
] as const;

/**
 * A text box that marks the slash commands in it: a layer under the (see-through) box draws the same text,
 * invisible, with a tint behind each known command. The box itself is untouched — the caret, the
 * selection and what is typed are all still the textarea's own.
 */
export function SlashTextarea({
  slash,
  wrapperClassName,
  ref,
  className,
  onScroll,
  ...props
}: React.ComponentProps<"textarea"> & { slash: SlashInput; wrapperClassName?: string }) {
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const text = typeof props.value === "string" ? props.value : "";
  const marks = slash.highlights;
  const shown = marks.length > 0;

  // Stable, so the caller's ref is not let go of and handed the box again on every render.
  const setRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      areaRef.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [ref]
  );

  // Lay the layer out as the box is: its padding, its borders, its font, and the width a scrollbar takes.
  const sync = useCallback(() => {
    const area = areaRef.current;
    const layer = layerRef.current;
    if (!area || !layer) return;
    const cs = getComputedStyle(area);
    for (const p of MIRRORED) layer.style.setProperty(p, cs.getPropertyValue(p));
    const borders = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
    const bar = Math.max(0, area.offsetWidth - area.clientWidth - borders);
    layer.style.paddingRight = `${parseFloat(cs.paddingRight) + bar}px`;
    layer.scrollTop = area.scrollTop;
    layer.scrollLeft = area.scrollLeft;
  }, []);

  // After every change of the text (a line more can bring a scrollbar), and whenever the box is resized.
  useEffect(() => {
    if (shown) sync();
  });
  useEffect(() => {
    const area = areaRef.current;
    if (!shown || !area || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(sync);
    ro.observe(area);
    return () => ro.disconnect();
  }, [shown, sync]);

  const parts: React.ReactNode[] = [];
  if (shown) {
    let at = 0;
    for (const m of marks) {
      if (m.start > at) parts.push(text.slice(at, m.start));
      parts.push(
        <mark key={m.start} className="rounded-[3px] bg-sky-500/20 text-transparent dark:bg-sky-400/25">
          {text.slice(m.start, m.end)}
        </mark>
      );
      at = m.end;
    }
    // A trailing newline still makes a line in the box, but not in a div without something after it.
    parts.push(text.slice(at) + ZERO_WIDTH);
  }

  return (
    <div className={cn("relative", wrapperClassName)}>
      {shown && (
        <div
          ref={layerRef}
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words border-solid border-transparent text-transparent"
        >
          {parts}
        </div>
      )}
      {/* relative: drawn over the layer, which, positioned, would otherwise be drawn over it. */}
      <Textarea
        ref={setRef}
        className={cn("relative", className)}
        onScroll={(e) => {
          if (shown) sync();
          onScroll?.(e);
        }}
        {...props}
      />
    </div>
  );
}
