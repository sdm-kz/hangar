import { useEffect, useRef, useState, type ReactNode } from "react";
import type { BrowseResult } from "@/types";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { sameFolder } from "@/lib/projects";
import { folderName } from "@/lib/recentFolders";
import { ArrowUp, Folder, HardDrive, Loader2 } from "lucide-react";
import { useApi } from "@/lib/node";

/**
 * Filesystem folder picker with type-to-navigate autocomplete and keyboard navigation.
 * The text field holds the chosen absolute path; the dropdown lists subfolders and drive
 * roots served by /api/fs/browse on the machine running the service.
 *
 * Keyboard (while focused): ↓/↑ move the highlight, Enter opens the highlighted folder
 * (or navigates to the typed path when nothing is highlighted), Esc closes.
 */
export function FolderPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (path: string) => void;
}) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);

  async function browse(path?: string) {
    setLoading(true);
    try {
      setResult(await api.browse(path));
    } catch {
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  // Load the listing for the current value whenever the dropdown opens.
  useEffect(() => {
    if (open) browse(value || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Reset the highlight whenever a new listing loads.
  useEffect(() => {
    setActiveIndex(-1);
  }, [result]);

  // Close on outside click.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  // Keep the highlighted row scrolled into view.
  useEffect(() => {
    if (activeIndex < 0) return;
    containerRef.current
      ?.querySelector(`[data-nav-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  function pick(path: string) {
    onChange(path);
    browse(path);
  }

  // Navigable rows = optional "Up one level" (index 0) followed by the directories.
  const upOffset = result?.parent ? 1 : 0;
  const navLength = upOffset + (result?.directories.length ?? 0);

  function activate(index: number) {
    if (index < 0) {
      browse(value.trim() || undefined); // navigate to the typed path
      return;
    }
    if (upOffset && index === 0) {
      pick(result!.parent!);
      return;
    }
    const dir = result?.directories[index - upOffset];
    if (dir) pick(dir.path);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      setActiveIndex((i) => Math.min(i + 1, navLength - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        browse(value.trim() || undefined);
      } else {
        activate(activeIndex);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="flex gap-2">
        <Input
          value={value}
          placeholder="C:\path\to\project"
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          className="font-mono text-xs"
        />
        <Button type="button" variant="outline" size="icon" onClick={() => setOpen((o) => !o)}>
          <Folder className="size-4" />
        </Button>
      </div>

      {open && (
        <div className="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-md popover-edge bg-popover p-1 shadow-md">
          {loading && (
            <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Loading…
            </div>
          )}

          {!loading && result && (
            <>
              {result.parent && (
                <button
                  type="button"
                  data-nav-index={0}
                  onClick={() => pick(result.parent!)}
                  onMouseEnter={() => setActiveIndex(0)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent",
                    activeIndex === 0 && "bg-accent"
                  )}
                >
                  <ArrowUp className="size-3.5 text-muted-foreground" />
                  <span className="text-muted-foreground">Up one level</span>
                </button>
              )}

              {result.drives.length > 0 && (
                <div className="flex flex-wrap gap-1 border-b px-2 py-1.5">
                  {result.drives.map((d) => (
                    <button
                      key={d.path}
                      type="button"
                      onClick={() => pick(d.path)}
                      className="flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-xs hover:bg-accent"
                    >
                      <HardDrive className="size-3" />
                      {d.name}
                    </button>
                  ))}
                </div>
              )}

              {result.directories.length === 0 && (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">No subfolders</div>
              )}

              {result.directories.map((d, i) => {
                const idx = upOffset + i;
                return (
                  <button
                    key={d.path}
                    type="button"
                    data-nav-index={idx}
                    onClick={() => pick(d.path)}
                    onMouseEnter={() => setActiveIndex(idx)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent",
                      (value === d.path || activeIndex === idx) && "bg-accent"
                    )}
                  >
                    <Folder className="size-3.5 text-muted-foreground" />
                    <span className="truncate">{d.name}</span>
                  </button>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A row of one-click folder picks — a project's linked folders, offered beside the picker wherever a
 * folder is chosen in a project's context. The chosen one is *marked*, not merely hovered: with the
 * picker above collapsed to a single line, this row is often the only thing on screen saying which
 * folder is set.
 */
export function FolderChips({
  folders,
  value,
  onPick,
  label,
  empty,
}: {
  folders: readonly string[];
  /** The folder currently set, so the chip matching it can show as chosen. */
  value: string;
  onPick: (path: string) => void;
  /** The heading above the row — a project's glyph and name, typically. */
  label: ReactNode;
  /** What to say when the list is empty; nothing renders without it. */
  empty?: ReactNode;
}) {
  // The chosen chip, kept in sight: a folder set before the dialog opened (a session started from a
  // worktree's row) can be the thirtieth chip, below the list's fold. Scrolls the list only, never the
  // dialog around it, which scrollIntoView would.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = listRef.current;
    const chosen = list?.querySelector<HTMLElement>("[data-chosen]");
    if (!list || !chosen) return;
    const top = chosen.offsetTop - list.clientTop;
    if (top < list.scrollTop) list.scrollTop = top - 4;
    else if (top + chosen.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = top + chosen.offsetHeight - list.clientHeight + 4;
  }, [value, folders]);

  if (folders.length === 0 && !empty) return null;
  return (
    <div className="space-y-1.5 pt-1">
      <div className="flex items-center gap-1 text-xs text-muted-foreground">{label}</div>
      {folders.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        // About four rows, then a scroller of its own: a project gathers a folder per worktree, and forty
        // of them would otherwise push every field under them out of the dialog. -m-1 p-1 gives the chips'
        // focus rings room inside the scroller without moving anything (see NewSessionDialog).
        <div ref={listRef} className="relative -m-1 flex max-h-34 flex-wrap gap-1.5 overflow-y-auto overscroll-contain p-1">
          {folders.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onPick(p)}
              title={p}
              data-chosen={sameFolder(p, value) || undefined}
              className={cn(
                "flex max-w-full items-center rounded-md border px-2 py-1 text-xs hover:bg-accent",
                sameFolder(p, value) && "border-primary bg-accent"
              )}
            >
              <span className="truncate">{folderName(p)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
