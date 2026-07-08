/** The last path segment of a folder path (works with both `\` and `/` separators). */
export function folderName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}
