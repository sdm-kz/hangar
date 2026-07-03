const KEY = "claudeweb.recentFolders";
const MAX = 8;

export function getRecentFolders(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function addRecentFolder(path: string) {
  const p = path.trim();
  if (!p) return;
  const list = getRecentFolders().filter((x) => x.toLowerCase() !== p.toLowerCase());
  list.unshift(p);
  localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
}

export function removeRecentFolder(path: string) {
  const list = getRecentFolders().filter((x) => x.toLowerCase() !== path.toLowerCase());
  localStorage.setItem(KEY, JSON.stringify(list));
}

export function folderName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}
