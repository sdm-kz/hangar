import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, GitBranch, Search } from "lucide-react";
import type { GitWorktree } from "@/types";
import { cn } from "@/lib/utils";

/** One folder the Files panel can be pointed at. `value` is what pickRoot takes ("" = the session's own). */
export type RootOption = {
  value: string;
  /** Folder name, plus its branch where it has one — what the closed picker shows. */
  label: string;
  /** Absolute path: the tooltip, and searchable so a folder can be found by where it is. */
  path: string;
  /** Worktrees first, then the folders linked by hand — the same two groups the list always had. */
  group: "worktree" | "linked";
  branch?: string | null;
};

/** Trailing segment of an absolute server path — the display name of a root folder. */
function baseName(p: string): string {
  const parts = p.split(/[/\\]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/**
 * The roots the Files panel offers, in the order they are shown: the repo's worktrees (or the
 * session's own folder alone, when it has none to choose between), then any linked folders.
 */
export function rootOptions(
  worktrees: GitWorktree[] | null,
  linked: string[] | null,
  workingDirectory: string
): RootOption[] {
  const out: RootOption[] =
    worktrees && worktrees.length > 1
      ? worktrees.map((w) => ({
          value: w.isCurrent ? "" : w.path,
          label: `${baseName(w.path)}${w.branch ? ` · ${w.branch}` : ""}${
            w.isCurrent ? " (this session)" : ""
          }`,
          path: w.path,
          group: "worktree",
          branch: w.branch,
        }))
      : [
          {
            value: "",
            label: `${baseName(workingDirectory)} (this session)`,
            path: workingDirectory,
            group: "worktree",
          },
        ];
  for (const f of linked ?? []) {
    out.push({ value: f, label: baseName(f), path: f, group: "linked" });
  }
  return out;
}

/**
 * Which folder the Files panel browses: a worktree of the session's repo, or a folder linked to it.
 *
 * A `<select>` until the list grew past what you can pick out by eye — a repo with a worktree per
 * ticket lists a dozen near-identical names, and a native dropdown gives you nothing to narrow them
 * with. So: a filter box over the same two groups. Terms are matched independently against the
 * name, the branch and the full path, so "feat auth" finds feat/auth-retry however the folder was
 * named, and a fragment of a path finds a linked folder whose leaf name says nothing useful.
 *
 * Keyboard: the filter takes focus on open, ↓/↑ move the highlight, Enter picks it, Esc closes.
 */
export function RootPicker({
  value,
  options,
  onPick,
  title,
}: {
  value: string;
  options: RootOption[];
  onPick: (dir: string) => void;
  /** Tooltip for the closed control — the caller knows the real path behind "" . */
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const current = options.find((o) => o.value === value);

  // Every term has to appear somewhere in the row: its label (name and branch) or its path. Matching
  // terms separately rather than as one string is what lets "feat auth" work when the branch reads
  // "feat/auth-retry" and the folder is named after the ticket instead.
  const shown = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return options;
    return options.filter((o) => {
      const hay = `${o.label} ${o.path}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [options, query]);

  // Opening starts on the current folder, so Enter without typing is a no-op rather than a jump to
  // whatever happens to be first; typing then re-aims at the best remaining row.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    const i = options.findIndex((o) => o.value === value);
    setActive(i < 0 ? 0 : i);
    inputRef.current?.focus();
  }, [open, options, value]);

  useEffect(() => {
    setActive((i) => (i < shown.length ? i : 0));
  }, [shown.length]);

  // Close on a click outside, the way every other menu in the panel does.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Keep the highlight in view while arrowing through a list longer than the popup.
  useEffect(() => {
    if (!open) return;
    boxRef.current?.querySelector(`[data-root-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const pick = (dir: string) => {
    setOpen(false);
    if (dir !== value) onPick(dir);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (shown.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + shown.length) % shown.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = shown[active];
      if (o) pick(o.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div ref={boxRef} className="relative min-w-0 flex-1">
      <button
        type="button"
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className="flex w-full min-w-0 items-center gap-1 rounded border bg-background px-1 py-0.5 text-left text-foreground outline-none focus:ring-1 focus:ring-primary"
      >
        <span className="min-w-0 flex-1 truncate">{current?.label ?? "…"}</span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
      </button>

      {/* The popup is wider than the control when the names need it: the pane it lives in is narrow
          enough that "AB-1234-fix-invalid-token-log-level" truncates to nothing useful, and a list
          you cannot read is not a list you can search. Capped so it stays inside a phone screen. */}
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-max min-w-full max-w-[min(22rem,80vw)] overflow-hidden rounded-md popover-edge bg-popover shadow-md">
          {/* The filter is the point of the control, so it holds the top of the popup and the focus.
              It stays put while the rows below it scroll. */}
          <div className="flex items-center gap-1 border-b px-1.5 py-1">
            <Search className="size-3 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Filter folders and branches…"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-[10px] text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div role="listbox" className="max-h-56 overflow-y-auto overscroll-contain p-1">
            {shown.length === 0 && (
              <p className="px-2 py-1.5 text-[10px] text-muted-foreground">No folder matches</p>
            )}
            {shown.map((o, i) => {
              // The group heading only earns its line where both groups are on screen; filtered down
              // to linked folders alone it would be a label over the whole list.
              const heading = o.group === "linked" && i > 0 && shown[i - 1].group !== "linked";
              return (
                <div key={o.value || "__current"}>
                  {heading && (
                    <p className="px-2 pb-0.5 pt-1 text-[9px] uppercase tracking-wide text-muted-foreground">
                      Linked folders
                    </p>
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={o.value === value}
                    data-root-index={i}
                    title={o.path}
                    onClick={() => pick(o.value)}
                    onMouseEnter={() => setActive(i)}
                    className={cn(
                      "flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-[10px] text-foreground",
                      i === active && "bg-accent",
                      o.value === value && "font-medium"
                    )}
                  >
                    {o.branch && <GitBranch className="size-3 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
