export type FileKind = "image" | "text" | "binary";

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);

// Text/code extensions we render inline.
const TEXT = new Set([
  "txt", "md", "markdown", "log", "csv", "tsv", "diff", "patch",
  "json", "jsonc", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties",
  "html", "htm", "css", "scss", "sass", "less",
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "vue", "svelte", "astro",
  "py", "rb", "go", "rs", "java", "kt", "kts", "c", "h", "cpp", "cc", "hpp", "hh",
  "cs", "fs", "fsx", "php", "pl", "lua", "r", "sql", "graphql", "gql",
  "swift", "dart", "scala", "clj", "cljs", "ex", "exs", "erl", "hs", "ml", "jl",
  "sh", "bash", "zsh", "fish", "ps1", "psm1", "psd1", "bat", "cmd",
  "dockerfile", "makefile", "gradle", "tf", "proto", "gitignore", "gitattributes",
  "editorconfig", "csproj", "sln", "props", "targets", "nuspec", "config",
]);

// Extensionless files that are still text.
const TEXT_NAMES = new Set([
  "dockerfile", "makefile", "license", "readme", "changelog", "authors",
  "procfile", "gemfile", "rakefile", "notice", "copying",
]);

export function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function fileKind(name: string): FileKind {
  const ext = fileExt(name);
  if (ext && IMAGE.has(ext)) return "image";
  if (ext && TEXT.has(ext)) return "text";
  if (!ext && TEXT_NAMES.has(name.toLowerCase())) return "text";
  return "binary";
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
