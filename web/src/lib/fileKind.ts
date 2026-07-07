export type FileKind = "image" | "text" | "binary";

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);

// Known binary formats we never try to preview as text (they'd render as gibberish).
const BINARY = new Set([
  // executables / libraries / build artifacts
  "exe", "dll", "so", "dylib", "bin", "obj", "o", "a", "lib", "pdb", "class",
  "wasm", "node", "pyc", "pyo", "msi", "apk", "app", "dmg", "iso",
  // archives
  "zip", "tar", "gz", "tgz", "bz2", "xz", "rar", "7z", "jar", "war", "nupkg", "cab",
  // office / documents
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf",
  // media
  "mp3", "wav", "flac", "ogg", "m4a", "aac", "mp4", "avi", "mov", "mkv", "webm", "wmv", "flv",
  // fonts
  "ttf", "otf", "woff", "woff2", "eot",
  // design / data blobs
  "psd", "ai", "sketch", "fig", "db", "sqlite", "dat", "pack", "idx",
]);

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
  if (ext && BINARY.has(ext)) return "binary";
  return "text";
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
