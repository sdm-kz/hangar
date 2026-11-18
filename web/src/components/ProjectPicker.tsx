import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { Project } from "@/types";
import { sortedByName } from "@/lib/projects";
import { cn } from "@/lib/utils";
import { ProjectGlyph } from "./ProjectGlyph";

/**
 * A project, or none, picked by typing part of its name: a text box over a list of the projects, each
 * with its glyph, narrowed to the ones whose name has what was typed in it. A native <select> could
 * only be scrolled, and with a few dozen projects that is a long way to the one you want.
 *
 * The box shows the picked project's name until something is typed into it; leaving it without picking
 * puts that name back. Keyboard: typing or ↓/↑ opens the list, ↓/↑ move the highlight, Enter picks it
 * (and never submits the form the picker sits in), Esc closes the list and only the list. Ctrl/⌘+Enter
 * is left to the form.
 */
export function ProjectPicker({
  id,
  projects,
  value,
  onChange,
}: {
  id: string;
  projects: Project[];
  /** The picked project's id, "" for none. */
  value: string;
  onChange: (projectId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // What has been typed since the box was entered, or null while it just shows the pick.
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const current = projects.find((p) => p.id === value) ?? null;
  const q = (query ?? "").trim().toLowerCase();
  // "No project" leads the list until something is typed, which is a search for a project.
  const options: (Project | null)[] = [
    ...(q ? [] : [null]),
    ...sortedByName(projects).filter((p) => !q || p.name.toLowerCase().includes(q)),
  ];

  const close = () => {
    setOpen(false);
    setQuery(null);
  };
  // The name back in the box, selected: typing next starts a new search instead of adding to the name.
  const selectName = () => requestAnimationFrame(() => {
    if (document.activeElement === inputRef.current) inputRef.current?.select();
  });

  const show = () => {
    if (open) return;
    const i = options.findIndex((p) => (p?.id ?? "") === value);
    setActive(i < 0 ? 0 : i); // on the current one, so Enter straight away keeps it
    setOpen(true);
  };

  // Close on a click outside. Esc is caught on the window, ahead of the dialog's own listener on the
  // document, so it folds the list away rather than closing the dialog the picker sits in.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) close();
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      close();
      selectName();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onEsc, true);
    };
  }, [open]);

  // Keep the highlighted row in view while the arrows walk a list longer than the box.
  useEffect(() => {
    if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, id]);

  const pick = (p: Project | null) => {
    close();
    selectName();
    if ((p?.id ?? "") !== value) onChange(p?.id ?? "");
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return show();
      if (options.length === 0) return;
      const n = options.length;
      setActive((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if (e.key === "Enter") {
      if (e.ctrlKey || e.metaKey) return; // the form's: create
      e.preventDefault();
      if (!open) return show();
      if (options[active] !== undefined) pick(options[active]);
    } else if (e.key === "Tab" && open) {
      close();
    }
  };

  return (
    <div ref={boxRef} className="relative">
      <ProjectGlyph
        project={query === null ? current : null}
        className={cn(
          "pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2",
          (query !== null || !current) && "text-muted-foreground"
        )}
      />
      <input
        ref={inputRef}
        id={id}
        role="combobox"
        aria-autocomplete="list"
        aria-controls={`${id}-list`}
        aria-expanded={open}
        aria-activedescendant={open && options.length ? `${id}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        value={query ?? current?.name ?? ""}
        placeholder={current ? current.name : "No project"}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={(e) => e.target.select()}
        onClick={() => {
          if (query === null) selectName();
          show();
        }}
        onKeyDown={onKeyDown}
        // The rows and the chevron keep the focus here, so leaving the box means nothing was picked.
        onBlur={close}
        className="flex h-9 w-full rounded-md field-edge bg-transparent py-1 pl-8 pr-8 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={open ? "Close the project list" : "Show every project"}
        onMouseDown={(e) => {
          e.preventDefault(); // keep the focus in the box
          if (open) close();
          else {
            inputRef.current?.focus();
            show();
          }
        }}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
      >
        <ChevronDown className="size-4 opacity-50" />
      </button>

      {open && (
        <div
          id={`${id}-list`}
          role="listbox"
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-60 overflow-y-auto overscroll-contain rounded-md popover-edge bg-popover p-1 text-popover-foreground shadow-md"
        >
          {options.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">No project matches “{query?.trim()}”.</div>
          )}
          {options.map((p, i) => (
            <div
              key={p?.id ?? ""}
              id={`${id}-${i}`}
              role="option"
              aria-selected={(p?.id ?? "") === value}
              onMouseEnter={() => setActive(i)}
              // mousedown, not click: the outside-click listener runs on mousedown too, and the focus
              // stays in the box rather than moving to a row that is about to go.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(p);
              }}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
                i === active && "bg-accent"
              )}
            >
              <Check className={cn("size-3.5 shrink-0", (p?.id ?? "") === value ? "opacity-100" : "opacity-0")} />
              <ProjectGlyph project={p} className={cn("size-3.5 shrink-0", !p && "text-muted-foreground")} />
              <span className={cn("truncate", !p && "text-muted-foreground")}>{p ? p.name : "No project"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
