import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, sessionFileUrl } from "@/lib/api";
import type { FileEntry, GitStatus, GitWorktree } from "@/types";
import { MAX_OFFICE_PREVIEW, fileExt, fileKind, formatSize } from "@/lib/fileKind";
import { highlightCode } from "@/lib/highlight";
import { readUrlState, patchUrlState } from "@/lib/urlState";
import { loadSessionUi, saveSessionUi } from "@/lib/sessionUi";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/ui/confirm";
import { RenameField } from "./RenameField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ImageLightbox } from "./ImageLightbox";
import { OfficeViewer } from "./OfficeViewer";
import { PdfViewer } from "./PdfViewer";
import {
  GitHistory,
  CommitFilePreview,
  CommitDetailPreview,
  type CommitSelection,
} from "./GitHistory";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  Download,
  Expand,
  File as FileIcon,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  GitCompare,
  Image as ImageIcon,
  ListTree,
  Loader2,
  Maximize2,
  Minimize2,
  Pencil,
  RefreshCw,
  Save,
  Search,
  Trash2,
  Upload,
  Video,
  X,
} from "lucide-react";
import { writeToClipboard } from "@/lib/clipboard";
import { CopyPathButton } from "./CopyPathButton";

// Row-level actions threaded down to each tree node (rename inline, delete, new folder inside a dir).
interface RowActions {
  readOnly: boolean; // browsing another worktree — mutating actions are hidden
  renamingPath: string | null;
  onStartRename: (path: string) => void;
  onRename: (path: string, newName: string) => void;
  onCancelRename: () => void;
  onDelete: (entry: FileEntry) => void;
  onNewFolderIn: (dir: string) => void;
}

const MAX_TEXT_PREVIEW = 2_000_000; // 2 MB

// Desktop width of the file-tree pane. Persisted per-browser and drag-resizable (like the sidebar).
const TREE_MIN = 180;
const TREE_MAX = 640;
const TREE_DEFAULT = 288; // matches the old md:w-72
const TREE_WIDTH_KEY = "claudeweb.filesTreeWidth";

function readTreeWidth() {
  const n = Number(localStorage.getItem(TREE_WIDTH_KEY));
  return Number.isFinite(n) && n > 0 ? Math.min(TREE_MAX, Math.max(TREE_MIN, n)) : TREE_DEFAULT;
}

type GitFiles = Record<string, string>;

// Entries built from a path alone (git status, a restored URL) carry no stat, so their size is
// unknown rather than zero — the preview header hides it instead of claiming "0 B".
const UNKNOWN_SIZE = -1;

// Build a minimal FileEntry from a path (used to restore a selection from the URL,
// where we only know the path). Size is filled in once the tree/preview loads.
function fileEntryFromPath(path: string): FileEntry {
  return { name: path.split("/").pop() || path, path, isDir: false, size: UNKNOWN_SIZE };
}

// The chain of ancestor folder paths of a file/dir path ("a/b/c.txt" -> ["a", "a/b"]). Used to
// expand the tree down to a revealed file.
function ancestorDirs(path: string): string[] {
  const parts = path.split("/");
  parts.pop(); // drop the file (or leaf) segment
  const out: string[] = [];
  let acc = "";
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    out.push(acc);
  }
  return out;
}

// Reconstruct the open file tabs for a session: a URL deep-link for this session wins as the active
// tab, otherwise the per-session storage. `files` holds every open tab; the active one is always
// present (older stored state only had a single `file`). `preview` marks the transient tab that
// single-click reuses (only kept if it's actually one of the open tabs).
function restoreTabs(
  sessionId: string,
  useUrl: boolean
): { tabs: FileEntry[]; active: string | null; preview: string | null } {
  const u = useUrl ? readUrlState() : {};
  const ui = loadSessionUi(sessionId);
  const active = (useUrl && u.session === sessionId && u.file ? u.file : ui.file) || null;
  const paths = ui.files && ui.files.length ? [...ui.files] : active ? [active] : [];
  if (active && !paths.includes(active)) paths.unshift(active);
  const preview = ui.preview && paths.includes(ui.preview) ? ui.preview : null;
  return { tabs: paths.map(fileEntryFromPath), active, preview };
}

/** Imperative handle: lets a parent (SessionView) open a file in this browser from elsewhere. */
export interface FileBrowserHandle {
  revealFile: (path: string) => void;
  showChanges: () => void; // switch this browser into the git-changes view
}

/** How the active preview reports unsaved edits back up so closing a tab can guard them. */
interface PreviewGuard {
  dirty: boolean;
  save: () => Promise<boolean>;
}

/** Two-pane file explorer: searchable, auto-refreshing directory tree + preview/edit pane. */
export const FileBrowser = forwardRef<
  FileBrowserHandle,
  {
    sessionId: string;
    gitFiles?: GitFiles;
    onRefresh?: () => void;
    refreshToken?: number;
  }
>(function FileBrowser({ sessionId, gitFiles, onRefresh, refreshToken = 0 }, ref) {
  // Open files shown as tabs above the preview. Clicking a file opens (or re-activates) its tab; the
  // active tab is what the preview renders. Restored from the URL deep-link / per-session storage.
  const [tabs, setTabs] = useState<FileEntry[]>(() => restoreTabs(sessionId, true).tabs);
  const [activePath, setActivePath] = useState<string | null>(() => restoreTabs(sessionId, true).active);
  // The transient "preview" tab: single-clicking a file reuses this one slot instead of piling up
  // tabs; middle-/double-click opens a pinned tab and clears the preview mark.
  const [previewPath, setPreviewPath] = useState<string | null>(() => restoreTabs(sessionId, true).preview);
  const selected = useMemo(
    () => tabs.find((t) => t.path === activePath) ?? null,
    [tabs, activePath]
  );
  // The active preview registers its unsaved-edit state here so closing that tab can prompt to save.
  const previewGuard = useRef<PreviewGuard>({ dirty: false, save: async () => true });
  // Promise-based "save changes?" dialog shown when a tab with unsaved edits is about to close.
  const [closeGuard, setCloseGuard] = useState<{ name: string } | null>(null);
  const closeGuardResolve = useRef<((choice: "save" | "discard" | "cancel") => void) | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FileEntry[] | null>(null);
  const [searching, setSearching] = useState(false);
  // Whether the tree shows git changes (+ the history panel) instead of all files — remembered per
  // session so returning to it (or reloading) restores the changes/history view.
  const [showChanges, setShowChanges] = useState(() => loadSessionUi(sessionId).changes ?? false);
  const toggleChanges = useCallback(() => {
    setShowChanges((v) => {
      const next = !v;
      if (v) setCommitSel(null); // leaving changes mode drops the commit preview
      saveSessionUi(sessionId, { changes: next });
      return next;
    });
  }, [sessionId]);
  // Switch into the changes view (used by the header's branch badge). Idempotent if already there.
  const openChanges = useCallback(() => {
    setShowChanges(true);
    saveSessionUi(sessionId, { changes: true });
  }, [sessionId]);
  // The whole browser (Files tree, search, changes, preview) can be pointed at another worktree of
  // the session's repo. "" = the session's own working dir. Another worktree's files live outside
  // the session's dir, so browsing one is read-only — the write/rename/delete/upload endpoints stay
  // confined to the session's own working directory.
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  // Restored per session (and across reloads); "" until proven otherwise by the list below.
  const [worktreeDir, setWorktreeDir] = useState(() => loadSessionUi(sessionId).worktree ?? "");
  const [altStatus, setAltStatus] = useState<GitStatus | null>(null);
  const readOnly = !!worktreeDir;

  const pickWorktree = useCallback(
    (dir: string) => {
      setWorktreeDir(dir);
      saveSessionUi(sessionId, { worktree: dir });
    },
    [sessionId]
  );

  // Per session: restore its saved worktree pick and (re)load the repo's worktree list. A stale
  // response landing after a quick session switch must be dropped — validating the restored pick
  // against another session's list would wrongly wipe it.
  useEffect(() => {
    setWorktreeDir(loadSessionUi(sessionId).worktree ?? "");
    setAltStatus(null);
    setWorktrees([]);
    let cancelled = false;
    api.gitWorktrees(sessionId).then((list) => !cancelled && setWorktrees(list)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Drop a restored pick that's no longer one of the repo's worktrees (removed since it was saved);
  // a pick that became the session's own dir also falls back to "". Skipped until this session's
  // list has actually loaded (a repo always lists at least its main worktree).
  useEffect(() => {
    if (!worktreeDir || !worktrees.length) return;
    if (!worktrees.some((w) => !w.isCurrent && w.path === worktreeDir)) pickWorktree("");
  }, [worktrees, worktreeDir, pickWorktree]);

  // Fetch the selected (non-current) worktree's status; the current one uses the passed gitFiles.
  useEffect(() => {
    if (!worktreeDir) return void setAltStatus(null);
    let cancelled = false;
    api.gitStatus(sessionId, worktreeDir).then((s) => !cancelled && setAltStatus(s)).catch(() => !cancelled && setAltStatus(null));
    return () => {
      cancelled = true;
    };
  }, [worktreeDir, sessionId, refreshToken]);

  // In the changes view, group changed files under collapsible folders instead of a flat list.
  const [changesTree, setChangesTree] = useState(() => loadSessionUi(sessionId).changesTree ?? false);
  const toggleChangesTree = useCallback(() => {
    setChangesTree((v) => {
      const next = !v;
      saveSessionUi(sessionId, { changesTree: next });
      return next;
    });
  }, [sessionId]);

  // Expanded-folder state for the two trees. Both are collapsed by default, so we persist only the
  // set of folders the user has opened; anything absent renders collapsed. Seed the Files tree with
  // the ancestors of the file being restored so it expands into view on load.
  const [filesExpanded, setFilesExpanded] = useState<Set<string>>(() => {
    const ui = loadSessionUi(sessionId);
    const set = new Set(ui.filesExpanded ?? []);
    const u = readUrlState();
    const reveal = (u.session === sessionId && u.file ? u.file : ui.file) || null;
    if (reveal) for (const d of ancestorDirs(reveal)) set.add(d);
    return set;
  });
  const [changesExpanded, setChangesExpanded] = useState<Set<string>>(
    () => new Set(loadSessionUi(sessionId).changesExpanded ?? [])
  );
  const toggleFilesDir = useCallback(
    (path: string) => {
      setFilesExpanded((s) => {
        const n = new Set(s);
        n.has(path) ? n.delete(path) : n.add(path);
        saveSessionUi(sessionId, { filesExpanded: [...n] });
        return n;
      });
    },
    [sessionId]
  );
  const toggleChangesDir = useCallback(
    (path: string) => {
      setChangesExpanded((s) => {
        const n = new Set(s);
        n.has(path) ? n.delete(path) : n.add(path);
        saveSessionUi(sessionId, { changesExpanded: [...n] });
        return n;
      });
    },
    [sessionId]
  );
  // Expand the Files tree down to a path (adds its ancestor folders to the expanded set).
  const expandFilesTo = useCallback(
    (path: string) => {
      setFilesExpanded((s) => {
        const n = new Set(s);
        for (const d of ancestorDirs(path)) n.add(d);
        saveSessionUi(sessionId, { filesExpanded: [...n] });
        return n;
      });
    },
    [sessionId]
  );
  // A file picked out of a commit in the History panel — previewed in place of a working-tree file.
  const [commitSel, setCommitSel] = useState<CommitSelection | null>(null);
  const [treeWidth, setTreeWidth] = useState(readTreeWidth); // desktop tree-pane width (px)

  // Folder that Upload targets in the tree ("" = repo root). Clicking a folder selects it.
  const [uploadDir, setUploadDir] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setUploading(true);
      setUploadError(null);
      try {
        await api.uploadSessionFiles(sessionId, uploadDir, Array.from(files));
        onRefresh?.();
      } catch {
        setUploadError("Upload failed");
      } finally {
        setUploading(false);
      }
    },
    [sessionId, uploadDir, onRefresh]
  );

  // New-folder inline creator. The name may be nested ("a/b/c" or "a\b\c") and is created under
  // the current upload target; on success that new folder becomes the target.
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolder, setNewFolder] = useState("");
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);

  const createFolder = useCallback(async () => {
    const name = newFolder.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!name) return;
    const rel = uploadDir ? `${uploadDir}/${name}` : name;
    setFolderBusy(true);
    setFolderError(null);
    try {
      const r = await api.createSessionFolder(sessionId, rel);
      setUploadDir(r.path); // target the folder we just made
      setCreatingFolder(false);
      setNewFolder("");
      onRefresh?.();
    } catch {
      setFolderError("Couldn't create folder");
    } finally {
      setFolderBusy(false);
    }
  }, [newFolder, uploadDir, sessionId, onRefresh]);

  // Drag the divider between the tree and the preview to resize the tree; persist the result.
  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = readTreeWidth();
    let width = startW;
    const onMove = (ev: PointerEvent) => {
      width = Math.min(TREE_MAX, Math.max(TREE_MIN, startW + ev.clientX - startX));
      setTreeWidth(width);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem(TREE_WIDTH_KEY, String(width));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const resetTreeWidth = useCallback(() => {
    setTreeWidth(TREE_DEFAULT);
    localStorage.setItem(TREE_WIDTH_KEY, String(TREE_DEFAULT));
  }, []);

  // Persist the open tabs + active + preview mark for this session; mirror the active into the URL.
  const persistTabs = useCallback(
    (nextTabs: FileEntry[], nextActive: string | null, nextPreview: string | null) => {
      saveSessionUi(sessionId, {
        file: nextActive ?? "",
        files: nextTabs.map((t) => t.path),
        preview: nextPreview ?? "",
      });
      patchUrlState({ file: nextActive ?? undefined });
    },
    [sessionId]
  );

  // Guard against silently dropping unsaved edits in the active tab: if it's dirty, ask whether to
  // save, discard, or cancel. Returns false to abort. Called before anything that would navigate
  // away from (or close) the edited file. Only the active tab can be edited.
  const guardActiveEdits = useCallback(async (): Promise<boolean> => {
    if (!previewGuard.current.dirty) return true;
    setCloseGuard({ name: selected?.name ?? "This file" });
    const choice = await new Promise<"save" | "discard" | "cancel">((resolve) => {
      closeGuardResolve.current = resolve;
    });
    if (choice === "cancel") return false;
    if (choice === "save") return previewGuard.current.save();
    return true; // discard
  }, [selected]);

  const settleCloseGuard = useCallback((choice: "save" | "discard" | "cancel") => {
    closeGuardResolve.current?.(choice);
    closeGuardResolve.current = null;
    setCloseGuard(null);
  }, []);

  // Open a file and activate it. `pin` decides the tab model:
  //  - pin=false (single click): reuse the one transient preview slot — replace the current preview
  //    tab in place, or create it if there's none. Keeps the tab list from piling up.
  //  - pin=true (middle/double click): open (or promote to) a permanent tab.
  const openFile = useCallback(
    async (f: FileEntry, pin: boolean) => {
      // Switching away from an unsaved edit prompts to save first.
      if (f.path !== activePath && !(await guardActiveEdits())) return;
      setCommitSel(null);
      const isOpen = tabs.some((t) => t.path === f.path);
      let next: FileEntry[];
      let nextPreview = previewPath;
      if (isOpen) {
        next = tabs.map((t) => (t.path === f.path ? f : t)); // refresh entry (size may now be known)
        if (pin && previewPath === f.path) nextPreview = null; // promote the preview tab to pinned
      } else if (pin || !previewPath) {
        next = [...tabs, f]; // new tab (pinned, or the first preview tab)
        if (!pin) nextPreview = f.path;
      } else {
        next = tabs.map((t) => (t.path === previewPath ? f : t)); // reuse the preview slot in place
        nextPreview = f.path;
      }
      setTabs(next);
      setActivePath(f.path);
      setPreviewPath(nextPreview);
      persistTabs(next, f.path, nextPreview);
    },
    [tabs, activePath, previewPath, persistTabs, guardActiveEdits]
  );

  // Tree/list selection: single click previews, middle/double click opens a pinned tab.
  const selectFile = useCallback(
    (f: FileEntry, newTab?: boolean) => openFile(f, !!newTab),
    [openFile]
  );

  // Switch to an already-open tab (doesn't change its preview/pinned status). Switching away from an
  // unsaved edit prompts to save first.
  const activateTab = useCallback(
    async (path: string) => {
      if (path === activePath) return;
      if (!(await guardActiveEdits())) return;
      setCommitSel(null);
      setActivePath(path);
      persistTabs(tabs, path, previewPath);
    },
    [tabs, activePath, previewPath, persistTabs, guardActiveEdits]
  );

  // Double-clicking a preview tab pins it so single-clicking other files won't replace it.
  const pinTab = useCallback(
    (path: string) => {
      if (previewPath !== path) return;
      setPreviewPath(null);
      persistTabs(tabs, path, null);
    },
    [tabs, previewPath, persistTabs]
  );

  // Close a tab; if it was the active one, fall back to its neighbour (or empty).
  const closeTab = useCallback(
    async (path: string) => {
      const idx = tabs.findIndex((t) => t.path === path);
      if (idx === -1) return;
      // Only the active tab can hold unsaved edits — guard just that case.
      if (path === activePath && !(await guardActiveEdits())) return;
      const next = tabs.filter((t) => t.path !== path);
      const nextActive =
        activePath === path
          ? next.length
            ? next[Math.min(idx, next.length - 1)].path
            : null
          : activePath;
      const nextPreview = previewPath === path ? null : previewPath;
      setTabs(next);
      setActivePath(nextActive);
      setPreviewPath(nextPreview);
      persistTabs(next, nextActive, nextPreview);
    },
    [tabs, activePath, previewPath, persistTabs, guardActiveEdits]
  );

  // Close every open tab.
  const closeAllTabs = useCallback(async () => {
    if (!(await guardActiveEdits())) return;
    setTabs([]);
    setActivePath(null);
    setPreviewPath(null);
    persistTabs([], null, null);
  }, [persistTabs, guardActiveEdits]);

  // ---- Per-node file operations (rename / delete / new folder inside a folder) ----
  const confirm = useConfirm();
  const [renamingPath, setRenamingPath] = useState<string | null>(null);

  const doRename = useCallback(
    async (path: string, newName: string) => {
      setRenamingPath(null);
      const clean = newName.trim();
      if (!clean || clean === path.split("/").pop()) return;
      try {
        await api.renameSessionFile(sessionId, path, clean);
        // Follow any open tab whose file (or ancestor folder) was renamed.
        const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        const newPath = parent ? `${parent}/${clean}` : clean;
        const affected = (p: string) => p === path || p.startsWith(path + "/");
        if (tabs.some((t) => affected(t.path))) {
          const next = tabs.map((t) =>
            affected(t.path) ? fileEntryFromPath(t.path.replace(path, newPath)) : t
          );
          const remap = (p: string | null) => (p && affected(p) ? p.replace(path, newPath) : p);
          const nextActive = remap(activePath);
          const nextPreview = remap(previewPath);
          setTabs(next);
          setActivePath(nextActive);
          setPreviewPath(nextPreview);
          persistTabs(next, nextActive, nextPreview);
        }
        onRefresh?.();
      } catch {
        /* ignore — best effort */
      }
    },
    [sessionId, tabs, activePath, previewPath, persistTabs, onRefresh]
  );

  const doDelete = useCallback(
    async (entry: FileEntry) => {
      const ok = await confirm({
        title: `Delete ${entry.isDir ? "folder" : "file"}?`,
        description: (
          <>
            Permanently delete <span className="font-medium text-foreground">{entry.name}</span>
            {entry.isDir && " and everything inside it"}.
          </>
        ),
        confirmLabel: "Delete",
      });
      if (!ok) return;
      try {
        await api.deleteSessionFile(sessionId, entry.path);
        // Drop any tab for the deleted file (or files under a deleted folder).
        const affected = (p: string) => p === entry.path || p.startsWith(entry.path + "/");
        if (tabs.some((t) => affected(t.path))) {
          const next = tabs.filter((t) => !affected(t.path));
          const nextActive =
            activePath && !affected(activePath) ? activePath : next[0]?.path ?? null;
          const nextPreview = previewPath && !affected(previewPath) ? previewPath : null;
          setTabs(next);
          setActivePath(nextActive);
          setPreviewPath(nextPreview);
          persistTabs(next, nextActive, nextPreview);
        }
        onRefresh?.();
      } catch {
        /* ignore — best effort */
      }
    },
    [sessionId, tabs, activePath, previewPath, persistTabs, confirm, onRefresh]
  );

  // Open the new-folder creator targeting a specific directory ("" = repo root).
  const newFolderIn = useCallback((dir: string) => {
    setUploadDir(dir);
    setFolderError(null);
    setNewFolder("");
    setCreatingFolder(true);
  }, []);

  const rowActions: RowActions = {
    readOnly,
    renamingPath,
    onStartRename: setRenamingPath,
    onRename: doRename,
    onCancelRename: () => setRenamingPath(null),
    onDelete: doDelete,
    onNewFolderIn: newFolderIn,
  };

  // Reveal a file in the working-tree Files pane (from a commit preview): leave the changes/commit
  // view, select it, and expand the tree down to it.
  const revealFile = useCallback(
    (path: string) => {
      setShowChanges(false);
      setQuery("");
      expandFilesTo(path);
      openFile(fileEntryFromPath(path), false);
    },
    [openFile, expandFilesTo]
  );

  // Let SessionView open a file here (from a terminal file-link click) or switch to the changes view.
  useImperativeHandle(ref, () => ({ revealFile, showChanges: openChanges }), [revealFile, openChanges]);

  // When the session actually changes, restore that session's last-previewed file (or clear if it
  // had none). Skips the initial mount (and StrictMode's double-invoked mount effect), so the
  // URL-restored selection survives.
  const prevSession = useRef(sessionId);
  useEffect(() => {
    if (prevSession.current === sessionId) return;
    prevSession.current = sessionId;
    const restored = restoreTabs(sessionId, false);
    setTabs(restored.tabs);
    setActivePath(restored.active);
    setPreviewPath(restored.preview);
    const ui = loadSessionUi(sessionId);
    const nextFilesExpanded = new Set(ui.filesExpanded ?? []);
    if (restored.active) for (const d of ancestorDirs(restored.active)) nextFilesExpanded.add(d);
    setFilesExpanded(nextFilesExpanded);
    setChangesExpanded(new Set(ui.changesExpanded ?? []));
    setCommitSel(null);
    setQuery("");
    setShowChanges(ui.changes ?? false);
    setChangesTree(ui.changesTree ?? false);
    setUploadDir("");
    setUploadError(null);
    setCreatingFolder(false);
    setNewFolder("");
    setFolderError(null);
    patchUrlState({ file: restored.active ?? undefined });
  }, [sessionId]);

  // Which repo's changes to show: the session's own (gitFiles) or the picked worktree's (altStatus).
  const effectiveGitFiles = worktreeDir ? altStatus?.files : gitFiles;

  const changeCount = effectiveGitFiles ? Object.keys(effectiveGitFiles).length : 0;
  const changeEntries = useMemo<FileEntry[]>(
    () =>
      effectiveGitFiles
        ? Object.keys(effectiveGitFiles)
            .sort((a, b) => a.localeCompare(b))
            .map((p) => ({ name: p.split("/").pop() || p, path: p, isDir: false, size: UNKNOWN_SIZE }))
        : [],
    [effectiveGitFiles]
  );

  // In the changes view the search box filters the changed-file list in place (below), so the query
  // narrows the changes rather than searching the whole working tree.
  const filteredChangeEntries = useMemo<FileEntry[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return changeEntries;
    return changeEntries.filter((e) => e.path.toLowerCase().includes(q));
  }, [changeEntries, query]);

  // The grouped changes tree, built once here so the header's collapse/expand-all can enumerate every
  // rendered folder (compacted paths — the same keys the folder rows toggle on).
  const changeTreeRoot = useMemo(() => buildChangeTree(filteredChangeEntries), [filteredChangeEntries]);
  const allChangeDirPaths = useMemo(() => collectChangeDirPaths(changeTreeRoot), [changeTreeRoot]);
  const allChangesExpanded =
    allChangeDirPaths.length > 0 && allChangeDirPaths.every((p) => changesExpanded.has(p));
  const expandAllChanges = useCallback(() => {
    const set = new Set(allChangeDirPaths);
    setChangesExpanded(set);
    saveSessionUi(sessionId, { changesExpanded: [...set] });
  }, [allChangeDirPaths, sessionId]);
  const collapseAllChanges = useCallback(() => {
    setChangesExpanded(new Set());
    saveSessionUi(sessionId, { changesExpanded: [] });
  }, [sessionId]);

  // Debounced recursive search — only for the all-files tree; the changes view filters locally.
  useEffect(() => {
    const q = query.trim();
    if (!q || showChanges) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      api
        .searchSessionFiles(sessionId, q, worktreeDir || undefined)
        .then((r) => setResults(r.entries))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(t);
  }, [query, sessionId, refreshToken, showChanges, worktreeDir]);

  return (
    <div className="flex h-full flex-col md:flex-row">
      <div
        style={{ "--tree-w": `${treeWidth}px` } as React.CSSProperties}
        className="flex max-h-64 w-full flex-col border-b md:max-h-none md:w-[var(--tree-w)] md:shrink-0 md:border-b-0"
      >
        <div className="flex items-center justify-between px-3 py-2 text-xs font-medium text-muted-foreground">
          <span>{showChanges ? "Changes" : "Files"}</span>
          <div className="flex items-center gap-1.5">
            {gitFiles && (
              <button
                title={showChanges ? "Show all files" : "Show git changes only"}
                onClick={toggleChanges}
                className={cn(
                  "flex items-center gap-1 rounded px-1 py-0.5 hover:text-foreground",
                  showChanges ? "bg-amber-500/15 text-amber-500" : ""
                )}
              >
                <GitCompare className="size-3.5" />
                {changeCount > 0 && <span className="text-[10px] font-semibold">{changeCount}</span>}
              </button>
            )}
            {gitFiles && showChanges && (
              <button
                title={changesTree ? "Show as a flat list" : "Group by folders"}
                onClick={toggleChangesTree}
                className={cn(
                  "flex items-center rounded px-1 py-0.5 hover:text-foreground",
                  changesTree ? "bg-accent text-foreground" : ""
                )}
              >
                <ListTree className="size-3.5" />
              </button>
            )}
            {gitFiles && showChanges && changesTree && allChangeDirPaths.length > 0 && (
              <button
                title={allChangesExpanded ? "Collapse all folders" : "Expand all folders"}
                onClick={allChangesExpanded ? collapseAllChanges : expandAllChanges}
                className="flex items-center rounded px-1 py-0.5 hover:text-foreground"
              >
                {allChangesExpanded ? (
                  <ChevronsDownUp className="size-3.5" />
                ) : (
                  <ChevronsUpDown className="size-3.5" />
                )}
              </button>
            )}
            {!readOnly && (
              <button
                title="New folder at root"
                onClick={() => (creatingFolder ? setCreatingFolder(false) : newFolderIn(""))}
                className={cn("hover:text-foreground", creatingFolder && "text-foreground")}
              >
                <FolderPlus className="size-3.5" />
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                uploadFiles(e.target.files);
                e.target.value = ""; // allow re-selecting the same file later
              }}
            />
            {!readOnly && (
              <button
                title={uploadError ?? `Upload file(s) to ${uploadDir || "root"}`}
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className={cn(
                  "hover:text-foreground disabled:opacity-50",
                  uploadError && "text-destructive"
                )}
              >
                {uploading ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Upload className="size-3.5" />
                )}
              </button>
            )}
            <button title="Refresh" onClick={() => onRefresh?.()} className="hover:text-foreground">
              <RefreshCw className="size-3.5" />
            </button>
          </div>
        </div>
        {!showChanges && !readOnly && !query.trim() && (
          <div className="flex items-center gap-1 px-3 pb-1 text-[10px] text-muted-foreground">
            <span className="shrink-0">Upload target:</span>
            <span className="truncate font-medium text-foreground">{uploadDir || "root"}</span>
            {uploadDir && (
              <button
                onClick={() => setUploadDir("")}
                title="Reset to root"
                className="shrink-0 hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        )}
        {/* Pick which worktree of the repo to browse (Files tree, search, changes and preview). */}
        {worktrees.length > 1 && (
          <div className="flex items-center gap-1 px-3 pb-1 text-[10px] text-muted-foreground">
            <span className="shrink-0">Worktree:</span>
            <select
              value={worktreeDir}
              onChange={(e) => pickWorktree(e.target.value)}
              title="Browse another worktree of this repo (read-only)"
              className="min-w-0 flex-1 truncate rounded border bg-background px-1 py-0.5 text-foreground outline-none focus:ring-1 focus:ring-primary"
            >
              {worktrees.map((w) => (
                <option key={w.path} value={w.isCurrent ? "" : w.path}>
                  {w.path.split(/[/\\]+/).filter(Boolean).pop()}
                  {w.branch ? ` · ${w.branch}` : ""}
                  {w.isCurrent ? " (this session)" : ""}
                </option>
              ))}
            </select>
          </div>
        )}

        {creatingFolder && !readOnly && (
          <div className="px-2 pb-1">
            <div className="flex items-center gap-1">
              <Input
                autoFocus
                value={newFolder}
                onChange={(e) => setNewFolder(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") createFolder();
                  else if (e.key === "Escape") setCreatingFolder(false);
                }}
                placeholder={`New folder in ${uploadDir || "root"}… (a/b/c)`}
                className="h-8 flex-1 text-xs"
                spellCheck={false}
                disabled={folderBusy}
              />
              <Button size="sm" className="h-8 px-2" onClick={createFolder} disabled={folderBusy || !newFolder.trim()}>
                {folderBusy ? <Loader2 className="size-3.5 animate-spin" /> : "Create"}
              </Button>
            </div>
            {folderError && <p className="px-1 pt-1 text-[10px] text-destructive">{folderError}</p>}
          </div>
        )}

        <div className="px-2 pb-1">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={showChanges ? "Search changes…" : "Search files…"}
              className="h-8 pl-7 pr-7 text-xs"
              spellCheck={false}
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                title="Clear"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-auto px-1 pb-2">
          {showChanges ? (
            changesTree ? (
              <ChangesTree
                root={changeTreeRoot}
                isEmpty={filteredChangeEntries.length === 0}
                empty={query.trim() ? "No matching changes" : "No changes"}
                expanded={changesExpanded}
                onToggle={toggleChangesDir}
                gitFiles={effectiveGitFiles}
                selectedPath={selected?.path ?? null}
                onSelect={selectFile}
                actions={rowActions}
              />
            ) : (
              <FlatFileList
                entries={filteredChangeEntries}
                empty={query.trim() ? "No matching changes" : "No changes"}
                gitFiles={effectiveGitFiles}
                selectedPath={selected?.path ?? null}
                onSelect={selectFile}
                actions={rowActions}
              />
            )
          ) : query.trim() ? (
            <FlatFileList
              entries={results ?? []}
              loading={searching && results === null}
              empty="No matches"
              gitFiles={effectiveGitFiles}
              selectedPath={selected?.path ?? null}
              onSelect={selectFile}
              actions={rowActions}
            />
          ) : (
            <TreeLevel
              sessionId={sessionId}
              dir={worktreeDir || undefined}
              path=""
              depth={0}
              refreshToken={refreshToken}
              selectedPath={selected?.path ?? null}
              expanded={filesExpanded}
              onToggleDir={toggleFilesDir}
              gitFiles={effectiveGitFiles}
              onSelect={selectFile}
              uploadDir={uploadDir}
              onSelectDir={setUploadDir}
              actions={rowActions}
            />
          )}
        </div>

        {/* Commit history, collapsible, shown only in the changes view. */}
        {gitFiles && showChanges && (
          <GitHistory
            sessionId={sessionId}
            refreshToken={refreshToken}
            selected={commitSel}
            onSelect={setCommitSel}
          />
        )}
      </div>

      {/* Draggable divider between the tree and preview (desktop only). */}
      <div
        onPointerDown={startResize}
        onDoubleClick={resetTreeWidth}
        title="Drag to resize · double-click to reset"
        className="hidden w-1.5 shrink-0 cursor-col-resize border-l bg-transparent transition-colors hover:bg-primary/20 active:bg-primary/30 md:block"
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {commitSel ? (
          <div className="min-h-0 flex-1">
            {commitSel.path ? (
              <CommitFilePreview
                key={`${commitSel.hash}:${commitSel.path}`}
                sessionId={sessionId}
                selection={{ ...commitSel, path: commitSel.path }}
                onBack={() => setCommitSel((s) => (s ? { ...s, path: undefined, status: undefined } : null))}
                onClose={() => setCommitSel(null)}
                onOpenInTree={revealFile}
              />
            ) : (
              <CommitDetailPreview
                sessionId={sessionId}
                selection={commitSel}
                onSelectFile={setCommitSel}
                onClose={() => setCommitSel(null)}
              />
            )}
          </div>
        ) : (
          <>
            {tabs.length > 0 && (
              <FileTabStrip
                tabs={tabs}
                activePath={activePath}
                previewPath={previewPath}
                gitFiles={effectiveGitFiles}
                onActivate={activateTab}
                onPin={pinTab}
                onClose={closeTab}
                onCloseAll={closeAllTabs}
              />
            )}
            <div className="min-h-0 flex-1">
              <FilePreview
                sessionId={sessionId}
                file={selected}
                gitStatus={selected ? effectiveGitFiles?.[selected.path] : undefined}
                gitDir={worktreeDir || undefined}
                refreshToken={refreshToken}
                onSaved={onRefresh}
                guard={previewGuard}
              />
            </div>
          </>
        )}
      </div>

      {/* Save-changes prompt shown when a tab with unsaved edits is about to close. */}
      <Dialog open={!!closeGuard} onOpenChange={(o) => !o && settleCloseGuard("cancel")}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Save changes?</DialogTitle>
            <DialogDescription>
              <span className="font-medium text-foreground">{closeGuard?.name}</span> has unsaved
              changes. Save them before closing?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => settleCloseGuard("cancel")}>
              Cancel
            </Button>
            <Button variant="outline" onClick={() => settleCloseGuard("discard")}>
              Don't save
            </Button>
            <Button onClick={() => settleCloseGuard("save")} autoFocus>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
});

/**
 * Tab strip above the preview: one tab per open file. The transient "preview" tab (opened by a
 * single click) is shown in italics; double-clicking it pins it. Middle-click closes a tab, and a
 * trailing "close all" button clears them.
 */
function FileTabStrip({
  tabs,
  activePath,
  previewPath,
  gitFiles,
  onActivate,
  onPin,
  onClose,
  onCloseAll,
}: {
  tabs: FileEntry[];
  activePath: string | null;
  previewPath: string | null;
  gitFiles?: GitFiles;
  onActivate: (path: string) => void;
  onPin: (path: string) => void;
  onClose: (path: string) => void;
  onCloseAll: () => void;
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
    const active = el?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!el || !active) return;
    const c = el.getBoundingClientRect();
    const a = active.getBoundingClientRect();
    const pad = 8;
    let target = el.scrollLeft;
    if (a.left < c.left) target -= c.left - a.left + pad;
    else if (a.right > c.right) target += a.right - c.right + pad;
    if (target !== el.scrollLeft) el.scrollTo({ left: target, behavior: "smooth" });
  }, [activePath, tabs.length]);

  return (
    <div className="flex shrink-0 items-stretch border-b bg-muted/30">
      <div ref={scrollRef} className="hover-scrollbar flex flex-1 items-stretch gap-0.5 overflow-x-auto px-1 pt-1">
        {tabs.map((t) => {
          const kind = fileKind(t.name);
          const Icon =
            kind === "image" ? ImageIcon : kind === "video" ? Video : kind === "binary" ? FileIcon : FileText;
          const active = t.path === activePath;
          const preview = t.path === previewPath;
          return (
            <div
              key={t.path}
              role="tab"
              aria-selected={active}
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
                "group/tab flex shrink-0 cursor-pointer items-center gap-1.5 rounded-t border-b-2 px-2 py-1.5 text-xs",
                active
                  ? "border-primary bg-background text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-background/60 hover:text-foreground"
              )}
            >
              <Icon className="size-3.5 shrink-0" />
              <span
                className={cn(
                  "max-w-[12rem] truncate",
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
                  "-mr-0.5 ml-0.5 rounded p-0.5 hover:bg-accent hover:text-foreground",
                  active ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100"
                )}
              >
                <X className="size-3" />
              </button>
            </div>
          );
        })}
      </div>
      {tabs.length > 1 && (
        <button
          onClick={onCloseAll}
          title="Close all tabs"
          className="flex shrink-0 items-center border-l px-2 text-muted-foreground hover:bg-background hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}

export const STATUS_COLOR: Record<string, string> = {
  M: "text-amber-500",
  A: "text-emerald-500",
  U: "text-emerald-500",
  D: "text-red-500",
  R: "text-sky-500",
};

function GitMarker({ status }: { status?: string }) {
  if (!status) return null;
  return (
    <span className={cn("ml-auto shrink-0 pl-1 text-[10px] font-bold", STATUS_COLOR[status] ?? "text-muted-foreground")}>
      {status}
    </span>
  );
}

function dirHasChanges(gitFiles: GitFiles | undefined, dirPath: string): boolean {
  if (!gitFiles) return false;
  const prefix = dirPath + "/";
  for (const p in gitFiles) if (p === dirPath || p.startsWith(prefix)) return true;
  return false;
}

/** Flat list of files (used for search results and the git-changes view). */
function FlatFileList({
  entries,
  loading,
  empty,
  gitFiles,
  selectedPath,
  onSelect,
  actions,
}: {
  entries: FileEntry[];
  loading?: boolean;
  empty: string;
  gitFiles?: GitFiles;
  selectedPath: string | null;
  onSelect: (f: FileEntry, newTab?: boolean) => void;
  actions: RowActions;
}) {
  if (loading)
    return <IndentedNote depth={0}><Loader2 className="size-3 animate-spin" /> Loading…</IndentedNote>;
  if (entries.length === 0) return <IndentedNote depth={0}>{empty}</IndentedNote>;

  return (
    <>
      {entries.map((e) => {
        const kind = fileKind(e.name);
        const Icon = kind === "image" ? ImageIcon : kind === "video" ? Video : FileText;
        return (
          <Row
            key={e.path}
            depth={0}
            selected={selectedPath === e.path}
            entry={e}
            actions={actions}
            onClick={() => onSelect(e)}
            onOpenNewTab={() => onSelect(e, true)}
          >
            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-col">
              <span className={cn("truncate", gitFiles?.[e.path] && STATUS_COLOR[gitFiles[e.path]])}>{e.name}</span>
              <span className="truncate text-[10px] text-muted-foreground">{e.path}</span>
            </span>
            <GitMarker status={gitFiles?.[e.path]} />
          </Row>
        );
      })}
    </>
  );
}

// A folder in the changes tree: its own changed files plus nested subfolders. Built entirely from the
// flat list of changed paths — no directory listing needed, so folders with no changes never appear.
interface ChangeDir {
  name: string; // display segment (may be a compacted chain like "a/b/c")
  path: string; // full folder path, unique — used as the collapse key
  dirs: Map<string, ChangeDir>;
  files: FileEntry[];
}

function buildChangeTree(entries: FileEntry[]): ChangeDir {
  const root: ChangeDir = { name: "", path: "", dirs: new Map(), files: [] };
  for (const e of entries) {
    const parts = e.path.split("/");
    parts.pop(); // file name — the entry itself lands in `files`
    let node = root;
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      let child = node.dirs.get(part);
      if (!child) {
        child = { name: part, path: acc, dirs: new Map(), files: [] };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.push(e);
  }
  return root;
}

// Collapse a chain of single-child folders that hold no files of their own into one row ("a/b/c"),
// matching how editors render sparse change trees. The returned node keeps the deepest folder's path.
function compactDir(dir: ChangeDir): ChangeDir {
  let node = dir;
  let name = dir.name;
  while (node.files.length === 0 && node.dirs.size === 1) {
    const [child] = node.dirs.values();
    name = `${name}/${child.name}`;
    node = child;
  }
  return { name, path: node.path, dirs: node.dirs, files: node.files };
}

function countChanges(dir: ChangeDir): number {
  let n = dir.files.length;
  for (const d of dir.dirs.values()) n += countChanges(d);
  return n;
}

// Every folder path rendered in the changes tree (compacted, matching the collapse keys). Used to
// enumerate targets for expand-all / collapse-all.
function collectChangeDirPaths(root: ChangeDir): string[] {
  const out: string[] = [];
  const walk = (dir: ChangeDir) => {
    for (const child of dir.dirs.values()) {
      const c = compactDir(child);
      out.push(c.path);
      walk(c);
    }
  };
  walk(root);
  return out;
}

/** Changed files grouped into a collapsible folder tree (the changes view's "group by folders" mode). */
function ChangesTree({
  root,
  isEmpty,
  empty,
  expanded,
  onToggle,
  gitFiles,
  selectedPath,
  onSelect,
  actions,
}: {
  root: ChangeDir;
  isEmpty: boolean;
  empty: string;
  // Folders are collapsed by default; this holds the ones the user has expanded (persisted per session).
  expanded: Set<string>;
  onToggle: (path: string) => void;
  gitFiles?: GitFiles;
  selectedPath: string | null;
  onSelect: (f: FileEntry, newTab?: boolean) => void;
  actions: RowActions;
}) {
  if (isEmpty) return <IndentedNote depth={0}>{empty}</IndentedNote>;

  return (
    <ChangeDirChildren
      dir={root}
      depth={0}
      expanded={expanded}
      onToggle={onToggle}
      gitFiles={gitFiles}
      selectedPath={selectedPath}
      onSelect={onSelect}
      actions={actions}
    />
  );
}

interface ChangeTreeProps {
  expanded: Set<string>;
  onToggle: (path: string) => void;
  gitFiles?: GitFiles;
  selectedPath: string | null;
  onSelect: (f: FileEntry, newTab?: boolean) => void;
  actions: RowActions;
}

// Render a folder's subfolders (compacted, alphabetical) followed by its own changed files.
function ChangeDirChildren({ dir, depth, ...rest }: { dir: ChangeDir; depth: number } & ChangeTreeProps) {
  const dirs = useMemo(
    () => [...dir.dirs.values()].map(compactDir).sort((a, b) => a.name.localeCompare(b.name)),
    [dir]
  );
  const files = useMemo(() => [...dir.files].sort((a, b) => a.name.localeCompare(b.name)), [dir]);
  return (
    <>
      {dirs.map((d) => (
        <ChangeDirNode key={d.path} dir={d} depth={depth} {...rest} />
      ))}
      {files.map((e) => (
        <Row
          key={e.path}
          depth={depth}
          selected={rest.selectedPath === e.path}
          entry={e}
          actions={rest.actions}
          onClick={() => rest.onSelect(e)}
          onOpenNewTab={() => rest.onSelect(e, true)}
        >
          <span className="size-3.5 shrink-0" />
          {(() => {
            const kind = fileKind(e.name);
            const Icon = kind === "image" ? ImageIcon : kind === "video" ? Video : FileText;
            return <Icon className="size-3.5 shrink-0 text-muted-foreground" />;
          })()}
          <span className={cn("truncate", rest.gitFiles?.[e.path] && STATUS_COLOR[rest.gitFiles[e.path]])}>
            {e.name}
          </span>
          <GitMarker status={rest.gitFiles?.[e.path]} />
        </Row>
      ))}
    </>
  );
}

function ChangeDirNode({ dir, depth, ...rest }: { dir: ChangeDir; depth: number } & ChangeTreeProps) {
  const open = rest.expanded.has(dir.path);
  return (
    <>
      <div className="group relative flex items-center rounded-sm text-xs hover:bg-accent">
        <button
          onClick={() => rest.onToggle(dir.path)}
          style={{ paddingLeft: depth * 12 + 8 }}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-2 text-left"
        >
          {open ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          {open ? (
            <FolderOpen className="size-3.5 shrink-0 text-amber-500" />
          ) : (
            <Folder className="size-3.5 shrink-0 text-amber-500" />
          )}
          <span className="truncate text-muted-foreground">{dir.name}</span>
          <span className="ml-auto shrink-0 pl-1 text-[10px] font-medium text-muted-foreground">
            {countChanges(dir)}
          </span>
        </button>
      </div>
      {open && <ChangeDirChildren dir={dir} depth={depth + 1} {...rest} />}
    </>
  );
}

function TreeLevel({
  sessionId,
  dir,
  path,
  depth,
  refreshToken,
  selectedPath,
  expanded,
  onToggleDir,
  gitFiles,
  onSelect,
  uploadDir,
  onSelectDir,
  actions,
}: {
  sessionId: string;
  dir?: string; // another worktree of the session's repo to list from (read-only browsing)
  path: string;
  depth: number;
  refreshToken: number;
  selectedPath: string | null;
  expanded: Set<string>;
  onToggleDir: (path: string) => void;
  gitFiles?: GitFiles;
  onSelect: (f: FileEntry, newTab?: boolean) => void;
  uploadDir: string;
  onSelectDir: (path: string) => void;
  actions: RowActions;
}) {
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState(false);

  // Re-fetches when refreshToken changes; TreeDir stays mounted so expansion is preserved.
  useEffect(() => {
    let cancelled = false;
    api
      .listSessionFiles(sessionId, path || undefined, dir)
      .then((r) => !cancelled && (setEntries(r.entries), setError(false)))
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
    };
  }, [sessionId, dir, path, refreshToken]);

  if (error) return <IndentedNote depth={depth}>Unable to read folder</IndentedNote>;
  if (entries === null)
    return <IndentedNote depth={depth}><Loader2 className="size-3 animate-spin" /> Loading…</IndentedNote>;
  if (entries.length === 0) return <IndentedNote depth={depth}>Empty</IndentedNote>;

  return (
    <>
      {entries.map((e) =>
        e.isDir ? (
          <TreeDir
            key={e.path}
            sessionId={sessionId}
            dir={dir}
            entry={e}
            depth={depth}
            refreshToken={refreshToken}
            selectedPath={selectedPath}
            expanded={expanded}
            onToggleDir={onToggleDir}
            gitFiles={gitFiles}
            onSelect={onSelect}
            uploadDir={uploadDir}
            onSelectDir={onSelectDir}
            actions={actions}
          />
        ) : (
          <FileRow
            key={e.path}
            entry={e}
            depth={depth}
            selected={selectedPath === e.path}
            gitStatus={gitFiles?.[e.path]}
            onSelect={onSelect}
            actions={actions}
          />
        )
      )}
    </>
  );
}

function TreeDir({
  sessionId,
  dir,
  entry,
  depth,
  refreshToken,
  selectedPath,
  expanded,
  onToggleDir,
  gitFiles,
  onSelect,
  uploadDir,
  onSelectDir,
  actions,
}: {
  sessionId: string;
  dir?: string;
  entry: FileEntry;
  depth: number;
  refreshToken: number;
  selectedPath: string | null;
  expanded: Set<string>;
  onToggleDir: (path: string) => void;
  gitFiles?: GitFiles;
  onSelect: (f: FileEntry, newTab?: boolean) => void;
  uploadDir: string;
  onSelectDir: (path: string) => void;
  actions: RowActions;
}) {
  // Open state is lifted to the parent so it persists per session (collapsed by default).
  const open = expanded.has(entry.path);
  return (
    <>
      {/* Clicking a folder toggles it open and makes it the upload target. */}
      <Row
        depth={depth}
        selected={uploadDir === entry.path}
        entry={entry}
        actions={actions}
        onClick={() => {
          onToggleDir(entry.path);
          onSelectDir(entry.path);
        }}
        extraActions={
          <button
            className="rounded p-0.5 hover:bg-background hover:text-foreground"
            title="New folder here"
            onClick={(e) => {
              e.stopPropagation();
              actions.onNewFolderIn(entry.path);
            }}
          >
            <FolderPlus className="size-3.5" />
          </button>
        }
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        {open ? (
          <FolderOpen className="size-3.5 shrink-0 text-amber-500" />
        ) : (
          <Folder className="size-3.5 shrink-0 text-amber-500" />
        )}
        <span className="truncate">{entry.name}</span>
        {!open && dirHasChanges(gitFiles, entry.path) && (
          <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />
        )}
      </Row>
      {open && (
        <TreeLevel
          sessionId={sessionId}
          dir={dir}
          path={entry.path}
          depth={depth + 1}
          refreshToken={refreshToken}
          selectedPath={selectedPath}
          expanded={expanded}
          onToggleDir={onToggleDir}
          gitFiles={gitFiles}
          onSelect={onSelect}
          uploadDir={uploadDir}
          onSelectDir={onSelectDir}
          actions={actions}
        />
      )}
    </>
  );
}

function FileRow({
  entry,
  depth,
  selected,
  gitStatus,
  onSelect,
  actions,
}: {
  entry: FileEntry;
  depth: number;
  selected: boolean;
  gitStatus?: string;
  onSelect: (f: FileEntry, newTab?: boolean) => void;
  actions: RowActions;
}) {
  const kind = fileKind(entry.name);
  const Icon =
    kind === "image" ? ImageIcon : kind === "video" ? Video : kind === "binary" ? FileIcon : FileText;
  // Bring a URL-restored selection into view (fires only when a row mounts already
  // selected — normal clicks select an already-mounted row, so they don't scroll).
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Row
      ref={ref}
      depth={depth}
      selected={selected}
      entry={entry}
      actions={actions}
      onClick={() => onSelect(entry)}
      onOpenNewTab={() => onSelect(entry, true)}
    >
      <span className="size-3.5 shrink-0" />
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className={cn("truncate", gitStatus && STATUS_COLOR[gitStatus])}>{entry.name}</span>
      <GitMarker status={gitStatus} />
    </Row>
  );
}

const Row = forwardRef<
  HTMLDivElement,
  {
    depth: number;
    selected?: boolean;
    onClick: () => void;
    onOpenNewTab?: () => void; // file-only: middle-/double-click opens a pinned tab
    entry: FileEntry;
    actions: RowActions;
    extraActions?: React.ReactNode; // dir-only: "new folder here"
    children: React.ReactNode;
  }
>(function Row({ depth, selected, onClick, onOpenNewTab, entry, actions, extraActions, children }, ref) {
  const renaming = actions.renamingPath === entry.path;
  return (
    <div
      ref={ref}
      className={cn(
        "group relative flex items-center rounded-sm text-xs hover:bg-accent",
        selected && "bg-accent font-medium"
      )}
    >
      {renaming ? (
        <div className="min-w-0 flex-1 py-0.5 pr-2" style={{ paddingLeft: depth * 12 + 8 }}>
          <RenameField
            value={entry.name}
            onSubmit={(name) => actions.onRename(entry.path, name)}
            onCancel={actions.onCancelRename}
          />
        </div>
      ) : (
        <>
          <button
            onClick={onClick}
            onDoubleClick={onOpenNewTab}
            // Middle-click opens the file in a new pinned tab (browser-link behaviour).
            onAuxClick={(e) => {
              if (e.button === 1 && onOpenNewTab) {
                e.preventDefault();
                onOpenNewTab();
              }
            }}
            onMouseDown={(e) => {
              if (e.button === 1) e.preventDefault(); // suppress middle-click autoscroll
            }}
            style={{ paddingLeft: depth * 12 + 8 }}
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-2 text-left"
          >
            {children}
          </button>
          {/* Hover actions, overlaid at the right so they don't eat name width when idle. Mutating
              ones are hidden while browsing another worktree (endpoints only touch the session dir). */}
          <div className="absolute right-1 hidden items-center gap-0.5 rounded bg-accent pl-1 text-muted-foreground group-hover:flex">
            {!actions.readOnly && extraActions}
            <CopyPathButton
              path={entry.path}
              className="rounded p-0.5 hover:bg-background hover:text-foreground"
            />
            {!actions.readOnly && (
              <>
                <button
                  className="rounded p-0.5 hover:bg-background hover:text-foreground"
                  title="Rename"
                  onClick={(e) => {
                    e.stopPropagation();
                    actions.onStartRename(entry.path);
                  }}
                >
                  <Pencil className="size-3.5" />
                </button>
                <button
                  className="rounded p-0.5 hover:bg-background hover:text-destructive"
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    actions.onDelete(entry);
                  }}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
});

function IndentedNote({ depth, children }: { depth: number; children: React.ReactNode }) {
  return (
    <div
      style={{ paddingLeft: depth * 12 + 8 }}
      className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground"
    >
      {children}
    </div>
  );
}

function FilePreview({
  sessionId,
  file,
  gitStatus,
  gitDir,
  refreshToken,
  onSaved,
  guard,
}: {
  sessionId: string;
  file: FileEntry | null;
  gitStatus?: string;
  // When set, changes come from another worktree of the repo. Its files live outside the session's
  // working dir, so every read is scoped to that dir; editing stays disabled there.
  gitDir?: string;
  refreshToken: number;
  onSaved?: () => void;
  // Lets the parent read this preview's unsaved-edit state (and trigger a save) when closing a tab.
  guard?: React.MutableRefObject<PreviewGuard>;
}) {
  const [text, setText] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error" | "toolarge">("idle");
  const [view, setView] = useState<"preview" | "diff">("preview");
  const [diff, setDiff] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const [mdView, setMdView] = useState<"rendered" | "raw">("rendered");
  const [fullscreen, setFullscreen] = useState(false); // full-page popup preview

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState(false);
  // The scrollable content area; used to detect an in-progress text selection so a background
  // auto-refresh doesn't rebuild the DOM out from under a copy.
  const contentRef = useRef<HTMLDivElement>(null);

  const copyPath = useCallback(async () => {
    if (!file) return;
    await writeToClipboard(file.path);
    setCopiedPath(true);
    setTimeout(() => setCopiedPath(false), 1500);
  }, [file]);

  const kind = file ? fileKind(file.name) : "binary";
  const isMarkdown = !!file && ["md", "markdown"].includes(fileExt(file.name));
  const isHtml = !!file && ["html", "htm"].includes(fileExt(file.name));
  // Another worktree's files are read-only here: the write endpoint is confined to the session's dir.
  const canEdit = kind === "text" && status === "idle" && text !== null && !gitDir;
  const rawUrl = useCallback(
    (download = false) => (file ? sessionFileUrl(sessionId, file.path, download, gitDir) : ""),
    [sessionId, file, gitDir]
  );

  // Syntax-highlighted HTML for the plain-text view (null for unsupported languages).
  const highlighted = useMemo(
    () => (file && text !== null ? highlightCode(file.name, text) : null),
    [file, text]
  );

  useEffect(() => {
    setText(null);
    setStatus("idle");
    setView("preview");
    setDiff(null);
    setMdView("rendered");
    setEditing(false);
    setSaveError(null);
    setFullscreen(false);
    if (!file || kind !== "text") return;
    if (file.size > MAX_TEXT_PREVIEW) {
      setStatus("toolarge");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    api
      .fetchSessionFileText(sessionId, file.path, gitDir)
      .then((t) => !cancelled && (setText(t), setStatus("idle")))
      .catch(() => !cancelled && setStatus("error"));
    return () => {
      cancelled = true;
    };
  }, [sessionId, file, kind, gitDir]);

  // Auto-refresh: when the working dir changes, re-fetch the current file's content and
  // invalidate the cached diff — but never clobber an in-progress edit.
  useEffect(() => {
    if (!file || editing) return;
    // Skip while the user is selecting/copying inside the preview: swapping in fresh content (or
    // reloading the diff) rebuilds the DOM (the highlighted <code> is set via innerHTML) and drops
    // the selection. Checked both now AND when the fetch resolves: a fetch kicked off by an earlier
    // bump — before the selection began — would otherwise land mid-selection and clobber it. A later
    // fs change re-runs this once the selection is released.
    const selectingInPreview = () => {
      const sel = window.getSelection();
      return !!(
        sel &&
        !sel.isCollapsed &&
        contentRef.current &&
        (contentRef.current.contains(sel.anchorNode) || contentRef.current.contains(sel.focusNode))
      );
    };
    if (selectingInPreview()) return;
    let cancelled = false;
    if (view === "diff") {
      // The diff is on screen: refetch it in the background and swap in only if it actually changed,
      // so the pane doesn't flash to empty/loading on every tick. (Nulling it here is what caused the
      // flicker.) Not toggling diffLoading keeps the current diff visible until the new one lands.
      api
        .gitDiff(sessionId, file.path, gitDir)
        .then((d) => {
          if (cancelled) return;
          const next = d.diff || "";
          setDiff((prev) => (prev === next ? prev : next));
        })
        .catch(() => {});
    } else {
      setDiff(null); // diff not visible — drop the cached one so it reloads fresh when next viewed
      if (fileKind(file.name) === "text" && file.size <= MAX_TEXT_PREVIEW) {
        api
          .fetchSessionFileText(sessionId, file.path, gitDir)
          .then((t) => !cancelled && !selectingInPreview() && setText(t))
          .catch(() => {});
      }
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  useEffect(() => {
    if (view !== "diff" || !file || diff !== null) return;
    let cancelled = false;
    setDiffLoading(true);
    api
      .gitDiff(sessionId, file.path, gitDir)
      .then((d) => !cancelled && setDiff(d.diff || ""))
      .catch(() => !cancelled && setDiff(""))
      .finally(() => !cancelled && setDiffLoading(false));
    return () => {
      cancelled = true;
    };
  }, [view, sessionId, file, diff, gitDir]);

  // Esc leaves the full-page popup (but not while editing — Esc there could drop unsaved text).
  useEffect(() => {
    if (!fullscreen || editing) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFullscreen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen, editing]);

  async function save(): Promise<boolean> {
    if (!file) return true;
    setSaving(true);
    setSaveError(null);
    try {
      await api.writeSessionFile(sessionId, file.path, draft);
      setText(draft);
      setEditing(false);
      onSaved?.(); // refresh git status (file may now be modified)
      return true;
    } catch {
      setSaveError("Failed to save.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  // Report unsaved-edit state up so closing this file's tab can prompt to save. Runs every render so
  // `save`'s current closure (draft/file) is always the one the parent calls; cleared on unmount.
  const dirty = editing && draft !== (text ?? "");
  useEffect(() => {
    if (guard) guard.current = { dirty, save };
  });
  useEffect(
    () => () => {
      if (guard) guard.current = { dirty: false, save: async () => true };
    },
    [guard]
  );

  if (!file) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Select a file to preview
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col",
        fullscreen ? "fixed inset-0 z-50 bg-background" : "h-full"
      )}
    >
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {file.name}
            {editing && <span className="ml-1 text-amber-500">•</span>}
          </div>
          <button
            type="button"
            onClick={copyPath}
            title="Copy file path"
            className="group/path flex max-w-full items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
          >
            <span className="truncate">
              {file.path}
              {file.size >= 0 && ` · ${formatSize(file.size)}`}
            </span>
            {copiedPath ? (
              <Check className="size-3 shrink-0 text-emerald-500" />
            ) : (
              <Copy className="size-3 shrink-0 opacity-0 transition-opacity group-hover/path:opacity-100" />
            )}
          </button>
        </div>

        {editing ? (
          <>
            {saveError && <span className="text-xs text-destructive">{saveError}</span>}
            <Button variant="ghost" size="sm" className="h-7" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" className="h-7" onClick={save} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save
            </Button>
          </>
        ) : (
          <>
            {gitStatus && (
              <div className="hidden h-7 overflow-hidden rounded-md border sm:flex">
                <TabButton active={view === "preview"} onClick={() => setView("preview")}>
                  Preview
                </TabButton>
                <TabButton active={view === "diff"} onClick={() => setView("diff")}>
                  <GitCompare className="size-3.5" /> Diff
                </TabButton>
              </div>
            )}

            {(isMarkdown || isHtml) && view === "preview" && (
              <div className="hidden h-7 overflow-hidden rounded-md border sm:flex">
                <TabButton active={mdView === "rendered"} onClick={() => setMdView("rendered")}>
                  {isHtml ? "Preview" : "Rendered"}
                </TabButton>
                <TabButton active={mdView === "raw"} onClick={() => setMdView("raw")}>
                  {isHtml ? "Source" : "Raw"}
                </TabButton>
              </div>
            )}

            {canEdit && view === "preview" && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-7 px-0"
                title="Edit"
                onClick={() => {
                  setDraft(text ?? "");
                  setEditing(true);
                }}
              >
                <Pencil className="size-4" />
              </Button>
            )}

            {kind === "image" && view === "preview" && (
              <Button variant="outline" size="sm" className="h-7 w-7 px-0" title="Fullscreen" onClick={() => setLightbox(true)}>
                <Expand className="size-4" />
              </Button>
            )}

            {/* Non-image previews open in a full-page popup instead of the image lightbox. */}
            {kind !== "image" && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-7 px-0"
                onClick={() => setFullscreen((f) => !f)}
                title={fullscreen ? "Exit full screen (Esc)" : "Full screen"}
              >
                {fullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
              </Button>
            )}
            <Button asChild variant="outline" size="sm" className="h-7 w-7 px-0" title="Download">
              <a href={rawUrl(true)} download={file.name}>
                <Download className="size-4" />
              </a>
            </Button>
          </>
        )}
      </header>

      <div ref={contentRef} className="min-h-0 flex-1 overflow-auto">
        {editing ? (
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="h-full w-full resize-none rounded-none border-0 font-mono text-xs leading-relaxed focus-visible:ring-0"
          />
        ) : view === "diff" ? (
          diffLoading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading diff…
            </div>
          ) : (
            <DiffView diff={diff ?? ""} />
          )
        ) : (
          <>
            {kind === "image" && (
              <div className="flex min-h-full items-center justify-center bg-[repeating-conic-gradient(theme(colors.muted)_0%_25%,transparent_0%_50%)] bg-[length:20px_20px] p-4">
                <button onClick={() => setLightbox(true)} title="Click to zoom" className="cursor-zoom-in">
                  <img
                    src={rawUrl()}
                    alt={file.name}
                    className="max-h-full max-w-full object-contain shadow-sm"
                  />
                </button>
              </div>
            )}

            {kind === "video" && (
              <div className="flex h-full items-center justify-center bg-black p-2">
                <video
                  src={rawUrl()}
                  controls
                  className="max-h-full max-w-full object-contain"
                />
              </div>
            )}

            {kind === "text" && status === "loading" && (
              <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading…
              </div>
            )}
            {kind === "text" && status === "error" && (
              <div className="p-4 text-sm text-destructive">Failed to read file.</div>
            )}
            {kind === "text" && status === "idle" && text !== null &&
              (isMarkdown && mdView === "rendered" ? (
                <div className="prose prose-sm max-w-none p-4 dark:prose-invert prose-pre:bg-muted prose-pre:text-foreground">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
                </div>
              ) : isHtml && mdView === "rendered" ? (
                // Render in a sandboxed iframe WITHOUT allow-same-origin: the document gets an
                // opaque origin, so page scripts can't reach this app's token or DOM. Relative
                // asset URLs won't resolve (no base) — self-contained pages preview best.
                <iframe
                  title={`Preview of ${file.name}`}
                  srcDoc={text}
                  sandbox="allow-scripts allow-forms allow-popups allow-modals"
                  className="h-full w-full border-0 bg-white"
                />
              ) : highlighted !== null ? (
                <pre className="overflow-auto whitespace-pre p-4 font-mono text-xs leading-relaxed">
                  <code
                    className="hljs bg-transparent p-0"
                    dangerouslySetInnerHTML={{ __html: highlighted }}
                  />
                </pre>
              ) : (
                <pre className="overflow-auto whitespace-pre p-4 font-mono text-xs leading-relaxed">{text}</pre>
              ))}

            {kind === "office" && file.size <= MAX_OFFICE_PREVIEW && (
              <OfficeViewer url={rawUrl()} name={file.name} />
            )}

            {kind === "pdf" && (
              <PdfViewer
                url={rawUrl()}
                downloadUrl={rawUrl(true)}
                name={file.name}
              />
            )}

            {(kind === "binary" ||
              status === "toolarge" ||
              (kind === "office" && file.size > MAX_OFFICE_PREVIEW)) && (
              <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                <FileIcon className="size-10 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  {status === "toolarge" || kind === "office"
                    ? "File is too large to preview."
                    : "No preview available for this file type."}
                </p>
                <Button asChild variant="outline" size="sm">
                  <a href={rawUrl(true)} download={file.name}>
                    <Download className="size-4" /> Download
                  </a>
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {lightbox && (
        <ImageLightbox
          src={rawUrl()}
          name={file.name}
          onClose={() => setLightbox(false)}
        />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 px-2.5 py-1 text-xs font-medium",
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
      )}
    >
      {children}
    </button>
  );
}

export function DiffView({ diff }: { diff: string }) {
  const lines = useMemo(() => diff.split("\n"), [diff]);
  if (!diff.trim())
    return <div className="p-4 text-sm text-muted-foreground">No differences to show.</div>;

  return (
    <div className="min-w-max py-1 font-mono text-xs leading-relaxed">
      {lines.map((ln, i) => {
        let cls = "";
        if (ln.startsWith("+") && !ln.startsWith("+++"))
          cls = "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
        else if (ln.startsWith("-") && !ln.startsWith("---"))
          cls = "bg-red-500/10 text-red-600 dark:text-red-400";
        else if (ln.startsWith("@@")) cls = "text-sky-600 dark:text-sky-400";
        else if (
          ln.startsWith("diff ") ||
          ln.startsWith("index ") ||
          ln.startsWith("+++") ||
          ln.startsWith("---") ||
          ln.startsWith("new file") ||
          ln.startsWith("deleted") ||
          ln.startsWith("similarity") ||
          ln.startsWith("rename ")
        )
          cls = "text-muted-foreground";
        return (
          <div key={i} className={cn("whitespace-pre px-4", cls)}>
            {ln || " "}
          </div>
        );
      })}
    </div>
  );
}
