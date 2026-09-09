import { useEffect, useState } from "react";
import { Globe } from "lucide-react";

/**
 * A linked page's favicon, degrading to a plain globe.
 *
 * The image is loaded by the browser straight from the site, so it fails for all the ordinary
 * reasons — the site has no icon, the guessed /favicon.ico is a 404, the machine is offline — and a
 * broken-image glyph in a tab is worse than no icon at all. Shared by the tab strip, the frame's
 * toolbar and the add dialog so those three always show the same thing.
 */
export function LinkIcon({ src, className }: { src?: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  // A new URL deserves its own attempt; without this, one failure would stick to the element.
  useEffect(() => setFailed(false), [src]);

  if (!src || failed) return <Globe className={className} />;
  return <img src={src} alt="" onError={() => setFailed(true)} className={className} />;
}
