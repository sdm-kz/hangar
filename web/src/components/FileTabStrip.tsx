import type { FileEntry } from "@/types";
import type { GitFiles } from "./FileBrowser";
import { fileKind } from "@/lib/fileKind";
import { STATUS_COLOR } from "@/lib/gitStatusColor";
import { cn } from "@/lib/utils";
import { File as FileIcon, FileText, Image as ImageIcon, Video, X } from "lucide-react";

/**
 * The session's open files, as tabs in its tab bar. A file is a view of the session in its own right,
 * so it gets a tab of the same standing — clicking one fills the pane with that file, while Files and
 * Split show the same file beside the tree.
 *
 * The transient "preview" tab (opened by a single click) is shown in italics; double-clicking pins
 * it. Middle-click closes a tab, and FileTabsCloseAll below clears them all.
 *
 * Rendered into the tab bar's shared scroller (see TabScroll) rather than into a strip of its own,
 * so the open files and the pull requests beside them are one run of tabs with one scrollbar.
 */
export function FileTabs({
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
}: {
  tabs: FileEntry[];
  activePath: string | null;
  previewPath: string | null;
  showingFile: boolean;
  gitFiles?: GitFiles;
  onActivate: (path: string) => void;
  onPin: (path: string) => void;
  onClose: (path: string) => void;
}) {
  if (!tabs.length) return null;

  return (
    <>
      {/* Divides the views and the reviews from the files opened alongside them. */}
      <div className="my-2 w-px shrink-0 bg-border" />
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
    </>
  );
}

/**
 * The button that closes every open file tab. Outside the scrolling run the tabs are in, beside the
 * other controls: a bar scrolled to its far end must not have hidden the way to clear it.
 */
export function FileTabsCloseAll({ tabs, onCloseAll }: { tabs: FileEntry[]; onCloseAll: () => void }) {
  if (tabs.length < 2) return null;
  return (
    <button
      onClick={onCloseAll}
      title="Close all file tabs"
      className="flex h-full shrink-0 items-center border-l px-2 text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <X className="size-4" />
    </button>
  );
}
