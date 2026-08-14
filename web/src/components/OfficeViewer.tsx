import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { MAX_OFFICE_PREVIEW, officeKind } from "@/lib/fileKind";
import {
  collectDocxOutline,
  jumpToDocxSection,
  wireDocxLinks,
  type DocxOutlineEntry,
} from "@/lib/docxLinks";
import { TocPanel } from "@/components/TocPanel";
import { ZoomControls, usePersistentZoom } from "@/components/ZoomControls";
import { cn } from "@/lib/utils";

type Status = "loading" | "error" | "toolarge" | "ready";

/**
 * Read-only inline viewer for Word (.docx) and Excel (.xlsx). Fetches the file's
 * raw bytes from `url` and renders them with docx-preview / SheetJS, both loaded on
 * demand (dynamic import) so they stay out of the main bundle. The source is just a
 * URL, so this serves both the per-session browser and the server-wide Files panel.
 */
export function OfficeViewer({ url, name }: { url: string; name: string }) {
  const kind = officeKind(name);
  if (kind === "xlsx") return <XlsxViewer url={url} />;
  return <DocxViewer url={url} />;
}

// Thrown when the response is bigger than we're willing to parse in the browser.
const TOO_LARGE = "toolarge";

// Fetch the file's raw bytes as an ArrayBuffer (the URL carries auth in its query, same
// as the image previews). Bails out on oversized files before buffering them.
async function fetchBytes(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(res.statusText);
  const len = Number(res.headers.get("content-length"));
  if (len > MAX_OFFICE_PREVIEW) throw new Error(TOO_LARGE);
  return res.arrayBuffer();
}

function DocxViewer({ url }: { url: string }) {
  const [status, setStatus] = useState<Status>("loading");
  const [zoom, setZoom] = usePersistentZoom("docx");
  const [outline, setOutline] = useState<DocxOutlineEntry[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    let unwireLinks: (() => void) | undefined;
    setStatus("loading");
    setOutline([]);
    (async () => {
      try {
        const [buffer, { renderAsync }] = await Promise.all([
          fetchBytes(url, ctrl.signal),
          import("docx-preview"),
        ]);
        if (ctrl.signal.aborted || !containerRef.current) return;
        containerRef.current.replaceChildren();
        await renderAsync(buffer, containerRef.current, undefined, {
          inWrapper: true,
          ignoreLastRenderedPageBreak: true,
        });
        if (ctrl.signal.aborted) return;
        // Make the rendered document's links work inside the viewer, and rebuild a table of contents
        // for files that carry only its formatting — see lib/docxLinks.ts.
        unwireLinks = wireDocxLinks(containerRef.current);
        setOutline(collectDocxOutline(containerRef.current));
        setStatus("ready");
      } catch (e) {
        if (!ctrl.signal.aborted) setStatus(failure(e));
      }
    })();
    return () => {
      ctrl.abort();
      unwireLinks?.();
    };
  }, [url]);

  return (
    <div className="relative h-full bg-neutral-100 dark:bg-neutral-900">
      {status === "loading" && <Centered><Loader2 className="size-4 animate-spin" /> Loading document…</Centered>}
      {status === "toolarge" && <Centered>This document is too large to preview.</Centered>}
      {status === "error" && <Centered className="text-destructive">Failed to render document.</Centered>}
      {status === "ready" && <ZoomControls zoom={zoom} onChange={setZoom} />}
      {/* Top-left: the zoom controls already own the right corner. */}
      {status === "ready" && (
        <TocPanel
          containerRef={scrollRef}
          entries={outline}
          onSelect={(e) => jumpToDocxSection(e.el)}
          storageKey="claudeweb.docxTocOpen"
          align="start"
        />
      )}
      {/* The scroll area wraps the host so the zoom controls stay put while the pages scroll. */}
      <div ref={scrollRef} className={cn("h-full overflow-auto p-4", status !== "ready" && "hidden")}>
        {/* docx-preview injects its own page-styled DOM; keep it light-on-white for fidelity. */}
        <div ref={containerRef} className="docx-host mx-auto" style={{ zoom }} />
      </div>
    </div>
  );
}

function XlsxViewer({ url }: { url: string }) {
  const [status, setStatus] = useState<Status>("loading");
  const [sheets, setSheets] = useState<{ name: string; html: string }[]>([]);
  const [active, setActive] = useState(0);
  const [zoom, setZoom] = usePersistentZoom("xlsx");

  useEffect(() => {
    const ctrl = new AbortController();
    setStatus("loading");
    setActive(0);
    (async () => {
      try {
        const [buffer, XLSX] = await Promise.all([
          fetchBytes(url, ctrl.signal),
          import("xlsx"),
        ]);
        if (ctrl.signal.aborted) return;
        const wb = XLSX.read(buffer, { type: "array" });
        const parsed = wb.SheetNames.map((name) => ({
          name,
          html: XLSX.utils.sheet_to_html(wb.Sheets[name], { id: "", editable: false }),
        }));
        setSheets(parsed);
        setStatus("ready");
      } catch (e) {
        if (!ctrl.signal.aborted) setStatus(failure(e));
      }
    })();
    return () => ctrl.abort();
  }, [url]);

  const activeHtml = useMemo(() => sheets[active]?.html ?? "", [sheets, active]);

  if (status === "loading")
    return <Centered><Loader2 className="size-4 animate-spin" /> Loading spreadsheet…</Centered>;
  if (status === "toolarge") return <Centered>This spreadsheet is too large to preview.</Centered>;
  if (status === "error") return <Centered className="text-destructive">Failed to render spreadsheet.</Centered>;

  return (
    <div className="relative flex h-full flex-col">
      {/* Bottom-right like a real spreadsheet, and clear of the sheet-tab strip up top. */}
      <ZoomControls zoom={zoom} onChange={setZoom} className="bottom-3 right-3" />
      {sheets.length > 1 && (
        <div className="flex shrink-0 gap-0.5 overflow-x-auto border-b px-2 py-1">
          {sheets.map((s, i) => (
            <button
              key={s.name}
              onClick={() => setActive(i)}
              className={cn(
                "shrink-0 rounded px-2.5 py-1 text-xs font-medium",
                i === active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
              )}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      {/* SheetJS emits a static <table> (no scripts). Style it for borders + dark mode.
          CSS `zoom` scales the table while flexbox keeps the container's size, so
          overflow-auto scrolling stays correct at any level. */}
      <div
        style={{ zoom }}
        className="xlsx-host min-h-0 flex-1 overflow-auto p-3 text-xs"
        dangerouslySetInnerHTML={{ __html: activeHtml }}
      />
    </div>
  );
}

// Map a thrown error to the status it should show — oversize files get their own message.
function failure(e: unknown): Status {
  return e instanceof Error && e.message === TOO_LARGE ? "toolarge" : "error";
}

function Centered({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex h-full items-center justify-center gap-2 p-4 text-sm text-muted-foreground", className)}>
      {children}
    </div>
  );
}
