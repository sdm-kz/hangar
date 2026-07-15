import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { DirEntry, FsNode } from "@/types";
import { fileKind } from "@/lib/fileKind";
import { cn } from "@/lib/utils";
import { RenameField } from "./RenameField";
import { Button } from "@/components/ui/button";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  FileText,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Image as ImageIcon,
  Loader2,
  Pencil,
  RefreshCw,
  Upload,
} from "lucide-react";

// Trailing path segment, used as a node's display name when the API gives an absolute path.
function baseName(p: string): string {
  const parts = p.split(/[/\\]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

// Parent directory of an absolute path (drops the last segment), or null at a drive/filesystem root.
function parentOf(p: string): string | null {
  const norm = p.replace(/[/\\]+$/, "");
  const idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  if (idx <= 0) return null;
  const parent = norm.slice(0, idx);
  // Keep the trailing slash on a Windows drive root ("C:" -> "C:\").
  return /^[A-Za-z]:$/.test(parent) ? parent + "\\" : parent;
}

function join(dir: string, name: string): string {
  const sep = dir.includes("\\") || /^[A-Za-z]:/.test(dir) ? "\\" : "/";
  return dir.replace(/[/\\]+$/, "") + sep + name;
}

function FileGlyph({ name }: { name: string }) {
  const kind = fileKind(name);
  if (kind === "image") return <ImageIcon className="size-4 shrink-0 text-muted-foreground" />;
  if (kind === "text") return <FileText className="size-4 shrink-0 text-muted-foreground" />;
  return <FileIcon className="size-4 shrink-0 text-muted-foreground" />;
}

/**
 * Whole-server filesystem tree for the sidebar Files tab. Lazily lists drives, then directories on
 * expand. Clicking a file opens it in the main content area (via <c>onOpenFile</c>); clicking a
 * folder selects it as the target for the New file / New folder / Upload actions in the toolbar.
 * Any node can be renamed inline. Absolute server paths throughout.
 */
export function FilesSidebar({
  openPath,
  onOpenFile,
  onNewSession,
}: {
  openPath: string | null; // the file currently open in the main area, for highlight
  onOpenFile: (path: string) => void;
  onNewSession: (path: string) => void; // start a session in a folder (hover action on dir rows)
}) {
  const [drives, setDrives] = useState<DirEntry[]>([]);
  const [children, setChildren] = useState<Map<string, FsNode[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [selectedDir, setSelectedDir] = useState<string | null>(null); // target for toolbar actions
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null); // tree scroll container, for scroll-into-view
  const openPathRef = useRef(openPath);
  openPathRef.current = openPath;
  const scrolledRef = useRef<string | null>(null); // last openPath we scrolled to

  const listDir = useCallback(async (path: string) => {
    setLoading((s) => new Set(s).add(path));
    try {
      const res = await api.fsList(path);
      setChildren((m) => new Map(m).set(path, res.entries));
    } catch {
      setChildren((m) => new Map(m).set(path, []));
    } finally {
      setLoading((s) => {
        const n = new Set(s);
        n.delete(path);
        return n;
      });
    }
  }, []);

  // Expand the tree down to (and select) a file's directory, loading each ancestor as needed. Used to
  // "reveal" a file opened elsewhere (a terminal link, the preview's Show-in-Files button).
  const revealPath = useCallback(
    async (filePath: string) => {
      const dir = parentOf(filePath);
      if (!dir) return;
      const chain: string[] = [];
      let cur: string | null = dir;
      while (cur) {
        chain.unshift(cur);
        cur = parentOf(cur);
      }
      setExpanded((s) => new Set([...s, ...chain]));
      setSelectedDir(dir);
      await Promise.all(chain.map(listDir));
    },
    [listDir]
  );

  // Initial load: drive roots plus a useful starting point — the open file (revealed) if one is set,
  // otherwise the default start folder, so the tree doesn't land on bare drive letters.
  useEffect(() => {
    (async () => {
      try {
        const res = await api.fsList();
        setDrives(res.drives);
        if (openPathRef.current) return; // a file is open — the reveal effect below expands to it
        if (res.current) {
          // Expand the chain from the drive root down to the default folder.
          const chain: string[] = [];
          let cur: string | null = res.current;
          while (cur) {
            chain.unshift(cur);
            cur = parentOf(cur);
          }
          setExpanded(new Set(chain));
          setSelectedDir(res.current);
          setChildren((m) => new Map(m).set(res.current!, res.entries));
          await Promise.all(chain.filter((p) => p !== res.current).map(listDir));
        }
      } catch {
        setError("Could not read the filesystem.");
      }
    })();
  }, [listDir]);

  // Reveal the open file whenever it changes (e.g. the Files tab was opened via Show-in-Files, or a
  // different terminal link was clicked while the tab is showing).
  useEffect(() => {
    if (openPath) revealPath(openPath);
  }, [openPath, revealPath]);

  // Once the revealed file's row is rendered, scroll it into view (once per open file).
  useEffect(() => {
    if (!openPath || scrolledRef.current === openPath) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-fspath="${CSS.escape(openPath)}"]`);
    if (el) {
      scrolledRef.current = openPath;
      el.scrollIntoView({ block: "center" });
    }
  }, [openPath, children]);

  const toggle = useCallback(
    (path: string) => {
      setSelectedDir(path);
      setExpanded((s) => {
        const n = new Set(s);
        if (n.has(path)) {
          n.delete(path);
        } else {
          n.add(path);
          if (!children.has(path)) listDir(path);
        }
        return n;
      });
    },
    [children, listDir]
  );

  // Reload a directory that's currently visible (after a create/rename/upload) so the tree reflects it.
  const reload = useCallback(
    (path: string | null) => {
      if (path && (expanded.has(path) || children.has(path))) listDir(path);
    },
    [expanded, children, listDir]
  );

  const doRename = useCallback(
    async (path: string, name: string) => {
      setRenaming(null);
      try {
        const res = await api.fsRename(path, name);
        reload(parentOf(path));
        // If the open file was the one renamed, follow it to its new path.
        if (openPath === path) onOpenFile(res.path);
      } catch {
        setError("Rename failed.");
      }
    },
    [reload, openPath, onOpenFile]
  );

  const newFolder = useCallback(async () => {
    if (!selectedDir) return;
    const name = window.prompt("New folder name:");
    if (!name?.trim()) return;
    try {
      await api.fsMkdir(join(selectedDir, name.trim()));
      setExpanded((s) => new Set(s).add(selectedDir));
      await listDir(selectedDir);
    } catch {
      setError("Could not create folder.");
    }
  }, [selectedDir, listDir]);

  const newFile = useCallback(async () => {
    if (!selectedDir) return;
    const name = window.prompt("New file name:");
    if (!name?.trim()) return;
    try {
      const res = await api.fsNewFile(join(selectedDir, name.trim()));
      setExpanded((s) => new Set(s).add(selectedDir));
      await listDir(selectedDir);
      onOpenFile(res.path); // open the empty file straight into the editor
    } catch {
      setError("Could not create file (it may already exist).");
    }
  }, [selectedDir, listDir, onOpenFile]);

  const onUpload = useCallback(
    async (files: FileList | null) => {
      if (!selectedDir || !files || files.length === 0) return;
      try {
        await api.fsUpload(selectedDir, Array.from(files));
        setExpanded((s) => new Set(s).add(selectedDir));
        await listDir(selectedDir);
      } catch {
        setError("Upload failed.");
      }
    },
    [selectedDir, listDir]
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar: actions target the selected folder. */}
      <div className="flex items-center gap-0.5 border-b px-2 py-1.5">
        <span className="mr-auto truncate text-xs text-muted-foreground" title={selectedDir ?? undefined}>
          {selectedDir ? baseName(selectedDir) : "Select a folder"}
        </span>
        <Button variant="ghost" size="icon" className="size-7" title="New file" disabled={!selectedDir} onClick={newFile}>
          <FilePlus className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" className="size-7" title="New folder" disabled={!selectedDir} onClick={newFolder}>
          <FolderPlus className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          title="Upload files"
          disabled={!selectedDir}
          onClick={() => uploadRef.current?.click()}
        >
          <Upload className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          title="Refresh"
          onClick={() => reload(selectedDir)}
        >
          <RefreshCw className="size-4" />
        </Button>
        <input
          ref={uploadRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            onUpload(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {error && (
        <div className="border-b bg-destructive/10 px-2 py-1 text-xs text-destructive" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto py-1">
        {drives.map((d) => (
          <TreeNode
            key={d.path}
            path={d.path}
            name={d.name}
            isDir
            isDrive
            depth={0}
            openPath={openPath}
            selectedDir={selectedDir}
            expanded={expanded}
            loading={loading}
            children_={children}
            renaming={renaming}
            onToggle={toggle}
            onOpenFile={onOpenFile}
            onNewSession={onNewSession}
            onStartRename={setRenaming}
            onRename={doRename}
            onCancelRename={() => setRenaming(null)}
          />
        ))}
      </div>
    </div>
  );
}

// A single row plus (for an expanded directory) its recursively-rendered children.
function TreeNode({
  path,
  name,
  isDir,
  isDrive = false,
  depth,
  openPath,
  selectedDir,
  expanded,
  loading,
  children_,
  renaming,
  onToggle,
  onOpenFile,
  onNewSession,
  onStartRename,
  onRename,
  onCancelRename,
}: {
  path: string;
  name: string;
  isDir: boolean;
  isDrive?: boolean;
  depth: number;
  openPath: string | null;
  selectedDir: string | null;
  expanded: Set<string>;
  loading: Set<string>;
  children_: Map<string, FsNode[]>;
  renaming: string | null;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
  onNewSession: (path: string) => void;
  onStartRename: (path: string) => void;
  onRename: (path: string, name: string) => void;
  onCancelRename: () => void;
}) {
  const isOpen = expanded.has(path);
  const isBusy = loading.has(path);
  const kids = children_.get(path);
  const active = !isDir && openPath === path;
  const selected = isDir && selectedDir === path;

  return (
    <div>
      <div
        data-fspath={path}
        className={cn(
          "group flex items-center gap-1 rounded px-1 py-0.5 text-sm",
          "cursor-pointer hover:bg-accent",
          active && "bg-accent font-medium",
          selected && "bg-accent/50"
        )}
        style={{ paddingLeft: depth * 12 + 4 }}
        onClick={() => (isDir ? onToggle(path) : onOpenFile(path))}
      >
        {isDir ? (
          isOpen ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <span className="w-4 shrink-0" />
        )}
        {isDrive ? (
          <HardDrive className="size-4 shrink-0 text-muted-foreground" />
        ) : isDir ? (
          isOpen ? <FolderOpen className="size-4 shrink-0 text-sky-500" /> : <Folder className="size-4 shrink-0 text-sky-500" />
        ) : (
          <FileGlyph name={name} />
        )}

        {renaming === path ? (
          <RenameField value={name} onSubmit={(n) => onRename(path, n)} onCancel={onCancelRename} />
        ) : (
          <span className="min-w-0 flex-1 truncate">{name}</span>
        )}

        {isBusy && <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />}
        {/* Start a Claude session in this folder — hover action on any directory row. */}
        {isDir && renaming !== path && (
          <button
            className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground group-hover:block"
            title="New session in this folder"
            onClick={(e) => {
              e.stopPropagation();
              onNewSession(path);
            }}
          >
            <Bot className="size-3.5" />
          </button>
        )}
        {/* Drives can't be renamed; everything else can, via a hover pencil. */}
        {!isDrive && renaming !== path && (
          <button
            className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground group-hover:block"
            title="Rename"
            onClick={(e) => {
              e.stopPropagation();
              onStartRename(path);
            }}
          >
            <Pencil className="size-3" />
          </button>
        )}
      </div>

      {isDir && isOpen && kids && (
        <div>
          {kids.length === 0 ? (
            <div className="px-1 py-0.5 text-xs text-muted-foreground" style={{ paddingLeft: (depth + 1) * 12 + 20 }}>
              empty
            </div>
          ) : (
            kids.map((c) => (
              <TreeNode
                key={c.path}
                path={c.path}
                name={c.name}
                isDir={c.isDir}
                depth={depth + 1}
                openPath={openPath}
                selectedDir={selectedDir}
                expanded={expanded}
                loading={loading}
                children_={children_}
                renaming={renaming}
                onToggle={onToggle}
                onOpenFile={onOpenFile}
                onNewSession={onNewSession}
                onStartRename={onStartRename}
                onRename={onRename}
                onCancelRename={onCancelRename}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
