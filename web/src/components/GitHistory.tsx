import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { GitCommit, GitCommitDetail, GitCommitFile, GitFileContent } from "@/types";
import { fileKind } from "@/lib/fileKind";
import { cn } from "@/lib/utils";
import { DiffView, STATUS_COLOR } from "./FileBrowser";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  FileSymlink,
  FileText,
  GitCommitHorizontal,
  History,
  Image as ImageIcon,
  Loader2,
  X,
} from "lucide-react";

// A commit picked from the history — previewed on the right. With `path` set it targets one file
// (a diff); without, the whole commit (its details + file list).
export interface CommitSelection {
  hash: string;
  shortHash: string;
  subject: string;
  path?: string;
  status?: string;
}

const OPEN_KEY = "claudeweb.gitHistoryOpen";
const PAGE = 50;

// Drag-resizable panel height (px), persisted per-browser like the tree/sidebar panes.
const H_MIN = 100;
const H_MAX = 900;
const H_DEFAULT = 260;
const HEIGHT_KEY = "claudeweb.gitHistoryHeight";

function readHeight() {
  const n = Number(localStorage.getItem(HEIGHT_KEY));
  return Number.isFinite(n) && n > 0 ? Math.min(H_MAX, Math.max(H_MIN, n)) : H_DEFAULT;
}

/**
 * Collapsible commit-history panel shown under the changes list. Selecting a commit previews its
 * full details (message, author, files) on the right; picking a file there shows its diff.
 */
export function GitHistory({
  sessionId,
  refreshToken,
  selected,
  onSelect,
}: {
  sessionId: string;
  refreshToken: number;
  selected: CommitSelection | null;
  onSelect: (sel: CommitSelection) => void;
}) {
  const [open, setOpen] = useState(() => localStorage.getItem(OPEN_KEY) === "1");
  const [commits, setCommits] = useState<GitCommit[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [height, setHeight] = useState(readHeight); // body height (px), drag-resizable

  // Newest commit currently shown; lets the auto-refresh below skip re-rendering when nothing changed.
  const headRef = useRef<string | null>(null);
  const resetKey = `${open}|${sessionId}`;
  const prevReset = useRef("");

  // Drag the top edge to resize the panel; dragging up grows it. Persist on release.
  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = readHeight();
    let h = startH;
    const onMove = (ev: PointerEvent) => {
      h = Math.min(H_MAX, Math.max(H_MIN, startH + (startY - ev.clientY)));
      setHeight(h);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem(HEIGHT_KEY, String(h));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  }, []);

  const resetHeight = useCallback(() => {
    setHeight(H_DEFAULT);
    localStorage.setItem(HEIGHT_KEY, String(H_DEFAULT));
  }, []);

  const toggleOpen = useCallback(() => {
    setOpen((v) => {
      const next = !v;
      localStorage.setItem(OPEN_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  // Load the first page when opened / on session change, and re-poll on refreshToken. A poll that
  // finds the same head commit leaves the list untouched — no flicker, scroll and paging preserved.
  useEffect(() => {
    if (!open) return;
    const isReset = prevReset.current !== resetKey;
    prevReset.current = resetKey;
    let cancelled = false;
    if (isReset) {
      setCommits(null);
      setError(false);
      headRef.current = null;
    }
    api
      .gitLog(sessionId, 0, PAGE)
      .then((r) => {
        if (cancelled) return;
        const newHead = r.commits[0]?.hash ?? null;
        if (isReset || headRef.current !== newHead) {
          headRef.current = newHead;
          setCommits(r.commits);
          setHasMore(r.hasMore);
        }
      })
      .catch(() => !cancelled && isReset && setError(true));
    return () => {
      cancelled = true;
    };
  }, [open, sessionId, refreshToken, resetKey]);

  const loadMore = useCallback(() => {
    setLoadingMore(true);
    api
      .gitLog(sessionId, commits?.length ?? 0, PAGE)
      .then((r) => {
        setCommits((prev) => [...(prev ?? []), ...r.commits]);
        setHasMore(r.hasMore);
      })
      .catch(() => setError(true))
      .finally(() => setLoadingMore(false));
  }, [sessionId, commits]);

  return (
    <div className="flex shrink-0 flex-col border-t">
      {/* Drag the top edge to resize the panel (desktop). */}
      {open && (
        <div
          onPointerDown={startResize}
          onDoubleClick={resetHeight}
          title="Drag to resize · double-click to reset"
          className="h-1.5 shrink-0 cursor-row-resize bg-transparent transition-colors hover:bg-primary/20 active:bg-primary/30"
        />
      )}
      <button
        onClick={toggleOpen}
        className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <History className="size-3.5" />
        <span>History</span>
      </button>

      {open && (
        <div style={{ height, maxHeight: "75vh" }} className="min-h-0 shrink-0 overflow-auto pb-2">
          {commits === null ? (
            <Note>
              <Loader2 className="size-3 animate-spin" /> Loading history…
            </Note>
          ) : error ? (
            <Note>Unable to read history</Note>
          ) : commits.length === 0 ? (
            <Note>No commits</Note>
          ) : (
            <>
              {commits.map((c, i) => (
                <CommitRow
                  key={c.hash}
                  sessionId={sessionId}
                  commit={c}
                  first={i === 0}
                  last={i === commits.length - 1 && !hasMore}
                  active={selected?.hash === c.hash && !selected.path}
                  selectedFilePath={selected?.hash === c.hash ? selected.path ?? null : null}
                  onSelectCommit={() =>
                    onSelect({ hash: c.hash, shortHash: c.shortHash, subject: c.subject })
                  }
                  onSelectFile={(f) =>
                    onSelect({
                      hash: c.hash,
                      shortHash: c.shortHash,
                      subject: c.subject,
                      path: f.path,
                      status: f.status,
                    })
                  }
                />
              ))}
              {hasMore && (
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="flex w-full items-center gap-1.5 py-1.5 pl-8 text-left text-xs text-muted-foreground hover:text-foreground"
                >
                  {loadingMore ? <Loader2 className="size-3 animate-spin" /> : null}
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

type Ref = { label: string; kind: "head" | "branch" | "remote" | "tag" };

// Parse git's %D decoration string into typed chips ("HEAD -> main, origin/main, tag: v1").
function parseRefs(refs: string): Ref[] {
  if (!refs) return [];
  return refs
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map<Ref>((r) => {
      if (r.startsWith("tag: ")) return { label: r.slice(5), kind: "tag" };
      if (r.startsWith("HEAD -> ")) return { label: r.slice(8), kind: "head" };
      if (r === "HEAD") return { label: "HEAD", kind: "head" };
      if (r.includes("/")) return { label: r, kind: "remote" };
      return { label: r, kind: "branch" };
    });
}

const REF_STYLE: Record<Ref["kind"], string> = {
  head: "bg-primary/15 text-primary ring-1 ring-primary/30",
  branch: "bg-primary/10 text-primary",
  remote: "bg-muted text-muted-foreground",
  tag: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
};

function RefBadges({ refs }: { refs: string }) {
  const parsed = parseRefs(refs);
  if (parsed.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {parsed.map((r) => (
        <span
          key={r.kind + r.label}
          title={r.label}
          className={cn(
            "max-w-[8rem] truncate rounded px-1 py-px text-[9px] font-medium leading-tight",
            REF_STYLE[r.kind]
          )}
        >
          {r.label}
        </span>
      ))}
    </span>
  );
}

function CommitRow({
  sessionId,
  commit,
  first,
  last,
  active,
  selectedFilePath,
  onSelectCommit,
  onSelectFile,
}: {
  sessionId: string;
  commit: GitCommit;
  first: boolean;
  last: boolean;
  active: boolean;
  // Path of this commit's file currently previewed (highlights the file row), or null.
  selectedFilePath: string | null;
  onSelectCommit: () => void;
  onSelectFile: (f: GitCommitFile) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [files, setFiles] = useState<GitCommitFile[] | null>(null);
  const [error, setError] = useState(false);

  // Lazily fetch the commit's changed files the first time it's expanded.
  useEffect(() => {
    if (!expanded || files !== null) return;
    let cancelled = false;
    api
      .gitCommit(sessionId, commit.hash)
      .then((d) => !cancelled && setFiles(d.files))
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
    };
  }, [expanded, files, sessionId, commit.hash]);

  // Fill the graph node when this commit is the one being previewed (as a whole or via a file).
  const nodeActive = active || selectedFilePath !== null;

  return (
    <div className="flex items-stretch gap-2 pr-2 text-xs">
      {/* Single-lane graph rail: a continuous line with a node dot per commit. Spans the full
          row height so the line stays connected even when the file list is expanded. */}
      <span className="relative w-5 shrink-0">
        <span
          className={cn(
            "absolute left-1/2 w-px -translate-x-1/2 bg-border",
            first ? "top-[11px]" : "top-0",
            last ? "h-[11px]" : "h-full"
          )}
        />
        <span
          className={cn(
            "absolute left-1/2 top-[7px] size-2 -translate-x-1/2 rounded-full border-2 bg-background",
            nodeActive ? "border-primary bg-primary" : "border-primary"
          )}
        />
      </span>

      <div className="min-w-0 flex-1">
        <div className={cn("flex items-start gap-1 rounded-sm hover:bg-accent", active && "bg-accent")}>
          <button
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? "Hide changed files" : "Show changed files"}
            className="shrink-0 rounded px-0.5 py-1 text-muted-foreground hover:text-foreground"
          >
            {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
          <button
            onClick={onSelectCommit}
            title={`${commit.shortHash} · ${commit.date}`}
            className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 items-center gap-1">
                <RefBadges refs={commit.refs} />
                <span className={cn("truncate text-foreground", active && "font-medium")}>
                  {commit.subject}
                </span>
              </span>
              <span className="truncate text-[10px] text-muted-foreground">
                {commit.author} · {commit.relativeDate}
              </span>
            </span>
            <span className="shrink-0 self-center font-mono text-[10px] text-muted-foreground">
              {commit.shortHash}
            </span>
          </button>
        </div>

        {expanded && (
          <div className="pb-1">
            {files === null ? (
              error ? (
                <Note pl={2}>Unable to read files</Note>
              ) : (
                <Note pl={2}>
                  <Loader2 className="size-3 animate-spin" /> Loading files…
                </Note>
              )
            ) : files.length === 0 ? (
              <Note pl={2}>No files</Note>
            ) : (
              files.map((f) => (
                <CommitFileRow
                  key={f.path}
                  file={f}
                  selected={selectedFilePath === f.path}
                  onClick={() => onSelectFile(f)}
                />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CommitFileRow({
  file,
  selected,
  onClick,
}: {
  file: GitCommitFile;
  selected: boolean;
  onClick: () => void;
}) {
  const name = file.path.split("/").pop() || file.path;
  const Icon = fileKind(name) === "image" ? ImageIcon : FileText;
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-xs hover:bg-accent",
        selected && "bg-accent font-medium"
      )}
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-col">
        <span className={cn("truncate", STATUS_COLOR[file.status])}>{name}</span>
        <span className="truncate text-[10px] text-muted-foreground">{file.path}</span>
      </span>
      <span
        className={cn(
          "ml-auto shrink-0 pl-1 text-[10px] font-bold",
          STATUS_COLOR[file.status] ?? "text-muted-foreground"
        )}
      >
        {file.status}
      </span>
    </button>
  );
}

function Note({ children, pl = 3 }: { children: React.ReactNode; pl?: number }) {
  return (
    <div
      style={{ paddingLeft: pl * 4 }}
      className="flex items-center gap-1.5 py-1 pr-2 text-xs text-muted-foreground"
    >
      {children}
    </div>
  );
}

/** Right-pane preview of a whole commit: full message, author/date, and its changed files. */
export function CommitDetailPreview({
  sessionId,
  selection,
  onSelectFile,
  onClose,
}: {
  sessionId: string;
  selection: CommitSelection;
  onSelectFile: (sel: CommitSelection) => void;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [error, setError] = useState(false);
  const reqRef = useRef(0);

  useEffect(() => {
    const req = ++reqRef.current;
    setDetail(null);
    setError(false);
    api
      .gitCommit(sessionId, selection.hash)
      .then((d) => reqRef.current === req && setDetail(d))
      .catch(() => reqRef.current === req && setError(true));
  }, [sessionId, selection.hash]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <GitCommitHorizontal className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">Commit</div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">
            {selection.shortHash}
          </div>
        </div>
        <button
          onClick={onClose}
          title="Close commit preview"
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {detail === null ? (
          error ? (
            <div className="p-4 text-sm text-destructive">Unable to read commit.</div>
          ) : (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading commit…
            </div>
          )
        ) : (
          <div className="flex flex-col gap-4 p-4">
            {/* Full commit message: subject + body, whitespace preserved. */}
            <div>
              <div className="text-sm font-semibold leading-snug">{detail.subject}</div>
              {detail.body && (
                <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-sm text-foreground/90">
                  {detail.body}
                </pre>
              )}
            </div>

            {/* Author / date / full hash. */}
            <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">Author</dt>
              <dd className="min-w-0 truncate">
                {detail.author}
                {detail.authorEmail && (
                  <span className="text-muted-foreground"> &lt;{detail.authorEmail}&gt;</span>
                )}
              </dd>
              <dt className="text-muted-foreground">Date</dt>
              <dd>
                {detail.date}
                <span className="text-muted-foreground"> · {detail.relativeDate}</span>
              </dd>
              <dt className="text-muted-foreground">Commit</dt>
              <dd className="min-w-0 truncate font-mono">{detail.hash}</dd>
            </dl>

            {/* Changed files — click to see the file's diff for this commit. */}
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">
                {detail.files.length} file{detail.files.length === 1 ? "" : "s"} changed
              </div>
              <div className="-mx-1">
                {detail.files.map((f) => (
                  <CommitFileRow
                    key={f.path}
                    file={f}
                    selected={false}
                    onClick={() =>
                      onSelectFile({
                        hash: detail.hash,
                        shortHash: detail.shortHash,
                        subject: detail.subject,
                        path: f.path,
                        status: f.status,
                      })
                    }
                  />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Right-pane preview of a single file within a chosen commit — its diff or full content. */
export function CommitFilePreview({
  sessionId,
  selection,
  onBack,
  onClose,
  onOpenInTree,
}: {
  sessionId: string;
  selection: CommitSelection & { path: string };
  onBack: () => void;
  onClose: () => void;
  // Reveal this file in the working-tree Files pane (null when it no longer exists there).
  onOpenInTree?: (path: string) => void;
}) {
  const [view, setView] = useState<"diff" | "full">("diff");
  const [diff, setDiff] = useState<string | null>(null);
  const [full, setFull] = useState<GitFileContent | null>(null);
  const name = useMemo(() => selection.path.split("/").pop() || selection.path, [selection.path]);
  const reqRef = useRef(0);

  // Reset both caches and the view whenever the selected file/commit changes, so switching files
  // never shows the previously-loaded file's diff. (The parent also keys us by hash+path.)
  useEffect(() => {
    setView("diff");
    setDiff(null);
    setFull(null);
  }, [sessionId, selection.hash, selection.path]);

  // Lazily fetch whichever view is active; skip if already cached for this file. Each fetch is
  // guarded by a request id so a stale response can't overwrite a newer one.
  useEffect(() => {
    if (view === "diff" ? diff !== null : full !== null) return;
    const req = ++reqRef.current;
    if (view === "diff") {
      api
        .gitCommitDiff(sessionId, selection.hash, selection.path)
        .then((d) => reqRef.current === req && setDiff(d.diff || ""))
        .catch(() => reqRef.current === req && setDiff(""));
    } else {
      api
        .gitCommitFile(sessionId, selection.hash, selection.path)
        .then((f) => reqRef.current === req && setFull(f))
        .catch(() => reqRef.current === req && setFull({ isRepo: true, path: selection.path, exists: false, content: "" }));
    }
  }, [view, diff, full, sessionId, selection.hash, selection.path]);

  // Loading is simply "the active view's data isn't in yet" — derived, so a file switch that nulls
  // the cache immediately shows the loader instead of the old content.
  const loading = view === "diff" ? diff === null : full === null;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <button
          onClick={onBack}
          title="Back to commit"
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{name}</div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">
            <span className="text-foreground">{selection.shortHash}</span> · {selection.subject}
          </div>
        </div>
        {onOpenInTree && (
          <button
            onClick={() => onOpenInTree(selection.path)}
            title="Open this file in the Files pane"
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <FileSymlink className="size-4" />
          </button>
        )}
        <button
          onClick={onClose}
          title="Close commit preview"
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </header>

      {/* Diff vs. full-file-at-this-commit toggle. */}
      <div className="flex items-center gap-1 border-b px-3 py-1.5">
        <ViewTab active={view === "diff"} onClick={() => setView("diff")}>Diff</ViewTab>
        <ViewTab active={view === "full"} onClick={() => setView("full")}>Full file</ViewTab>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading {view === "diff" ? "diff" : "file"}…
          </div>
        ) : view === "diff" ? (
          <DiffView diff={diff ?? ""} />
        ) : full?.exists ? (
          <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed">
            {full.content}
          </pre>
        ) : (
          <div className="p-4 text-sm text-muted-foreground">
            This file does not exist at this commit.
          </div>
        )}
      </div>
    </div>
  );
}

function ViewTab({
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
      type="button"
      onClick={onClick}
      className={cn(
        "rounded px-2 py-0.5 text-xs font-medium transition-colors",
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
      )}
    >
      {children}
    </button>
  );
}
