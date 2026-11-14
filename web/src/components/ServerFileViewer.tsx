import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fileExt, fileKind } from "@/lib/fileKind";
import { highlightCode, highlightLines } from "@/lib/highlight";
import { CodeLines, gutterStyle } from "./CodeLines";
import { useCodeNav } from "@/lib/codeNav";
import { useHtml } from "@/lib/useHtml";
import { useContentRev } from "@/lib/useContentRev";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/CodeEditor";
import { Markdown, MarkdownToc } from "./Markdown";
import { OfficeViewer } from "./OfficeViewer";
import { PdfViewer } from "./PdfViewer";
import { ModelViewer } from "./ModelViewer";
import {
  ScrollJumpButtons,
  ZoomControls,
  usePersistentLineNumbers,
  usePersistentReadingWidth,
  usePersistentWordWrap,
  usePersistentZoom,
  frameZoomStyle,
} from "./ZoomControls";
import { CopyPathButton } from "./CopyPathButton";
import { previewUrl } from "@/lib/urlState";
import { writeToClipboard } from "@/lib/clipboard";
import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  ExternalLink,
  FolderTree,
  Loader2,
  Maximize2,
  Menu,
  Minimize2,
  Pencil,
  RefreshCw,
  Save,
  X,
} from "lucide-react";
import { MobileSessionsProgress, ShowSidebarButton } from "@/components/ShowSidebarButton";
import { OverflowToolbar, type OverflowItem } from "./OverflowToolbar";
import { ImagePane } from "./ImagePane";
import { useApi } from "@/lib/node";
import type { Api } from "@/lib/api";

/** How much of the header row the file name keeps before the controls start giving way. */
const VIEWER_NAME_MIN = 96;

const MAX_TEXT_PREVIEW = 2_000_000; // 2 MB — matches the per-session browser's cap

// Scroll position per file, per browser tab: lets the standalone preview tab (and a reopened file
// in the app) come back where it was after a reload. sessionStorage keeps it tab-local and drops
// it when the tab closes, so positions from different tabs never fight each other.
// Keyed by node too: the same path on two machines is two files. This node's keys are as they were.
const scrollKey = (base: string, p: string) => `hangar.previewScroll:${base}${p}`;

function baseName(p: string): string {
  const parts = p.split(/[/\\]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/**
 * Where the viewer reads and writes the file it shows. The server's own disk by default; a remote
 * files tab hands in its host instead, and the whole viewer — previews, the editor, downloads — works
 * the same over SFTP.
 */
export interface FileSource {
  /** The file's raw bytes, for media previews and downloads. Carries the token, like serverFileUrl. */
  url: (path: string, download?: boolean) => string;
  text: (path: string) => Promise<string>;
  write: (path: string, content: string) => Promise<void>;
  /**
   * A ticket for the HTML preview frame. Absent, the page is rendered from its own bytes — it shows,
   * but its relative stylesheets and images have nothing to resolve against.
   */
  previewTicket?: (path: string) => Promise<{ ticket: string; name: string }>;
  /** Whether the standalone preview tab (which reads the server's disk) can show this file. */
  newTab: boolean;
}

/** A node's own disk, through its file API. */
export function serverFileSource(api: Api): FileSource {
  return {
    url: api.serverFileUrl,
    text: (path) => api.fetchServerFileText(path),
    write: (path, content) => api.fsWrite(path, content),
    previewTicket: (path) => api.previewTicket(path),
    // The standalone preview tab reads the disk of the node the page was loaded from; a peer's file
    // isn't there to show.
    newTab: !api.base,
  };
}

/** A host's disk over a remote files tab's SSH connection. */
export function remoteFileSource(api: Api, tab: string): FileSource {
  return {
    url: (p, dl) => api.remoteFileUrl(tab, p, dl),
    text: (p) => api.remoteFileText(tab, p),
    write: (p, c) => api.remoteWrite(tab, p, c),
    newTab: false,
  };
}

/**
 * Main-area preview/editor for a file on the server machine (absolute path), opened from the sidebar
 * Files tab. Text files preview with syntax highlighting and can be edited/saved; Markdown has a
 * Rendered/Raw toggle; images, video, PDFs and Office documents (.docx/.xlsx) preview inline;
 * anything else offers a download.
 *
 * Also doubles as the whole page in the standalone preview tab (PreviewApp): there is no sidebar
 * or session view there, so every app-chrome callback is optional — leave them out and the
 * corresponding buttons (menu, close, open-in-new-tab) disappear.
 */
export function ServerFileViewer({
  path,
  back,
  onClose,
  onReveal,
  onToggleSidebar,
  collapsed = false,
  onToggleCollapsed,
  source: given,
}: {
  path: string;
  /** Standalone preview tab only: link back into the app (see previewReturnUrl). */
  back?: { href: string; label: string };
  /** Return to the session view. Absent in the standalone preview tab, which has nowhere to go. */
  onClose?: () => void;
  // Reveal this file in the Files tab tree (switch tab + expand/scroll to it).
  onReveal?: () => void;
  /** Open the mobile sidebar drawer. Absent in the standalone preview tab (no sidebar). */
  onToggleSidebar?: () => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** Where the file comes from; the disk of the view's node by default. */
  source?: FileSource;
}) {
  const api = useApi();
  const ownDisk = useMemo(() => serverFileSource(api), [api]);
  const source = given ?? ownDisk;
  const name = baseName(path);
  const kind = fileKind(name);
  const ext = fileExt(name);
  const isMarkdown = ext === "md" || ext === "markdown";
  const isHtml = ext === "html" || ext === "htm";

  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tooLarge, setTooLarge] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [rendered, setRendered] = useState(true); // markdown/HTML: rendered preview vs raw source
  // Full-page preview: the viewer takes the whole window, sidebar and all. The same thing the
  // session's Files panel offers, and wanted here for the same reason -- a rendered page or a long
  // document is worth reading at the width of the screen rather than beside a file tree.
  const [fullscreen, setFullscreen] = useState(false);
  // Text/markdown preview zoom; kept while switching files and across reloads so a chosen size sticks.
  const [zoom, setZoom] = usePersistentZoom("text");
  // A page has its own natural size, so its zoom is kept apart from the text previews'.
  const [htmlZoom, setHtmlZoom] = usePersistentZoom("html");
  // Optional left/right margins for the text previews: caps the line length and centers the
  // content, which is what makes a full-page preview readable on a wide monitor. Persisted like
  // zoom, so the choice sticks across files, reloads and preview tabs.
  const [readingWidth, setReadingWidth] = usePersistentReadingWidth("text");
  const [wordWrap, setWordWrap] = usePersistentWordWrap("text");
  const [lineNumbers, setLineNumbers] = usePersistentLineNumbers("text");
  // Bumped by the header refresh button: re-runs the text fetch and cache-busts media URLs.
  const [reloadKey, setReloadKey] = useState(0);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null); // the name-and-controls row, for the toolbar's room
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  // Raw-bytes URL for media previews; carries the reload counter so a refresh actually bypasses
  // the browser cache instead of re-serving the stale image/video/document.
  const rawUrl = reloadKey ? `${source.url(path)}&v=${reloadKey}` : source.url(path);
  const downloadUrl = source.url(path, true);

  // --- The HTML frame's source --------------------------------------------------------------------
  // Loaded from a ticketed URL rather than handed its bytes, so the page's own relative images and
  // stylesheets have something to resolve against; the server appends the scroll bridge. Mirrors the
  // per-session file preview — see FileBrowser's previewSrc, and api.previewTicket for the ticket.
  // What makes the frame reload: `src` is otherwise stable across an edit, so the frame would go on
  // showing the document it first loaded. The file's contents changing moves it, and so does the
  // refresh button on its own — re-reading an unchanged file leaves the text equal, and a press of
  // refresh should reload the page regardless.
  const contentRev = useContentRev(text);

  // Keyed by the path it was minted for, and re-minted whenever the frame is about to reload — see
  // FileBrowser's copy for both reasons. They matter more here: `rendered` is not reset when the
  // open file changes, so a ticket for the previous file would otherwise still be in hand when a
  // new one is shown.
  const [preview, setPreview] = useState<
    { forPath: string; ticket: string; name: string } | { forPath: string; failed: true } | null
  >(null);
  useEffect(() => {
    if (!isHtml || !rendered || !path) return;
    let cancelled = false;
    if (!source.previewTicket) {
      setPreview({ forPath: path, failed: true });
      return;
    }
    source
      .previewTicket(path)
      .then((p) => !cancelled && setPreview({ forPath: path, ...p }))
      .catch(() => !cancelled && setPreview({ forPath: path, failed: true }));
    return () => {
      cancelled = true;
    };
  }, [isHtml, rendered, path, contentRev, reloadKey, source]);

  const previewSrc = preview?.forPath === path ? preview : null;
  const frameSrc =
    previewSrc && !("failed" in previewSrc)
      ? api.previewFrameUrl(previewSrc.ticket, previewSrc.name, `${contentRev}-${reloadKey}`)
      : "";

  // A section anchor in the URL hash belongs to the file it was clicked in: keep it across a
  // reload (that's what makes it restorable), but drop it when switching to a different file.
  const prevPath = useRef<string | null>(null);
  useEffect(() => {
    if (prevPath.current !== null && prevPath.current !== path && window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    prevPath.current = path;
  }, [path]);

  // Load text content when the open file (or its kind) changes.
  useEffect(() => {
    setEditing(false);
    setError(null);
    setText(null);
    setTooLarge(false);
    if (kind !== "text") return;

    let alive = true;
    setLoading(true);
    source
      .text(path)
      .then((t) => {
        if (!alive) return;
        if (t.length > MAX_TEXT_PREVIEW) setTooLarge(true);
        else setText(t);
      })
      .catch(() => alive && setError("Could not read this file."))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [path, kind, reloadKey, source]);

  // Restore the saved scroll position once real content is in the DOM (text arrives async, so this
  // must run after the loader goes away; it also re-runs when leaving edit mode or toggling
  // rendered/raw, where the restore is a no-op because scrolling keeps the key up to date).
  // Best-effort: markdown images that load later can still shift the layout.
  useEffect(() => {
    if (loading || editing) return;
    // A section anchor in the URL wins over the pixel position: the Markdown component scrolls
    // to it itself, and it stays correct even when late-rendering diagrams shift the layout.
    if (isMarkdown && rendered && window.location.hash) return;
    // The HTML frame scrolls its own document, not this container — the effect below is what puts
    // that one back, and the offset it stores would be clamped to nothing if applied here.
    if (isHtml && rendered) return;
    const el = scrollRef.current;
    if (!el) return;
    const saved = Number(sessionStorage.getItem(scrollKey(api.base, path)));
    if (saved > 0) el.scrollTop = saved;
  }, [path, loading, editing, text, rendered, isMarkdown, isHtml]);

  // Where an HTML preview was left off. The frame has an opaque origin, so nothing out here can
  // read or set its scrollTop: the bridge the server appends to the document reports its own
  // position and is told where to go back to. Same exchange as the per-session preview — see
  // FileBrowser, which explains why the message has to name the document it came from — and it
  // writes to the same key as the container position above, so a file remembers one place
  // whichever way it was being shown.
  useEffect(() => {
    if (!isHtml || !rendered || !frameSrc) return;
    const ours = new URL(frameSrc, window.location.origin).pathname;
    let placed = false; // this document has been told where to go; later readies are duplicates
    const onMessage = (e: MessageEvent) => {
      const frame = frameRef.current?.contentWindow;
      if (!frame || e.source !== frame) return; // only our own preview frame
      const msg = e.data as { cwScrollReady?: boolean; cwScroll?: number; cwPath?: string } | null;
      if (!msg || typeof msg !== "object") return;
      if (msg.cwPath !== ours) return; // the frame has navigated; that page keeps its own place
      try {
        if (msg.cwScrollReady) {
          if (placed) return;
          placed = true;
          frame.postMessage({ cwScrollTo: Number(sessionStorage.getItem(scrollKey(api.base, path))) || 0 }, "*");
        } else if (typeof msg.cwScroll === "number") {
          sessionStorage.setItem(scrollKey(api.base, path), String(Math.round(msg.cwScroll)));
        }
      } catch {
        /* storage unavailable — position keeping is best-effort, same as the container above */
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [isHtml, rendered, path, frameSrc]);

  // highlight.js escapes its input, so the resulting HTML is safe to inject (same as FileBrowser).
  // useHtml keeps the injected markup identical across renders, so re-renders don't rebuild the
  // <code> (and drop whatever the user had selected in it).
  const highlighted = useHtml(
    useMemo(() => (text !== null && !lineNumbers ? highlightCode(name, text) : null), [name, text, lineNumbers])
  );
  // The same, a line at a time, for the view that numbers its lines (see CodeLines).
  const numberedLines = useMemo(
    () => (text !== null && lineNumbers ? highlightLines(name, text) : null),
    [name, text, lineNumbers]
  );
  // A click on a name in the code marks it throughout; Ctrl/⌘+click goes to its declaration.
  const nav = useCodeNav();

  const copyContent = useCallback(async () => {
    if (text === null) return;
    await writeToClipboard(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [text]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await source.write(path, draft);
      setText(draft);
      setEditing(false);
    } catch {
      setError("Save failed.");
    } finally {
      setSaving(false);
    }
  }, [path, draft, source]);

  // Esc leaves the full-page view — but not while editing, where it could drop unsaved text. Capture
  // phase, and the root takes focus on the way in, so the key still lands here after a click inside
  // the preview. Keys pressed inside an embedded PDF or the HTML iframe never reach this document at
  // all, which is why the button stays as the way out there.
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

  // The viewer's controls, in the order they give way: the view switch and the edit and copy
  // actions stay longest; the ways out of this pane (full page, a new tab, download) go first.
  const viewerTools: OverflowItem[] = [];
  const editable = kind === "text" && !tooLarge && !editing;
  if (editable && (isMarkdown || isHtml)) {
    const toggleLabel = isHtml ? (rendered ? "Source" : "Preview") : rendered ? "Raw" : "Rendered";
    viewerTools.push({
      id: "render",
      inline: (
        <Button variant="ghost" size="sm" onClick={() => setRendered((r) => !r)}>
          {toggleLabel}
        </Button>
      ),
      menu: [
        {
          id: "render-rendered",
          label: isHtml ? "Preview" : "Rendered",
          pressed: rendered,
          onClick: () => setRendered(true),
        },
        { id: "render-raw", label: isHtml ? "Source" : "Raw", pressed: !rendered, onClick: () => setRendered(false) },
      ],
    });
  }
  if (editable) {
    viewerTools.push({
      id: "copy",
      inline: (
        <Button
          variant="ghost"
          size="icon"
          onClick={copyContent}
          disabled={text === null}
          title={copied ? "Copied!" : "Copy content"}
        >
          {copied ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
        </Button>
      ),
      menu: [
        { id: "copy", label: "Copy content", icon: <Copy className="size-4" />, onClick: copyContent, disabled: text === null },
      ],
    });
    const startEdit = () => {
      setDraft(text ?? "");
      setEditing(true);
    };
    viewerTools.push({
      id: "edit",
      inline: (
        <Button variant="ghost" size="sm" onClick={startEdit} disabled={text === null}>
          <Pencil className="size-4" />
          <span className="ml-1 hidden sm:inline">Edit</span>
        </Button>
      ),
      menu: [{ id: "edit", label: "Edit", icon: <Pencil className="size-4" />, onClick: startEdit, disabled: text === null }],
    });
  }
  if (!editing) {
    const reload = () => setReloadKey((k) => k + 1);
    viewerTools.push({
      id: "reload",
      inline: (
        <Button variant="ghost" size="icon" onClick={reload} disabled={loading} title="Refresh">
          <RefreshCw className={cn("size-4", loading && "animate-spin")} />
        </Button>
      ),
      menu: [{ id: "reload", label: "Refresh", icon: <RefreshCw className="size-4" />, onClick: reload, disabled: loading }],
    });
  }
  if (onReveal)
    viewerTools.push({
      id: "reveal",
      inline: (
        <Button variant="ghost" size="icon" onClick={onReveal} title="Show in Files">
          <FolderTree className="size-4" />
        </Button>
      ),
      menu: [{ id: "reveal", label: "Show in Files", icon: <FolderTree className="size-4" />, onClick: onReveal }],
    });
  // Embedded in the app: take the whole window, sidebar and all. Pointless in a standalone preview
  // tab, which is already the whole window -- hence the same gate as the new-tab link below. Leaving
  // is by this button or Esc; Close stays what it is, so the two are never the same X.
  // The way back out is not here but beside the toolbar (see below): in full page it must never be
  // the thing that ends up in the menu, least of all on a phone, where there is no Esc.
  if (onClose && !editing && !fullscreen) {
    viewerTools.push({
      id: "fullpage",
      inline: (
        <Button variant="ghost" size="icon" onClick={() => setFullscreen(true)} title="Full page" aria-label="Full page">
          <Maximize2 className="size-4" />
        </Button>
      ),
      menu: [{ id: "fullpage", label: "Full page", icon: <Maximize2 className="size-4" />, onClick: () => setFullscreen(true) }],
    });
  }
  // Embedded in the app: the same file as a standalone full-page preview in its own browser tab (the
  // path rides in the query string, so that tab survives a refresh). The current section anchor is
  // carried along, read at click time because hash changes don't re-render this component.
  if (onClose && source.newTab) {
    const tabUrl = () => previewUrl(path) + window.location.hash;
    viewerTools.push({
      id: "newtab",
      inline: (
        <Button variant="ghost" size="icon" asChild title="Open in new browser tab">
          <a
            href={previewUrl(path)}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => {
              e.currentTarget.href = tabUrl();
            }}
          >
            <ExternalLink className="size-4" />
          </a>
        </Button>
      ),
      menu: [
        { id: "newtab", label: "Open in new browser tab", icon: <ExternalLink className="size-4" />, href: tabUrl, newTab: true },
      ],
    });
  }
  viewerTools.push({
    id: "download",
    inline: (
      <Button variant="ghost" size="icon" asChild title="Download">
        <a href={downloadUrl} download={name}>
          <Download className="size-4" />
        </a>
      </Button>
    ),
    menu: [
      { id: "download", label: "Download", icon: <Download className="size-4" />, href: downloadUrl, download: name },
    ],
  });

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className={cn(
        "flex flex-col outline-none",
        fullscreen ? "fixed inset-0 z-50 bg-background safe-area-pad" : "h-full"
      )}
    >
      <header className="flex items-center gap-2 border-b px-3 py-2">
        {/* Standalone preview tab: the way back to the app view this preview was opened from. */}
        {back && (
          <Button variant="ghost" size="sm" asChild className="shrink-0 px-2" title={back.label}>
            <a href={back.href}>
              <ArrowLeft className="size-4" />
              <span className="ml-1 hidden sm:inline">{back.label}</span>
            </a>
          </Button>
        )}
        {onToggleSidebar && (
          <Button variant="ghost" size="icon" className="md:hidden" onClick={onToggleSidebar} title="Sessions & files">
            <Menu className="size-5" />
          </Button>
        )}
        {onToggleSidebar && <MobileSessionsProgress />}
        {collapsed && onToggleCollapsed && (
          <ShowSidebarButton onClick={onToggleCollapsed} />
        )}
        {/* The name and the controls share this row, which takes what the buttons either side leave;
            the controls give way into a "more" menu before the name does. */}
        <div ref={rowRef} className="flex min-w-0 flex-1 items-center gap-2">
          <div className="group min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1">
              <div className="truncate text-sm font-medium">
                {name}
                {editing && <span className="ml-1 text-amber-500">•</span>}
              </div>
              <CopyPathButton
                path={name}
                title="Copy file name"
                className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                iconClassName="size-3"
              />
            </div>
            <div className="flex min-w-0 items-center gap-1">
              <div className="truncate text-xs text-muted-foreground" title={path}>
                {path}
              </div>
              <CopyPathButton
                path={path}
                className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                iconClassName="size-3"
              />
            </div>
          </div>
          {editing && kind === "text" && !tooLarge && (
            <>
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={saving}>
                Cancel
              </Button>
              <Button size="sm" onClick={save} disabled={saving}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                <span className="ml-1 hidden sm:inline">Save</span>
              </Button>
            </>
          )}
          <OverflowToolbar
            items={viewerTools}
            container={rowRef}
            reserve={VIEWER_NAME_MIN + 8 + (editing ? 160 : 0) + (fullscreen ? 36 + 8 : 0)}
            menuButtonClassName="size-9"
            menuButtonWidth={36}
          />
          {fullscreen && (
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              onClick={() => setFullscreen(false)}
              title="Exit full page (Esc)"
              aria-label="Exit full page"
            >
              <Minimize2 className="size-4" />
            </Button>
          )}
        </div>
        {onClose && (
          <Button variant="ghost" size="icon" onClick={onClose} title="Close">
            <X className="size-5" />
          </Button>
        )}
      </header>

      <div className="relative min-h-0 flex-1">
        {/* Zoom applies to the text-based previews; images/video/PDF/Office bring their own. A
            rendered HTML page gets zoom alone, below: it lays itself out, so the rest means nothing. */}
        {kind === "text" && !tooLarge && text !== null && (editing || !(isHtml && rendered)) && (
          <ZoomControls
            zoom={zoom}
            onChange={setZoom}
            width={readingWidth}
            // The editor neither wraps nor caps its width: either would pull the caret off the
            // highlighted text under it (see CodeEditor). Zoom alone carries over.
            onWidthChange={editing ? undefined : setReadingWidth}
            wrap={wordWrap}
            // Rendered markdown flows as paragraphs already; a wrap switch there would do nothing.
            onWrapChange={editing || (isMarkdown && rendered) ? undefined : setWordWrap}
            lineNumbers={lineNumbers}
            onLineNumbersChange={!editing && isMarkdown && rendered ? undefined : setLineNumbers}
            onGoToLine={!editing && isMarkdown && rendered ? undefined : nav.goToLine}
            className="bottom-3 right-3"
          />
        )}
        {kind === "text" && isHtml && rendered && !editing && !tooLarge && previewSrc !== null && (
          <ZoomControls zoom={htmlZoom} onChange={setHtmlZoom} className="bottom-3 right-3" />
        )}
        {isMarkdown && rendered && !editing && !tooLarge && text !== null && (
          <MarkdownToc containerRef={scrollRef} text={text} />
        )}
        {!editing && <ScrollJumpButtons containerRef={scrollRef} watch={text ?? path} />}
        <div
          ref={scrollRef}
          className="h-full overflow-auto"
          onScroll={(e) => {
            // While the loader/editor is up the container collapses and the browser clamps
            // scrollTop to 0 — don't let that clobber the saved position.
            if (loading || editing) return;
            try {
              sessionStorage.setItem(scrollKey(api.base, path), String(e.currentTarget.scrollTop));
            } catch {
              /* storage unavailable — position keeping is best-effort */
            }
          }}
        >
        {error ? (
          <div className="p-6 text-sm text-destructive">{error}</div>
        ) : loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : kind === "image" ? (
          <ImagePane key={rawUrl} src={rawUrl} alt={name} className="bg-muted/30" />
        ) : kind === "video" ? (
          <div className="flex h-full items-center justify-center bg-black p-2">
            <video src={rawUrl} controls className="max-h-full max-w-full object-contain" />
          </div>
        ) : kind === "office" ? (
          <OfficeViewer url={rawUrl} name={name} />
        ) : kind === "pdf" ? (
          <PdfViewer url={rawUrl} downloadUrl={downloadUrl} name={name} />
        ) : kind === "model" ? (
          <ModelViewer url={rawUrl} name={name} />
        ) : kind !== "text" ? (
          <DownloadPrompt href={downloadUrl} name={name} />
        ) : tooLarge ? (
          <div className="p-6 text-sm text-muted-foreground">
            This file is too large to preview inline.{" "}
            <a className="text-primary underline" href={downloadUrl} download={name}>
              Download it
            </a>{" "}
            instead.
          </div>
        ) : editing ? (
          <CodeEditor name={name} value={draft} onChange={setDraft} zoom={zoom} nav={nav} lineNumbers={lineNumbers} />
        ) : isMarkdown && rendered ? (
          // maxWidth sits on the zoomed box on purpose: `zoom` scales it along with the text, so a
          // line keeps the same character count as you zoom (see READING_WIDTHS).
          <div
            style={{ zoom, maxWidth: readingWidth ?? undefined }}
            className="prose prose-sm dark:prose-invert mx-auto max-w-none p-4"
          >
            <Markdown text={text ?? ""} docPath={path} assetUrl={given ? source.url : undefined} />
          </div>
        ) : isHtml && rendered ? (
          // Render in a sandboxed iframe WITHOUT allow-same-origin: the document gets an opaque origin,
          // so page scripts can't reach this app's token or DOM. Loaded from a ticketed URL so the
          // page's relative assets resolve, falling back to its bytes (and broken assets) if no ticket
          // could be minted. Mirrors the per-session file preview.
          previewSrc === null ? (
            <div className="h-full w-full bg-white" />
          ) : (
            <div className="h-full w-full overflow-hidden">
              <iframe
                ref={frameRef}
                title={`Preview of ${name}`}
                {...("failed" in previewSrc ? { srcDoc: text ?? "" } : { src: frameSrc })}
                sandbox="allow-scripts allow-forms allow-popups allow-modals"
                style={frameZoomStyle(htmlZoom)}
                className="h-full w-full border-0 bg-white"
              />
            </div>
          )
        ) : lineNumbers && text !== null ? (
          <pre
            ref={nav.ref}
            style={{ zoom, maxWidth: readingWidth ?? undefined, ...gutterStyle(text) }}
            className={`code-lines code-lines-sticky mx-auto overflow-auto p-4 font-mono text-xs leading-relaxed ${wordWrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre"}`}
          >
            {nav.overlay}
            {numberedLines ? (
              <code className="hljs">
                <CodeLines text={text} lines={numberedLines} />
              </code>
            ) : (
              <CodeLines text={text} lines={null} />
            )}
          </pre>
        ) : highlighted ? (
          <pre ref={nav.ref} style={{ zoom, maxWidth: readingWidth ?? undefined }} className={`mx-auto overflow-auto p-4 font-mono text-xs leading-relaxed ${wordWrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre"}`}>
            {nav.overlay}
            <code className="hljs" dangerouslySetInnerHTML={highlighted} />
          </pre>
        ) : (
          <pre ref={nav.ref} style={{ zoom, maxWidth: readingWidth ?? undefined }} className={`mx-auto overflow-auto p-4 font-mono text-xs leading-relaxed ${wordWrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre"}`}>{text}{nav.overlay}</pre>
        )}
        </div>
      </div>
    </div>
  );
}

function DownloadPrompt({ href, name }: { href: string; name: string }) {
  return (
    <div className={cn("flex h-full flex-col items-center justify-center gap-3 p-6 text-center")}>
      <p className="text-sm text-muted-foreground">This file type can't be previewed.</p>
      <Button asChild>
        <a href={href} download={name}>
          <Download className="mr-1 size-4" />
          Download
        </a>
      </Button>
    </div>
  );
}
