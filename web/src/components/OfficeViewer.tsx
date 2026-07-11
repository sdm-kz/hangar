import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { sessionFileUrl } from "@/lib/api";
import { officeKind } from "@/lib/fileKind";
import type { FileEntry } from "@/types";
import { cn } from "@/lib/utils";

type Status = "loading" | "error" | "ready";

/**
 * Read-only inline viewer for Word (.docx) and Excel (.xlsx). Fetches the file's
 * raw bytes and renders them with docx-preview / SheetJS, both loaded on demand
 * (dynamic import) so they stay out of the main bundle.
 */
export function OfficeViewer({ sessionId, file }: { sessionId: string; file: FileEntry }) {
  const kind = officeKind(file.name);
  if (kind === "xlsx") return <XlsxViewer sessionId={sessionId} file={file} />;
  return <DocxViewer sessionId={sessionId} file={file} />;
}

// Fetch a session file's raw bytes as an ArrayBuffer (same auth-via-query URL the
// image previews and fetchSessionFileText use).
async function fetchBytes(sessionId: string, path: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(sessionFileUrl(sessionId, path), { signal });
  if (!res.ok) throw new Error(res.statusText);
  return res.arrayBuffer();
}

function DocxViewer({ sessionId, file }: { sessionId: string; file: FileEntry }) {
  const [status, setStatus] = useState<Status>("loading");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setStatus("loading");
    (async () => {
      try {
        const [buffer, { renderAsync }] = await Promise.all([
          fetchBytes(sessionId, file.path, ctrl.signal),
          import("docx-preview"),
        ]);
        if (ctrl.signal.aborted || !containerRef.current) return;
        containerRef.current.innerHTML = "";
        await renderAsync(buffer, containerRef.current, undefined, {
          inWrapper: true,
          ignoreLastRenderedPageBreak: true,
        });
        if (!ctrl.signal.aborted) setStatus("ready");
      } catch {
        if (!ctrl.signal.aborted) setStatus("error");
      }
    })();
    return () => ctrl.abort();
  }, [sessionId, file.path]);

  return (
    <div className="relative h-full overflow-auto bg-neutral-100 p-4 dark:bg-neutral-900">
      {status === "loading" && <Centered><Loader2 className="size-4 animate-spin" /> Loading document…</Centered>}
      {status === "error" && <Centered className="text-destructive">Failed to render document.</Centered>}
      {/* docx-preview injects its own page-styled DOM; keep it light-on-white for fidelity. */}
      <div ref={containerRef} className={cn("docx-host mx-auto", status !== "ready" && "hidden")} />
    </div>
  );
}

function XlsxViewer({ sessionId, file }: { sessionId: string; file: FileEntry }) {
  const [status, setStatus] = useState<Status>("loading");
  const [sheets, setSheets] = useState<{ name: string; html: string }[]>([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setStatus("loading");
    setActive(0);
    (async () => {
      try {
        const [buffer, XLSX] = await Promise.all([
          fetchBytes(sessionId, file.path, ctrl.signal),
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
      } catch {
        if (!ctrl.signal.aborted) setStatus("error");
      }
    })();
    return () => ctrl.abort();
  }, [sessionId, file.path]);

  const activeHtml = useMemo(() => sheets[active]?.html ?? "", [sheets, active]);

  if (status === "loading")
    return <Centered><Loader2 className="size-4 animate-spin" /> Loading spreadsheet…</Centered>;
  if (status === "error") return <Centered className="text-destructive">Failed to render spreadsheet.</Centered>;

  return (
    <div className="flex h-full flex-col">
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
      {/* SheetJS emits a static <table> (no scripts). Style it for borders + dark mode. */}
      <div
        className="xlsx-host min-h-0 flex-1 overflow-auto p-3 text-xs"
        dangerouslySetInnerHTML={{ __html: activeHtml }}
      />
    </div>
  );
}

function Centered({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex h-full items-center justify-center gap-2 p-4 text-sm text-muted-foreground", className)}>
      {children}
    </div>
  );
}
