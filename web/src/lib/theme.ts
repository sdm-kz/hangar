import type { ITheme } from "@xterm/xterm";
import {
  ANSI,
  BUILTIN_THEMES,
  THEME_TOKENS,
  builtinTheme,
  completeColors,
  isColor,
  type ThemeColors,
  type ThemeKind,
} from "@/lib/themes";

/** Light or dark: what the rest of the app keys on (Tailwind's `dark:`, Mermaid, the 3D grid). */
export type Theme = ThemeKind;

/** What the browser follows: one of the two, or the system's own setting. */
export type ThemeMode = Theme | "system";

/** A theme beyond the built-ins, as the server sends it (see the server's ThemeStore). */
export interface UiTheme {
  id: string;
  /** Null = the base's name: a settings-file theme that only tunes a built-in. */
  name: string | null;
  /** Null = the built-in of the same id. */
  base: string | null;
  colors: ThemeColors;
}

export interface UiThemesState {
  /** The settings file's defaults for a browser that has not picked a theme; "" = the built-in pair. */
  lightTheme: string;
  darkTheme: string;
  /** From the settings file (Ui:Themes): read-only here, and copied to be changed. */
  configured: UiTheme[];
  /** Made in the Themes dialog, kept on the server. */
  custom: UiTheme[];
}

/** One row of the theme picker. */
export interface ThemeEntry {
  id: string;
  name: string;
  kind: Theme;
  /** Where it comes from: built in (perhaps tuned by the settings file), the settings file, or the dialog. */
  source: "builtin" | "config" | "custom";
  /** A built-in the settings file changes some colours of. */
  tuned: boolean;
  /** Every colour, filled in — enough to draw a swatch of it. */
  colors: ThemeColors;
}

// The mode keeps the key the plain light/dark switch always used, so a browser's old choice still holds.
const MODE_KEY = "hangar.theme";
const CHOICE_KEY = (kind: Theme) => `hangar.theme.${kind}`;
// What index.html paints before the app loads: both kinds' colours, resolved, so the first paint never
// waits on this bundle (or the server) to put the right background up.
const VARS_KEY = "hangar.theme.vars";
// The server's themes as last seen, so a theme made in the dialog resolves before they are fetched again.
const LIBRARY_KEY = "hangar.theme.library";

const EMPTY: UiThemesState = { lightTheme: "", darkTheme: "", configured: [], custom: [] };

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode, or full: the theme still applies, it just isn't remembered */
  }
}

function readLibrary(): UiThemesState {
  try {
    const parsed = JSON.parse(read(LIBRARY_KEY) ?? "null") as UiThemesState | null;
    if (parsed && Array.isArray(parsed.configured) && Array.isArray(parsed.custom)) return parsed;
  } catch {
    /* a bad cache is as good as none */
  }
  return EMPTY;
}

let library: UiThemesState = readLibrary();
let current: ThemeColors = {};
let version = 0;

const listeners = new Set<(theme: Theme) => void>();
const changeListeners = new Set<() => void>();

const systemDark = () => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

export function getThemeMode(): ThemeMode {
  const m = read(MODE_KEY);
  return m === "dark" || m === "system" ? m : "light";
}

/** The kind showing now. */
export function getTheme(): Theme {
  const mode = getThemeMode();
  return mode === "system" ? (systemDark() ? "dark" : "light") : mode;
}

/** The theme's own entry among the server's, if it has one: the dialog's before the settings file's. */
const overlayOf = (id: string) =>
  library.custom.find((t) => t.id === id) ?? library.configured.find((t) => t.id === id);

function validColors(colors: ThemeColors | undefined): ThemeColors {
  const out: ThemeColors = {};
  for (const [k, v] of Object.entries(colors ?? {})) if (typeof v === "string" && isColor(v)) out[k] = v;
  return out;
}

interface Resolved {
  kind: Theme;
  name: string;
  /** As given, the derived colours not yet filled in. */
  colors: ThemeColors;
}

/**
 * A theme followed down its bases to a built-in. A base that isn't there is drawn as Hangar Light
 * rather than not at all, and a loop of bases is cut off the same way. `builtinOnly` is how a settings
 * entry that tunes a built-in reaches the built-in under it, which shares its id.
 */
function resolve(id: string, depth = 0, builtinOnly = false): Resolved | null {
  const overlay = builtinOnly ? undefined : overlayOf(id);
  if (overlay && depth < 8) {
    const base = resolveBase(overlay, depth);
    return { kind: base.kind, name: overlay.name ?? base.name, colors: { ...base.colors, ...validColors(overlay.colors) } };
  }
  const builtin = builtinTheme(id);
  return builtin ? { kind: builtin.kind, name: builtin.name, colors: builtin.colors } : null;
}

function resolveBase(overlay: UiTheme, depth: number): Resolved {
  const baseId = overlay.base ?? (builtinTheme(overlay.id) ? overlay.id : "light");
  return resolve(baseId, depth + 1, baseId === overlay.id) ?? resolve("light", 0, true)!;
}

/** Every colour of a theme, filled in; null when there is no such theme. */
export function themeColors(id: string): ThemeColors | null {
  const r = resolve(id);
  return r ? completeColors(r.colors) : null;
}

/** The colours a theme starts from before its own — what one of its colours resets to. */
export function themeBaseColors(id: string): ThemeColors {
  const overlay = overlayOf(id);
  return overlay ? resolveBase(overlay, 0).colors : {};
}

export function themeKind(id: string): Theme | null {
  return resolve(id)?.kind ?? null;
}

/** Every theme there is: the built-ins, then the settings file's, then the dialog's. */
export function listThemes(): ThemeEntry[] {
  const entry = (id: string, source: ThemeEntry["source"], tuned = false): ThemeEntry | null => {
    const r = resolve(id);
    return r ? { id, name: r.name, kind: r.kind, source, tuned, colors: completeColors(r.colors) } : null;
  };
  return [
    ...BUILTIN_THEMES.map((t) => entry(t.id, "builtin", library.configured.some((c) => c.id === t.id))),
    ...library.configured.filter((t) => !builtinTheme(t.id)).map((t) => entry(t.id, "config")),
    ...library.custom.map((t) => entry(t.id, "custom")),
  ].filter((e): e is ThemeEntry => e !== null);
}

export function getThemeLibrary(): UiThemesState {
  return library;
}

/** The theme this browser shows in light or dark mode: its own pick, else the settings file's, else the built-in. */
export function getThemeChoice(kind: Theme): string {
  const picked = read(CHOICE_KEY(kind));
  if (picked && themeKind(picked) === kind) return picked;
  const configured = kind === "light" ? library.lightTheme : library.darkTheme;
  if (configured && themeKind(configured) === kind) return configured;
  return kind;
}

const camel = (s: string) => s.replace(/-([a-z])/g, (_m, ch: string) => ch.toUpperCase());

/** The showing theme's terminal colours, as xterm takes them. */
export function getTerminalTheme(): ITheme {
  const c = current;
  const theme: Record<string, string | undefined> = {
    background: c["terminal-background"],
    foreground: c["terminal-foreground"],
    cursor: c["terminal-cursor"],
    cursorAccent: c["terminal-background"],
    selectionBackground: c["terminal-selection"],
  };
  for (const name of ANSI) {
    theme[name] = c[`terminal-${name}`];
    theme[camel(`bright-${name}`)] = c[`terminal-bright-${name}`];
  }
  return theme as ITheme;
}

/**
 * The CSS custom properties a theme sets on the page: every token but the terminal's, which xterm takes
 * as an object — bar its background, which the padding around the terminal is painted with too.
 */
function cssVars(colors: ThemeColors): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const token of THEME_TOKENS) {
    const v = colors[token.id];
    if (v && (token.group !== "terminal" || token.id === "terminal-background")) vars[`--${token.id}`] = v;
  }
  return vars;
}

/** Paint the theme the mode and the picks call for, and tell everyone who draws in colour. */
function apply() {
  const kind = getTheme();
  const colors = themeColors(getThemeChoice(kind)) ?? themeColors(kind)!;
  current = colors;

  const root = document.documentElement;
  root.classList.toggle("dark", kind === "dark");
  const vars = cssVars(colors);
  for (const token of THEME_TOKENS) {
    const name = `--${token.id}`;
    if (vars[name]) root.style.setProperty(name, vars[name]);
    else root.style.removeProperty(name);
  }

  // Both kinds, so a browser on "system" paints the right one even when the system flipped overnight.
  const other: Theme = kind === "dark" ? "light" : "dark";
  const otherColors = themeColors(getThemeChoice(other)) ?? themeColors(other)!;
  write(VARS_KEY, JSON.stringify({ [kind]: vars, [other]: cssVars(otherColors) }));

  version++;
  listeners.forEach((cb) => cb(kind));
  changeListeners.forEach((cb) => cb());
}

/** Subscribe to theme changes (e.g. to re-theme the xterm terminal). Returns an unsubscribe fn. */
export function subscribeTheme(cb: (theme: Theme) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** For useSyncExternalStore: anything about the themes changed — a pick, the mode, a colour, the list. */
export function subscribeThemeChanges(cb: () => void): () => void {
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}

export function getThemeVersion(): number {
  return version;
}

export function setThemeMode(mode: ThemeMode) {
  write(MODE_KEY, mode);
  apply();
}

/** Pick the theme for light or dark mode — and show it, unless the system is choosing which kind shows. */
export function setThemeChoice(kind: Theme, id: string) {
  write(CHOICE_KEY(kind), id);
  if (getThemeMode() !== "system") write(MODE_KEY, kind);
  apply();
}

/** Flip between the two kinds. From "system" it goes to the other of whichever is showing. */
export function toggleTheme(): Theme {
  const next: Theme = getTheme() === "dark" ? "light" : "dark";
  setThemeMode(next);
  return next;
}

/** Take the server's themes (on sign-in, and after every change), and repaint with them. */
export function setThemeLibrary(state: UiThemesState) {
  library = {
    lightTheme: state.lightTheme ?? "",
    darkTheme: state.darkTheme ?? "",
    configured: state.configured ?? [],
    custom: state.custom ?? [],
  };
  write(LIBRARY_KEY, JSON.stringify(library));
  apply();
}

/** Change a custom theme's colours here and now, ahead of the server's answer — the dialog's live edit. */
export function previewCustomColors(id: string, colors: ThemeColors) {
  library = { ...library, custom: library.custom.map((t) => (t.id === id ? { ...t, colors } : t)) };
  apply();
}

// index.html has already painted the page from the cache; this is the same done properly, and kept up
// with the system's setting from here on.
apply();
if (typeof matchMedia === "function")
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (getThemeMode() === "system") apply();
  });
