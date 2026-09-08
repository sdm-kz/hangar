import { useCallback, useEffect, useRef, useState, type UIEvent } from "react";
import { api } from "@/lib/api";
import type { DirEntry, FsNode } from "@/types";
import { fileKind } from "@/lib/fileKind";
import { cn } from "@/lib/utils";
import { useTreeKeyNav, navRowProps } from "@/lib/useTreeKeyNav";
import { useConfirm } from "@/components/ui/confirm";
import { RenameField } from "./RenameField";
import { CopyPathButton } from "./CopyPathButton";
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
  TerminalSquare,
  HardDrive,
  Image as ImageIcon,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
  Video,
} from "lucide-react";

// Which folders are expanded in the tree is a per-browser preference, remembered across refreshes so
// the tree comes back the way you left it instead of collapsing to the default start folder.
const EXPANDED_KEY = "claudeweb.filesExpanded";
function loadExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}
function saveExpanded(set: Set<string>) {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...set]));
  } catch {
    /* storage disabled — preference is best-effort */
  }
}

// The rest of the tree's view state, remembered the same way: which folder the toolbar actions target,
// and how far the tree is scrolled. The panel unmounts whenever the sidebar switches to Sessions, so
// without this every trip back to Files (and every refresh) would drop you at the top of the tree.
const SELECTED_KEY = "claudeweb.filesSelectedDir";
const SCROLL_KEY = "claudeweb.filesScroll";
function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStored(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage disabled — preference is best-effort */
  }
}

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
  if (kind === "video") return <Video className="size-4 shrink-0 text-muted-foreground" />;
  if (kind === "text") return <FileText className="size-4 shrink-0 text-muted-foreground" />;
  return <FileIcon className="size-4 shrink-0 text-muted-foreground" />;
}

/**
 * Whole-server filesystem tree for the sidebar Files tab. Lazily lists drives, then directories on
 * expand. Clicking a file opens it in the main content area (via <c>onOpenFile</c>); clicking a
 * folder selects it as the target for the New session / New file / New folder / Upload toolbar actions.
 * Any node can be renamed inline. Absolute server paths throughout.
 */
export function FilesSidebar({
  openPath,
  revealDir,
  revealToken = 0,
  onOpenFile,
  onNewSession,
  onOpenShell,
}: {
  openPath: string | null; // the file currently open in the main area, for highlight
  revealDir?: string | null; // a folder to jump to, asked for from outside the tree
  revealToken?: number; // bumped per request, so asking for the same folder twice goes back to it
  onOpenFile: (path: string) => void;
  onNewSession: (path: string) => void; // start a session in a folder (hover action on dir rows)
  onOpenShell: (path: string) => void; // open a shell in a folder (hover action on dir rows)
}) {
  const confirm = useConfirm();
  const [drives, setDrives] = useState<DirEntry[]>([]);
  const [children, setChildren] = useState<Map<string, FsNode[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded);
  const [loading, setLoading] = useState<Set<string>>(new Set());
  // Target for toolbar actions; restored from the last visit so the toolbar isn't disabled on arrival.
  const [selectedDir, setSelectedDir] = useState<string | null>(() => readStored(SELECTED_KEY));
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false); // has the initial batch of folder listings landed?
  const uploadRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null); // tree scroll container, for scroll-into-view
  const openPathRef = useRef(openPath);
  openPathRef.current = openPath;
  const revealDirRef = useRef(revealDir);
  revealDirRef.current = revealDir;
  const scrolledRef = useRef<string | null>(null); // last openPath we scrolled to
  const scrolledDirRef = useRef<number | null>(null); // last reveal-a-folder request we scrolled to
  const restoredScrollRef = useRef(false); // have we replayed the remembered scroll offset yet?
  const saveScrollRef = useRef<number | undefined>(undefined); // debounce timer for scroll writes

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

  // Expand the tree down to (and select) a directory, loading each ancestor as needed.
  const expandTo = useCallback(
    async (dir: string) => {
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

  // "Reveal" a file opened elsewhere (a terminal link, the preview's Show-in-Files button) — which
  // means opening the folder holding it, since that is what the tree can point at.
  const revealPath = useCallback(
    async (filePath: string) => {
      const dir = parentOf(filePath);
      if (dir) await expandTo(dir);
    },
    [expandTo]
  );

  // Remember the expanded-folder set across refreshes.
  useEffect(() => {
    saveExpanded(expanded);
  }, [expanded]);

  // ...and the selected folder alongside it.
  useEffect(() => {
    writeStored(SELECTED_KEY, selectedDir);
  }, [selectedDir]);

  // Replay the remembered scroll offset, but only once the restored folders have finished listing.
  // Scrolling earlier is worse than not scrolling at all: rows keep arriving above the viewport, and
  // the browser's scroll anchoring drags the offset along with them, landing somewhere arbitrary.
  // Staying at the top until the tree is complete keeps anchoring inert (it doesn't act at offset 0).
  const settled = ready && loading.size === 0; // no listing still in flight, so no more rows coming
  useEffect(() => {
    if (restoredScrollRef.current || !settled) return;
    const box = scrollRef.current;
    if (!box) return;
    const target = Number(readStored(SCROLL_KEY) ?? 0);
    if (!(target > 0)) {
      restoredScrollRef.current = true;
      return;
    }
    if (box.scrollHeight - box.clientHeight < target) return; // a listing is still outstanding
    box.scrollTop = target;
    restoredScrollRef.current = true;
  }, [settled, drives, children]);

  // Remember where the tree is scrolled to, debounced so a flick doesn't hammer localStorage. Scrolls
  // that happen while the tree is still filling in aren't the user's doing (anchoring again), so they
  // neither overwrite the remembered offset nor cancel the pending restore.
  const onScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      if (!restoredScrollRef.current && !settled) return;
      restoredScrollRef.current = true; // the view is where it's wanted now; don't jump it later
      const top = Math.round(e.currentTarget.scrollTop);
      window.clearTimeout(saveScrollRef.current);
      saveScrollRef.current = window.setTimeout(() => writeStored(SCROLL_KEY, String(top)), 150);
    },
    [settled]
  );

  // Initial load: drive roots plus a useful starting point. Priority: (1) restore the folders the user
  // had expanded last time, (2) reveal the open file, (3) fall back to the default start folder so the
  // tree doesn't land on bare drive letters.
  useEffect(() => {
    (async () => {
      try {
        const res = await api.fsList();
        setDrives(res.drives);
        // Restore the remembered tree: load every persisted-expanded folder so its rows render.
        const persisted = loadExpanded();
        if (persisted.size > 0) {
          // Keep the folder that was selected last time; only fall back to the default start folder.
          if (res.current && !readStored(SELECTED_KEY) && !revealDirRef.current) setSelectedDir(res.current);
          await Promise.all([...persisted].map(listDir));
          return;
        }
        // A file is open, or a folder was asked for — the reveal effects below expand to those
        // instead of to the default start folder.
        if (openPathRef.current || revealDirRef.current) return;
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
      } finally {
        setReady(true); // the tree is as complete as it's going to get — safe to replay the scroll
      }
    })();
  }, [listDir]);

  // Reveal the open file whenever it changes (e.g. the Files tab was opened via Show-in-Files, or a
  // different terminal link was clicked while the tab is showing).
  useEffect(() => {
    if (openPath) revealPath(openPath);
  }, [openPath, revealPath]);

  // Jump to a folder asked for from outside — a session row's "show folder in Files". Keyed on the
  // token rather than the path so a second ask for the same folder takes you back to it, and it
  // claims the scroll restore: this reveal is where the tree is meant to be, not where it was left.
  useEffect(() => {
    if (!revealDir) return;
    restoredScrollRef.current = true;
    void expandTo(revealDir);
  }, [revealDir, revealToken, expandTo]);

  // ...and scroll to it once its row exists, on the same terms as the file scroll below.
  useEffect(() => {
    if (!revealDir || scrolledDirRef.current === revealToken) return;
    const box = scrollRef.current;
    const el = box?.querySelector<HTMLElement>(`[data-fspath="${CSS.escape(revealDir)}"]`);
    if (!box || !el) return;
    scrolledDirRef.current = revealToken;
    const c = box.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.top >= c.top && r.bottom <= c.bottom) return;
    el.scrollIntoView({ block: "center" });
  }, [revealDir, revealToken, children]);

  // Once the revealed file's row is rendered, scroll it into view (once per open file). Rows that are
  // already visible stay put — otherwise clicking from one file to the next re-centres the tree and
  // nudges it a line under the cursor.
  useEffect(() => {
    if (!openPath || scrolledRef.current === openPath) return;
    const box = scrollRef.current;
    const el = box?.querySelector<HTMLElement>(`[data-fspath="${CSS.escape(openPath)}"]`);
    if (!box || !el) return;
    scrolledRef.current = openPath;
    const c = box.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.top >= c.top && r.bottom <= c.bottom) return;
    el.scrollIntoView({ block: "center" });
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

  // Walk the tree with the arrow keys: ↑/↓ step row to row (opening each file they land on, so a
  // folder of files can be read through without the mouse), → / Enter open a folder, ← close it.
  const treeKeys = useTreeKeyNav({
    containerRef: scrollRef,
    onFocusFile: onOpenFile,
    onToggleDir: toggle,
  });

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

  const doDelete = useCallback(
    async (path: string, isDir: boolean) => {
      const ok = await confirm({
        title: `Delete ${isDir ? "folder" : "file"}?`,
        description: (
          <>
            Permanently delete <span className="font-medium text-foreground">{baseName(path)}</span>
            {isDir && " and everything inside it"}.
          </>
        ),
        confirmLabel: "Delete",
      });
      if (!ok) return;
      try {
        await api.fsDelete(path);
        reload(parentOf(path));
      } catch {
        setError("Delete failed.");
      }
    },
    [confirm, reload, openPath, onOpenFile]
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
        {/* Same action as the row's hover button, reachable where there is no hover (touch). */}
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          title="New session in this folder"
          disabled={!selectedDir}
          onClick={() => selectedDir && onNewSession(selectedDir)}
        >
          <Bot className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          title="Open a shell in this folder"
          disabled={!selectedDir}
          onClick={() => selectedDir && onOpenShell(selectedDir)}
        >
          <TerminalSquare className="size-4" />
        </Button>
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

      <div
        ref={scrollRef}
        onScroll={onScroll}
        {...treeKeys}
        className="min-h-0 flex-1 overflow-auto py-1 outline-none"
      >
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
            onOpenShell={onOpenShell}
            onStartRename={setRenaming}
            onRename={doRename}
            onCancelRename={() => setRenaming(null)}
            onDelete={doDelete}
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
  onOpenShell,
  onStartRename,
  onRename,
  onCancelRename,
  onDelete,
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
  onOpenShell: (path: string) => void;
  onStartRename: (path: string) => void;
  onRename: (path: string, name: string) => void;
  onCancelRename: () => void;
  onDelete: (path: string, isDir: boolean) => void;
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
        {...navRowProps({ path, isDir, open: isOpen, current: active || selected, depth })}
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
        {/* Copy the absolute path — available on drives, folders and files alike. */}
        {renaming !== path && (
          <CopyPathButton
            path={path}
            iconClassName="size-3"
            className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground group-hover:block"
          />
        )}
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
        {/* Open a shell in this folder — hover action on any directory row. */}
        {isDir && renaming !== path && (
          <button
            className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground group-hover:block"
            title="Open a shell in this folder"
            onClick={(e) => {
              e.stopPropagation();
              onOpenShell(path);
            }}
          >
            <TerminalSquare className="size-3.5" />
          </button>
        )}
        {/* Drives can't be renamed/deleted; everything else can, via hover actions. */}
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
        {!isDrive && renaming !== path && (
          <button
            className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-destructive group-hover:block"
            title="Delete"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(path, isDir);
            }}
          >
            <Trash2 className="size-3" />
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
                onOpenShell={onOpenShell}
                onStartRename={onStartRename}
                onRename={onRename}
                onCancelRename={onCancelRename}
                onDelete={onDelete}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
