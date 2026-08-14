import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, serverFileUrl } from "@/lib/api";
import { fileExt, fileKind } from "@/lib/fileKind";
import { highlightCode } from "@/lib/highlight";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Markdown, MarkdownToc } from "./Markdown";
import { OfficeViewer } from "./OfficeViewer";
import { PdfViewer } from "./PdfViewer";
import {
  ScrollJumpButtons,
  ZoomControls,
  usePersistentReadingWidth,
  usePersistentZoom,
} from "./ZoomControls";
import { CopyPathButton } from "./CopyPathButton";
import { previewUrl } from "@/lib/urlState";
import { writeToClipboard } from "@/lib/clipboard";
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  FolderTree,
  Loader2,
  Menu,
  PanelLeftOpen,
  Pencil,
  RefreshCw,
  Save,
  X,
} from "lucide-react";

const MAX_TEXT_PREVIEW = 2_000_000; // 2 MB — matches the per-session browser's cap

// Scroll position per file, per browser tab: lets the standalone preview tab (and a reopened file
// in the app) come back where it was after a reload. sessionStorage keeps it tab-local and drops
// it when the tab closes, so positions from different tabs never fight each other.
const scrollKey = (p: string) => `claudeweb.previewScroll:${p}`;

function baseName(p: string): string {
  const parts = p.split(/[/\\]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
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
  onClose,
  onReveal,
  onToggleSidebar,
  collapsed = false,
  onToggleCollapsed,
}: {
  path: string;
  /** Return to the session view. Absent in the standalone preview tab, which has nowhere to go. */
  onClose?: () => void;
  // Reveal this file in the Files tab tree (switch tab + expand/scroll to it).
  onReveal?: () => void;
  /** Open the mobile sidebar drawer. Absent in the standalone preview tab (no sidebar). */
  onToggleSidebar?: () => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
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
  // Text/markdown preview zoom; kept while switching files and across reloads so a chosen size sticks.
  const [zoom, setZoom] = usePersistentZoom("text");
  // Optional left/right margins for the text previews: caps the line length and centers the
  // content, which is what makes a full-page preview readable on a wide monitor. Persisted like
  // zoom, so the choice sticks across files, reloads and preview tabs.
  const [readingWidth, setReadingWidth] = usePersistentReadingWidth("text");
  // Bumped by the header refresh button: re-runs the text fetch and cache-busts media URLs.
  const [reloadKey, setReloadKey] = useState(0);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Raw-bytes URL for media previews; carries the reload counter so a refresh actually bypasses
  // the browser cache instead of re-serving the stale image/video/document.
  const rawUrl = reloadKey ? `${serverFileUrl(path)}&v=${reloadKey}` : serverFileUrl(path);

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
    api
      .fetchServerFileText(path)
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
  }, [path, kind, reloadKey]);

  // Restore the saved scroll position once real content is in the DOM (text arrives async, so this
  // must run after the loader goes away; it also re-runs when leaving edit mode or toggling
  // rendered/raw, where the restore is a no-op because scrolling keeps the key up to date).
  // Best-effort: markdown images that load later can still shift the layout.
  useEffect(() => {
    if (loading || editing) return;
    // A section anchor in the URL wins over the pixel position: the Markdown component scrolls
    // to it itself, and it stays correct even when late-rendering diagrams shift the layout.
    if (isMarkdown && rendered && window.location.hash) return;
    const el = scrollRef.current;
    if (!el) return;
    const saved = Number(sessionStorage.getItem(scrollKey(path)));
    if (saved > 0) el.scrollTop = saved;
  }, [path, loading, editing, text, rendered, isMarkdown]);

  // highlight.js escapes its input, so the resulting HTML is safe to inject (same as FileBrowser).
  const highlighted = useMemo(
    () => (text !== null ? highlightCode(name, text) : null),
    [name, text]
  );

  const copyContent = useCallback(async () => {
    if (text === null) return;
    await writeToClipboard(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [text]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await api.fsWrite(path, draft);
      setText(draft);
      setEditing(false);
    } catch {
      setError("Save failed.");
    } finally {
      setSaving(false);
    }
  }, [path, draft]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        {onToggleSidebar && (
          <Button variant="ghost" size="icon" className="md:hidden" onClick={onToggleSidebar} title="Sessions & files">
            <Menu className="size-5" />
          </Button>
        )}
        {collapsed && onToggleCollapsed && (
          <Button
            variant="ghost"
            size="icon"
            className="hidden md:inline-flex"
            title="Show sidebar"
            onClick={onToggleCollapsed}
          >
            <PanelLeftOpen className="size-5" />
          </Button>
        )}
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

        {kind === "text" && !tooLarge && (
          editing ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={saving}>
                Cancel
              </Button>
              <Button size="sm" onClick={save} disabled={saving}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                <span className="ml-1 hidden sm:inline">Save</span>
              </Button>
            </>
          ) : (
            <>
              {(isMarkdown || isHtml) && (
                <Button variant="ghost" size="sm" onClick={() => setRendered((r) => !r)}>
                  {isHtml ? (rendered ? "Source" : "Preview") : rendered ? "Raw" : "Rendered"}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                onClick={copyContent}
                disabled={text === null}
                title={copied ? "Copied!" : "Copy content"}
              >
                {copied ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDraft(text ?? "");
                  setEditing(true);
                }}
                disabled={text === null}
              >
                <Pencil className="size-4" />
                <span className="ml-1 hidden sm:inline">Edit</span>
              </Button>
            </>
          )
        )}
        {!editing && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setReloadKey((k) => k + 1)}
            disabled={loading}
            title="Refresh"
          >
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </Button>
        )}
        {onReveal && (
          <Button variant="ghost" size="icon" onClick={onReveal} title="Show in Files">
            <FolderTree className="size-4" />
          </Button>
        )}
        {/* Embedded in the app: offer the same file as a standalone full-page preview in its own
            browser tab (the path rides in the query string, so that tab survives a refresh). */}
        {onClose && (
          <Button variant="ghost" size="icon" asChild title="Open in new browser tab">
            <a
              href={previewUrl(path)}
              target="_blank"
              rel="noreferrer"
              // Carry the current section anchor along so the new tab opens at the same place.
              // Refreshed at click time because hash changes don't re-render this component.
              onClick={(e) => {
                e.currentTarget.href = previewUrl(path) + window.location.hash;
              }}
            >
              <ExternalLink className="size-4" />
            </a>
          </Button>
        )}
        <Button variant="ghost" size="icon" asChild title="Download">
          <a href={serverFileUrl(path, true)} download={name}>
            <Download className="size-4" />
          </a>
        </Button>
        {onClose && (
          <Button variant="ghost" size="icon" onClick={onClose} title="Close">
            <X className="size-5" />
          </Button>
        )}
      </header>

      <div className="relative min-h-0 flex-1">
        {/* Zoom applies to the text-based previews; images/video/PDF/Office bring their own. The
            sandboxed HTML iframe is excluded — CSS zoom would scale the frame, not its document. */}
        {kind === "text" && !tooLarge && !editing && text !== null && !(isHtml && rendered) && (
          <ZoomControls
            zoom={zoom}
            onChange={setZoom}
            width={readingWidth}
            onWidthChange={setReadingWidth}
            className="bottom-3 right-3"
          />
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
              sessionStorage.setItem(scrollKey(path), String(e.currentTarget.scrollTop));
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
          <div className="flex h-full items-center justify-center bg-muted/30 p-4">
            <img src={rawUrl} alt={name} className="max-h-full max-w-full object-contain" />
          </div>
        ) : kind === "video" ? (
          <div className="flex h-full items-center justify-center bg-black p-2">
            <video src={rawUrl} controls className="max-h-full max-w-full object-contain" />
          </div>
        ) : kind === "office" ? (
          <OfficeViewer url={rawUrl} name={name} />
        ) : kind === "pdf" ? (
          <PdfViewer url={rawUrl} downloadUrl={serverFileUrl(path, true)} name={name} />
        ) : kind !== "text" ? (
          <DownloadPrompt path={path} name={name} />
        ) : tooLarge ? (
          <div className="p-6 text-sm text-muted-foreground">
            This file is too large to preview inline.{" "}
            <a className="text-primary underline" href={serverFileUrl(path, true)} download={name}>
              Download it
            </a>{" "}
            instead.
          </div>
        ) : editing ? (
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="h-full w-full resize-none rounded-none border-0 font-mono text-xs leading-relaxed focus-visible:ring-0"
          />
        ) : isMarkdown && rendered ? (
          // maxWidth sits on the zoomed box on purpose: `zoom` scales it along with the text, so a
          // line keeps the same character count as you zoom (see READING_WIDTHS).
          <div
            style={{ zoom, maxWidth: readingWidth ?? undefined }}
            className="prose prose-sm dark:prose-invert mx-auto max-w-none p-4"
          >
            <Markdown text={text ?? ""} />
          </div>
        ) : isHtml && rendered ? (
          // Render in a sandboxed iframe WITHOUT allow-same-origin: the document gets an opaque origin,
          // so page scripts can't reach this app's token or DOM. Relative asset URLs won't resolve (no
          // base) — self-contained pages preview best. Mirrors the per-session file preview.
          <iframe
            title={`Preview of ${name}`}
            srcDoc={text ?? ""}
            sandbox="allow-scripts allow-forms allow-popups allow-modals"
            className="h-full w-full border-0 bg-white"
          />
        ) : highlighted ? (
          <pre style={{ zoom, maxWidth: readingWidth ?? undefined }} className="mx-auto overflow-auto whitespace-pre p-4 font-mono text-xs leading-relaxed">
            <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
          </pre>
        ) : (
          <pre style={{ zoom, maxWidth: readingWidth ?? undefined }} className="mx-auto overflow-auto whitespace-pre p-4 font-mono text-xs leading-relaxed">{text}</pre>
        )}
        </div>
      </div>
    </div>
  );
}

function DownloadPrompt({ path, name }: { path: string; name: string }) {
  return (
    <div className={cn("flex h-full flex-col items-center justify-center gap-3 p-6 text-center")}>
      <p className="text-sm text-muted-foreground">This file type can't be previewed.</p>
      <Button asChild>
        <a href={serverFileUrl(path, true)} download={name}>
          <Download className="mr-1 size-4" />
          Download
        </a>
      </Button>
    </div>
  );
}
