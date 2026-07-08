export type Theme = "light" | "dark";

const KEY = "claudeweb.theme";

export function getTheme(): Theme {
  return localStorage.getItem(KEY) === "dark" ? "dark" : "light";
}

const listeners = new Set<(theme: Theme) => void>();

/** Subscribe to theme changes (e.g. to re-theme the xterm terminal). Returns an unsubscribe fn. */
export function subscribeTheme(cb: (theme: Theme) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  localStorage.setItem(KEY, theme);
  listeners.forEach((cb) => cb(theme));
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  return next;
}
