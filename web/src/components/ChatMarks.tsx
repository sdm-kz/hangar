import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Bookmark, Check, ListTodo, MessageSquareText, Pencil, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { markRange, type ChatMark, type ChatMarks, type FlatCache } from "@/lib/chatMarks";
import { cn } from "@/lib/utils";

// Painted with the Custom Highlight API, as find's matches are (see index.css): the chat's own nodes are
// never touched. Under find's, which says where you are now; a done to-do is struck through.
const OPEN = "chat-mark";
const DONE = "chat-mark-done";
const CURRENT = "chat-mark-current";
// How long a mark gone to from the list stays lit.
const FLASH_MS = 1600;

const registry = (): HighlightRegistry | null =>
  typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights : null;

// Every chat on screen paints its marks under the same two names: each one's ranges are kept here, and
// the highlights are made anew from all of them.
const painted = new Map<object, { open: Range[]; done: Range[] }>();
function repaint() {
  const reg = registry();
  if (!reg) return;
  const open = new Highlight();
  const done = new Highlight();
  open.priority = done.priority = -1;
  for (const p of painted.values()) {
    for (const r of p.open) open.add(r);
    for (const r of p.done) done.add(r);
  }
  reg.set(OPEN, open);
  reg.set(DONE, done);
}

let flashTimer: number | undefined;
/** Light up the text of a mark just gone to, for a moment. */
export function flashRange(range: Range) {
  const reg = registry();
  if (!reg) return;
  window.clearTimeout(flashTimer);
  reg.set(CURRENT, new Highlight(range));
  flashTimer = window.setTimeout(() => reg.delete(CURRENT), FLASH_MS);
}

/** A mark's place in the margin: by the first line of its text, in the layer's coordinates. */
export interface MarkSpot {
  mark: ChatMark;
  top: number;
  left: number;
}

// The margin's markers: a box this wide, this far left of the column's text.
const MARKER = 16;
const MARKER_GAP = 4;

/**
 * Paint the marks whose items are drawn, and say where in the margin each one's marker goes. Kept up to
 * date as the chat changes under them: a reply being written, Markdown settling, a fold opened, the zoom.
 */
export function useMarkPaint({
  marks,
  contentRef,
  layerRef,
  zoom,
  drawn,
  shownFrom,
}: {
  marks: ChatMark[];
  /** What holds the drawn items, each in an element with its key as data-find-key. */
  contentRef: RefObject<HTMLElement | null>;
  /** The box the markers are laid out in, unzoomed, around the content. */
  layerRef: RefObject<HTMLElement | null>;
  zoom: number;
  /** The items, and the first of them drawn: what is drawn changes when either does. */
  drawn: unknown;
  shownFrom: number;
}): MarkSpot[] {
  const [spots, setSpots] = useState<MarkSpot[]>([]);
  const self = useRef({});
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const measure = useCallback(() => {
    const content = contentRef.current;
    const layer = layerRef.current;
    const list = marksRef.current;
    if (!content || !layer || !list.length) {
      if (painted.delete(self.current)) repaint();
      setSpots((s) => (s.length ? [] : s));
      return;
    }
    const cache: FlatCache = new Map();
    const open: Range[] = [];
    const done: Range[] = [];
    const next: MarkSpot[] = [];
    const box = layer.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(content).paddingLeft) || 0;
    const textLeft = content.getBoundingClientRect().left + pad * zoomRef.current;
    const left = Math.max(2, textLeft - box.left - MARKER - MARKER_GAP);
    for (const mark of list) {
      const range = markRange(content, mark, cache);
      if (!range) continue;
      (mark.todo?.done ? done : open).push(range);
      // In a closed fold the text has no lines: painted for when it opens, but nothing in the margin.
      const line = [...range.getClientRects()].find((r) => r.width || r.height);
      if (line) next.push({ mark, top: line.top - box.top + line.height / 2 - MARKER / 2, left });
    }
    painted.set(self.current, { open, done });
    repaint();
    // Two on one line go side by side, the later further out.
    next.sort((a, b) => a.top - b.top);
    for (let i = 1; i < next.length; i++)
      if (Math.abs(next[i].top - next[i - 1].top) < MARKER / 2)
        next[i] = { ...next[i], top: next[i - 1].top, left: Math.max(2, next[i - 1].left - MARKER - 2) };
    // Only when something moved: every redraw of the markers is cheap, but not every frame.
    setSpots((cur) =>
      cur.length === next.length &&
      cur.every((s, i) => s.mark === next[i].mark && Math.abs(s.top - next[i].top) < 0.5 && s.left === next[i].left)
        ? cur
        : next
    );
  }, [contentRef, layerRef]);

  useLayoutEffect(measure, [measure, marks, zoom, drawn, shownFrom]);
  useEffect(() => {
    const content = contentRef.current;
    if (!content || !marks.length) return;
    let raf = 0;
    const later = () => {
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          measure();
        });
    };
    const mo = new MutationObserver(later);
    mo.observe(content, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["open"] });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(later);
    ro?.observe(content);
    window.addEventListener("resize", later);
    return () => {
      mo.disconnect();
      ro?.disconnect();
      window.removeEventListener("resize", later);
      cancelAnimationFrame(raf);
    };
  }, [contentRef, marks.length, measure]);
  useEffect(
    () => () => {
      if (painted.delete(self.current)) repaint();
    },
    []
  );
  return spots;
}

/** What a mark is, for its icon and its name. */
function MarkIcon({ mark, className }: { mark: ChatMark; className?: string }) {
  return mark.note ? (
    <MessageSquareText className={className} />
  ) : (
    <Bookmark className={className} />
  );
}

/** A to-do's box: ticks it off and back. */
function TodoBox({ done, onToggle, className }: { done: boolean; onToggle: () => void; className?: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      title={done ? "Done — mark as not done" : "Mark as done"}
      onClick={onToggle}
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-sm border shadow-sm",
        done ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/60 bg-background hover:border-primary",
        className
      )}
    >
      {done && <Check className="size-3" />}
    </button>
  );
}

/**
 * The markers in the chat's margin, by the first line of each mark's text: a to-do's box, to tick off
 * where it is read, and an icon for a bookmark or a note, which opens it in the list.
 */
export function MarkMargin({
  spots,
  onToggle,
  onOpen,
}: {
  spots: MarkSpot[];
  onToggle: (mark: ChatMark) => void;
  onOpen: (mark: ChatMark) => void;
}) {
  return (
    <div aria-hidden={!spots.length} className="pointer-events-none absolute inset-0 select-none" data-find-skip>
      {spots.map(({ mark, top, left }) => (
        <div
          key={mark.id}
          style={{ top, left, width: MARKER, height: MARKER }}
          className="pointer-events-auto absolute grid place-items-center"
          data-chat-marks-opener
        >
          {mark.todo ? (
            <TodoBox done={mark.todo.done} onToggle={() => onToggle(mark)} />
          ) : (
            <button
              type="button"
              title={mark.note ?? "Bookmark"}
              onClick={() => onOpen(mark)}
              className="grid size-4 place-items-center rounded-sm text-amber-500 hover:bg-muted"
            >
              <MarkIcon mark={mark} className="size-3.5" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** The button for the list, in the chat's corner: the count is the to-dos not done yet. */
export function MarksButton({ marks, open, onClick }: { marks: ChatMark[]; open: boolean; onClick: () => void }) {
  const left = marks.filter((m) => m.todo && !m.todo.done).length;
  return (
    <Button
      variant="ghost"
      size="icon"
      className="relative size-7"
      title={
        marks.length
          ? `Bookmarks, notes and to-dos${left ? ` (${left} to do)` : ""}`
          : "Bookmarks, notes and to-dos: select text in the chat to add one"
      }
      aria-pressed={open}
      data-chat-marks-opener
      onClick={onClick}
    >
      {left ? <ListTodo className="size-4" /> : <Bookmark className="size-4" />}
      {left > 0 && (
        <span className="absolute -right-0.5 -top-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-primary px-0.5 text-[9px] font-semibold leading-none text-primary-foreground">
          {left > 99 ? "99+" : left}
        </span>
      )}
    </Button>
  );
}

type Tab = "todo" | "all" | "notes";
const TABS: { tab: Tab; label: string }[] = [
  { tab: "todo", label: "To do" },
  { tab: "all", label: "All" },
  { tab: "notes", label: "Notes" },
];

/**
 * The conversation's marks, in the order of the conversation: what is left to do, everything, or the
 * notes. A row's text goes to where it is in the chat; its box ticks a to-do off; its buttons write the
 * note, make it a to-do or not, and take it away.
 */
export function MarksPanel({
  store,
  order,
  focus,
  editing,
  onEdited,
  onGo,
  onClose,
}: {
  store: ChatMarks;
  /** Each item's place in the conversation, by its key: a mark whose item isn't there can't be gone to. */
  order: Map<string, number>;
  /** A mark to show, opened from its marker: scrolled to and lit. */
  focus: string | null;
  /** A mark whose note to write at once, just put on the text: let go without one, it goes. */
  editing: string | null;
  onEdited: () => void;
  onGo: (mark: ChatMark) => void;
  onClose: () => void;
}) {
  const { marks, update, remove } = store;
  const anyTodo = marks.some((m) => m.todo && !m.todo.done);
  const [tab, setTab] = useState<Tab>(() => (anyTodo && !focus && !editing ? "todo" : "all"));
  const [edit, setEdit] = useState<{ id: string; text: string; fresh: boolean } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // A note to write as soon as its mark is made.
  useEffect(() => {
    if (!editing) return;
    setTab("all");
    setEdit({ id: editing, text: "", fresh: true });
    onEdited();
  }, [editing, onEdited]);
  useEffect(() => {
    if (!focus) return;
    if (tab !== "all") setTab("all");
    requestAnimationFrame(() =>
      rootRef.current?.querySelector(`[data-mark-id="${CSS.escape(focus)}"]`)?.scrollIntoView({ block: "nearest" })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  // Out of it, or Escape: closed. Not by its own button or a marker, which open it.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (rootRef.current?.contains(t) || t?.closest?.("[data-chat-marks-opener]")) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const place = (m: ChatMark) => order.get(m.itemKey) ?? -1;
  const sorted = [...marks].sort((a, b) => place(a) - place(b) || a.createdAt - b.createdAt);
  const shown = sorted.filter((m) =>
    tab === "todo" ? m.todo && !m.todo.done : tab === "notes" ? !!m.note || edit?.id === m.id : true
  );
  const done = tab === "todo" ? marks.filter((m) => m.todo?.done).length : 0;

  const saveEdit = () => {
    if (!edit) return;
    const text = edit.text.trim();
    const mark = marks.find((m) => m.id === edit.id);
    // A mark made for its note and left without one: it was never wanted as a bookmark.
    if (edit.fresh && !text && mark && !mark.todo) remove(edit.id);
    else if (mark && (mark.note ?? "") !== text) update(edit.id, { note: text || undefined });
    setEdit(null);
  };
  // Closed by a click outside, the list goes before the box would lose the focus: no blur comes to save
  // what was being written, so it is saved on the way out.
  const saveEditRef = useRef(saveEdit);
  saveEditRef.current = saveEdit;
  useEffect(() => () => saveEditRef.current(), []);

  return (
    <div
      ref={rootRef}
      className="flex max-h-[min(70vh,32rem)] w-[22rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg"
    >
      <div className="flex items-center gap-1 border-b p-1">
        {TABS.map(({ tab: t, label }) => {
          const n =
            t === "todo"
              ? marks.filter((m) => m.todo && !m.todo.done).length
              : t === "notes"
                ? marks.filter((m) => m.note).length
                : marks.length;
          return (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                "rounded-md px-2 py-1 text-xs font-medium",
                tab === t ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {label}
              {n > 0 && <span className="ml-1 tabular-nums text-muted-foreground">{n}</span>}
            </button>
          );
        })}
        <span className="flex-1" />
        {store.unsaved && <span className="px-1 text-[11px] text-destructive">Not saved yet</span>}
        <Button variant="ghost" size="icon" className="size-6" title="Close (Esc)" onClick={onClose}>
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
        {shown.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            {marks.length === 0
              ? "Select text in the chat to bookmark it, put a note on it or make it a to-do."
              : tab === "todo"
                ? done
                  ? "All done."
                  : "Nothing to do. Make a to-do from text you select, or a whole list of steps at once."
                : "No notes yet."}
          </p>
        ) : (
          shown.map((m) => {
            const there = order.has(m.itemKey);
            return (
              <div
                key={m.id}
                data-mark-id={m.id}
                className={cn(
                  "group/mark flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60",
                  focus === m.id && "bg-muted"
                )}
              >
                <span className="mt-0.5 grid size-4 shrink-0 place-items-center">
                  {m.todo ? (
                    <TodoBox done={m.todo.done} onToggle={() => update(m.id, { todo: { done: !m.todo!.done } })} />
                  ) : (
                    <MarkIcon mark={m} className="size-3.5 text-amber-500" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    disabled={!there}
                    title={there ? "Go to it in the chat" : "In the part of the conversation that isn't loaded here"}
                    onClick={() => onGo(m)}
                    className={cn(
                      "line-clamp-2 w-full break-words text-left text-sm",
                      m.todo?.done && "text-muted-foreground line-through",
                      there ? "hover:underline" : "cursor-default opacity-70"
                    )}
                  >
                    {m.quote}
                  </button>
                  {edit?.id === m.id ? (
                    <textarea
                      autoFocus
                      rows={2}
                      value={edit.text}
                      placeholder="Your note on this…"
                      onChange={(e) => setEdit({ ...edit, text: e.target.value })}
                      onBlur={saveEdit}
                      onKeyDown={(e) => {
                        if (e.nativeEvent.isComposing) return;
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          saveEdit();
                        } else if (e.key === "Escape") {
                          // Kept from closing the list: Escape here is the note's.
                          e.preventDefault();
                          e.stopPropagation();
                          if (edit.fresh && !m.todo && !m.note) remove(m.id);
                          setEdit(null);
                        }
                      }}
                      className="mt-1 w-full resize-y rounded-md border bg-background px-2 py-1 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    />
                  ) : (
                    m.note && (
                      <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-muted-foreground">{m.note}</p>
                    )
                  )}
                </div>
                <div className="flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover/mark:opacity-100 [@media(pointer:coarse)]:opacity-100">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    title={m.note ? "Edit the note" : "Add a note"}
                    onClick={() => setEdit({ id: m.id, text: m.note ?? "", fresh: false })}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    title={m.todo ? "Not a to-do" : "Make it a to-do"}
                    onClick={() => update(m.id, { todo: m.todo ? undefined : { done: false } })}
                  >
                    {m.todo ? <Bookmark className="size-3.5" /> : <ListTodo className="size-3.5" />}
                  </Button>
                  <Button variant="ghost" size="icon" className="size-6" title="Remove" onClick={() => remove(m.id)}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            );
          })
        )}
        {done > 0 && shown.length > 0 && (
          <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
            {done} done — under All
          </p>
        )}
      </div>
    </div>
  );
}
