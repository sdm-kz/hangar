import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { BrowseResult } from "@/types";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ArrowUp, Folder, HardDrive, Loader2 } from "lucide-react";

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
