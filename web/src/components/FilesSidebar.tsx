import { useCallback, useEffect, useRef, useState, type UIEvent } from "react";
import { useApi, useNodeId } from "@/lib/node";
import type { DirEntry, FsNode } from "@/types";
import { fileKind } from "@/lib/fileKind";
import { cn } from "@/lib/utils";
import { useTreeKeyNav, navRowProps } from "@/lib/useTreeKeyNav";
import { useMarkedPaths, withoutDescendants, type MarkedPaths } from "@/lib/useMarkedPaths";
import { useConfirm } from "@/components/ui/confirm";
import { RenameField } from "./RenameField";
import { CopyPathButton } from "./CopyPathButton";
import { ToolbarMore, type ToolAction } from "./ToolbarMore";
import { Button } from "@/components/ui/button";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CornerDownLeft,
  File as FileIcon,
  FileText,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  TerminalSquare,
  HardDrive,
  Image as ImageIcon,
  ListChecks,
  Loader2,
  Pencil,
  RefreshCw,
  Square,
  SquareCheck,
  Trash2,
  Upload,
  Video,
} from "lucide-react";

// Which folders are expanded in the tree is a per-browser preference, remembered across refreshes so
// the tree comes back the way you left it instead of collapsing to the default start folder. The rest
// of the tree's view state is remembered the same way: which folder the toolbar actions target, and how
// far the tree is scrolled. The panel unmounts whenever the sidebar switches to Sessions, so without
// this every trip back to Files (and every refresh) would drop you at the top of the tree.
// Each machine's tree keeps its own: this one's under the keys it always had, a peer's under its id.
function storeKeys(node: string | null) {
  const of = (key: string) => (node ? `${key}:${node}` : key);
  return { expanded: of("hangar.filesExpanded"), selected: of("hangar.filesSelectedDir"), scroll: of("hangar.filesScroll") };
}
function loadExpanded(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}
function saveExpanded(key: string, set: Set<string>) {
  try {
    localStorage.setItem(key, JSON.stringify([...set]));
  } catch {
    /* storage disabled — preference is best-effort */
  }
}

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
  if (idx < 0) return null;
  // "/home" sits under "/", the one root a Unix tree has; "/" itself sits under nothing.
  if (idx === 0) return norm.length > 1 && norm[0] === "/" ? "/" : null;
  const parent = norm.slice(0, idx);
  // Keep the trailing slash on a Windows drive root ("C:" -> "C:\").
  return /^[A-Za-z]:$/.test(parent) ? parent + "\\" : parent;
}

// Whether a folder's row is on screen: every folder above it is open. Drive roots have nothing above.
function isVisible(dir: string, expanded: Set<string>): boolean {
  for (let p = parentOf(dir); p; p = parentOf(p)) if (!expanded.has(p)) return false;
  return true;
}

function join(dir: string, name: string): string {
  const sep = dir.includes("\\") || /^[A-Za-z]:/.test(dir) ? "\\" : "/";
  return dir.replace(/[/\\]+$/, "") + sep + name;
}

// How many folders one press of "expand one more level" opens at most. A level under a folder like
// node_modules is hundreds of listings at once; the next press carries on from where this one stopped.
const EXPAND_BATCH = 40;

// The toolbar's geometry, for working out how many of its buttons fit: each is a 28px square with a
// 2px gap, and the folder name keeps at least this much of the row.
const TOOL_SLOT = 30;
const LABEL_MIN = 56;

function FileGlyph({ name }: { name: string }) {
  const kind = fileKind(name);
  if (kind === "image") return <ImageIcon className="size-4 shrink-0 text-muted-foreground" />;
  if (kind === "video") return <Video className="size-4 shrink-0 text-muted-foreground" />;
  if (kind === "text") return <FileText className="size-4 shrink-0 text-muted-foreground" />;
  return <FileIcon className="size-4 shrink-0 text-muted-foreground" />;
}

/**
 * Whole-server filesystem tree for the sidebar Files tab: the disk of the machine its NodeProvider names
 * (this one, or a paired peer's, read through it). Lazily lists drives, then directories on
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
  onOpenShell?: (path: string) => void; // open a shell in a folder (hover action on dir rows); not on a peer
}) {
  const api = useApi();
  const keys = storeKeys(useNodeId());
  const confirm = useConfirm();
  const [drives, setDrives] = useState<DirEntry[]>([]);
  const [children, setChildren] = useState<Map<string, FsNode[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => loadExpanded(keys.expanded));
  const [loading, setLoading] = useState<Set<string>>(new Set());
  // Target for toolbar actions; restored from the last visit so the toolbar isn't disabled on arrival.
  const [selectedDir, setSelectedDir] = useState<string | null>(() => readStored(keys.selected));
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false); // has the initial batch of folder listings landed?
  const uploadRef = useRef<HTMLInputElement>(null);
  // The address field: open while a path is being typed, what is typed, and why the last one led
  // nowhere. `goTo` is the row a successful jump still has to scroll to, once its folder has listed.
  const [addressOpen, setAddressOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [addressError, setAddressError] = useState<string | null>(null);
  const [goingTo, setGoingTo] = useState(false);
  const [goTo, setGoTo] = useState<string | null>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const addressButtonRef = useRef<HTMLButtonElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null); // tree scroll container, for scroll-into-view
  const openPathRef = useRef(openPath);
  openPathRef.current = openPath;
  const revealDirRef = useRef(revealDir);
  revealDirRef.current = revealDir;
  const scrolledRef = useRef<string | null>(null); // last openPath we scrolled to
  const scrolledDirRef = useRef<number | null>(null); // last reveal-a-folder request we scrolled to
  const restoredScrollRef = useRef(false); // have we replayed the remembered scroll offset yet?
  const saveScrollRef = useRef<number | undefined>(undefined); // debounce timer for scroll writes
  // Rows marked for a batch action. The tree is the range gesture's frame of reference, so it is the
  // scroll container -- the element the rows live in -- that the hook reads their order from.
  const mark = useMarkedPaths(scrollRef);

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
  }, [api]);

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
    saveExpanded(keys.expanded, expanded);
  }, [keys.expanded, expanded]);

  // List any folder that is open and on screen but has no listing yet: one remembered open inside a
  // parent that has just been reopened, or one "expand one more level" opened. A failed listing
  // stores an empty one, so nothing here is asked for twice.
  useEffect(() => {
    if (!ready) return; // the initial load lists what it needs itself
    for (const dir of expanded)
      if (!children.has(dir) && !loading.has(dir) && isVisible(dir, expanded)) void listDir(dir);
  }, [ready, expanded, children, loading, listDir]);

  // ...and the selected folder alongside it.
  useEffect(() => {
    writeStored(keys.selected, selectedDir);
  }, [keys.selected, selectedDir]);

  // Replay the remembered scroll offset, but only once the restored folders have finished listing.
  // Scrolling earlier is worse than not scrolling at all: rows keep arriving above the viewport, and
  // the browser's scroll anchoring drags the offset along with them, landing somewhere arbitrary.
  // Staying at the top until the tree is complete keeps anchoring inert (it doesn't act at offset 0).
  const settled = ready && loading.size === 0; // no listing still in flight, so no more rows coming
  useEffect(() => {
    if (restoredScrollRef.current || !settled) return;
    const box = scrollRef.current;
    if (!box) return;
    const target = Number(readStored(keys.scroll) ?? 0);
    if (!(target > 0)) {
      restoredScrollRef.current = true;
      return;
    }
    if (box.scrollHeight - box.clientHeight < target) return; // a listing is still outstanding
    box.scrollTop = target;
    restoredScrollRef.current = true;
  }, [settled, drives, children, keys.scroll]);

  // Remember where the tree is scrolled to, debounced so a flick doesn't hammer localStorage. Scrolls
  // that happen while the tree is still filling in aren't the user's doing (anchoring again), so they
  // neither overwrite the remembered offset nor cancel the pending restore.
  const onScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      if (!restoredScrollRef.current && !settled) return;
      restoredScrollRef.current = true; // the view is where it's wanted now; don't jump it later
      const top = Math.round(e.currentTarget.scrollTop);
      window.clearTimeout(saveScrollRef.current);
      saveScrollRef.current = window.setTimeout(() => writeStored(keys.scroll, String(top)), 150);
    },
    [settled, keys.scroll]
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
        const persisted = loadExpanded(keys.expanded);
        if (persisted.size > 0) {
          // Keep the folder that was selected last time; only fall back to the default start folder.
          if (res.current && !readStored(keys.selected) && !revealDirRef.current) setSelectedDir(res.current);
          // Only the ones that will be on screen. The set also remembers folders left open inside ones
          // since closed, and listing those up front is work nobody sees; the effect below lists them
          // when a parent opening brings them back into view.
          await Promise.all([...persisted].filter((d) => isVisible(d, persisted)).map(listDir));
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

  // Jump to a typed path. The server resolves it -- either slash, quotes, ~, relative to the selected
  // folder -- to the folder's real on-disk spelling, which is what the tree's rows are keyed by; a
  // file resolves to the folder holding it, and the file's row is the one scrolled to.
  const openAddress = useCallback(() => {
    setAddress(selectedDir ?? "");
    setAddressError(null);
    setAddressOpen(true);
  }, [selectedDir]);

  // Focus goes back to the button that opened the field, rather than falling to the page.
  const closeAddress = useCallback(() => {
    setAddressOpen(false);
    setAddressError(null);
    requestAnimationFrame(() =>
      // The button, or -- when it has moved into the "more" menu -- the menu's own button.
      (addressButtonRef.current ?? moreButtonRef.current)?.focus()
    );
  }, []);

  const goToAddress = useCallback(async () => {
    const typed = address.trim();
    if (!typed || goingTo) return;
    setGoingTo(true);
    setAddressError(null);
    try {
      const res = await api.fsResolve(typed, selectedDir);
      if (!res.found || !res.dir) {
        setAddressError(res.error ?? "Nothing at that path.");
        return;
      }
      // This jump is where the tree is meant to be, so the remembered scroll must not undo it.
      restoredScrollRef.current = true;
      const target = res.file ?? res.dir;
      setGoTo(target);
      setAddressOpen(false);
      await expandTo(res.dir);
      // Every listing on the way down has landed, so the row is there by the next paint or not at
      // all (a listing that failed). Either way the jump is over: a target left standing would yank
      // the tree to it the next time that folder happened to list, long after anyone asked.
      window.setTimeout(() => setGoTo((cur) => (cur === target ? null : cur)), 500);
    } catch {
      setAddressError("Could not look that path up.");
    } finally {
      setGoingTo(false);
    }
  }, [address, goingTo, selectedDir, expandTo]);

  // Select the whole path when the field opens, so typing replaces it and a paste lands clean.
  useEffect(() => {
    if (addressOpen) addressRef.current?.select();
  }, [addressOpen]);

  // ...and scroll the jumped-to row into view once it exists -- always centred, unlike the reveals
  // above: a jump is a deliberate move somewhere else, so there is no position to preserve.
  useEffect(() => {
    if (!goTo) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-fspath="${CSS.escape(goTo)}"]`);
    if (!el) return;
    setGoTo(null);
    el.scrollIntoView({ block: "center" });
    // Focus lands on the row, so the arrow keys carry on from where the jump arrived.
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-nav-row="${CSS.escape(goTo)}"]`)
      ?.focus({ preventScroll: true });
  }, [goTo, children]);

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

  /**
   * Delete everything marked, behind one confirmation that names what is going.
   *
   * The names are spelled out rather than counted. A mark survives its folder being collapsed, so a
   * selection can hold rows that are no longer on screen, and "Delete 7 items?" would be asking for
   * a yes to something the answer cannot be seen from. Folders are spelled out for a second reason:
   * a folder takes everything inside it, which no count says either.
   */
  const deleteMarked = useCallback(async () => {
    const paths = withoutDescendants([...mark.marked.keys()]);
    if (paths.length === 0) return;
    const dirs = paths.filter((p) => mark.marked.get(p)).length;
    const ok = await confirm({
      title: `Delete ${paths.length} item${paths.length === 1 ? "" : "s"}?`,
      description: (
        <>
          <span className="mb-2 block">
            Permanently delete{dirs > 0 && " these, and everything inside the folders"}:
          </span>
          <span className="block max-h-40 overflow-y-auto">
            {paths.map((path) => (
              <span key={path} className="block truncate font-mono text-xs text-foreground" title={path}>
                {mark.marked.get(path) ? "📁 " : ""}
                {baseName(path)}
              </span>
            ))}
          </span>
        </>
      ),
      confirmLabel: `Delete ${paths.length}`,
    });
    if (!ok) return;
    const failed: string[] = [];
    // One at a time, and every one attempted: a folder that refuses to go (a file open in it, a
    // permission) is no reason to leave the rest of the selection standing.
    for (const path of paths) {
      try {
        await api.fsDelete(path);
      } catch {
        failed.push(baseName(path));
      }
    }
    for (const parent of new Set(paths.map(parentOf))) reload(parent);
    mark.clear();
    if (failed.length > 0)
      setError(
        failed.length === paths.length
          ? "Delete failed."
          : `Deleted ${paths.length - failed.length}, could not delete: ${failed.join(", ")}.`
      );
  }, [mark, confirm, reload]);

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

  // Open one more level under the selected folder: the shallowest folders in its subtree that are
  // showing but closed. A whole-filesystem tree has no safe "expand everything" -- a drive is millions
  // of entries -- so each press goes one level deeper instead, EXPAND_BATCH folders at a time, and
  // breadth first, so a level too big for one press is finished by the next before going deeper.
  const expandLevel = useCallback(() => {
    if (!selectedDir) return;
    // Folded out of sight (Collapse all, or a parent closed by hand): bring it back into view first,
    // or the press would open folders nobody can see.
    if (!isVisible(selectedDir, expanded)) {
      void expandTo(selectedDir);
      return;
    }
    const frontier: string[] = [];
    const queue = [selectedDir];
    while (queue.length && frontier.length < EXPAND_BATCH) {
      const dir = queue.shift()!;
      if (!expanded.has(dir)) frontier.push(dir);
      else for (const c of children.get(dir) ?? []) if (c.isDir) queue.push(c.path);
    }
    if (frontier.length === 0) return;
    // The listings follow from the effect above, which lists every open folder on screen that has none.
    setExpanded((s) => new Set([...s, ...frontier]));
  }, [selectedDir, expanded, children, expandTo]);

  // Fold the whole tree back to its drives. The selected folder stays selected -- the toolbar still
  // acts on it, and the address field still opens on it -- it just isn't on screen.
  const collapseAll = useCallback(() => {
    setExpanded(new Set());
    scrollRef.current?.scrollTo({ top: 0 });
    // The top is where the tree is now meant to be: a scroll restore still pending must not undo
    // that, and an already-top tree fires no scroll event to record it.
    restoredScrollRef.current = true;
    writeStored(keys.scroll, "0");
  }, [keys.scroll]);

  // Everything the toolbar offers, most-used first: when the panel is too narrow for all of them,
  // the ones at the end move into the "more" menu, so what stays out is what is reached for most.
  const actions: ToolAction[] = [
    {
      id: "goto",
      label: "Go to a folder or file by its path",
      icon: <FolderSearch className="size-4" />,
      onClick: () => (addressOpen ? closeAddress() : openAddress()),
      pressed: addressOpen,
    },
    {
      // Same action as the row's hover button, reachable where there is no hover (touch).
      id: "session",
      label: "New session in this folder",
      icon: <Bot className="size-4" />,
      onClick: () => selectedDir && onNewSession(selectedDir),
      disabled: !selectedDir,
    },
    ...(onOpenShell
      ? [
          {
            id: "shell",
            label: "Open a shell in this folder",
            icon: <TerminalSquare className="size-4" />,
            onClick: () => selectedDir && onOpenShell(selectedDir),
            disabled: !selectedDir,
          },
        ]
      : []),
    { id: "file", label: "New file", icon: <FilePlus className="size-4" />, onClick: newFile, disabled: !selectedDir },
    { id: "folder", label: "New folder", icon: <FolderPlus className="size-4" />, onClick: newFolder, disabled: !selectedDir },
    {
      id: "upload",
      label: "Upload files",
      icon: <Upload className="size-4" />,
      onClick: () => uploadRef.current?.click(),
      disabled: !selectedDir,
    },
    {
      id: "expand",
      // The folder it acts on is the one named at the toolbar's left, so the label needn't repeat it.
      label: "Expand one more level",
      icon: <ChevronsUpDown className="size-4" />,
      onClick: expandLevel,
      disabled: !selectedDir,
    },
    { id: "collapse", label: "Collapse all", icon: <ChevronsDownUp className="size-4" />, onClick: collapseAll },
    {
      // The way into select mode where there is no hover to reveal a row's own box, and a plain
      // way out of it once there is nothing marked left to act on.
      id: "select",
      label: mark.selecting ? "Leave select mode" : "Select files",
      icon: <ListChecks className="size-4" />,
      onClick: () => (mark.selecting ? mark.clear() : mark.start()),
      pressed: mark.selecting,
    },
    { id: "refresh", label: "Refresh", icon: <RefreshCw className="size-4" />, onClick: () => reload(selectedDir) },
  ];

  // How many of them fit beside the folder name, re-measured whenever the panel is resized. Null
  // until the first measurement, which draws them all -- the common case, and no flash of a menu.
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbarWidth, setToolbarWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    // The content box: the row's padding is already out of it.
    const ro = new ResizeObserver(([entry]) => setToolbarWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const room = toolbarWidth === null ? Infinity : toolbarWidth - LABEL_MIN;
  const fitsAll = actions.length * TOOL_SLOT <= room;
  // When they don't all fit, one slot goes to the menu button itself.
  const shown = fitsAll ? actions.length : Math.max(0, Math.floor(room / TOOL_SLOT) - 1);
  const inline = actions.slice(0, shown);
  const overflow = actions.slice(shown);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar: actions target the selected folder. Too narrow for all of them, and the ones at
          the end of the list move into a "more" menu rather than squeezing the folder name out. */}
      <div ref={toolbarRef} className="flex items-center gap-0.5 border-b px-2 py-1.5">
        {/* The folder's name doubles as the way into the address field: it is where a path would be
            shown anyway, and the toolbar has no width left for a field of its own. */}
        <button
          type="button"
          onClick={() => (addressOpen ? closeAddress() : openAddress())}
          className="mr-auto min-w-0 truncate rounded px-1 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          title={selectedDir ? `${selectedDir} — click to go to another path` : "Go to a path"}
        >
          {selectedDir ? baseName(selectedDir) : "Select a folder"}
        </button>
        {inline.map((a) => (
          <Button
            key={a.id}
            ref={a.id === "goto" ? addressButtonRef : undefined}
            variant="ghost"
            size="icon"
            className={cn("size-7 shrink-0", a.pressed && "text-foreground")}
            title={a.label}
            aria-label={a.label}
            aria-pressed={a.pressed}
            disabled={a.disabled}
            onClick={a.onClick}
          >
            {a.icon}
          </Button>
        ))}
        {overflow.length > 0 && <ToolbarMore actions={overflow} buttonRef={moreButtonRef} />}
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

      {/* The address field: a folder or a file, written either way round. Enter goes, Escape leaves. */}
      {addressOpen && (
        <div className="border-b px-2 py-1.5">
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              void goToAddress();
            }}
          >
            <input
              ref={addressRef}
              value={address}
              autoFocus
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder={"C:\\path\\to\\folder, or /path/to/file"}
              aria-label="Path to go to"
              onChange={(e) => {
                setAddress(e.target.value);
                setAddressError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  closeAddress();
                }
              }}
              className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <Button
              type="submit"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              title="Go (Enter)"
              disabled={!address.trim() || goingTo}
            >
              {goingTo ? <Loader2 className="size-4 animate-spin" /> : <CornerDownLeft className="size-4" />}
            </Button>
          </form>
          {addressError && <p className="mt-1 text-xs text-destructive">{addressError}</p>}
        </div>
      )}

      {error && (
        <div className="border-b bg-destructive/10 px-2 py-1 text-xs text-destructive" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {/* What is marked and what can be done with it. Shown from the moment select mode starts, so
          the mode always says out loud that it is on -- an empty tree of boxes with no explanation
          is how you end up clicking a file and wondering why it did not open. */}
      {mark.selecting && (
        <div className="flex items-center gap-1 border-b bg-accent/40 px-2 py-1 text-xs">
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {mark.count > 0 ? `${mark.count} selected` : "Select files and folders"}
          </span>
          <Button
            variant="destructive"
            size="sm"
            className="h-6 gap-1 px-2 text-xs"
            disabled={mark.count === 0}
            onClick={() => void deleteMarked()}
          >
            <Trash2 className="size-3" />
            Delete
          </Button>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={mark.clear}>
            Cancel
          </Button>
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={onScroll}
        {...treeKeys}
        // Escape is the way out of a selection, ahead of the tree's own keys -- which do not use it.
        onKeyDown={(e) => {
          if (e.key === "Escape" && mark.selecting) {
            e.preventDefault();
            mark.clear();
            return;
          }
          treeKeys.onKeyDown?.(e);
        }}
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
            mark={mark}
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
  mark,
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
  onOpenShell?: (path: string) => void;
  onStartRename: (path: string) => void;
  onRename: (path: string, name: string) => void;
  onCancelRename: () => void;
  onDelete: (path: string, isDir: boolean) => void;
  mark: MarkedPaths;
}) {
  const isOpen = expanded.has(path);
  const isBusy = loading.has(path);
  const kids = children_.get(path);
  const active = !isDir && openPath === path;
  const selected = isDir && selectedDir === path;
  const marked = mark.has(path);
  // A drive is the one thing here that cannot be deleted, so it is not a thing that can be marked.
  const markable = !isDrive;

  return (
    <div>
      <div
        data-fspath={path}
        {...navRowProps({ path, isDir, open: isOpen, current: active || selected, depth })}
        className={cn(
          "group flex items-center gap-1 rounded px-1 py-0.5 text-sm",
          "cursor-pointer hover:bg-accent",
          active && "bg-accent font-medium",
          selected && "bg-accent/50",
          marked && "bg-primary/10"
        )}
        style={{ paddingLeft: depth * 12 + 4 }}
        // In select mode the row is a checkbox: everything it normally does -- opening a file,
        // folding a folder -- would fight the gesture the mode is there for.
        onClick={(e) => {
          if (mark.selecting && markable) mark.toggle(path, isDir, e.shiftKey);
          else if (isDir) onToggle(path);
          else onOpenFile(path);
        }}
      >
        {mark.selecting && markable && (
          <span className={cn("shrink-0", marked ? "text-primary" : "text-muted-foreground")}>
            {marked ? <SquareCheck className="size-4" /> : <Square className="size-4" />}
          </span>
        )}
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
        {isDir && renaming !== path && onOpenShell && (
          <button
            className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground group-hover:block"
            title="Open a shell in this folder"
            onClick={(e) => {
              e.stopPropagation();
              onOpenShell?.(path);
            }}
          >
            <TerminalSquare className="size-3.5" />
          </button>
        )}
        {/* Start a selection with this row in it. Only before the mode is on: once it is, every row
            carries its own box on the left and a second one here would be a second answer. */}
        {markable && !mark.selecting && renaming !== path && (
          <button
            className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground group-hover:block"
            title="Select"
            onClick={(e) => {
              e.stopPropagation();
              mark.toggle(path, isDir, e.shiftKey);
            }}
          >
            <Square className="size-3" />
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
                mark={mark}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
