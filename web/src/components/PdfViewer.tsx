import { useEffect, useState } from "react";
import { Download, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/lib/node";

/**
 * Read-only inline viewer for PDFs. The server already serves them as `application/pdf`, so the
 * browser's own viewer does the work — no parsing, no size cap, and the bytes stream instead of
 * being buffered (unlike the docx/xlsx OfficeViewer). Like that viewer, the source is just a URL, so
 * this serves both the per-session browser and the server-wide Files panel.
 *
 * `<object>` rather than `<iframe>` for the built-in fallback: a browser with no PDF support renders
 * the children instead, which is where mobile browsers that refuse to embed PDFs end up.
 *
 * A peer's PDF comes through this node's proxy in a sandbox (server NodeProxy.Confine), where the
 * browser won't show a PDF at all — and its URL carries this node's token, which the page it opens
 * must not have. So it is fetched and shown from a blob: same bytes, no token, no sandbox.
 */
export function PdfViewer({
  url,
  downloadUrl,
  name,
}: {
  url: string;
  /** URL that forces a download (Content-Disposition: attachment); used by the fallback. */
  downloadUrl: string;
  name: string;
}) {
  const src = usePdfSource(url);
  if (src === null)
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  const fallback = (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm text-muted-foreground">
        {src ? "This browser can't show PDFs inline." : "The PDF couldn't be loaded."}
      </p>
      <div className="flex gap-2">
        {src && (
          <Button asChild variant="outline" size="sm">
            <a href={src} target="_blank" rel="noreferrer">
              <ExternalLink className="size-4" /> Open
            </a>
          </Button>
        )}
        <Button asChild size="sm">
          <a href={downloadUrl} download={name}>
            <Download className="size-4" /> Download
          </a>
        </Button>
      </div>
    </div>
  );
  if (!src) return fallback;
  return (
    <object data={src} type="application/pdf" title={name} className="h-full w-full">
      {fallback}
    </object>
  );
}

/** `url` itself for this node's PDF; for a peer's, a blob of it once fetched — null until then, "" if it can't be. */
function usePdfSource(url: string): string | null {
  const api = useApi();
  const [blob, setBlob] = useState<{ url: string; src: string } | null>(null);
  useEffect(() => {
    if (!api.base) return;
    let gone = false;
    let made: string | undefined;
    fetch(url)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(r.statusText))))
      .then((b) => {
        if (gone) return;
        made = URL.createObjectURL(new Blob([b], { type: "application/pdf" }));
        setBlob({ url, src: made });
      })
      // Nothing to show it from: the download button still works.
      .catch(() => !gone && setBlob({ url, src: "" }));
    return () => {
      gone = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [api.base, url]);
  if (!api.base) return url;
  return blob?.url === url ? blob.src : null;
}
