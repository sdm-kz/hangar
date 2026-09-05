import { useEffect, useRef } from "react";
import type { FileEntry } from "@/types";
import type { GitFiles } from "./FileBrowser";
import { fileKind } from "@/lib/fileKind";
import { STATUS_COLOR } from "@/lib/gitStatusColor";
import { cn } from "@/lib/utils";
import { File as FileIcon, FileText, Image as ImageIcon, Video, X } from "lucide-react";

/**
 * The session's open files, as tabs sitting in its tab bar to the right of Terminal/Split/Files. A
 * file is a view of the session in its own right, so it gets a tab of the same standing — clicking
 * one fills the pane with that file, while Files and Split show the same file beside the tree.
 *
 * The transient "preview" tab (opened by a single click) is shown in italics; double-clicking pins
 * it. Middle-click closes a tab, and a trailing button clears them all.
 */
export function FileTabStrip({
  tabs,
  activePath,
  previewPath,
  // Whether a file tab is the surface currently showing. False while the tree is (Files/Split): the
  // active file is still marked, but faintly, because the tab that owns the pane is Files.
  showingFile,
  gitFiles,
  onActivate,
  onPin,
  onClose,
  onCloseAll,
  className,
}: {
  tabs: FileEntry[];
  activePath: string | null;
  previewPath: string | null;
  showingFile: boolean;
  gitFiles?: GitFiles;
  onActivate: (path: string) => void;
  onPin: (path: string) => void;
  onClose: (path: string) => void;
  onCloseAll: () => void;
  className?: string;
}) {
  // Translate a vertical mouse wheel into horizontal scrolling over the strip. Uses a native,
  // non-passive listener so preventDefault works (React's onWheel is passive and can't).
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0 || el.scrollWidth <= el.clientWidth) return; // nothing to scroll sideways
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Keep the active tab in view: when selection changes (or tabs shift), scroll the strip so the
  // active tab is visible. Adjusts only the container's own scrollLeft, never the page.
  useEffect(() => {
    const el = scrollRef.current;
    const active = el?.querySelector<HTMLElement>('[data-current="true"]');
    if (!el || !active) return;
    const c = el.getBoundingClientRect();
    const a = active.getBoundingClientRect();
    const pad = 8;
    let target = el.scrollLeft;
    if (a.left < c.left) target -= c.left - a.left + pad;
    else if (a.right > c.right) target += a.right - c.right + pad;
    if (target !== el.scrollLeft) el.scrollTo({ left: target, behavior: "smooth" });
  }, [activePath, tabs.length]);

  if (!tabs.length) return null;

  return (
    <div className={cn("flex h-full min-w-0 flex-1 items-stretch", className)}>
      {/* Divides the fixed views from the files opened alongside them. */}
      <div className="my-2 w-px shrink-0 bg-border" />
      <div ref={scrollRef} className="hover-scrollbar flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {tabs.map((t) => {
          const kind = fileKind(t.name);
          const Icon =
            kind === "image" ? ImageIcon : kind === "video" ? Video : kind === "binary" ? FileIcon : FileText;
          const current = t.path === activePath;
          const active = current && showingFile;
          const preview = t.path === previewPath;
          return (
            <div
              key={t.path}
              role="tab"
              aria-selected={active}
              data-current={current}
              title={t.path}
              onClick={() => onActivate(t.path)}
              onDoubleClick={() => onPin(t.path)}
              // Middle-click closes the tab (matches browser tab behaviour).
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(t.path);
                }
              }}
              className={cn(
                "group/tab flex h-full shrink-0 cursor-pointer items-center gap-1.5 border-b-2 pl-3 pr-2 text-sm font-medium transition-colors",
                active
                  ? "border-primary text-foreground"
                  : current
                    // Open in the pane beside the tree rather than filling it: named, but not the
                    // tab holding the view.
                    ? "border-border text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon className="size-4 shrink-0" />
              <span
                className={cn(
                  "max-w-[10rem] truncate",
                  preview && "italic",
                  gitFiles?.[t.path] && STATUS_COLOR[gitFiles[t.path]]
                )}
              >
                {t.name}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(t.path);
                }}
                title="Close tab"
                className={cn(
                  "rounded p-0.5 hover:bg-accent hover:text-foreground",
                  current ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100"
                )}
              >
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
      {tabs.length > 1 && (
        <button
          onClick={onCloseAll}
          title="Close all file tabs"
          className="flex shrink-0 items-center border-l px-2 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}
