// Markdown files reference their images by a path relative to the document itself
// ("bench/slot-m1.png"). A preview renders inside the app's own page, so the browser would resolve
// those against the app's URL (https://host/bench/slot-m1.png) and get a 404 — the picture lives on
// the server's filesystem, next to the .md. Rewriting the src to the raw-file API, resolved against
// the document's own absolute path, is what makes those images show up.

import { serverFileUrl } from "@/lib/api";

/**
 * True for a src the browser can already fetch on its own: an absolute URL (http:, https:, data:,
 * blob:) or a protocol-relative one. The scheme needs two or more characters on purpose, so a
 * Windows drive letter ("G:\…") isn't mistaken for one.
 */
function isFetchable(src: string): boolean {
  return /^[a-z][a-z0-9+.-]+:/i.test(src) || src.startsWith("//");
}

/** The folder part of a file path, with either separator. */
function dirOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut >= 0 ? path.slice(0, cut) : "";
}

/** Append a relative path to a folder, flattening "." and ".." segments. Keeps the root ("G:", ""). */
function joinPath(dir: string, rel: string): string {
  const segments = dir.split(/[/\\]+/);
  for (const segment of rel.split(/[/\\]+/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 1) segments.pop();
      continue;
    }
    segments.push(segment);
  }
  // Mixed separators are fine for the server on Windows, and "/" keeps the URL readable.
  return segments.join("/");
}

/**
 * The file-API URL for an image referenced from the markdown document at `docPath` (an absolute
 * path on the server), or null when the src already points somewhere the browser can fetch and
 * should be left alone.
 */
export function mdAssetUrl(
  src: string,
  docPath: string,
  toUrl: (path: string) => string = serverFileUrl
): string | null {
  if (!src || src.startsWith("#") || isFetchable(src)) return null;
  let path = src;
  try {
    path = decodeURI(src); // "%20" in a link is a space in the file name
  } catch {
    /* malformed escape — take the src as written */
  }
  const isAbsolute = /^[a-zA-Z]:[\\/]/.test(path) || /^[/\\]/.test(path);
  return toUrl(isAbsolute ? path : joinPath(dirOf(docPath), path));
}
