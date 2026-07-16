import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, serverFileUrl } from "@/lib/api";
import { fileExt, fileKind } from "@/lib/fileKind";
import { highlightCode } from "@/lib/highlight";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Download,
  FolderTree,
  Loader2,
  Menu,
  PanelLeftOpen,
  Pencil,
  Save,
  X,
} from "lucide-react";

const MAX_TEXT_PREVIEW = 2_000_000; // 2 MB — matches the per-session browser's cap

function baseName(p: string): string {
  const parts = p.split(/[/\\]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/**
 * Main-area preview/editor for a file on the server machine (absolute path), opened from the sidebar
 * Files tab. Text files preview with syntax highlighting and can be edited/saved; Markdown has a
 * Rendered/Raw toggle; images preview inline; anything else offers a download.
 */
export function ServerFileViewer({
  path,
  onClose,
  onReveal,
  onToggleSidebar,
  collapsed,
  onToggleCollapsed,
}: {
  path: string;
  onClose: () => void;
  // Reveal this file in the Files tab tree (switch tab + expand/scroll to it).
  onReveal?: () => void;
  onToggleSidebar: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
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
  }, [path, kind]);

  // highlight.js escapes its input, so the resulting HTML is safe to inject (same as FileBrowser).
  const highlighted = useMemo(
    () => (text !== null ? highlightCode(name, text) : null),
    [name, text]
  );

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
        <Button variant="ghost" size="icon" className="md:hidden" onClick={onToggleSidebar} title="Sessions & files">
          <Menu className="size-5" />
        </Button>
        {collapsed && (
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
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {name}
            {editing && <span className="ml-1 text-amber-500">•</span>}
          </div>
          <div className="truncate text-xs text-muted-foreground" title={path}>
            {path}
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
        {onReveal && (
          <Button variant="ghost" size="icon" onClick={onReveal} title="Show in Files">
            <FolderTree className="size-4" />
          </Button>
        )}
        <Button variant="ghost" size="icon" asChild title="Download">
          <a href={serverFileUrl(path, true)} download={name}>
            <Download className="size-4" />
          </a>
        </Button>
        <Button variant="ghost" size="icon" onClick={onClose} title="Close">
          <X className="size-5" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="p-6 text-sm text-destructive">{error}</div>
        ) : loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : kind === "image" ? (
          <div className="flex h-full items-center justify-center bg-muted/30 p-4">
            <img src={serverFileUrl(path)} alt={name} className="max-h-full max-w-full object-contain" />
          </div>
        ) : kind === "video" ? (
          <div className="flex h-full items-center justify-center bg-black p-2">
            <video src={serverFileUrl(path)} controls className="max-h-full max-w-full object-contain" />
          </div>
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
          <div className="prose prose-sm dark:prose-invert max-w-none p-4">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text ?? ""}</ReactMarkdown>
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
          <pre className="overflow-auto whitespace-pre p-4 font-mono text-xs leading-relaxed">
            <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
          </pre>
        ) : (
          <pre className="overflow-auto whitespace-pre p-4 font-mono text-xs leading-relaxed">{text}</pre>
        )}
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
