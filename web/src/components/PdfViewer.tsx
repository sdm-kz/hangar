import { Download, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Read-only inline viewer for PDFs. The server already serves them as `application/pdf`, so the
 * browser's own viewer does the work — no parsing, no size cap, and the bytes stream instead of
 * being buffered (unlike the docx/xlsx OfficeViewer). Like that viewer, the source is just a URL, so
 * this serves both the per-session browser and the server-wide Files panel.
 *
 * `<object>` rather than `<iframe>` for the built-in fallback: a browser with no PDF support renders
 * the children instead, which is where mobile browsers that refuse to embed PDFs end up.
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
  return (
    <object data={url} type="application/pdf" title={name} className="h-full w-full">
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground">
          This browser can't show PDFs inline.
        </p>
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm">
            <a href={url} target="_blank" rel="noreferrer">
              <ExternalLink className="size-4" /> Open
            </a>
          </Button>
          <Button asChild size="sm">
            <a href={downloadUrl} download={name}>
              <Download className="size-4" /> Download
            </a>
          </Button>
        </div>
      </div>
    </object>
  );
}
