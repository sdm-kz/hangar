import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { File as FileIcon, Folder, Loader2, TerminalSquare } from "lucide-react";
import type { FileEntry, SlashCommand } from "@/types";
import { useApi } from "@/lib/node";
import { cn } from "@/lib/utils";
import { Textarea } from "@/components/ui/textarea";
import { commandRanges, insertCommand, rankCommands, SLASH_WORD, slashToken, startsWithQuery, type SlashRange } from "@/lib/slash";
import { insertMention, mentionLookup, mentionText, mentionToken, rankFiles } from "@/lib/mention";

// How long the command list is trusted before it is read again (a skill added in the meantime).
const COMMANDS_TTL_MS = 30_000;
// How long typing has to pause before the files are looked for: a search walks the session's folder.
const MENTION_DEBOUNCE_MS = 120;

export interface SlashInput {
  commands: SlashCommand[] | null;
  matches: SlashCommand[];
  /**
   * The files for an "@" being typed, best first — null while there is none, or before any have been read
   * for it. While the files for what is typed now are read, the last ones stay, to be clicked but not
   * taken with Tab or Enter.
   */
  files: FileEntry[] | null;
  /** An "@" is being typed: the list, when open, is of files. */
  mentioning: boolean;
  /** Put the file in place of the mention being typed: a space after a file, none after a folder. */
  completeFile: (e: FileEntry) => void;
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
 *
 * File suggestions too, for an "@" typed the way Claude Code's own box takes one: the session's folder
 * (or the folder typed so far) listed, or a bare name looked for anywhere under it. What goes in is a
 * path relative to the session's folder, which Claude reads when the message arrives.
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
  const at = Math.min(caret, text.length);
  const token = useMemo(() => slashToken(text, at), [text, at]);
  const query = token?.query ?? null;
  const mention = useMemo(() => (token ? null : mentionToken(text, at)), [token, text, at]);
  const mentionQuery = mention?.query ?? null;
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

  // The files for the "@" being typed, and what was typed when they were read. Kept while the next ones
  // are read, so the list doesn't blink out between keystrokes.
  const [found, setFound] = useState<{ query: string; entries: FileEntry[] } | null>(null);
  // Folders listed lately, by session and path: typing on narrows a listing already here rather than
  // asking again.
  const listed = useRef(new Map<string, { at: number; entries: FileEntry[] }>());
  useEffect(() => {
    if (mentionQuery === null) {
      setFound(null);
      return;
    }
    const look = mentionLookup(mentionQuery);
    const done = (entries: FileEntry[]) => setFound({ query: mentionQuery, entries });
    const fresh = (dir: string) => {
      const hit = listed.current.get(`${sessionId}\n${dir}`);
      return hit && Date.now() - hit.at < COMMANDS_TTL_MS ? hit.entries : null;
    };
    const list = (dir: string) =>
      fresh(dir) ??
      api.listSessionFiles(sessionId, dir || undefined).then((l) => {
        listed.current.set(`${sessionId}\n${dir}`, { at: Date.now(), entries: l.entries });
        return l.entries;
      });
    if (look.kind === "list") {
      const hit = fresh(look.dir);
      if (hit) {
        done(rankFiles(hit, look.name));
        return;
      }
    }
    let stale = false;
    const timer = setTimeout(() => {
      const read =
        look.kind === "list"
          ? Promise.resolve(list(look.dir)).then(
              (entries) => rankFiles(entries, look.name),
              // Not a folder of the session's own (src/x when it is web/src/x): the path is looked for
              // anywhere under it instead, as a pasted one is in the Files tab.
              () => api.searchSessionFiles(sessionId, mentionQuery).then((l) => rankFiles(l.entries, look.name))
            )
          : // A bare name: the files called that anywhere under the folder, and what is at its top too — the
            // search finds files only, and "@we" is as likely to be after web/ as after WebView.tsx.
            Promise.all([
              Promise.resolve(list("")).catch(() => [] as FileEntry[]),
              api.searchSessionFiles(sessionId, look.name).then((l) => l.entries),
            ]).then(([top, deep]) => {
              const seen = new Set(top.map((e) => e.path));
              return rankFiles([...top, ...deep.filter((e) => !seen.has(e.path))], look.name);
            });
      read.then(
        (entries) => !stale && done(entries),
        // A node too old to search, or one that dropped: no suggestions, and typing goes on.
        () => !stale && done([])
      );
    }, MENTION_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [mentionQuery, api, sessionId]);
  const files = mentionQuery === null ? null : (found?.entries ?? null);
  // The files shown are for what is typed now, not the last thing typed before it.
  const filesCurrent = found?.query === mentionQuery;

  // Whether the highlight was moved by hand since the query last changed.
  const [chosen, setChosen] = useState(false);
  useEffect(() => {
    setActive(0);
    setChosen(false);
  }, [query, mentionQuery]);

  const highlights = useMemo(() => (commands ? commandRanges(text, commands) : []), [text, commands]);

  const mentioning = mentionQuery !== null;
  const open =
    text !== closedOn &&
    (mentioning ? files === null || files.length > 0 : query !== null && (matches.length > 0 || !commands));
  const count = mentioning ? (files?.length ?? 0) : matches.length;
  const current = Math.min(active, Math.max(0, count - 1));
  const pick = open && !mentioning ? matches[current] : undefined;
  // Only from files read for what is typed now: one left from a keystroke ago (web/ while web/src/ is
  // read) would put back less than is there.
  const filePick = open && mentioning && filesCurrent ? files?.[current] : undefined;
  // A suggestion that only contains what was typed, or mentions it in its description, is not what was
  // meant by a whole command typed out — /new is not /fork — so Enter takes it only when it starts with
  // what was typed, or was picked with the arrows. A file is taken unless it is what is typed already —
  // but not for a bare "@", which Enter sends as it is unless a file was picked with the arrows.
  const enterCompletes = filePick
    ? mentionText(filePick) !== mentionQuery && (chosen || mentionQuery !== "")
    : !!pick && query !== pick.name && (chosen || startsWithQuery(pick, query ?? ""));
  const listId = `${id}-slash`;
  const optionId = (i: number) => `${id}-slash-${i}`;

  const put = (next: string, end: number, close: boolean) => {
    setText(next);
    // A folder keeps the list open, on what is in it.
    if (close) setClosedOn(next);
    setCaret(end);
    requestAnimationFrame(() => {
      const el = areaRef.current;
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = end;
    });
  };
  const complete = (c: SlashCommand) => {
    if (!token) return;
    const { text: next, caret: end } = insertCommand(text, token, caret, c);
    put(next, end, true);
  };
  const completeFile = (e: FileEntry) => {
    if (!mention) return;
    const { text: next, caret: end } = insertMention(text, mention, caret, e);
    put(next, end, !e.isDir);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || e.nativeEvent.isComposing) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setChosen(true);
      setActive((i) => (count ? (i + (e.key === "ArrowDown" ? 1 : -1) + count) % count : 0));
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
    const takes = e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && enterCompletes);
    if (filePick && takes) {
      e.preventDefault();
      completeFile(filePick);
      return true;
    }
    // The files are still being read: Tab waits for them rather than taking the focus out of the box.
    if (mentioning && e.key === "Tab") {
      e.preventDefault();
      return true;
    }
    if (pick && takes) {
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
    files,
    mentioning,
    completeFile,
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
      "aria-activedescendant": open && count ? optionId(current) : undefined,
      onSelect: (e) => track(e.currentTarget),
    },
  };
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
  }, [slash.active, slash.matches, slash.files]);
  if (!slash.open) return null;
  if (slash.mentioning)
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
        {!slash.files ? (
          <p className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Looking for files…
          </p>
        ) : (
          slash.files.map((f, i) => {
            const slashAt = f.path.lastIndexOf("/");
            const Icon = f.isDir ? Folder : FileIcon;
            return (
              <div
                key={f.path}
                id={slash.optionId(i)}
                data-index={i}
                role="option"
                aria-selected={i === slash.active}
                title={f.path}
                // mousedown, not click: taking the pick must not take the focus out of the box first.
                onMouseDown={(e) => {
                  e.preventDefault();
                  slash.completeFile(f);
                }}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm",
                  i === slash.active ? "bg-accent text-accent-foreground" : "hover:bg-muted"
                )}
              >
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="shrink-0 font-mono">
                  {f.name}
                  {f.isDir && "/"}
                </span>
                {/* The folder it is in, for the same name in two places: cut from the left, where it
                    says least. */}
                {slashAt > 0 && (
                  <span
                    dir="rtl"
                    className="min-w-0 flex-1 truncate text-left font-mono text-xs text-muted-foreground"
                  >
                    <bdi>{f.path.slice(0, slashAt)}</bdi>
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>
    );
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
