import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, sessionFileUrl } from "@/lib/api";
import type { FileEntry } from "@/types";
import { fileExt, fileKind, formatSize } from "@/lib/fileKind";
import { highlightCode } from "@/lib/highlight";
import { readUrlState, patchUrlState } from "@/lib/urlState";
import { loadSessionUi, saveSessionUi } from "@/lib/sessionUi";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ImageLightbox } from "./ImageLightbox";
import { OfficeViewer } from "./OfficeViewer";
import {
  GitHistory,
  CommitFilePreview,
  CommitDetailPreview,
  type CommitSelection,
} from "./GitHistory";
import {
  ChevronDown,
  ChevronRight,
  Download,
  Expand,
  File as FileIcon,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  GitCompare,
  Image as ImageIcon,
  Loader2,
  Maximize2,
  Minimize2,
  Pencil,
  RefreshCw,
  Save,
  Search,
  Upload,
  X,
} from "lucide-react";

const MAX_TEXT_PREVIEW = 2_000_000; // 2 MB
const MAX_OFFICE_PREVIEW = 15_000_000; // 15 MB — parsing docx/xlsx is heavier; cap before rendering

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

// Build a minimal FileEntry from a path (used to restore a selection from the URL,
// where we only know the path). Size is filled in once the tree/preview loads.
function fileEntryFromPath(path: string): FileEntry {
  return { name: path.split("/").pop() || path, path, isDir: false, size: 0 };
}

/** Two-pane file explorer: searchable, auto-refreshing directory tree + preview/edit pane. */
export function FileBrowser({
  sessionId,
  gitFiles,
  onRefresh,
  refreshToken = 0,
}: {
  sessionId: string;
  gitFiles?: GitFiles;
  onRefresh?: () => void;
  refreshToken?: number;
}) {
  // Restore the previewed file: a URL deep-link for this session wins, otherwise the file this
  // session was last viewing (persisted per-session in the browser).
  const [selected, setSelected] = useState<FileEntry | null>(() => {
    const u = readUrlState();
    const path = u.session === sessionId && u.file ? u.file : loadSessionUi(sessionId).file;
    return path ? fileEntryFromPath(path) : null;
  });
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FileEntry[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [showChanges, setShowChanges] = useState(false);
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

  // Path to auto-reveal in the tree: the restored file (from URL or per-session storage). Updated on
  // session switch so the newly-restored file expands into view; manual navigation doesn't touch it.
  const [expandTo, setExpandTo] = useState<string | null>(() => {
    const u = readUrlState();
    return u.session === sessionId && u.file ? u.file : loadSessionUi(sessionId).file ?? null;
  });

  // Select a working-tree file: mirror it into the URL, remember it for this session, and clear any
  // commit preview.
  const selectFile = useCallback(
    (f: FileEntry) => {
      setCommitSel(null);
      setSelected(f);
      patchUrlState({ file: f.path });
      saveSessionUi(sessionId, { file: f.path });
    },
    [sessionId]
  );

  // When the session actually changes, restore that session's last-previewed file (or clear if it
  // had none). Skips the initial mount (and StrictMode's double-invoked mount effect), so the
  // URL-restored selection survives.
  const prevSession = useRef(sessionId);
  useEffect(() => {
    if (prevSession.current === sessionId) return;
    prevSession.current = sessionId;
    const storedFile = loadSessionUi(sessionId).file ?? null;
    setSelected(storedFile ? fileEntryFromPath(storedFile) : null);
    setExpandTo(storedFile);
    setCommitSel(null);
    setQuery("");
    setShowChanges(false);
    setUploadDir("");
    setUploadError(null);
    setCreatingFolder(false);
    setNewFolder("");
    setFolderError(null);
    patchUrlState({ file: storedFile ?? undefined });
  }, [sessionId]);

  const changeCount = gitFiles ? Object.keys(gitFiles).length : 0;
  const changeEntries = useMemo<FileEntry[]>(
    () =>
      gitFiles
        ? Object.keys(gitFiles)
            .sort((a, b) => a.localeCompare(b))
            .map((p) => ({ name: p.split("/").pop() || p, path: p, isDir: false, size: 0 }))
        : [],
    [gitFiles]
  );

  // Debounced recursive search.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      api
        .searchSessionFiles(sessionId, q)
        .then((r) => setResults(r.entries))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(t);
  }, [query, sessionId, refreshToken]);

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
                onClick={() =>
                  setShowChanges((v) => {
                    if (v) setCommitSel(null); // leaving changes mode drops the commit preview
                    return !v;
                  })
                }
                className={cn(
                  "flex items-center gap-1 rounded px-1 py-0.5 hover:text-foreground",
                  showChanges ? "bg-amber-500/15 text-amber-500" : ""
                )}
              >
                <GitCompare className="size-3.5" />
                {changeCount > 0 && <span className="text-[10px] font-semibold">{changeCount}</span>}
              </button>
            )}
            <button
              title={`New folder in ${uploadDir || "root"}`}
              onClick={() => {
                setFolderError(null);
                setCreatingFolder((v) => !v);
              }}
              className={cn(
                "hover:text-foreground",
                creatingFolder && "text-foreground"
              )}
            >
              <FolderPlus className="size-3.5" />
            </button>
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
            <button title="Refresh" onClick={() => onRefresh?.()} className="hover:text-foreground">
              <RefreshCw className="size-3.5" />
            </button>
          </div>
        </div>
        {!showChanges && !query.trim() && (
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

        {creatingFolder && (
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
              placeholder="Search files…"
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
          {query.trim() ? (
            <FlatFileList
              entries={results ?? []}
              loading={searching && results === null}
              empty="No matches"
              gitFiles={gitFiles}
              selectedPath={selected?.path ?? null}
              onSelect={selectFile}
            />
          ) : showChanges ? (
            <FlatFileList
              entries={changeEntries}
              empty="No changes"
              gitFiles={gitFiles}
              selectedPath={selected?.path ?? null}
              onSelect={selectFile}
            />
          ) : (
            <TreeLevel
              sessionId={sessionId}
              path=""
              depth={0}
              refreshToken={refreshToken}
              selectedPath={selected?.path ?? null}
              expandTo={expandTo}
              gitFiles={gitFiles}
              onSelect={selectFile}
              uploadDir={uploadDir}
              onSelectDir={setUploadDir}
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

      <div className="min-h-0 min-w-0 flex-1">
        {commitSel ? (
          commitSel.path ? (
            <CommitFilePreview
              sessionId={sessionId}
              selection={{ ...commitSel, path: commitSel.path }}
              onBack={() => setCommitSel((s) => (s ? { ...s, path: undefined, status: undefined } : null))}
              onClose={() => setCommitSel(null)}
            />
          ) : (
            <CommitDetailPreview
              sessionId={sessionId}
              selection={commitSel}
              onSelectFile={setCommitSel}
              onClose={() => setCommitSel(null)}
            />
          )
        ) : (
          <FilePreview
            sessionId={sessionId}
            file={selected}
            gitStatus={selected ? gitFiles?.[selected.path] : undefined}
            refreshToken={refreshToken}
            onSaved={onRefresh}
          />
        )}
      </div>
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
}: {
  entries: FileEntry[];
  loading?: boolean;
  empty: string;
  gitFiles?: GitFiles;
  selectedPath: string | null;
  onSelect: (f: FileEntry) => void;
}) {
  if (loading)
    return <IndentedNote depth={0}><Loader2 className="size-3 animate-spin" /> Loading…</IndentedNote>;
  if (entries.length === 0) return <IndentedNote depth={0}>{empty}</IndentedNote>;

  return (
    <>
      {entries.map((e) => {
        const kind = fileKind(e.name);
        const Icon = kind === "image" ? ImageIcon : FileText;
        return (
          <Row key={e.path} depth={0} selected={selectedPath === e.path} onClick={() => onSelect(e)}>
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

function TreeLevel({
  sessionId,
  path,
  depth,
  refreshToken,
  selectedPath,
  expandTo,
  gitFiles,
  onSelect,
  uploadDir,
  onSelectDir,
}: {
  sessionId: string;
  path: string;
  depth: number;
  refreshToken: number;
  selectedPath: string | null;
  expandTo: string | null;
  gitFiles?: GitFiles;
  onSelect: (f: FileEntry) => void;
  uploadDir: string;
  onSelectDir: (path: string) => void;
}) {
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState(false);

  // Re-fetches when refreshToken changes; TreeDir stays mounted so expansion is preserved.
  useEffect(() => {
    let cancelled = false;
    api
      .listSessionFiles(sessionId, path || undefined)
      .then((r) => !cancelled && (setEntries(r.entries), setError(false)))
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
    };
  }, [sessionId, path, refreshToken]);

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
            entry={e}
            depth={depth}
            refreshToken={refreshToken}
            selectedPath={selectedPath}
            expandTo={expandTo}
            gitFiles={gitFiles}
            onSelect={onSelect}
            uploadDir={uploadDir}
            onSelectDir={onSelectDir}
          />
        ) : (
          <FileRow
            key={e.path}
            entry={e}
            depth={depth}
            selected={selectedPath === e.path}
            gitStatus={gitFiles?.[e.path]}
            onSelect={onSelect}
          />
        )
      )}
    </>
  );
}

function TreeDir({
  sessionId,
  entry,
  depth,
  refreshToken,
  selectedPath,
  expandTo,
  gitFiles,
  onSelect,
  uploadDir,
  onSelectDir,
}: {
  sessionId: string;
  entry: FileEntry;
  depth: number;
  refreshToken: number;
  selectedPath: string | null;
  expandTo: string | null;
  gitFiles?: GitFiles;
  onSelect: (f: FileEntry) => void;
  uploadDir: string;
  onSelectDir: (path: string) => void;
}) {
  // Auto-open when the file to reveal lives under this folder.
  const [open, setOpen] = useState(() => !!expandTo && expandTo.startsWith(entry.path + "/"));
  return (
    <>
      {/* Clicking a folder toggles it open and makes it the upload target. */}
      <Row
        depth={depth}
        selected={uploadDir === entry.path}
        onClick={() => {
          setOpen((o) => !o);
          onSelectDir(entry.path);
        }}
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
          <span className="ml-auto size-1.5 shrink-0 rounded-full bg-amber-500" />
        )}
      </Row>
      {open && (
        <TreeLevel
          sessionId={sessionId}
          path={entry.path}
          depth={depth + 1}
          refreshToken={refreshToken}
          selectedPath={selectedPath}
          expandTo={expandTo}
          gitFiles={gitFiles}
          onSelect={onSelect}
          uploadDir={uploadDir}
          onSelectDir={onSelectDir}
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
}: {
  entry: FileEntry;
  depth: number;
  selected: boolean;
  gitStatus?: string;
  onSelect: (f: FileEntry) => void;
}) {
  const kind = fileKind(entry.name);
  const Icon = kind === "image" ? ImageIcon : kind === "binary" ? FileIcon : FileText;
  // Bring a URL-restored selection into view (fires only when a row mounts already
  // selected — normal clicks select an already-mounted row, so they don't scroll).
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Row ref={ref} depth={depth} selected={selected} onClick={() => onSelect(entry)}>
      <span className="size-3.5 shrink-0" />
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className={cn("truncate", gitStatus && STATUS_COLOR[gitStatus])}>{entry.name}</span>
      <GitMarker status={gitStatus} />
    </Row>
  );
}

const Row = forwardRef<
  HTMLButtonElement,
  { depth: number; selected?: boolean; onClick: () => void; children: React.ReactNode }
>(function Row({ depth, selected, onClick, children }, ref) {
  return (
    <button
      ref={ref}
      onClick={onClick}
      style={{ paddingLeft: depth * 12 + 8 }}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-sm py-1 pr-2 text-left text-xs hover:bg-accent",
        selected && "bg-accent font-medium"
      )}
    >
      {children}
    </button>
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
  refreshToken,
  onSaved,
}: {
  sessionId: string;
  file: FileEntry | null;
  gitStatus?: string;
  refreshToken: number;
  onSaved?: () => void;
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

  const kind = file ? fileKind(file.name) : "binary";
  const isMarkdown = !!file && ["md", "markdown"].includes(fileExt(file.name));
  const isHtml = !!file && ["html", "htm"].includes(fileExt(file.name));
  const canEdit = kind === "text" && status === "idle" && text !== null;

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
      .fetchSessionFileText(sessionId, file.path)
      .then((t) => !cancelled && (setText(t), setStatus("idle")))
      .catch(() => !cancelled && setStatus("error"));
    return () => {
      cancelled = true;
    };
  }, [sessionId, file, kind]);

  // Auto-refresh: when the working dir changes, re-fetch the current file's content and
  // invalidate the cached diff — but never clobber an in-progress edit.
  useEffect(() => {
    if (!file || editing) return;
    setDiff(null); // force diff to reload lazily
    if (fileKind(file.name) !== "text" || file.size > MAX_TEXT_PREVIEW) return;
    let cancelled = false;
    api
      .fetchSessionFileText(sessionId, file.path)
      .then((t) => !cancelled && setText(t))
      .catch(() => {});
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
      .gitDiff(sessionId, file.path)
      .then((d) => !cancelled && setDiff(d.diff || ""))
      .catch(() => !cancelled && setDiff(""))
      .finally(() => !cancelled && setDiffLoading(false));
    return () => {
      cancelled = true;
    };
  }, [view, sessionId, file, diff]);

  // Esc leaves the full-page popup (but not while editing — Esc there could drop unsaved text).
  useEffect(() => {
    if (!fullscreen || editing) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFullscreen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen, editing]);

  async function save() {
    if (!file) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.writeSessionFile(sessionId, file.path, draft);
      setText(draft);
      setEditing(false);
      onSaved?.(); // refresh git status (file may now be modified)
    } catch {
      setSaveError("Failed to save.");
    } finally {
      setSaving(false);
    }
  }

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
          <div className="truncate font-mono text-[11px] text-muted-foreground">
            {file.path} · {formatSize(file.size)}
          </div>
        </div>

        {editing ? (
          <>
            {saveError && <span className="text-xs text-destructive">{saveError}</span>}
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save
            </Button>
          </>
        ) : (
          <>
            {gitStatus && (
              <div className="hidden overflow-hidden rounded-md border sm:flex">
                <TabButton active={view === "preview"} onClick={() => setView("preview")}>
                  Preview
                </TabButton>
                <TabButton active={view === "diff"} onClick={() => setView("diff")}>
                  <GitCompare className="size-3.5" /> Diff
                </TabButton>
              </div>
            )}

            {(isMarkdown || isHtml) && view === "preview" && (
              <div className="hidden overflow-hidden rounded-md border sm:flex">
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
                onClick={() => {
                  setDraft(text ?? "");
                  setEditing(true);
                }}
              >
                <Pencil className="size-4" /> <span className="hidden sm:inline">Edit</span>
              </Button>
            )}

            {kind === "image" && view === "preview" && (
              <Button variant="outline" size="sm" onClick={() => setLightbox(true)}>
                <Expand className="size-4" /> <span className="hidden sm:inline">Fullscreen</span>
              </Button>
            )}

            {/* Non-image previews open in a full-page popup instead of the image lightbox. */}
            {kind !== "image" && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setFullscreen((f) => !f)}
                title={fullscreen ? "Exit full screen (Esc)" : "Full screen"}
              >
                {fullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
                <span className="hidden sm:inline">{fullscreen ? "Exit" : "Fullscreen"}</span>
              </Button>
            )}
            <Button asChild variant="outline" size="sm">
              <a href={sessionFileUrl(sessionId, file.path, true)} download={file.name}>
                <Download className="size-4" /> <span className="hidden sm:inline">Download</span>
              </a>
            </Button>
          </>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
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
                    src={sessionFileUrl(sessionId, file.path)}
                    alt={file.name}
                    className="max-h-full max-w-full object-contain shadow-sm"
                  />
                </button>
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
              <OfficeViewer sessionId={sessionId} file={file} />
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
                  <a href={sessionFileUrl(sessionId, file.path, true)} download={file.name}>
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
          src={sessionFileUrl(sessionId, file.path)}
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
