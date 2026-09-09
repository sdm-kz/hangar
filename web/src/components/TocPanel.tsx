import { useEffect, useRef, useState, type RefObject } from "react";
import { TableOfContents, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface TocItem {
  /** Stable key for the entry — a heading id in markdown, a generated one in formats without ids. */
  id: string;
  label: string;
  /** 1–6. Indentation is relative to the shallowest level actually present. */
  level: number;
  /** The element this entry points at, used for the scroll spy and the jump. */
  el: HTMLElement;
}

/**
 * Floating table-of-contents overlay shared by the preview viewers (markdown, Word). Position it
 * inside a `relative` ancestor; `containerRef` is the scrollable element holding the document.
 *
 * The panel only knows how to *show* an outline — collecting the entries and deciding what a click
 * does (markdown anchors the URL hash, Word just scrolls) belongs to the caller. While scrolling,
 * the entry whose section is at the top of the view is highlighted.
 */
export function TocPanel({
  containerRef,
  entries,
  onSelect,
  storageKey,
  align = "end",
  className,
}: {
  containerRef: RefObject<HTMLElement | null>;
  entries: TocItem[];
  onSelect: (entry: TocItem) => void;
  /** localStorage key holding whether the panel is open — a preference that sticks across files. */
  storageKey: string;
  /** Which side the button and panel line up on, for viewers whose corner is already taken. */
  align?: "start" | "end";
  className?: string;
}) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(storageKey) === "1";
    } catch {
      return false;
    }
  });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLElement | null>(null);

  const toggle = () => {
    setOpen((o) => {
      try {
        localStorage.setItem(storageKey, o ? "0" : "1");
      } catch {
        /* preference only */
      }
      return !o;
    });
  };

  // A leftover filter belongs to the previous document.
  useEffect(() => setQuery(""), [entries]);

  // Scroll spy: the active section is the last entry at or above the top of the container (with a
  // little slack so a just-anchored heading counts as its own section).
  useEffect(() => {
    const root = containerRef.current;
    if (!root || entries.length === 0) {
      setActiveId(null);
      return;
    }
    let raf = 0;
    const update = () => {
      raf = 0;
      const top = root.getBoundingClientRect().top + 24;
      let current = entries[0].id;
      for (const e of entries) {
        if (e.el.getBoundingClientRect().top <= top) current = e.id;
        else break;
      }
      setActiveId(current);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    root.addEventListener("scroll", schedule, { passive: true });
    // Late layout shifts (mermaid diagrams, images, zoom changes) move the headings without a
    // scroll event — watch the content's size so the highlight stays honest.
    const ro = new ResizeObserver(schedule);
    if (root.firstElementChild) ro.observe(root.firstElementChild);
    return () => {
      root.removeEventListener("scroll", schedule);
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [containerRef, entries]);

  // Keep the highlighted entry visible inside the (scrollable) panel as reading progresses.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [open, activeId]);

  if (entries.length === 0) return null;
  const minLevel = Math.min(...entries.map((e) => e.level));
  const q = query.trim().toLowerCase();
  const visible = q ? entries.filter((e) => e.label.toLowerCase().includes(q)) : entries;

  return (
    <div
      className={cn(
        "absolute top-3 z-10 flex flex-col",
        align === "end" ? "right-3 items-end" : "left-3 items-start",
        className
      )}
    >
      <Button
        variant="ghost"
        size="icon"
        className="size-7 rounded-md border bg-background/90 shadow-sm backdrop-blur"
        title={open ? "Hide table of contents" : "Table of contents"}
        onClick={toggle}
      >
        {open ? <X className="size-4" /> : <TableOfContents className="size-4" />}
      </Button>
      {open && (
        <nav
          ref={listRef}
          className="mt-2 max-h-[min(24rem,60vh)] w-60 max-w-[70vw] overflow-y-auto rounded-md popover-edge bg-background/95 pb-1 shadow-md backdrop-blur"
        >
          {/* Sticky so the filter stays reachable while the section list scrolls under it. */}
          <div className="sticky top-0 border-b bg-background/95 p-1 backdrop-blur">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter sections…"
              autoFocus
              className="h-6 w-full rounded-sm bg-muted/50 px-1.5 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
              onKeyDown={(e) => {
                // Enter jumps to the first match; Esc clears the filter before anything
                // else (like a dialog) gets to act on it.
                if (e.key === "Enter" && visible[0]) onSelect(visible[0]);
                if (e.key === "Escape" && query) {
                  e.stopPropagation();
                  setQuery("");
                }
              }}
            />
          </div>
          {visible.length === 0 && (
            <div className="px-2.5 py-2 text-xs text-muted-foreground">No matching sections.</div>
          )}
          {visible.map((e) => (
            <button
              key={e.id}
              data-active={e.id === activeId || undefined}
              title={e.label}
              onClick={() => onSelect(e)}
              className={cn(
                "block w-full truncate px-2.5 py-1 text-left text-xs hover:bg-accent",
                e.id === activeId ? "bg-accent font-medium text-foreground" : "text-muted-foreground"
              )}
              style={{ paddingLeft: `${0.625 + (e.level - minLevel) * 0.75}rem` }}
            >
              {e.label}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
