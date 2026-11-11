import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type UIEvent } from "react";
import { ApiError } from "@/lib/api";
import type { FileEntry, GitStatus, GitWorktree } from "@/types";
import { MAX_MODEL_PREVIEW, MAX_OFFICE_PREVIEW, fileExt, fileKind, formatSize } from "@/lib/fileKind";
import { highlightCode, highlightLines } from "@/lib/highlight";
import { CodeLines, gutterStyle } from "./CodeLines";
import { useCodeNav } from "@/lib/codeNav";
import { useHtml } from "@/lib/useHtml";
import { useContentRev } from "@/lib/useContentRev";
import { readUrlState, previewUrl } from "@/lib/urlState";
import { loadSessionUi, saveSessionUi, subscribeSessionUi } from "@/lib/sessionUi";
import { EXPLORER_GUARD, fileEntryFromPath, UNKNOWN_SIZE, type FileTabs, type PreviewGuard } from "@/lib/useFileTabs";
import { useTreeKeyNav, navRowProps } from "@/lib/useTreeKeyNav";
import { useMarkedPaths, withoutDescendants, type MarkedPaths } from "@/lib/useMarkedPaths";
import { movedPairs, useTreeDrag } from "@/lib/useTreeDrag";
import { STATUS_COLOR } from "@/lib/gitStatusColor";
import {
  announceRemoteChange,
  clearFileClip,
  clipSourceFor,
  describeClip,
  getFileClip,
  hasTextSelection,
  sameSide,
  setFileClip,
  useFileClip,
} from "@/lib/fileClipboard";
import { folderName } from "@/lib/recentFolders";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/ui/confirm";
import { RenameField } from "./RenameField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CodeEditor } from "@/components/CodeEditor";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ImageLightbox } from "./ImageLightbox";
import { RootPicker, rootOptions } from "./RootPicker";
import { FolderPicker } from "./FolderPicker";
import { Markdown, MarkdownToc } from "./Markdown";
import { OfficeViewer } from "./OfficeViewer";
import { PdfViewer } from "./PdfViewer";
import { ModelViewer } from "./ModelViewer";
import {
  GitHistory,
  CommitFilePreview,
  CommitDetailPreview,
  type CommitSelection,
} from "./GitHistory";
import {
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  ClipboardPaste,
  Copy,
  Download,
  Expand,
  ExternalLink,
  File as FileIcon,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSymlink,
  GitCompare,
  History,
  Image as ImageIcon,
  ListChecks,
  ListTree,
  Loader2,
  Maximize2,
  Pencil,
  RefreshCw,
  Save,
  Scissors,
  Search,
  Square,
  SquareCheck,
  Trash2,
  Upload,
  Video,
  X,
} from "lucide-react";
import { writeToClipboard } from "@/lib/clipboard";
import { nativePath } from "@/lib/paths";
import { CopyPathButton } from "./CopyPathButton";
import { OverflowToolbar, type OverflowItem } from "./OverflowToolbar";
import {
  ScrollJumpButtons,
  ZoomControls,
  usePersistentLineNumbers,
  usePersistentReadingWidth,
  usePersistentWordWrap,
  usePersistentZoom,
} from "./ZoomControls";
import { sessionKey, useApi, useSessionKey } from "@/lib/node";

// Row-level actions threaded down to each tree node (rename inline, delete, new folder inside a dir).
interface RowActions {
  readOnly: boolean; // browsing another worktree — mutating actions are hidden
  renamingPath: string | null;
  onStartRename: (path: string) => void;
  onRename: (path: string, newName: string) => void;
  onCancelRename: () => void;
  onDelete: (entry: FileEntry) => void;
  onNewFolderIn: (dir: string) => void;
  mark: MarkedPaths; // rows marked for a batch action (see useMarkedPaths)
  // Rows can be dragged onto a folder to move them (the tree only); `over` is the folder a drop
  // would land in. See useTreeDrag.
  drag?: { over: string | null };
}

/**
 * A search box's query as a path: slashes levelled, ends trimmed, lowercased.
 *
 * What gets pasted into that box is often a path rather than a name — out of a terminal, a diff, a
 * stack trace — and it arrives in whatever slashes its source used. Matching it means levelling them
 * first; the server does the same to the paths it walks (see SessionFileBrowser.Search).
 */
function pathQuery(query: string): string {
  return query.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
}

const MAX_TEXT_PREVIEW = 2_000_000; // 2 MB

// Desktop width of the file-tree pane. Persisted per-browser and drag-resizable (like the sidebar).
const TREE_MIN = 180;
const TREE_MAX = 640;
const TREE_DEFAULT = 288; // matches the old md:w-72
const TREE_WIDTH_KEY = "hangar.filesTreeWidth";

function readTreeWidth() {
  const n = Number(localStorage.getItem(TREE_WIDTH_KEY));
  return Number.isFinite(n) && n > 0 ? Math.min(TREE_MAX, Math.max(TREE_MIN, n)) : TREE_DEFAULT;
}

// The same pane stacked above the preview on narrow screens, where the divider is horizontal and it
// is the height that gets dragged. Kept under its own key so a phone and a desktop don't fight.
const TREE_H_MIN = 96;
const TREE_H_DEFAULT = 256; // matches the old max-h-64
const PREVIEW_H_MIN = 120; // room the preview keeps below the tree, and so the tree's ceiling
const TREE_HEIGHT_KEY = "hangar.filesTreeHeight";

function readTreeHeight() {
  const n = Number(localStorage.getItem(TREE_HEIGHT_KEY));
  return Number.isFinite(n) && n > 0 ? Math.max(TREE_H_MIN, n) : TREE_H_DEFAULT;
}

// Which way the split runs right now — the divider is the same element in both layouts, so it asks
// at drag time rather than rendering two of them. Stated in rem, because that is what Tailwind's
// `md:` is: at a larger root font size the two part company, and the drag would work the wrong axis.
const ROW_LAYOUT_QUERY = "(min-width: 48rem)";
function isRowLayout() {
  return window.matchMedia(ROW_LAYOUT_QUERY).matches;
}

// Whether the preview header's Preview/Diff toggle is on screen — it is `sm:`-gated, and opening a
// file straight into its diff on a narrower screen would strand the user there.
const DIFF_TOGGLE_QUERY = "(min-width: 40rem)";
function hasDiffToggle() {
  return window.matchMedia(DIFF_TOGGLE_QUERY).matches;
}

export type GitFiles = Record<string, string>;

// Whether two sets hold the same members — used to leave state (and the renders below it) alone
// when the server's copy says what this browser already had.
function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// Whether two absolute server paths name the same folder. Compared loosely (case- and
// trailing-separator-insensitive) because a path can arrive from the server, storage or a picker.
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[/\\]+$/, "").replace(/\\/g, "/").toLowerCase();
  return !!a && !!b && norm(a) === norm(b);
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

/** Imperative handle: lets a parent (SessionView) open a file in this browser from elsewhere. */
// Every FileBrowser of a session browses the same root — the explorer, and each file tab on screen
// in a group of its own. The root is saved in the session's bag, but local saves do not notify, so a
// switch in one of them is announced here for the others to follow.
const rootListeners = new Set<(sessionKey: string, dir: string) => void>();

export interface FileBrowserHandle {
  revealFile: (path: string) => void;
  // Switch this browser into the git-changes view; `dir` also moves it to that root ("" = the
  // session's own), for the header's badge, which can name another worktree's branch.
  showChanges: (dir?: string) => void;
  // Move to the worktree the header's badge has just been pointed at ("" = the session's own).
  followWorktree: (dir: string) => void;
}

/** Two-pane file explorer: searchable, auto-refreshing directory tree + preview/edit pane. */
export const FileBrowser = forwardRef<
  FileBrowserHandle,
  {
    sessionId: string;
    // The session's absolute working dir; only used to turn a relative file path into an absolute
    // one for the standalone new-tab preview (which reads through the server-wide file API).
    workingDirectory: string;
    gitFiles?: GitFiles;
    // The session's open files. They are tabs in the session's own tab bar, so the state lives above
    // this panel (see lib/useFileTabs); the panel opens files into it and renders the active one.
    tabs: FileTabs;
    // Show the preview alone, no tree: the pane a file tab fills when it is the surface on screen.
    previewOnly?: boolean;
    // Which file that preview shows, when it is not the session's active file: each file tab on
    // screen has a browser of its own, and several can be on screen at once in a split pane.
    previewPath?: string;
    // Show the tree alone, no preview: the files it opens are showing in another group beside it,
    // the way an IDE's explorer sits beside its editors.
    treeOnly?: boolean;
    onRefresh?: () => void;
    refreshToken?: number;
  }
>(function FileBrowser(
  { sessionId, workingDirectory, gitFiles, tabs, previewOnly = false, previewPath, treeOnly: treeOnlyAsked = false, onRefresh, refreshToken = 0 },
  ref
) {
  const api = useApi();
  const uiKey = useSessionKey(sessionId);
  const { guardActiveEdits } = tabs;
  if (previewPath !== undefined) previewOnly = true;
  const selected = useMemo(
    () =>
      previewPath === undefined
        ? tabs.selected
        : tabs.tabs.find((t) => t.path === previewPath) ?? fileEntryFromPath(previewPath),
    [previewPath, tabs.selected, tabs.tabs]
  );
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FileEntry[] | null>(null);
  const [searching, setSearching] = useState(false);
  // Whether the tree shows git changes (+ the history panel) instead of all files — remembered per
  // session so returning to it (or reloading) restores the changes/history view.
  const [showChanges, setShowChanges] = useState(() => loadSessionUi(uiKey).changes ?? false);
  // Or the commit history alone, in place of the tree — the history without having to go through
  // the changes view to reach it. The two views are exclusive; each button switches straight to its
  // own from the other.
  const [showCommits, setShowCommits] = useState(() => loadSessionUi(uiKey).commits ?? false);
  const toggleChanges = useCallback(() => {
    const next = !showChanges || showCommits;
    setShowChanges(next);
    setShowCommits(false);
    if (!next) setCommitSel(null); // back to the files drops the commit preview
    saveSessionUi(uiKey, { changes: next, commits: false });
  }, [sessionId, showChanges, showCommits]);
  const toggleCommits = useCallback(() => {
    const next = !showCommits;
    setShowCommits(next);
    if (next) setShowChanges(false);
    else setCommitSel(null);
    saveSessionUi(uiKey, next ? { commits: true, changes: false } : { commits: false });
  }, [sessionId, showCommits]);
  // The whole browser (Files tree, search, changes, preview) can be pointed at another root: either
  // another worktree of the session's repo, or a folder the user has linked to the session. "" = the
  // session's own working dir. A worktree is browsed read-only (the mutating endpoints refuse it); a
  // linked folder was chosen deliberately, so it stays fully editable.
  const [worktrees, setWorktrees] = useState<GitWorktree[] | null>(null); // null = not loaded yet
  const [linked, setLinked] = useState<string[] | null>(null); // linked folders; null = not loaded yet
  // Restored per session (and across reloads); validated against both lists once they've loaded.
  const [rootDir, setRootDir] = useState(() => loadSessionUi(uiKey).worktree ?? "");
  const [altStatus, setAltStatus] = useState<GitStatus | null>(null);
  const isLinkedRoot = !!rootDir && (linked ?? []).some((f) => samePath(f, rootDir));
  // The roots the picker offers, in one list: worktrees first, then the folders linked by hand.
  const rootChoices = useMemo(
    () => rootOptions(worktrees, linked, workingDirectory),
    [worktrees, linked, workingDirectory]
  );
  const readOnly = !!rootDir && !isLinkedRoot; // browsing another worktree
  // Root that writes (upload / rename / delete / new folder / save) target; undefined = the
  // session's own working dir.
  const writeDir = isLinkedRoot ? rootDir : undefined;

  // Point the browser at a root, without disturbing anything else. Used when code — not the user —
  // moves it: revealing a working-dir file, or dropping a root that has gone away.
  const setRoot = useCallback(
    (dir: string) => {
      setRootDir(dir);
      saveSessionUi(uiKey, { worktree: dir });
      for (const cb of rootListeners) cb(uiKey, dir);
    },
    [uiKey]
  );
  useEffect(() => {
    const cb = (key: string, dir: string) => key === uiKey && setRootDir(dir);
    rootListeners.add(cb);
    return () => void rootListeners.delete(cb);
  }, [uiKey]);

  // Per session: restore its saved root and (re)load the repo's worktrees plus the linked folders. A
  // stale response landing after a quick session switch must be dropped — validating the restored
  // pick against another session's lists would wrongly wipe it.
  useEffect(() => {
    setRootDir(loadSessionUi(uiKey).worktree ?? "");
    setAltStatus(null);
    setWorktrees(null);
    setLinked(null);
    let cancelled = false;
    api.gitWorktrees(sessionId)
      .then((list) => !cancelled && setWorktrees(list))
      .catch(() => !cancelled && setWorktrees([]));
    api.linkedFolders(sessionId)
      .then((list) => !cancelled && setLinked(list))
      .catch(() => !cancelled && setLinked([]));
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Drop a restored pick that's gone: a worktree removed since it was saved, or a folder unlinked
  // (possibly from another browser). Waits for both lists so a slow response can't wipe a valid pick.
  useEffect(() => {
    if (!rootDir || worktrees === null || linked === null) return;
    const known =
      worktrees.some((w) => !w.isCurrent && samePath(w.path, rootDir)) ||
      linked.some((f) => samePath(f, rootDir));
    if (!known) setRoot("");
  }, [worktrees, linked, rootDir, setRoot]);

  // Fetch the selected worktree's status; the session's own uses the passed gitFiles, and a linked
  // folder is a different tree altogether (no git view — see gitAvailable below).
  useEffect(() => {
    // Waits for the linked list: until it lands a restored linked folder still looks like a worktree,
    // and asking git about it would only earn a rejection.
    if (!rootDir || isLinkedRoot || linked === null) return void setAltStatus(null);
    let cancelled = false;
    api.gitStatus(sessionId, rootDir).then((s) => !cancelled && setAltStatus(s)).catch(() => !cancelled && setAltStatus(null));
    return () => {
      cancelled = true;
    };
  }, [rootDir, isLinkedRoot, linked, sessionId, refreshToken]);

  // In the changes view, group changed files under collapsible folders instead of a flat list.
  const [changesTree, setChangesTree] = useState(() => loadSessionUi(uiKey).changesTree ?? false);
  const toggleChangesTree = useCallback(() => {
    setChangesTree((v) => {
      const next = !v;
      saveSessionUi(uiKey, { changesTree: next });
      return next;
    });
  }, [sessionId]);

  // Expanded-folder state for the two trees. Both are collapsed by default, so we persist only the
  // set of folders the user has opened; anything absent renders collapsed. Seed the Files tree with
  // the ancestors of the file being restored so it expands into view on load.
  const [filesExpanded, setFilesExpanded] = useState<Set<string>>(() => {
    const ui = loadSessionUi(uiKey);
    const set = new Set(ui.filesExpanded ?? []);
    const u = readUrlState();
    const reveal = (sessionKey(u.node, u.session ?? "") === uiKey && u.file ? u.file : ui.file) || null;
    if (reveal) for (const d of ancestorDirs(reveal)) set.add(d);
    return set;
  });
  const [changesExpanded, setChangesExpanded] = useState<Set<string>>(
    () => new Set(loadSessionUi(uiKey).changesExpanded ?? [])
  );
  // Bumped when the copy the server holds for this session arrives, which is generally after this
  // panel has already read the local mirror — the effects that only run at mount re-run off it.
  const [seedEpoch, setSeedEpoch] = useState(0);

  // The saved state lives on the server, so opening a session fetches it and it lands here a moment
  // after mount: this device may never have seen the session, or may have seen it before another one
  // moved things around. Only that seed is taken — a later write from another browser must not
  // re-expand folders or jump the tree under whoever is using this one.
  useEffect(
    () =>
      subscribeSessionUi(uiKey, (seed) => {
        if (!seed) return;
        const ui = loadSessionUi(uiKey);
        setRootDir(ui.worktree ?? "");
        setShowChanges(ui.changes ?? false);
        setShowCommits(ui.commits ?? false);
        setChangesTree(ui.changesTree ?? false);
        setFilesExpanded((cur) => {
          const next = new Set(ui.filesExpanded ?? []);
          // Keep the tree open down to whatever file the seed says is active.
          if (ui.file) for (const d of ancestorDirs(ui.file)) next.add(d);
          return sameSet(cur, next) ? cur : next;
        });
        setChangesExpanded((cur) => {
          const next = new Set(ui.changesExpanded ?? []);
          return sameSet(cur, next) ? cur : next;
        });
        setSeedEpoch((e) => e + 1);
      }),
    [sessionId]
  );
  const toggleFilesDir = useCallback(
    (path: string) => {
      setFilesExpanded((s) => {
        const n = new Set(s);
        n.has(path) ? n.delete(path) : n.add(path);
        saveSessionUi(uiKey, { filesExpanded: [...n] });
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
        saveSessionUi(uiKey, { changesExpanded: [...n] });
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
        saveSessionUi(uiKey, { filesExpanded: [...n] });
        return n;
      });
    },
    [sessionId]
  );
  // A file picked out of a commit in the History panel — previewed in place of a working-tree file.
  const [commitSel, setCommitSel] = useState<CommitSelection | null>(null);
  // Tree alone, as asked — except while a commit is picked: its preview has nowhere to show but
  // beside the tree, unlike a file, which has a tab of its own in the other group.
  const treeOnly = treeOnlyAsked && !commitSel;
  const [treeWidth, setTreeWidth] = useState(readTreeWidth); // desktop tree-pane width (px)
  const [treeHeight, setTreeHeight] = useState(readTreeHeight); // mobile tree-pane height (px)

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
        await api.uploadSessionFiles(sessionId, uploadDir, Array.from(files), writeDir);
        onRefresh?.();
      } catch {
        setUploadError("Upload failed");
      } finally {
        setUploading(false);
      }
    },
    [sessionId, uploadDir, writeDir, onRefresh]
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
      const r = await api.createSessionFolder(sessionId, rel, writeDir);
      setUploadDir(r.path); // target the folder we just made
      setCreatingFolder(false);
      setNewFolder("");
      onRefresh?.();
    } catch {
      setFolderError("Couldn't create folder");
    } finally {
      setFolderBusy(false);
    }
  }, [newFolder, uploadDir, sessionId, writeDir, onRefresh]);

  // Drag the divider between the tree and the preview to resize the tree; persist the result. Side by
  // side that means the tree's width, stacked it means its height — same gesture, whichever axis the
  // split currently runs along. Touch drags come through as pointer events too, so both work here.
  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const row = isRowLayout();
    const box = e.currentTarget.parentElement?.getBoundingClientRect();
    // Stacked, the ceiling is the pane itself: leave room for the preview below rather than a
    // fixed pixel cap, since a phone in landscape has far less to give than one upright. The same
    // ceiling is on the pane as a max-height, so the drag stops exactly where the layout does.
    const max = row
      ? TREE_MAX
      : Math.max(TREE_H_MIN, (box?.height ?? window.innerHeight) - PREVIEW_H_MIN);
    const min = row ? TREE_MIN : TREE_H_MIN;
    const start = row ? e.clientX : e.clientY;
    const startSize = row ? readTreeWidth() : readTreeHeight();
    let size = startSize;
    const onMove = (ev: PointerEvent) => {
      size = Math.min(max, Math.max(min, startSize + (row ? ev.clientX : ev.clientY) - start));
      if (row) setTreeWidth(size);
      else setTreeHeight(size);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem(row ? TREE_WIDTH_KEY : TREE_HEIGHT_KEY, String(size));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = row ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  }, []);

  const resetTreeSize = useCallback(() => {
    if (isRowLayout()) {
      setTreeWidth(TREE_DEFAULT);
      localStorage.setItem(TREE_WIDTH_KEY, String(TREE_DEFAULT));
    } else {
      setTreeHeight(TREE_H_DEFAULT);
      localStorage.setItem(TREE_HEIGHT_KEY, String(TREE_H_DEFAULT));
    }
  }, []);

  // A user-driven root switch (the picker, or linking/unlinking a folder). Open tabs and the upload
  // target are paths *inside* the current root: worktrees of one repo share a layout so they carry
  // over, but a linked folder is an unrelated tree, so switching to or from one closes the open
  // files. `folders` overrides the linked list for a folder that was linked moments ago (state
  // hasn't settled yet). Returns false if the user cancelled at the unsaved-changes prompt.
  const pickRoot = useCallback(
    async (dir: string, folders: string[] = linked ?? []): Promise<boolean> => {
      if (dir === rootDir) return true;
      const unrelated = isLinkedRoot || (!!dir && folders.some((f) => samePath(f, dir)));
      if (unrelated) {
        if (!(await guardActiveEdits())) return false;
        tabs.replace([], null, null);
        setCommitSel(null);
        setUploadDir("");
        setCreatingFolder(false);
        setQuery("");
      }
      setRoot(dir);
      return true;
    },
    [rootDir, linked, isLinkedRoot, guardActiveEdits, tabs, setRoot]
  );

  // Switch into the changes view (used by the header's branch badge). Idempotent if already there.
  // The changes are the session repo's, so a linked folder is left behind first.
  const openChanges = useCallback(
    (dir?: string) => {
      setShowChanges(true);
      setShowCommits(false);
      saveSessionUi(uiKey, { changes: true, commits: false });
      const target = dir ?? (isLinkedRoot ? "" : rootDir);
      if (target !== rootDir && !samePath(target, rootDir)) pickRoot(target);
    },
    [sessionId, isLinkedRoot, rootDir, pickRoot]
  );

  // The header's badge was pointed at another worktree -- from the badge, or by the session itself --
  // so the panel goes where the work now is. The worktrees are re-read first: one the session has
  // only just created is missing from the list loaded at open, and the check that drops a root gone
  // stale would throw the move straight back out.
  const followWorktree = useCallback(
    async (dir: string) => {
      let list: GitWorktree[];
      try {
        list = await api.gitWorktrees(sessionId);
      } catch {
        return;
      }
      setWorktrees(list);
      const tree = dir ? list.find((w) => samePath(w.path, dir)) : undefined;
      if (!dir || tree) void pickRoot(!tree || tree.isCurrent ? "" : tree.path);
    },
    [api, sessionId, pickRoot]
  );

  // ---- Linked folders: extra folders attached to this session, browsable in place of its own tree.
  // The list lives on the server (keyed by the session's working folder) so it survives a restart.
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkPath, setLinkPath] = useState("");
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  const linkFolder = useCallback(async () => {
    const path = linkPath.trim();
    if (!path) return;
    setLinking(true);
    setLinkError(null);
    try {
      const folders = await api.linkFolder(sessionId, path);
      setLinked(folders);
      setLinkOpen(false);
      // Show it right away — looking at the folder is the point of linking it.
      await pickRoot(folders.find((f) => samePath(f, path)) ?? path, folders);
    } catch (e) {
      setLinkError(e instanceof ApiError ? e.message : "Could not link that folder.");
    } finally {
      setLinking(false);
    }
  }, [linkPath, sessionId, pickRoot]);

  const unlinkFolder = useCallback(
    async (path: string) => {
      // Leave the folder before unlinking it, so the panel doesn't sit on a root it may no longer read.
      if (samePath(path, rootDir) && !(await pickRoot(""))) return;
      try {
        setLinked(await api.unlinkFolder(sessionId, path));
      } catch {
        /* ignore — best effort */
      }
    },
    [rootDir, sessionId, pickRoot]
  );

  // Tree/list selection: single click previews, middle/double click opens a pinned tab. Leaving a
  // commit's diff behind is what opening a working-tree file means; a dirty file can never be showing
  // while a commit is (the preview holding the edits is unmounted), so dropping the commit ahead of
  // the tab api's unsaved-edit guard can't discard anything.
  const selectFile = useCallback(
    (f: FileEntry, newTab?: boolean) => {
      setCommitSel(null);
      void tabs.open(f, !!newTab);
    },
    [tabs]
  );

  // Which repo's changes to show: the session's own (gitFiles) or the picked worktree's (altStatus).
  // A linked folder is an unrelated tree, so it has none — the changes view and history hide there,
  // and `changesView` (not the raw `showChanges`) drives the render so a remembered changes view
  // simply comes back when the session's own folder is selected again.
  const effectiveGitFiles = isLinkedRoot ? undefined : rootDir ? altStatus?.files : gitFiles;
  const gitAvailable = !!gitFiles && !isLinkedRoot;
  const commitsView = showCommits && gitAvailable;
  const changesView = showChanges && gitAvailable && !commitsView;

  // The tree pane's scroll container. Its offset is remembered per session and per view, so
  // switching sessions (or reloading) comes back to the same place rather than the top of the tree.
  const treeScrollRef = useRef<HTMLDivElement>(null);

  // ---- Per-node file operations (rename / delete / new folder inside a folder) ----
  const confirm = useConfirm();
  // What a failed batch delete left behind, said where the selection was made. A single delete has
  // no such line -- the row it failed on is still sitting there, which says it.
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Rows marked for a batch action. A range is measured across the tree pane, so the scroll
  // container is what the hook reads row order back from -- whichever tree happens to be in it.
  const mark = useMarkedPaths(treeScrollRef);
  // A mark is a path, and a path here means the root it was made under. Switching session or folder
  // turns every one of them into a claim about a tree that is no longer on screen -- and the batch
  // delete would happily act on it -- so a selection does not outlive the thing it was made in.
  useEffect(() => {
    mark.clear();
  }, [sessionId, rootDir, mark.clear]);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);

  /**
   * Close any tab showing one of these paths, or a file that was inside one of them. Deleting a file
   * out from under its own tab leaves a tab that can only ever report that the file is gone.
   */
  const closeTabsUnder = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) return;
      const affected = (p: string) => paths.some((d) => p === d || p.startsWith(d + "/"));
      if (!tabs.tabs.some((t) => affected(t.path))) return;
      const next = tabs.tabs.filter((t) => !affected(t.path));
      const cur = tabs.activePath;
      const prev = tabs.previewPath;
      tabs.replace(
        next,
        cur && !affected(cur) ? cur : next[0]?.path ?? null,
        prev && !affected(prev) ? prev : null
      );
    },
    [tabs]
  );

  /** Keep open tabs on files that moved: a tab on a moved file, or on one inside a moved folder, follows it. */
  const followMoves = useCallback(
    (moves: [from: string, to: string][]) => {
      const moveOf = (p: string) => moves.find(([from]) => p === from || p.startsWith(from + "/"));
      const remap = (p: string | null) => {
        const m = p ? moveOf(p) : undefined;
        return p && m ? m[1] + p.slice(m[0].length) : p;
      };
      if (!tabs.tabs.some((t) => moveOf(t.path))) return;
      tabs.replace(
        tabs.tabs.map((t) => (moveOf(t.path) ? fileEntryFromPath(remap(t.path)!) : t)),
        remap(tabs.activePath),
        remap(tabs.previewPath)
      );
    },
    [tabs]
  );

  const doRename = useCallback(
    async (path: string, newName: string) => {
      setRenamingPath(null);
      const clean = newName.trim();
      if (!clean || clean === path.split("/").pop()) return;
      try {
        await api.renameSessionFile(sessionId, path, clean, writeDir);
        // Follow any open tab whose file (or ancestor folder) was renamed.
        const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        followMoves([[path, parent ? `${parent}/${clean}` : clean]]);
        onRefresh?.();
      } catch {
        /* ignore — best effort */
      }
    },
    [sessionId, writeDir, followMoves, onRefresh]
  );

  const doDelete = useCallback(
    async (entry: FileEntry) => {
      const staged = hasStagedAdd(effectiveGitFiles, entry.path, entry.isDir);
      const ok = await confirm({
        title: `Delete ${entry.isDir ? "folder" : "file"}?`,
        description: (
          <>
            Permanently delete <span className="font-medium text-foreground">{entry.name}</span>
            {entry.isDir && " and everything inside it"}.
            {staged &&
              (entry.isDir
                ? " Staged-but-uncommitted files inside it are unstaged as well — otherwise a commit would still add them."
                : " It is staged but not committed, so it is unstaged as well — otherwise a commit would still add it.")}
          </>
        ),
        confirmLabel: "Delete",
      });
      if (!ok) return;
      try {
        await api.deleteSessionFile(sessionId, entry.path, writeDir);
        closeTabsUnder([entry.path]);
        onRefresh?.();
      } catch {
        /* ignore — best effort */
      }
    },
    [sessionId, writeDir, closeTabsUnder, confirm, onRefresh, effectiveGitFiles]
  );

  /**
   * Delete everything marked, behind one confirmation that names what is going.
   *
   * The names are spelled out rather than counted. A mark outlives its folder being collapsed and a
   * switch to the changes view, so a selection can hold rows that are no longer on screen, and
   * "Delete 7 items?" would be asking for a yes to something the answer cannot be seen from.
   */
  const deleteMarked = useCallback(async () => {
    const paths = withoutDescendants([...mark.marked.keys()]);
    if (paths.length === 0) return;
    const dirs = paths.filter((p) => mark.marked.get(p)).length;
    const staged = paths.some((p) => hasStagedAdd(effectiveGitFiles, p, !!mark.marked.get(p)));
    const ok = await confirm({
      title: `Delete ${paths.length} item${paths.length === 1 ? "" : "s"}?`,
      description: (
        <>
          <span className="mb-2 block">
            Permanently delete{dirs > 0 && " these, and everything inside the folders"}:
          </span>
          <span className="mb-2 block max-h-40 overflow-y-auto">
            {paths.map((path) => (
              <span key={path} className="block truncate font-mono text-xs text-foreground" title={path}>
                {mark.marked.get(path) ? "📁 " : ""}
                {path}
              </span>
            ))}
          </span>
          {staged && (
            <span className="block">
              Staged-but-uncommitted files among them are unstaged as well — otherwise a commit would
              still add them.
            </span>
          )}
        </>
      ),
      confirmLabel: `Delete ${paths.length}`,
    });
    if (!ok) return;
    const failed: string[] = [];
    const gone: string[] = [];
    // One at a time, and every one attempted: a file that refuses to go is no reason to leave the
    // rest of the selection standing.
    for (const path of paths) {
      try {
        await api.deleteSessionFile(sessionId, path, writeDir);
        gone.push(path);
      } catch {
        failed.push(path);
      }
    }
    closeTabsUnder(gone);
    mark.clear();
    setDeleteError(
      failed.length === 0
        ? null
        : failed.length === paths.length
          ? "Delete failed."
          : `Deleted ${gone.length}, could not delete ${failed.length}: ${failed.join(", ")}.`
    );
    onRefresh?.();
  }, [mark, sessionId, writeDir, closeTabsUnder, confirm, onRefresh, effectiveGitFiles]);

  // ---- The app's file clipboard: copy or cut here, paste into any file panel — a remote tab
  //      over SSH, another session's files, or back into this one. See lib/fileClipboard.
  const clip = useFileClip();
  const [pasting, setPasting] = useState(false);
  const clipSide = useMemo(
    () => ({ kind: "session" as const, sessionId, dir: rootDir || undefined }),
    [sessionId, rootDir]
  );
  /** Marked rows, else the file on show — what Copy and Cut take. */
  const clipSubject = useCallback((): { path: string; isDir: boolean }[] => {
    if (mark.count > 0) return withoutDescendants([...mark.marked.keys()]).map((p) => ({ path: p, isDir: !!mark.marked.get(p) }));
    return selected?.path ? [{ path: selected.path, isDir: false }] : [];
  }, [mark, selected]);
  const toClipboard = useCallback(
    (mode: "copy" | "cut") => {
      const items = clipSubject();
      if (items.length === 0 || (mode === "cut" && readOnly)) return;
      setFileClip({
        mode,
        base: api.base,
        source: clipSide,
        label: folderName(rootDir || workingDirectory),
        items: items.map((i) => ({ path: i.path, name: i.path.split("/").pop() || i.path, isDir: i.isDir })),
      });
      mark.clear();
    },
    [api, clipSubject, readOnly, clipSide, rootDir, workingDirectory, mark]
  );
  const paste = useCallback(async () => {
    const c = getFileClip();
    if (!c || readOnly) return;
    const from = clipSourceFor(c, api.base);
    if ("error" in from) {
      setDeleteError(from.error);
      return;
    }
    const move = c.mode === "cut";
    setPasting(true);
    setDeleteError(null);
    try {
      const r = await api.transfer(from.source, c.items.map((i) => i.path), clipSide, uploadDir, move);
      if (move && r.errors.length === 0) clearFileClip();
      // Same side means the same node too: a peer's session can't be told from one here by its id alone.
      if (move && (c.base ?? "") === api.base && sameSide(c.source, clipSide)) closeTabsUnder(c.items.map((i) => i.path));
      if (move && c.source.kind === "remote")
        announceRemoteChange(c.source.tab, c.items.map((i) => i.path).filter((p) => !r.errors.some((x) => x.path === p)));
      if (r.errors.length) setDeleteError(r.errors.map((x) => `${x.path.split("/").pop()}: ${x.error}`).join(" · "));
    } catch (e) {
      setDeleteError(`Paste failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPasting(false);
      onRefresh?.();
    }
  }, [api, readOnly, clipSide, uploadDir, closeTabsUnder, onRefresh]);

  // ---- Drag and drop in the tree: rows dropped on a folder move into it. Same move as a cut and a
  //      paste within this root, so the same rules hold -- nothing written over, a taken name gets
  //      " (1)" -- and open tabs follow their files to where they went.
  const moveInto = useCallback(
    async (paths: string[], folder: string) => {
      if (readOnly) return;
      setDeleteError(null);
      try {
        const r = await api.transfer(clipSide, paths, clipSide, folder, true);
        const moves = movedPairs(paths, r);
        if (moves) followMoves(moves);
        if (r.errors.length) setDeleteError(r.errors.map((x) => `${x.path.split("/").pop()}: ${x.error}`).join(" · "));
        // A drag of the marked rows uses the selection up; one of some other row leaves it standing.
        if (paths.some((p) => mark.has(p))) mark.clear();
        // Open the folder they went into, so the move can be seen to have happened.
        if (folder && !filesExpanded.has(folder)) toggleFilesDir(folder);
      } catch (e) {
        setDeleteError(`Move failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        onRefresh?.();
      }
    },
    [api, readOnly, clipSide, followMoves, mark, filesExpanded, toggleFilesDir, onRefresh]
  );
  const treeDrag = useTreeDrag({
    mark,
    parentOf: (p) => (p ? (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") : null),
    root: "",
    onMove: (paths, folder) => void moveInto(paths, folder),
    onOpenDir: toggleFilesDir,
  });

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
    mark,
  };
  // Dragging is the tree's alone: a search result or a changed file has no folder around it on
  // screen to be dropped into, and another worktree is browsed read-only.
  const treeDragOn = !readOnly && !changesView && !query.trim();
  const treeActions: RowActions = treeDragOn ? { ...rowActions, drag: { over: treeDrag.over } } : rowActions;

  // Reveal a file in the working-tree Files pane (from a commit preview): leave the changes/commit
  // view, select it, and expand the tree down to it.
  const revealFile = useCallback(
    async (path: string) => {
      // Leaving a linked folder closes its tabs, so check for unsaved edits the same way a switch
      // through the picker would. (The plain path guards inside the tab api's open.)
      if (isLinkedRoot && !(await guardActiveEdits())) return;
      setShowChanges(false);
      setShowCommits(false);
      setQuery("");
      expandFilesTo(path);
      // The path is relative to the session's own working dir, so step out of any linked folder
      // first. Its tabs belong to that other tree: replace them outright (rather than going through
      // pickRoot, whose clearing would then race this open) so the revealed file is what's left.
      if (isLinkedRoot) {
        setRoot("");
        tabs.replace([fileEntryFromPath(path)], path, path);
        setCommitSel(null);
        setUploadDir("");
        return;
      }
      setCommitSel(null);
      void tabs.open(fileEntryFromPath(path), false);
    },
    [tabs, expandFilesTo, isLinkedRoot, guardActiveEdits, setRoot]
  );

  // Let SessionView open a file here (from a terminal file-link click) or switch to the changes view.
  useImperativeHandle(
    ref,
    () => ({ revealFile, showChanges: openChanges, followWorktree: (dir) => void followWorktree(dir) }),
    [revealFile, openChanges, followWorktree]
  );

  // When the session actually changes, restore that session's last-previewed file (or clear if it
  // had none). Skips the initial mount (and StrictMode's double-invoked mount effect), so the
  // URL-restored selection survives.
  const prevSession = useRef(sessionId);
  useEffect(() => {
    if (prevSession.current === sessionId) return;
    prevSession.current = sessionId;
    const ui = loadSessionUi(uiKey);
    const nextFilesExpanded = new Set(ui.filesExpanded ?? []);
    // useFileTabs restores the tab list; expand the tree down to whatever it lands on.
    if (ui.file) for (const d of ancestorDirs(ui.file)) nextFilesExpanded.add(d);
    setFilesExpanded(nextFilesExpanded);
    setChangesExpanded(new Set(ui.changesExpanded ?? []));
    setCommitSel(null);
    setQuery("");
    setShowChanges(ui.changes ?? false);
    setShowCommits(ui.commits ?? false);
    setChangesTree(ui.changesTree ?? false);
    setUploadDir("");
    setUploadError(null);
    setCreatingFolder(false);
    setNewFolder("");
    setFolderError(null);
  }, [sessionId]);

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
    const q = pathQuery(query);
    if (!q) return changeEntries;
    const base = (rootDir || workingDirectory).replace(/\\/g, "/").toLowerCase();
    // Against the whole path as well as the repo-relative one, so a path pasted out of Explorer or a
    // terminal finds its file here too — the same rule the server searches by (SessionFileBrowser.Search).
    return changeEntries.filter(
      (e) => e.path.toLowerCase().includes(q) || `${base}/${e.path}`.toLowerCase().includes(q)
    );
  }, [changeEntries, query, rootDir, workingDirectory]);

  // The grouped changes tree, built once here so the header's collapse/expand-all can enumerate every
  // rendered folder (compacted paths — the same keys the folder rows toggle on).
  const changeTreeRoot = useMemo(() => buildChangeTree(filteredChangeEntries), [filteredChangeEntries]);
  const allChangeDirPaths = useMemo(() => collectChangeDirPaths(changeTreeRoot), [changeTreeRoot]);
  const allChangesExpanded =
    allChangeDirPaths.length > 0 && allChangeDirPaths.every((p) => changesExpanded.has(p));
  const expandAllChanges = useCallback(() => {
    const set = new Set(allChangeDirPaths);
    setChangesExpanded(set);
    saveSessionUi(uiKey, { changesExpanded: [...set] });
  }, [allChangeDirPaths, sessionId]);
  const collapseAllChanges = useCallback(() => {
    setChangesExpanded(new Set());
    saveSessionUi(uiKey, { changesExpanded: [] });
  }, [sessionId]);

  // Arrow-key walking of whichever tree the pane is showing. Landing on a file previews it (the
  // same as clicking it), so ↑/↓ steps through a folder the way an image viewer does; folders are
  // opened with → / Enter.
  const treeKeys = useTreeKeyNav({
    containerRef: treeScrollRef,
    onFocusFile: (path) => selectFile(fileEntryFromPath(path)),
    onToggleDir: (path) => {
      if (changesView && changesTree) return toggleChangesDir(path);
      toggleFilesDir(path);
      setUploadDir(path); // clicking a folder does this too — the keys mirror it
    },
  });
  const restoredScrollRef = useRef(false);
  const saveScrollRef = useRef<number | undefined>(undefined);
  // Results are transient — no offset kept. The commits view has no search box (nor a tree).
  const searchActive = !changesView && !commitsView && !!query.trim();

  // Re-arm the restore whenever the pane switches to showing something else.
  useEffect(() => {
    restoredScrollRef.current = false;
  }, [sessionId, changesView, commitsView, searchActive, seedEpoch]);

  // Replay the remembered offset, but only once the tree has stopped growing: folder levels each
  // fetch on their own, and scrolling while rows are still arriving above the viewport lets the
  // browser's scroll anchoring drag the offset somewhere else entirely. A quiet DOM means every level
  // that was going to render has; if the tree ends up shorter than it was (folders collapsed since),
  // go as far as it allows instead of waiting forever.
  useEffect(() => {
    if (searchActive) return;
    const box = treeScrollRef.current;
    if (!box) return;
    const ui = loadSessionUi(uiKey);
    const target = (changesView ? ui.changesScroll : ui.filesScroll) ?? 0;
    if (!(target > 0)) {
      restoredScrollRef.current = true;
      return;
    }
    const deadline = Date.now() + 3000;
    let timer = 0;
    const apply = () => {
      if (restoredScrollRef.current) return;
      const max = Math.max(0, box.scrollHeight - box.clientHeight);
      if (max < target && Date.now() < deadline) {
        timer = window.setTimeout(apply, 200); // a level is probably still fetching — look again
        return;
      }
      box.scrollTop = Math.min(target, max);
      restoredScrollRef.current = true;
      obs.disconnect();
    };
    const settle = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(apply, 120);
    };
    const obs = new MutationObserver(settle);
    obs.observe(box, { childList: true, subtree: true });
    settle(); // the tree may already be complete
    return () => {
      obs.disconnect();
      window.clearTimeout(timer);
    };
  }, [sessionId, changesView, commitsView, searchActive, seedEpoch]);

  // Save it back, debounced. Scrolls that land before the restore are the browser shifting rows
  // around as they load, not the user, so they mustn't overwrite the remembered offset.
  const onTreeScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      if (!restoredScrollRef.current || searchActive) return;
      const top = Math.round(e.currentTarget.scrollTop);
      window.clearTimeout(saveScrollRef.current);
      saveScrollRef.current = window.setTimeout(
        () => saveSessionUi(uiKey, changesView ? { changesScroll: top } : { filesScroll: top }),
        200
      );
    },
    [sessionId, changesView, searchActive]
  );

  // Debounced recursive search — only for the all-files tree; the changes view filters locally.
  useEffect(() => {
    const q = query.trim();
    if (!q || changesView || commitsView) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      api
        .searchSessionFiles(sessionId, q, rootDir || undefined)
        .then((r) => setResults(r.entries))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(t);
  }, [query, sessionId, refreshToken, changesView, commitsView, rootDir]);

  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* The tree, hidden when a file tab owns the whole pane — there the file is the view. */}
      <div
        style={
          {
            "--tree-w": `${treeWidth}px`,
            "--tree-h": `${treeHeight}px`,
            "--tree-h-max": `max(${TREE_H_MIN}px, calc(100% - ${PREVIEW_H_MIN}px))`,
          } as React.CSSProperties
        }
        className={cn(
          // The stacked cap mirrors the drag ceiling exactly, in CSS so it re-applies wherever the
          // pane lands: a height dragged in the full-width Files view would otherwise overflow the
          // half-height Split view (and a rotation into landscape), pushing the preview — and the
          // divider that would have fixed it — off the bottom of the screen.
          "flex h-[var(--tree-h)] max-h-[var(--tree-h-max)] w-full shrink-0 flex-col border-b",
          "md:h-auto md:max-h-none md:w-[var(--tree-w)] md:border-b-0",
          // Alone, the tree is the whole pane: no preview below or beside it to leave room for.
          treeOnly && "h-full max-h-none border-b-0 md:w-full md:flex-1",
          previewOnly && "hidden"
        )}
      >
        {/* A preview-only browser draws no tree at all: hidden, it would still fetch every folder
            level it had open, once for each file tab on screen. */}
        {!previewOnly && (<>
        <div className="flex items-center justify-between px-3 py-2 text-xs font-medium text-muted-foreground">
          <span>{commitsView ? "Commits" : changesView ? "Changes" : "Files"}</span>
          <div className="flex items-center gap-1.5">
            {gitAvailable && (
              <button
                title={changesView ? "Show all files" : "Show git changes only"}
                onClick={toggleChanges}
                className={cn(
                  "flex items-center gap-1 rounded px-1 py-0.5 hover:text-foreground",
                  changesView ? "bg-amber-500/15 text-amber-500" : ""
                )}
              >
                <GitCompare className="size-3.5" />
                {changeCount > 0 && <span className="text-[10px] font-semibold">{changeCount}</span>}
              </button>
            )}
            {gitAvailable && (
              <button
                title={commitsView ? "Show all files" : "Show commits"}
                aria-pressed={commitsView}
                onClick={toggleCommits}
                className={cn(
                  "flex items-center rounded px-1 py-0.5 hover:text-foreground",
                  commitsView && "bg-accent text-foreground"
                )}
              >
                <History className="size-3.5" />
              </button>
            )}
            {changesView && (
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
            {changesView && changesTree && allChangeDirPaths.length > 0 && (
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
            {!readOnly && !commitsView && (
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
            {!readOnly && !commitsView && (
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
            {clip && !readOnly && !commitsView && (
              <button
                title={`${describeClip(clip)} into ${uploadDir || "root"}`}
                onClick={() => void paste()}
                disabled={pasting}
                className="hover:text-foreground disabled:opacity-50"
              >
                {pasting ? <Loader2 className="size-3.5 animate-spin" /> : <ClipboardPaste className="size-3.5" />}
              </button>
            )}
            <button
              title="Link another folder to this session"
              onClick={() => {
                setLinkPath("");
                setLinkError(null);
                setLinkOpen(true);
              }}
              className="hover:text-foreground"
            >
              <FolderSymlink className="size-3.5" />
            </button>
            {/* The way into select mode where there is no hover to reveal a row's own box, and a
                plain way out of it once there is nothing marked left to act on. */}
            {!readOnly && !commitsView && (
              <button
                title={mark.selecting ? "Leave select mode" : "Select files"}
                aria-pressed={mark.selecting}
                onClick={() => (mark.selecting ? mark.clear() : mark.start())}
                className={cn("hover:text-foreground", mark.selecting && "text-foreground")}
              >
                <ListChecks className="size-3.5" />
              </button>
            )}
            <button title="Refresh" onClick={() => onRefresh?.()} className="hover:text-foreground">
              <RefreshCw className="size-3.5" />
            </button>
          </div>
        </div>
        {!changesView && !commitsView && !readOnly && !query.trim() && (
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
        {/* Which root the panel browses (Files tree, search, changes and preview): the session's own
            folder, another worktree of its repo, or one of the folders linked to it. */}
        {((worktrees?.length ?? 0) > 1 || (linked?.length ?? 0) > 0) && (
          <div className="flex items-center gap-1 px-3 pb-1 text-[10px] text-muted-foreground">
            <span className="shrink-0">Folder:</span>
            <RootPicker
              value={rootDir}
              options={rootChoices}
              onPick={(dir) => void pickRoot(dir)}
              title={rootDir || workingDirectory}
            />
            {isLinkedRoot && (
              <button
                onClick={() => unlinkFolder(rootDir)}
                title={`Unlink ${rootDir}`}
                className="shrink-0 hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        )}

        {creatingFolder && !readOnly && !commitsView && (
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

        {!commitsView && (
        <div className="px-2 pb-1">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={changesView ? "Search changes…" : "Search files…"}
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
        )}

        {/* What is marked and what can be done with it. Shown from the moment select mode starts, so
            the mode always says out loud that it is on -- a tree of empty boxes with no explanation
            is how you end up clicking a file and wondering why it did not open. */}
        {mark.selecting && !readOnly && !commitsView && (
          <div className="mx-2 mb-1 flex items-center gap-1 rounded bg-accent/60 px-2 py-1 text-xs">
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {mark.count > 0 ? `${mark.count} selected` : "Select files and folders"}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-xs"
              disabled={mark.count === 0}
              title="Copy — paste into any file panel, here or in a remote tab"
              onClick={() => toClipboard("copy")}
            >
              <Copy className="size-3" />
              Copy
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-xs"
              disabled={mark.count === 0}
              title="Cut — moved when pasted"
              onClick={() => toClipboard("cut")}
            >
              <Scissors className="size-3" />
              Cut
            </Button>
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
        {deleteError && (
          <p
            className="mx-2 mb-1 cursor-pointer text-[10px] text-destructive"
            onClick={() => setDeleteError(null)}
          >
            {deleteError}
          </p>
        )}

        {/* The commits view: the history alone, filling what the tree would. */}
        {commitsView ? (
          <GitHistory
            fill
            sessionId={sessionId}
            refreshToken={refreshToken}
            selected={commitSel}
            onSelect={setCommitSel}
          />
        ) : (
        <div
          ref={treeScrollRef}
          onScroll={onTreeScroll}
          {...treeKeys}
          // Escape is the way out of a selection, ahead of the tree's own keys -- which do not use it.
          onKeyDown={(e) => {
            if (e.key === "Escape" && mark.selecting) {
              e.preventDefault();
              mark.clear();
              return;
            }
            // The file clipboard, from the keyboard: Ctrl+C / Ctrl+X take the marked rows (or the
            // open file), Ctrl+V pastes into the upload target.
            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
              const k = e.key.toLowerCase();
              // Only with something to take: otherwise (or with text selected) the key is the
              // browser's, and a stray Ctrl+C must not replace a cut waiting in another panel.
              if ((k === "c" || k === "x") && !hasTextSelection() && clipSubject().length > 0) {
                e.preventDefault();
                toClipboard(k === "c" ? "copy" : "cut");
                return;
              }
              if (k === "v" && getFileClip()) {
                e.preventDefault();
                void paste();
                return;
              }
            }
            treeKeys.onKeyDown?.(e);
          }}
          {...(treeDragOn ? treeDrag.areaProps : {})}
          // A drop below the rows lands in the root, which has no row of its own to light up.
          className={cn("flex-1 overflow-auto px-1 pb-2 outline-none", treeDragOn && treeDrag.over === "" && "bg-primary/5")}
        >
          {changesView ? (
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
              dir={rootDir || undefined}
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
              actions={treeActions}
            />
          )}
        </div>
        )}

        {/* Commit history, collapsible, shown only in the changes view. */}
        {changesView && (
          <GitHistory
            sessionId={sessionId}
            refreshToken={refreshToken}
            selected={commitSel}
            onSelect={setCommitSel}
          />
        )}
        </>)}
      </div>

      {/* Draggable divider between the tree and preview: horizontal when stacked, vertical beside.
          `touch-none` keeps a drag from scrolling the page out from under the finger. */}
      {!previewOnly && !treeOnly && (
        <div
          onPointerDown={startResize}
          onDoubleClick={resetTreeSize}
          title="Drag to resize · double-click to reset"
          className="group flex h-3 w-full shrink-0 touch-none cursor-row-resize items-center justify-center bg-transparent transition-colors hover:bg-primary/20 active:bg-primary/30 md:h-auto md:w-1.5 md:cursor-col-resize md:border-l"
        >
          {/* A grip only the stacked layout needs — beside the preview the border is hint enough. */}
          <span className="h-0.5 w-8 rounded-full bg-border group-active:bg-primary/50 md:hidden" />
        </div>
      )}

      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", treeOnly && "hidden")}>
        {treeOnly ? null : commitSel ? (
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
          <div className="min-h-0 flex-1">
            <FilePreview
              sessionId={sessionId}
              workingDirectory={workingDirectory}
              file={selected}
              gitStatus={selected ? effectiveGitFiles?.[selected.path] : undefined}
              preferDiff={showChanges}
              dir={rootDir || undefined}
              readOnly={readOnly}
              refreshToken={refreshToken}
              onSaved={onRefresh}
              // A file tab's own preview guards that file; the explorer's follows the active file, so
              // it has a guard of its own that is asked about whenever the active file moves.
              guard={previewPath !== undefined ? tabs.guardFor(previewPath) : tabs.guardFor(EXPLORER_GUARD)}
              onOpenFile={(path) => void tabs.open(fileEntryFromPath(path), false)}
            />
          </div>
        )}
      </div>

      {/* Link an extra folder to this session, chosen anywhere on the server's filesystem. */}
      <Dialog open={linkOpen} onOpenChange={setLinkOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Link a folder</DialogTitle>
            <DialogDescription>
              Browse and edit another folder from this session's Files panel. Links are saved on the
              server against this session's working folder, so they come back after a restart.
            </DialogDescription>
          </DialogHeader>
          <FolderPicker value={linkPath} onChange={setLinkPath} />
          {linkError && <p className="text-xs text-destructive">{linkError}</p>}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setLinkOpen(false)} disabled={linking}>
              Cancel
            </Button>
            <Button onClick={linkFolder} disabled={linking || !linkPath.trim()}>
              {linking ? <Loader2 className="size-4 animate-spin" /> : "Link folder"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
});

function GitMarker({ status }: { status?: string }) {
  if (!status) return null;
  return (
    <span className={cn("ml-auto shrink-0 pl-1 text-[10px] font-bold", STATUS_COLOR[status] ?? "text-muted-foreground")}>
      {status}
    </span>
  );
}

/** Whether deleting this entry would strip a staged addition — a file `git add`ed but never
 * committed, whose index copy would outlive the file on disk (status "A"). A folder counts when
 * anything inside it is staged that way. */
// Takes a path rather than an entry: a marked row is remembered as one, and there is nothing else
// about a file this needs to know.
function hasStagedAdd(gitFiles: GitFiles | undefined, path: string, isDir: boolean): boolean {
  if (!gitFiles) return false;
  if (!isDir) return gitFiles[path] === "A";
  const prefix = path + "/";
  for (const p in gitFiles) if (gitFiles[p] === "A" && p.startsWith(prefix)) return true;
  return false;
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
        const Icon = kind === "image" ? ImageIcon : kind === "video" ? Video : kind === "model" ? Box : FileText;
        // Rows here carry the path under the name -- a hit can come from anywhere, so the name alone
        // does not say where it is. The row is handed the same line so the rename box keeps it.
        const pathLine = <span className="truncate text-[10px] text-muted-foreground">{e.path}</span>;
        return (
          <Row
            key={e.path}
            depth={0}
            selected={selectedPath === e.path}
            entry={e}
            actions={actions}
            onClick={() => onSelect(e)}
            onOpenNewTab={() => onSelect(e, true)}
            lead={<Icon className="size-3.5 shrink-0 text-muted-foreground" />}
            sub={pathLine}
          >
            <span className="flex min-w-0 flex-col">
              <span className={cn("truncate", gitFiles?.[e.path] && STATUS_COLOR[gitFiles[e.path]])}>{e.name}</span>
              {pathLine}
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
          lead={
            <>
              <span className="size-3.5 shrink-0" />
              {(() => {
                const kind = fileKind(e.name);
                const Icon = kind === "image" ? ImageIcon : kind === "video" ? Video : kind === "model" ? Box : FileText;
                return <Icon className="size-3.5 shrink-0 text-muted-foreground" />;
              })()}
            </>
          }
        >
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
          {...navRowProps({ path: dir.path, isDir: true, open, depth })}
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
  const api = useApi();
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
        open={open}
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
        lead={
          <>
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
          </>
        }
      >
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
    kind === "image" ? ImageIcon : kind === "video" ? Video : kind === "model" ? Box : kind === "binary" ? FileIcon : FileText;
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
      lead={
        <>
          <span className="size-3.5 shrink-0" />
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        </>
      }
    >
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
    open?: boolean; // dir-only: whether it is expanded, for the arrow keys
    onClick: () => void;
    onOpenNewTab?: () => void; // file-only: middle-/double-/modifier-click opens a pinned tab
    entry: FileEntry;
    actions: RowActions;
    extraActions?: React.ReactNode; // dir-only: "new folder here"
    // The glyphs that run ahead of the name -- a fold chevron, a file or folder icon, the blank that
    // stands in for a chevron on a row that cannot fold. Their own prop rather than the head of
    // `children` because the rename box has to draw them too: they are what holds the name's column,
    // and a name that jumps left the moment you start typing is a name you have to find again.
    lead?: React.ReactNode;
    // A second line under the name, where a row has one (the flat list writes the path there). Drawn
    // by the rename box as well, for the same reason as `lead` but in the other axis: without it the
    // row loses a line the moment you start typing, and every row below it moves up to fill the gap.
    sub?: React.ReactNode;
    children: React.ReactNode;
  }
>(function Row({ depth, selected, open, onClick, onOpenNewTab, entry, actions, extraActions, lead, sub, children }, ref) {
  const renaming = actions.renamingPath === entry.path;
  const { mark } = actions;
  const marked = mark.has(entry.path);
  // Nothing is markable while browsing another worktree: the delete the mark leads to is one of the
  // actions that root does not get.
  const selecting = mark.selecting && !actions.readOnly;
  // Written once and drawn by both states. Renaming is offered in select mode too, and a box that
  // left the tick out started the name one checkbox further left than the row it replaced.
  const checkbox = selecting && (
    <span className={cn("shrink-0", marked ? "text-primary" : "text-muted-foreground")}>
      {marked ? <SquareCheck className="size-3.5" /> : <Square className="size-3.5" />}
    </span>
  );
  // A row being renamed stays put: its field is where the pointer is busy.
  const draggable = !!actions.drag && !renaming;
  const dropTarget = entry.isDir && actions.drag?.over === entry.path;
  return (
    <div
      ref={ref}
      draggable={draggable || undefined}
      data-drag={draggable ? "1" : undefined}
      className={cn(
        "group relative flex items-center rounded-sm text-xs hover:bg-accent",
        selected && "bg-accent font-medium",
        marked && "bg-primary/10",
        dropTarget && "bg-primary/15 ring-1 ring-inset ring-primary/50"
      )}
    >
      {/* The rename box is the row button's own box: the same padding, the same flex line, the same
          leading glyphs. A row keeps its height while it is being renamed -- and every row below it
          keeps its place -- and the name stays on the column it was reading from, with the field
          taking the width the name had rather than collapsing to an input's default size, which left
          a long name scrolled to its tail with the front of it out of sight. */}
      {renaming ? (
        <div
          style={{ paddingLeft: depth * 12 + 8 }}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-2"
        >
          {checkbox}
          {lead}
          {sub ? (
            <span className="flex min-w-0 flex-1 flex-col">
              <RenameField
                value={entry.name}
                onSubmit={(name) => actions.onRename(entry.path, name)}
                onCancel={actions.onCancelRename}
              />
              {sub}
            </span>
          ) : (
            <RenameField
              value={entry.name}
              onSubmit={(name) => actions.onRename(entry.path, name)}
              onCancel={actions.onCancelRename}
            />
          )}
        </div>
      ) : (
        <>
          <button
            // Focus target for the tree's arrow keys; a selected file is where they resume from.
            {...navRowProps({
              path: entry.path,
              isDir: entry.isDir,
              open,
              current: !!selected && !entry.isDir,
              depth,
            })}
            // In select mode the row is a checkbox: opening a file or folding a folder would fight
            // the one gesture the mode is there for. Shift takes the range from the last row marked.
            // Otherwise: Cmd/Ctrl+click opens a pinned tab like middle-click (no middle button on
            // trackpads).
            onClick={(e) => {
              if (selecting) mark.toggle(entry.path, entry.isDir, e.shiftKey);
              else if ((e.metaKey || e.ctrlKey) && onOpenNewTab) onOpenNewTab();
              else onClick();
            }}
            onDoubleClick={selecting ? undefined : onOpenNewTab}
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
            {checkbox}
            {lead}
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
            {/* Start a selection with this row in it. Only before the mode is on: once it is, every
                row carries its own box on the left and a second one here would be a second answer. */}
            {!actions.readOnly && !mark.selecting && (
              <button
                className="rounded p-0.5 hover:bg-background hover:text-foreground"
                title="Select"
                onClick={(e) => {
                  e.stopPropagation();
                  mark.toggle(entry.path, entry.isDir, e.shiftKey);
                }}
              >
                <Square className="size-3.5" />
              </button>
            )}
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

// A search result's line, waiting for its file: picking a declaration in another file opens that file,
// and whichever preview ends up showing it brings the line in once the text is there.
const pendingReveals = new Map<string, { line: number; word: string }>();
const revealKey = (session: string, dir: string | undefined, path: string) => `${session}\n${dir ?? ""}\n${path}`;
// Told whenever a line is asked for, so a preview already showing that file — loaded long ago, in a
// group of its own — takes it now rather than at its next reload.
const revealListeners = new Set<() => void>();
function requestReveal(key: string, want: { line: number; word: string }) {
  pendingReveals.set(key, want);
  revealListeners.forEach((tell) => tell());
}

function FilePreview({
  sessionId,
  workingDirectory,
  file,
  gitStatus,
  preferDiff,
  dir,
  readOnly,
  refreshToken,
  onSaved,
  guard,
  onOpenFile,
}: {
  sessionId: string;
  // Absolute working dir, for resolving the previewed file's server path (new-tab preview).
  workingDirectory: string;
  file: FileEntry | null;
  gitStatus?: string;
  // Whether the file was picked out of the changes view, where what changed is the point: such a
  // file opens on its diff rather than its contents.
  preferDiff?: boolean;
  // The root the file lives in when it isn't the session's own working dir — another worktree of
  // its repo, or a folder linked to it. Every read (and any save) is scoped to it.
  dir?: string;
  // Whether that root refuses writes (true for another worktree; a linked folder is editable).
  readOnly?: boolean;
  refreshToken: number;
  onSaved?: () => void;
  // Lets the parent read this preview's unsaved-edit state (and trigger a save) when closing a tab.
  guard?: React.MutableRefObject<PreviewGuard>;
  // Opens another file of the same root — where a name's declaration turned out to be.
  onOpenFile?: (path: string) => void;
}) {
  const api = useApi();
  const uiKey = useSessionKey(sessionId);
  const [text, setText] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error" | "toolarge">("idle");
  const [view, setView] = useState<"preview" | "diff">("preview");
  const [diff, setDiff] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const [mdView, setMdView] = useState<"rendered" | "raw">("rendered");
  const [fullscreen, setFullscreen] = useState(false); // full-page popup preview
  const [reload, setReload] = useState(0); // cache-buster bumped by the header's refresh button
  // Text/markdown preview zoom; kept while switching files and across reloads so a chosen size sticks.
  const [zoom, setZoom] = usePersistentZoom("text");
  // Optional left/right margins for the text previews — mainly for the full-screen popup on a wide
  // monitor, where full-width lines get hard to read. Shared (and persisted) with the standalone
  // preview tab's viewer.
  const [readingWidth, setReadingWidth] = usePersistentReadingWidth("text");
  const [wordWrap, setWordWrap] = usePersistentWordWrap("text");
  const [lineNumbers, setLineNumbers] = usePersistentLineNumbers("text");

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState(false);
  const [copiedText, setCopiedText] = useState(false);
  // The scrollable content area; used to detect an in-progress text selection so a background
  // auto-refresh doesn't rebuild the DOM out from under a copy.
  const contentRef = useRef<HTMLDivElement>(null);
  // The preview root; focused when the full-page popup opens so Esc lands on it right away.
  const rootRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  // The sandboxed HTML preview frame, for the scroll bridge below.
  const frameRef = useRef<HTMLIFrameElement>(null);
  // False until this tab's remembered scroll offset has been put back. Scroll events before that are
  // the content settling into place, not the user, and must not overwrite what we are restoring.
  const scrollRestoredRef = useRef(false);
  const saveScrollRef = useRef<number | undefined>(undefined);
  // The debounced write still owed, so closing the tab (or the panel) keeps the last position
  // instead of losing the final 200ms of scrolling.
  const pendingScrollRef = useRef<(() => void) | null>(null);

  // The whole path, not the session-relative one on show: what gets copied out of here is pasted
  // into a terminal, an editor, or a message to someone else, and none of those know where the
  // session's root is. Written in the server's own separator — see nativePath.
  const copyPath = useCallback(async () => {
    if (!file) return;
    await writeToClipboard(nativePath(dir || workingDirectory, file.path));
    setCopiedPath(true);
    setTimeout(() => setCopiedPath(false), 1500);
  }, [file, dir, workingDirectory]);

  // Header button: select the whole visible preview and copy the file's raw text.
  const copyContents = useCallback(async () => {
    if (text === null) return;
    if (contentRef.current) window.getSelection()?.selectAllChildren(contentRef.current);
    await writeToClipboard(text);
    setCopiedText(true);
    setTimeout(() => setCopiedText(false), 1500);
  }, [text]);

  const kind = file ? fileKind(file.name) : "binary";
  const isMarkdown = !!file && ["md", "markdown"].includes(fileExt(file.name));
  const isHtml = !!file && ["html", "htm"].includes(fileExt(file.name));
  // Another worktree's files are read-only here: the write endpoint refuses them.
  const canEdit = kind === "text" && status === "idle" && text !== null && !readOnly;
  const rawUrl = useCallback(
    (download = false) => {
      if (!file) return "";
      const url = api.sessionFileUrl(sessionId, file.path, download, dir);
      // Cache-buster so URL-sourced previews (image, video, PDF, office) re-fetch on manual reload.
      return reload > 0 && !download ? `${url}&r=${reload}` : url;
    },
    [sessionId, file, dir, reload]
  );

  // Absolute server path of the previewed file, for the standalone new-tab preview: session file
  // paths are relative to the working dir (or the browsed worktree), but that page reads through
  // the server-wide file API, which takes absolute paths. Mixed separators are fine on Windows.
  const absPath = file
    ? `${(dir || workingDirectory).replace(/[/\\]+$/, "")}/${file.path}`
    : "";

  // Syntax-highlighted HTML for the plain-text view (null for unsupported languages), wrapped so
  // the markup is only injected when it actually changed — see useHtml.
  const highlighted = useHtml(
    useMemo(
      () => (file && text !== null && !lineNumbers ? highlightCode(file.name, text) : null),
      [file, text, lineNumbers]
    )
  );
  // The same, a line at a time, for the view that numbers its lines (see CodeLines).
  const numberedLines = useMemo(
    () => (file && text !== null && lineNumbers ? highlightLines(file.name, text) : null),
    [file, text, lineNumbers]
  );
  // A click on a name in the code marks it throughout; Ctrl/⌘+click goes to its declaration — in
  // this file, or, through git grep, in another one of the same root, which opens at that line.
  const loadedFor = useRef<string | null>(null);
  // The file a read failed for (or was refused for being too large): a line waiting for it never comes.
  const failedFor = useRef<string | null>(null);
  const [revealTick, setRevealTick] = useState(0);
  useEffect(() => {
    const tell = () => setRevealTick((t) => t + 1);
    revealListeners.add(tell);
    return () => {
      revealListeners.delete(tell);
    };
  }, []);
  const nav = useCodeNav({
    path: file?.path,
    search: (word) => api.sessionGrep(sessionId, word, dir),
    onOpen: (m, word) => {
      if (file && m.path === file.path) {
        nav.revealAt(m.line, word);
        return;
      }
      requestReveal(revealKey(uiKey, dir, m.path), { line: m.line, word });
      onOpenFile?.(m.path);
    },
  });
  const { revealAt } = nav;

  // The line a search result in another file pointed at, once that file is the one here: its text
  // read (this file's, not the last one's — hence loadedFor) and drawn as code rather than rendered.
  // A file that will never be drawn as code — not text, or not readable — lets go of it instead.
  useEffect(() => {
    if (!file) return;
    const key = revealKey(uiKey, dir, file.path);
    const want = pendingReveals.get(key);
    if (!want) return;
    if (kind !== "text" || failedFor.current === file.path) {
      pendingReveals.delete(key);
      return;
    }
    if (text === null || status !== "idle" || editing || loadedFor.current !== file.path) return;
    if ((isMarkdown || isHtml) && mdView === "rendered") return setMdView("raw");
    if (view !== "preview") return setView("preview");
    // Only a preview on screen takes it (see revealAt), and the one just opened may take a frame or
    // two to be; a preview kept out of sight gives up and leaves it to that one.
    let tries = 0;
    let frame = 0;
    const attempt = () => {
      if (!pendingReveals.has(key)) return;
      if (revealAt(want.line, want.word)) {
        pendingReveals.delete(key);
        // Where the file was last left is not where it was asked to open.
        scrollRestoredRef.current = true;
      } else if (++tries < 20) frame = requestAnimationFrame(attempt);
    };
    attempt();
    return () => cancelAnimationFrame(frame);
  }, [file, kind, text, status, editing, mdView, view, uiKey, dir, isMarkdown, isHtml, revealAt, revealTick]);

  useEffect(() => {
    setText(null);
    setStatus("idle");
    // Straight to the diff for a changed file picked in the changes view — but only for text (a
    // binary's diff says nothing) and only where the toggle back to Preview is on screen.
    setView(preferDiff && gitStatus && kind === "text" && hasDiffToggle() ? "diff" : "preview");
    setDiff(null);
    setMdView("rendered");
    setEditing(false);
    setSaveError(null);
    setFullscreen(false);
    setReload(0);
    if (!file || kind !== "text") return;
    failedFor.current = null;
    if (file.size > MAX_TEXT_PREVIEW) {
      failedFor.current = file.path;
      setStatus("toolarge");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    api
      .fetchSessionFileText(sessionId, file.path, dir)
      .then((t) => {
        if (cancelled) return;
        loadedFor.current = file.path;
        setText(t);
        setStatus("idle");
      })
      .catch(() => {
        if (cancelled) return;
        failedFor.current = file.path;
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
    // gitStatus/preferDiff are read for the opening view only: listing them would re-run this — and
    // wipe the loaded text — every time git's view of the file changed under it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, file, kind, dir]);

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
        .gitDiff(sessionId, file.path, dir)
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
          .fetchSessionFileText(sessionId, file.path, dir)
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
      .gitDiff(sessionId, file.path, dir)
      .then((d) => !cancelled && setDiff(d.diff || ""))
      .catch(() => !cancelled && setDiff(""))
      .finally(() => !cancelled && setDiffLoading(false));
    return () => {
      cancelled = true;
    };
  }, [view, sessionId, file, diff, dir]);

  // Manual reload from the header: re-fetch the text/diff, and bump the cache-buster so
  // URL-sourced previews (image, video, PDF, office) re-fetch too.
  const refresh = useCallback(() => {
    setReload((r) => r + 1);
    if (!file) return;
    if (view === "diff") {
      setDiff(null); // the diff effect refetches when it's null
      return;
    }
    if (fileKind(file.name) === "text" && file.size <= MAX_TEXT_PREVIEW) {
      setStatus("loading");
      api
        .fetchSessionFileText(sessionId, file.path, dir)
        .then((t) => (setText(t), setStatus("idle")))
        .catch(() => setStatus("error"));
    }
  }, [file, view, sessionId, dir]);

  // Esc leaves the full-page popup (but not while editing — Esc there could drop unsaved text).
  // Capture phase + focusing the popup on entry so the key still lands here after clicks inside
  // the preview. Keys pressed inside an embedded PDF/iframe can't reach this document at all, so
  // the close button stays as the fallback there.
  useEffect(() => {
    if (!fullscreen || editing) return;
    rootRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // An open "more" menu takes this Escape for itself: closing it is the smaller step, and
      // stopping the key here would leave the menu hanging over the header full screen left.
      if (rootRef.current?.querySelector('[role="menu"]')) return;
      e.stopPropagation();
      setFullscreen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [fullscreen, editing]);

  async function save(): Promise<boolean> {
    if (!file) return true;
    setSaving(true);
    setSaveError(null);
    try {
      await api.writeSessionFile(sessionId, file.path, draft, dir);
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

  // Whether the pane is showing the sandboxed HTML frame, which scrolls its own document rather than
  // the container below — the two restore paths are mutually exclusive.
  const htmlPreview = isHtml && mdView === "rendered" && view === "preview" && !editing;

  // --- The HTML frame's source --------------------------------------------------------------------
  // The frame is given a URL rather than the document's bytes, so the browser has something to
  // resolve the page's own `src="map.jpg"` against. Handed the bytes it resolved them against the
  // *app's* base URL, since an `about:srcdoc` document inherits one from its parent — so every
  // relative asset went looking for an SPA route and came back a broken image. The URL points at a
  // ticket standing for the file's folder (see api.previewTicket), which is also where the scroll
  // bridge comes from now that the client no longer assembles the document.

  // What makes the frame reload. `src` is otherwise stable across an edit — same ticket, same file —
  // and the frame would go on showing the document it first loaded. Two things move it: the file's
  // contents actually changing (a save here, or an edit on disk the tree poll picked up), and the
  // header's refresh button, which counts separately because re-reading an unchanged file leaves
  // the text equal — pressing refresh should still reload the page.
  const contentRev = useContentRev(text);

  // Carries the path it was minted for, rather than being cleared on the way in. Two things fall out
  // of that which a bare "loading" sentinel got wrong: a ticket left over from the previously open
  // file can never be handed to the frame (its `forPath` won't match, so the pane stays blank until
  // the new one lands), and flipping Source→Preview on the same file reuses what we already hold
  // instead of blanking the frame and paying for a round trip on every toggle.
  const [preview, setPreview] = useState<
    { forPath: string; ticket: string; name: string } | { forPath: string; failed: true } | null
  >(null);

  // Re-minted when the document is about to reload for a content change or a manual refresh, not
  // just when the file is opened. A ticket expires, and the page inside the frame is usually static
  // — it makes no requests, so nothing slides the idle timer, and the ticket can be dead by the time
  // an edit lands. Asking again at exactly the moment we are going to navigate the frame anyway
  // costs one cheap round trip (the server hands back the ticket it already has for that folder) and
  // is what keeps a long-open preview, or one whose mint failed, from going permanently blank.
  useEffect(() => {
    if (!htmlPreview || !absPath) return;
    let cancelled = false;
    api
      .previewTicket(absPath)
      .then((p) => !cancelled && setPreview({ forPath: absPath, ...p }))
      // Nothing to do but fall back to the old way of doing it: the page renders from its bytes,
      // relative assets stay broken, and it loses scroll memory with the bridge. Better than a
      // preview pane that just sits empty because a ticket couldn't be minted.
      .catch(() => !cancelled && setPreview({ forPath: absPath, failed: true }));
    return () => {
      cancelled = true;
    };
  }, [htmlPreview, absPath, contentRev, reload]);

  const previewSrc = preview?.forPath === absPath ? preview : null;
  const frameSrc =
    previewSrc && !("failed" in previewSrc)
      ? api.previewFrameUrl(previewSrc.ticket, previewSrc.name, `${contentRev}-${reload}`)
      : "";

  // --- Remembered scroll position, per open tab ------------------------------------------------
  // Where a file was left off is part of "this file is open", so it lives in the session's UI bag
  // alongside the tab list (see SessionUi.fileScroll) rather than in this component's state: that is
  // what carries it across a tab switch, a switch to another session and back, and a page reload.

  // Re-arm for each file the tab shows — and for each session, since switching sessions can leave
  // the same path on screen.
  useEffect(() => {
    scrollRestoredRef.current = false;
  }, [sessionId, file?.path]);

  useEffect(
    () => () => {
      window.clearTimeout(saveScrollRef.current);
      pendingScrollRef.current?.();
    },
    []
  );

  const rememberScroll = useCallback(
    (top: number) => {
      const path = file?.path;
      if (!path) return;
      const write = () => {
        pendingScrollRef.current = null;
        const rounded = Math.round(top);
        const kept = { ...(loadSessionUi(uiKey).fileScroll ?? {}) };
        // Back at the top is the default, so drop the entry rather than storing a zero — one fewer
        // key in a map that is written in full on every change.
        if (rounded > 0) kept[path] = rounded;
        else delete kept[path];
        saveSessionUi(uiKey, { fileScroll: kept });
      };
      pendingScrollRef.current = write;
      window.clearTimeout(saveScrollRef.current);
      saveScrollRef.current = window.setTimeout(write, 200);
    },
    [sessionId, file?.path]
  );

  // Put the offset back once there is something tall enough to scroll. Content arrives late and in
  // stages — the fetch, then images and markdown diagrams sizing themselves — so this waits for the
  // box to actually reach the target instead of scrolling to wherever it can and stopping there.
  useEffect(() => {
    if (!file || htmlPreview || editing || scrollRestoredRef.current) return;
    const box = contentRef.current;
    if (!box) return;
    if (kind === "text" && (status !== "idle" || text === null)) return; // nothing rendered yet
    const target = loadSessionUi(uiKey).fileScroll?.[file.path] ?? 0;
    if (!(target > 0)) {
      scrollRestoredRef.current = true;
      return;
    }
    const deadline = Date.now() + 3000;
    let timer = 0;
    const apply = () => {
      const max = Math.max(0, box.scrollHeight - box.clientHeight);
      if (max < target && Date.now() < deadline) {
        timer = window.setTimeout(apply, 120);
        return;
      }
      box.scrollTop = Math.min(target, max);
      scrollRestoredRef.current = true;
    };
    apply();
    return () => window.clearTimeout(timer);
  }, [sessionId, file, htmlPreview, editing, kind, status, text, view, mdView]);

  // The HTML frame can't be read or driven from here (opaque origin), so it reports its own position
  // and is handed the one to go back to. Re-runs whenever the frame reloads, because each load
  // starts a fresh document at the top that has to be placed again — which is exactly what a change
  // of `frameSrc` means now that the frame is loaded by URL: a different file, a new ticket, the
  // Source/Preview toggle, a manual or automatic content refresh.
  useEffect(() => {
    if (!htmlPreview || !file) return;
    const path = file.path;
    // The document we are actually tracking, as the bridge inside it sees its own location. The
    // frame can navigate — a previewed page may link to a sibling inside the same ticket, which
    // loads another document carrying another copy of the bridge — and `e.source` cannot tell them
    // apart, because a WindowProxy outlives the document in it. Filing that page's offset under
    // this file's name would make reopening this one jump to an offset from somewhere else, so
    // anything that doesn't name the document we opened is left alone.
    const ours = frameSrc ? new URL(frameSrc, window.location.origin).pathname : "";
    let placed = false; // this document has been told where to go; later readies are duplicates
    const onMessage = (e: MessageEvent) => {
      const frame = frameRef.current?.contentWindow;
      if (!frame || e.source !== frame) return; // only our own preview frame
      const msg = e.data as { cwScrollReady?: boolean; cwScroll?: number; cwPath?: string } | null;
      if (!msg || typeof msg !== "object") return;
      if (msg.cwPath !== ours) return; // the frame has navigated; that page keeps its own place
      if (msg.cwScrollReady) {
        if (placed) return;
        placed = true;
        frame.postMessage({ cwScrollTo: loadSessionUi(uiKey).fileScroll?.[path] ?? 0 }, "*");
        scrollRestoredRef.current = true;
      } else if (typeof msg.cwScroll === "number") {
        rememberScroll(msg.cwScroll);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [htmlPreview, file, sessionId, frameSrc, rememberScroll]);

  if (!file) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Select a file to preview
      </div>
    );
  }

  // The preview's controls, in the order they give way: the view switches stay longest, then the
  // edit and copy actions, and the ways out of this pane (full screen, a new tab, download) go first.
  const previewTools: OverflowItem[] = [];
  if (gitStatus)
    previewTools.push({
      id: "view",
      inline: (
        <div className="flex h-7 overflow-hidden rounded-md border">
          <TabButton active={view === "preview"} onClick={() => setView("preview")}>
            Preview
          </TabButton>
          <TabButton active={view === "diff"} onClick={() => setView("diff")}>
            <GitCompare className="size-3.5" /> Diff
          </TabButton>
        </div>
      ),
      menu: [
        { id: "view-preview", label: "Preview", pressed: view === "preview", onClick: () => setView("preview") },
        { id: "view-diff", label: "Diff", pressed: view === "diff", onClick: () => setView("diff") },
      ],
    });
  if ((isMarkdown || isHtml) && view === "preview")
    previewTools.push({
      id: "render",
      inline: (
        <div className="flex h-7 overflow-hidden rounded-md border">
          <TabButton active={mdView === "rendered"} onClick={() => setMdView("rendered")}>
            {isHtml ? "Preview" : "Rendered"}
          </TabButton>
          <TabButton active={mdView === "raw"} onClick={() => setMdView("raw")}>
            {isHtml ? "Source" : "Raw"}
          </TabButton>
        </div>
      ),
      menu: [
        {
          id: "render-rendered",
          label: isHtml ? "Preview" : "Rendered",
          pressed: mdView === "rendered",
          onClick: () => setMdView("rendered"),
        },
        { id: "render-raw", label: isHtml ? "Source" : "Raw", pressed: mdView === "raw", onClick: () => setMdView("raw") },
      ],
    });
  if (canEdit && view === "preview") {
    const startEdit = () => {
      setDraft(text ?? "");
      setEditing(true);
    };
    previewTools.push({
      id: "edit",
      inline: (
        <Button variant="outline" size="sm" className="h-7 w-7 px-0" title="Edit" onClick={startEdit}>
          <Pencil className="size-4" />
        </Button>
      ),
      menu: [{ id: "edit", label: "Edit", icon: <Pencil className="size-4" />, onClick: startEdit }],
    });
  }
  if (kind === "image" && view === "preview")
    previewTools.push({
      id: "lightbox",
      inline: (
        <Button variant="outline" size="sm" className="h-7 w-7 px-0" title="Fullscreen" onClick={() => setLightbox(true)}>
          <Expand className="size-4" />
        </Button>
      ),
      menu: [{ id: "lightbox", label: "Fullscreen", icon: <Expand className="size-4" />, onClick: () => setLightbox(true) }],
    });
  if (kind === "text" && view === "preview" && text !== null)
    previewTools.push({
      id: "copy",
      inline: (
        <Button variant="outline" size="sm" className="h-7 w-7 px-0" title="Select all & copy" onClick={copyContents}>
          {copiedText ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
        </Button>
      ),
      menu: [{ id: "copy", label: "Select all & copy", icon: <Copy className="size-4" />, onClick: copyContents }],
    });
  previewTools.push({
    id: "reload",
    inline: (
      <Button variant="outline" size="sm" className="h-7 w-7 px-0" title="Reload" onClick={refresh}>
        <RefreshCw className={cn("size-4", kind === "text" && status === "loading" && "animate-spin")} />
      </Button>
    ),
    menu: [{ id: "reload", label: "Reload", icon: <RefreshCw className="size-4" />, onClick: refresh }],
  });
  // Non-image previews open in a full-page popup instead of the image lightbox. The way back out is
  // not here but at the end of the strip -- see the close button there.
  if (kind !== "image" && !fullscreen)
    previewTools.push({
      id: "fullscreen",
      inline: (
        <Button variant="outline" size="sm" className="h-7 w-7 px-0" onClick={() => setFullscreen(true)} title="Full screen">
          <Maximize2 className="size-4" />
        </Button>
      ),
      menu: [{ id: "fullscreen", label: "Full screen", icon: <Maximize2 className="size-4" />, onClick: () => setFullscreen(true) }],
    });
  // Standalone full-page preview in its own browser tab; survives a refresh there. The URL is read
  // at click time: the app's deep-link params ride along, and they move without re-rendering this.
  // That page reads this node's disk, so a peer's file doesn't get one (plans/multi-node.md §6).
  if (!api.base) previewTools.push({
    id: "newtab",
    inline: (
      <Button asChild variant="outline" size="sm" className="h-7 w-7 px-0" title="Open in new browser tab">
        <a
          href={previewUrl(absPath)}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => {
            e.currentTarget.href = previewUrl(absPath);
          }}
        >
          <ExternalLink className="size-4" />
        </a>
      </Button>
    ),
    menu: [
      {
        id: "newtab",
        label: "Open in new browser tab",
        icon: <ExternalLink className="size-4" />,
        href: () => previewUrl(absPath),
        newTab: true,
      },
    ],
  });
  previewTools.push({
    id: "download",
    inline: (
      <Button asChild variant="outline" size="sm" className="h-7 w-7 px-0" title="Download">
        <a href={rawUrl(true)} download={file.name}>
          <Download className="size-4" />
        </a>
      </Button>
    ),
    menu: [{ id: "download", label: "Download", icon: <Download className="size-4" />, href: rawUrl(true), download: file.name }],
  });
  // What the toolbar leaves the rest of the header: the file name keeps at least PREVIEW_NAME_MIN,
  // plus the gap after it, and in full screen the close button and its own gaps.
  const toolbarReserve = PREVIEW_NAME_MIN + 8 + (fullscreen ? 28 + 4 + 8 : 0);

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className={cn(
        "flex flex-col outline-none",
        fullscreen ? "fixed inset-0 z-50 bg-background safe-area-pad" : "h-full"
      )}
    >
      <header ref={headerRef} className="flex items-center gap-2 border-b px-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {file.name}
            {editing && <span className="ml-1 text-amber-500">•</span>}
          </div>
          <button
            type="button"
            onClick={copyPath}
            title="Copy the full path"
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
            {/* Everything but the way out of full screen, which must never hide in a menu. What doesn't
                fit beside the file name moves into a "more" menu, from the end. */}
            <OverflowToolbar
              items={previewTools}
              container={headerRef}
              reserve={toolbarReserve}
              menuVariant="outline"
              menuButtonClassName="h-7 w-7"
            />

            {/* The way out of full screen: a cross, last in the strip and held a little apart from
                it. In full screen the preview is the whole window, so this is the one control you
                may need in a hurry — and where a window's close sits is the first place the eye
                goes. A pair of shrinking arrows in the middle of six other icons was neither.
                Deliberately not gated on `kind`: whatever is on screen, there has to be a way out
                that isn't Esc, which an embedded PDF or iframe can swallow. */}
            {fullscreen && (
              <Button
                variant="outline"
                size="sm"
                className="ml-1 h-7 w-7 px-0"
                onClick={() => setFullscreen(false)}
                title="Exit full screen (Esc)"
                aria-label="Exit full screen"
              >
                <X className="size-4" />
              </Button>
            )}
          </>
        )}
      </header>

      <div className="relative min-h-0 flex-1">
        {/* Zoom applies to the text-based previews; images/video/PDF/Office bring their own. The
            sandboxed HTML iframe is excluded — CSS zoom would scale the frame, not its document. */}
        {(editing || (view === "preview" && kind === "text" && status === "idle" && text !== null &&
          !(isHtml && mdView === "rendered"))) && (
            <ZoomControls
              zoom={zoom}
              onChange={setZoom}
              width={readingWidth}
              // The editor neither wraps nor caps its width: either would pull the caret off the
              // highlighted text under it (see CodeEditor). Zoom alone carries over.
              onWidthChange={editing ? undefined : setReadingWidth}
              wrap={wordWrap}
              // Rendered markdown flows as paragraphs already; a wrap switch there would do nothing.
              onWrapChange={editing || (isMarkdown && mdView === "rendered") ? undefined : setWordWrap}
              lineNumbers={lineNumbers}
              onLineNumbersChange={!editing && isMarkdown && mdView === "rendered" ? undefined : setLineNumbers}
              onGoToLine={!editing && isMarkdown && mdView === "rendered" ? undefined : nav.goToLine}
              className="bottom-3 right-3"
            />
          )}
        {!editing && view === "preview" && status === "idle" && text !== null &&
          isMarkdown && mdView === "rendered" && (
            <MarkdownToc containerRef={contentRef} text={text} />
          )}
        {fullscreen && !editing && (
          <ScrollJumpButtons containerRef={contentRef} watch={text ?? file.path} />
        )}
        <div
          ref={contentRef}
          className="h-full overflow-auto"
          onScroll={(e) => {
            // Not ours to record until the restore has run, and not while the editor is up: the
            // textarea replaces the content, which collapses the box and clamps scrollTop to 0.
            if (!scrollRestoredRef.current || editing || htmlPreview) return;
            rememberScroll(e.currentTarget.scrollTop);
          }}
        >
        {editing ? (
          <CodeEditor name={file.name} value={draft} onChange={setDraft} zoom={zoom} nav={nav} lineNumbers={lineNumbers} />
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
                // maxWidth sits on the zoomed box on purpose: `zoom` scales it along with the text,
                // so a line keeps the same character count as you zoom (see READING_WIDTHS).
                <div
                  style={{ zoom, maxWidth: readingWidth ?? undefined }}
                  className="prose prose-sm mx-auto max-w-none p-4 dark:prose-invert prose-pre:bg-muted prose-pre:text-foreground"
                >
                  <Markdown text={text} docPath={absPath} />
                </div>
              ) : isHtml && mdView === "rendered" ? (
                // Render in a sandboxed iframe WITHOUT allow-same-origin: the document gets an
                // opaque origin, so page scripts can't reach this app's token or DOM. It is loaded
                // from a ticketed URL (see previewSrc), which is what lets the page's own relative
                // images and stylesheets resolve; the server also puts the scroll bridge on the end.
                // Blank for the round trip that mints the ticket, and back to the bytes if that
                // fails — a page with no assets of its own is none the worse for it.
                previewSrc === null ? (
                  <div className="h-full w-full bg-white" />
                ) : (
                  <iframe
                    ref={frameRef}
                    title={`Preview of ${file.name}`}
                    {...("failed" in previewSrc ? { srcDoc: text } : { src: frameSrc })}
                    sandbox="allow-scripts allow-forms allow-popups allow-modals"
                    className="h-full w-full border-0 bg-white"
                  />
                )
              ) : lineNumbers ? (
                <pre
                  ref={nav.ref}
                  style={{ zoom, maxWidth: readingWidth ?? undefined, ...gutterStyle(text) }}
                  className={`code-lines code-lines-sticky mx-auto overflow-auto p-4 font-mono text-xs leading-relaxed ${wordWrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre"}`}
                >
                  {nav.overlay}
                  {numberedLines ? (
                    <code className="hljs bg-transparent p-0">
                      <CodeLines text={text} lines={numberedLines} />
                    </code>
                  ) : (
                    <CodeLines text={text} lines={null} />
                  )}
                </pre>
              ) : highlighted ? (
                <pre ref={nav.ref} style={{ zoom, maxWidth: readingWidth ?? undefined }} className={`mx-auto overflow-auto p-4 font-mono text-xs leading-relaxed ${wordWrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre"}`}>
                  {nav.overlay}
                  <code className="hljs bg-transparent p-0" dangerouslySetInnerHTML={highlighted} />
                </pre>
              ) : (
                <pre ref={nav.ref} style={{ zoom, maxWidth: readingWidth ?? undefined }} className={`mx-auto overflow-auto p-4 font-mono text-xs leading-relaxed ${wordWrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre"}`}>{text}{nav.overlay}</pre>
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

            {kind === "model" && file.size <= MAX_MODEL_PREVIEW && (
              <ModelViewer url={rawUrl()} name={file.name} />
            )}

            {(kind === "binary" ||
              status === "toolarge" ||
              (kind === "office" && file.size > MAX_OFFICE_PREVIEW) ||
              (kind === "model" && file.size > MAX_MODEL_PREVIEW)) && (
              <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                <FileIcon className="size-10 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  {status === "toolarge" || kind === "office" || kind === "model"
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

/** How much of the preview header the file name keeps before the toolbar starts giving way. */
const PREVIEW_NAME_MIN = 96;

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
  // Names in the diff, as in the file preview — each line an element of its own here, starting with
  // the diff's marker.
  const nav = useCodeNav({ lineSelector: "[data-code-line]", diffPrefix: true });
  if (!diff.trim())
    return <div className="p-4 text-sm text-muted-foreground">No differences to show.</div>;

  return (
    <div ref={nav.ref} className="min-w-max py-1 font-mono text-xs leading-relaxed">
      {nav.overlay}
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
          <div key={i} data-code-line className={cn("whitespace-pre px-4", cls)}>
            {ln || " "}
          </div>
        );
      })}
    </div>
  );
}
