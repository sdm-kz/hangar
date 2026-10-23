export type FileKind = "image" | "video" | "text" | "office" | "pdf" | "model" | "binary";

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);

// Video formats browsers can play inline via <video>. Checked before BINARY so these preview
// instead of showing a download prompt. Others (avi/mkv/wmv/flv) stay "binary".
const VIDEO = new Set(["mp4", "webm", "ogv", "m4v", "mov"]);

// Office documents we render inline (read-only) via docx-preview / SheetJS.
const OFFICE = new Set(["docx", "xlsx"]);

// 3D models we render inline (read-only) via three.js. Checked before the text fallback on purpose: an
// ASCII STL is text, but nobody wants to read its facet list.
const MODEL = new Set(["stl", "3mf"]);

// Known binary formats we never try to preview as text (they'd render as gibberish).
const BINARY = new Set([
  // executables / libraries / build artifacts
  "exe", "dll", "so", "dylib", "bin", "obj", "o", "a", "lib", "pdb", "class",
  "wasm", "node", "pyc", "pyo", "msi", "apk", "app", "dmg", "iso",
  // archives
  "zip", "tar", "gz", "tgz", "bz2", "xz", "rar", "7z", "jar", "war", "nupkg", "cab",
  // office / documents (docx + xlsx are the "office" kind and pdf is its own — all preview inline)
  "doc", "xls", "ppt", "pptx", "odt", "ods", "odp", "rtf",
  // media
  "mp3", "wav", "flac", "ogg", "m4a", "aac", "mp4", "avi", "mov", "mkv", "webm", "wmv", "flv",
  // fonts
  "ttf", "otf", "woff", "woff2", "eot",
  // design / data blobs
  "psd", "ai", "sketch", "fig", "db", "sqlite", "dat", "pack", "idx",
]);

// Parsing docx/xlsx in the browser is heavy; refuse anything past this before rendering.
export const MAX_OFFICE_PREVIEW = 15_000_000; // 15 MB

// Same for 3D models. Meshes run bigger than documents, and a few million triangles still orbit smoothly.
export const MAX_MODEL_PREVIEW = 150_000_000; // 150 MB

export function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

// Images render as images; known binary formats show a download prompt; everything else
// (including unknown/extensionless files) is treated as text and previewed inline. The
// size guard — not the file type — is what limits previews of large text files.
export function fileKind(name: string): FileKind {
  const ext = fileExt(name);
  if (ext && IMAGE.has(ext)) return "image";
  if (ext && VIDEO.has(ext)) return "video";
  if (ext && OFFICE.has(ext)) return "office";
  // PDFs render in the browser's own viewer (the server already serves them as application/pdf),
  // so there's nothing to parse and no size cap — unlike the docx/xlsx "office" kind.
  if (ext === "pdf") return "pdf";
  if (ext && MODEL.has(ext)) return "model";
  if (ext && BINARY.has(ext)) return "binary";
  return "text";
}

// Which inline Office renderer a file needs, or null if it isn't an Office document.
export function officeKind(name: string): "docx" | "xlsx" | null {
  const ext = fileExt(name);
  return ext === "docx" || ext === "xlsx" ? ext : null;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
