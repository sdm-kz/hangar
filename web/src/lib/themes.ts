/**
 * The colour themes: the built-in ones, and how any theme — built-in, from the settings file, or made in
 * the Themes dialog — comes down to one set of colours.
 *
 * A theme is a base and the colours that differ from it. The built-ins are the roots: each is the
 * palette of a well-known editor theme, spelled out for the three places the app paints — the interface
 * (shadcn's tokens, as CSS custom properties), highlighted code (highlight.js classes) and the terminal
 * (xterm's 16 ANSI colours). A built-in may leave out what is plainly derived from the rest (the text on
 * a card is the text on the page); {@link resolveColors} fills those in after the overrides are laid on,
 * so tuning a theme's background moves the terminal's with it unless the terminal has one of its own.
 */

export type ThemeKind = "light" | "dark";

export type TokenGroup = "interface" | "syntax" | "terminal";

export interface ThemeToken {
  /** The CSS custom property without its dashes, and the key in a theme's colours. */
  id: string;
  label: string;
  group: TokenGroup;
}

const ui = (id: string, label: string): ThemeToken => ({ id, label, group: "interface" });
const syn = (id: string, label: string): ThemeToken => ({ id: `syntax-${id}`, label, group: "syntax" });
const term = (id: string, label: string): ThemeToken => ({ id: `terminal-${id}`, label, group: "terminal" });

export const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** Every colour a theme can set, in the order the Themes dialog lists them. */
export const THEME_TOKENS: readonly ThemeToken[] = [
  ui("background", "Background"),
  ui("foreground", "Text"),
  ui("card", "Card"),
  ui("card-foreground", "Card text"),
  ui("popover", "Menus"),
  ui("popover-foreground", "Menu text"),
  ui("primary", "Primary"),
  ui("primary-foreground", "On primary"),
  ui("secondary", "Secondary"),
  ui("secondary-foreground", "On secondary"),
  ui("muted", "Muted"),
  ui("muted-foreground", "Muted text"),
  ui("accent", "Highlight"),
  ui("accent-foreground", "Highlight text"),
  ui("destructive", "Destructive"),
  ui("border", "Border"),
  ui("popover-border", "Menu edge"),
  ui("input", "Field outline"),
  ui("ring", "Focus ring"),
  syn("comment", "Comment"),
  syn("keyword", "Keyword"),
  syn("string", "String"),
  syn("number", "Number"),
  syn("title", "Function"),
  syn("type", "Type"),
  syn("tag", "Tag"),
  term("background", "Background"),
  term("foreground", "Text"),
  term("cursor", "Cursor"),
  term("selection", "Selection"),
  ...ANSI.map((c) => term(c, cap(c))),
  ...ANSI.map((c) => term(`bright-${c}`, `Bright ${c}`)),
];

const TOKEN_IDS = new Set(THEME_TOKENS.map((t) => t.id));
export const isThemeToken = (id: string) => TOKEN_IDS.has(id);

export type ThemeColors = Record<string, string>;

export interface BuiltinTheme {
  id: string;
  name: string;
  kind: ThemeKind;
  colors: ThemeColors;
}

/** The 16 ANSI colours, normal then bright, as terminal-* tokens. */
function ansi(...colors: string[]): ThemeColors {
  const out: ThemeColors = {};
  ANSI.forEach((c, i) => {
    out[`terminal-${c}`] = colors[i];
    out[`terminal-bright-${c}`] = colors[i + 8];
  });
  return out;
}

function syntax(comment: string, keyword: string, string: string, number: string, title: string, type: string, tag: string): ThemeColors {
  return {
    "syntax-comment": comment,
    "syntax-keyword": keyword,
    "syntax-string": string,
    "syntax-number": number,
    "syntax-title": title,
    "syntax-type": type,
    "syntax-tag": tag,
  };
}

/**
 * The built-in themes, light and dark, most of them in pairs. Their light terminals map ANSI white to
 * a grey and bright white to the text colour, as Hangar Light always has: the stock values are near
 * white, and output that uses them vanishes on a light background.
 */
export const BUILTIN_THEMES: readonly BuiltinTheme[] = [
  {
    id: "light",
    name: "Hangar Light",
    kind: "light",
    colors: {
      background: "oklch(1 0 0)",
      foreground: "oklch(0.145 0 0)",
      card: "oklch(1 0 0)",
      primary: "oklch(0.205 0 0)",
      "primary-foreground": "oklch(0.985 0 0)",
      secondary: "oklch(0.97 0 0)",
      "secondary-foreground": "oklch(0.205 0 0)",
      muted: "oklch(0.97 0 0)",
      "muted-foreground": "oklch(0.556 0 0)",
      accent: "oklch(0.97 0 0)",
      "accent-foreground": "oklch(0.205 0 0)",
      destructive: "oklch(0.577 0.245 27.325)",
      border: "oklch(0.87 0 0)",
      "popover-border": "oklch(0.84 0 0)",
      input: "oklch(0.87 0 0)",
      ring: "oklch(0.708 0 0)",
      ...syntax("#6a737d", "#d73a49", "#032f62", "#005cc5", "#6f42c1", "#e36209", "#22863a"),
      "terminal-background": "#ffffff",
      "terminal-foreground": "#24292e",
      "terminal-selection": "#b3d7ff",
      ...ansi(
        "#24292e", "#d73a49", "#22863a", "#b08800", "#0366d6", "#6f42c1", "#1b7c83", "#6a737d",
        "#959da5", "#cb2431", "#28a745", "#dbab09", "#2188ff", "#8a63d2", "#3192aa", "#24292e",
      ),
    },
  },
  {
    id: "dark",
    name: "Hangar Dark",
    kind: "dark",
    colors: {
      background: "oklch(0.145 0 0)",
      foreground: "oklch(0.985 0 0)",
      card: "oklch(0.205 0 0)",
      primary: "oklch(0.922 0 0)",
      "primary-foreground": "oklch(0.205 0 0)",
      secondary: "oklch(0.269 0 0)",
      muted: "oklch(0.269 0 0)",
      "muted-foreground": "oklch(0.708 0 0)",
      accent: "oklch(0.269 0 0)",
      destructive: "oklch(0.704 0.191 22.216)",
      border: "oklch(1 0 0 / 10%)",
      "popover-border": "oklch(1 0 0 / 22%)",
      input: "oklch(1 0 0 / 15%)",
      ring: "oklch(0.556 0 0)",
      ...syntax("#8b949e", "#ff7b72", "#a5d6ff", "#79c0ff", "#d2a8ff", "#ffa657", "#7ee787"),
      "terminal-background": "#0a0a0a",
      "terminal-foreground": "#e4e4e7",
      "terminal-selection": "#3f3f46",
      // xterm's own defaults (the Tango palette), which this theme has always used.
      ...ansi(
        "#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
        "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec",
      ),
    },
  },
  {
    id: "github-light",
    name: "GitHub Light",
    kind: "light",
    colors: {
      background: "#ffffff",
      foreground: "#1f2328",
      card: "#ffffff",
      primary: "#0969da",
      "primary-foreground": "#ffffff",
      muted: "#f6f8fa",
      "muted-foreground": "#59636e",
      accent: "#eff2f5",
      destructive: "#cf222e",
      border: "#d1d9e0",
      "popover-border": "#c5ced7",
      ring: "#0969da",
      ...syntax("#59636e", "#cf222e", "#0a3069", "#0550ae", "#8250df", "#953800", "#116329"),
      "terminal-selection": "#b6e3ff",
      ...ansi(
        "#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781",
        "#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#1f2328",
      ),
    },
  },
  {
    id: "github-dark",
    name: "GitHub Dark",
    kind: "dark",
    colors: {
      background: "#0d1117",
      foreground: "#e6edf3",
      card: "#151b23",
      primary: "#4493f8",
      "primary-foreground": "#0d1117",
      muted: "#212830",
      "muted-foreground": "#9198a1",
      accent: "#262c36",
      destructive: "#f85149",
      border: "#30363d",
      "popover-border": "#3d444d",
      ring: "#4493f8",
      ...syntax("#9198a1", "#ff7b72", "#a5d6ff", "#79c0ff", "#d2a8ff", "#ffa657", "#7ee787"),
      "terminal-selection": "#264f78",
      ...ansi(
        "#484f58", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4",
        "#6e7681", "#ffa198", "#56d364", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#ffffff",
      ),
    },
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    kind: "light",
    colors: {
      background: "#fdf6e3",
      foreground: "#586e75",
      card: "#fdf6e3",
      primary: "#268bd2",
      "primary-foreground": "#fdf6e3",
      muted: "#eee8d5",
      "muted-foreground": "#839496",
      accent: "#eee8d5",
      destructive: "#dc322f",
      border: "#e4ddc8",
      "popover-border": "#d6cfb9",
      ring: "#268bd2",
      ...syntax("#93a1a1", "#859900", "#2aa198", "#d33682", "#268bd2", "#b58900", "#cb4b16"),
      "terminal-selection": "#eee8d5",
      ...ansi(
        "#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#93a1a1",
        "#657b83", "#cb4b16", "#859900", "#b58900", "#268bd2", "#6c71c4", "#2aa198", "#586e75",
      ),
    },
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    kind: "dark",
    colors: {
      background: "#002b36",
      foreground: "#93a1a1",
      card: "#073642",
      primary: "#268bd2",
      "primary-foreground": "#fdf6e3",
      muted: "#073642",
      "muted-foreground": "#839496",
      accent: "#0d4150",
      destructive: "#dc322f",
      border: "#0f4553",
      "popover-border": "#1d5664",
      ring: "#268bd2",
      ...syntax("#586e75", "#859900", "#2aa198", "#d33682", "#268bd2", "#b58900", "#cb4b16"),
      "terminal-selection": "#073642",
      ...ansi(
        "#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5",
        "#586e75", "#cb4b16", "#859900", "#b58900", "#268bd2", "#6c71c4", "#2aa198", "#fdf6e3",
      ),
    },
  },
  {
    id: "one-light",
    name: "One Light",
    kind: "light",
    colors: {
      background: "#fafafa",
      foreground: "#383a42",
      card: "#ffffff",
      primary: "#4078f2",
      "primary-foreground": "#ffffff",
      muted: "#f0f0f1",
      "muted-foreground": "#696c77",
      accent: "#e5e5e6",
      destructive: "#e45649",
      border: "#dbdbdc",
      "popover-border": "#cdcdcf",
      ring: "#4078f2",
      ...syntax("#a0a1a7", "#a626a4", "#50a14f", "#986801", "#4078f2", "#c18401", "#e45649"),
      "terminal-selection": "#e5e5e6",
      ...ansi(
        "#383a42", "#e45649", "#50a14f", "#c18401", "#0184bc", "#a626a4", "#0997b3", "#a0a1a7",
        "#4f525e", "#e06c75", "#98c379", "#d19a66", "#61afef", "#c678dd", "#56b6c2", "#383a42",
      ),
    },
  },
  {
    id: "one-dark",
    name: "One Dark",
    kind: "dark",
    colors: {
      background: "#282c34",
      foreground: "#abb2bf",
      card: "#21252b",
      primary: "#61afef",
      "primary-foreground": "#282c34",
      muted: "#2c313a",
      "muted-foreground": "#7f848e",
      accent: "#2c313a",
      destructive: "#e06c75",
      border: "#3a3f4b",
      "popover-border": "#4b5263",
      ring: "#61afef",
      ...syntax("#7f848e", "#c678dd", "#98c379", "#d19a66", "#61afef", "#e5c07b", "#e06c75"),
      "terminal-selection": "#3e4451",
      ...ansi(
        "#282c34", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#dcdfe4",
        "#5a6374", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#dcdfe4",
      ),
    },
  },
  {
    id: "catppuccin-latte",
    name: "Catppuccin Latte",
    kind: "light",
    colors: {
      background: "#eff1f5",
      foreground: "#4c4f69",
      card: "#eff1f5",
      primary: "#8839ef",
      "primary-foreground": "#eff1f5",
      muted: "#e6e9ef",
      "muted-foreground": "#6c6f85",
      accent: "#dce0e8",
      destructive: "#d20f39",
      border: "#ccd0da",
      "popover-border": "#bcc0cc",
      ring: "#7287fd",
      ...syntax("#7c7f93", "#8839ef", "#40a02b", "#fe640b", "#1e66f5", "#df8e1d", "#179299"),
      "terminal-selection": "#ccd0da",
      ...ansi(
        "#5c5f77", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#acb0be",
        "#6c6f85", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#4c4f69",
      ),
    },
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    kind: "dark",
    colors: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      card: "#181825",
      primary: "#cba6f7",
      "primary-foreground": "#11111b",
      muted: "#313244",
      "muted-foreground": "#a6adc8",
      accent: "#313244",
      destructive: "#f38ba8",
      border: "#313244",
      "popover-border": "#45475a",
      input: "#45475a",
      ring: "#b4befe",
      ...syntax("#9399b2", "#cba6f7", "#a6e3a1", "#fab387", "#89b4fa", "#f9e2af", "#89dceb"),
      "terminal-selection": "#585b70",
      ...ansi(
        "#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de",
        "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8",
      ),
    },
  },
  {
    id: "gruvbox-light",
    name: "Gruvbox Light",
    kind: "light",
    colors: {
      background: "#fbf1c7",
      foreground: "#3c3836",
      card: "#f9f5d7",
      primary: "#af3a03",
      "primary-foreground": "#fbf1c7",
      muted: "#f2e5bc",
      "muted-foreground": "#7c6f64",
      accent: "#ebdbb2",
      destructive: "#9d0006",
      border: "#d5c4a1",
      "popover-border": "#bdae93",
      ring: "#d65d0e",
      ...syntax("#928374", "#9d0006", "#79740e", "#8f3f71", "#427b58", "#b57614", "#076678"),
      "terminal-selection": "#ebdbb2",
      ...ansi(
        "#3c3836", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#7c6f64",
        "#928374", "#9d0006", "#79740e", "#b57614", "#076678", "#8f3f71", "#427b58", "#3c3836",
      ),
    },
  },
  {
    id: "gruvbox-dark",
    name: "Gruvbox Dark",
    kind: "dark",
    colors: {
      background: "#282828",
      foreground: "#ebdbb2",
      card: "#32302f",
      primary: "#fabd2f",
      "primary-foreground": "#282828",
      muted: "#3c3836",
      "muted-foreground": "#a89984",
      accent: "#3c3836",
      destructive: "#fb4934",
      border: "#45403d",
      "popover-border": "#504945",
      input: "#504945",
      ring: "#fabd2f",
      ...syntax("#928374", "#fb4934", "#b8bb26", "#d3869b", "#8ec07c", "#fabd2f", "#83a598"),
      "terminal-selection": "#504945",
      ...ansi(
        "#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984",
        "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2",
      ),
    },
  },
  {
    id: "rose-pine-dawn",
    name: "Rosé Pine Dawn",
    kind: "light",
    colors: {
      background: "#faf4ed",
      foreground: "#575279",
      card: "#fffaf3",
      primary: "#286983",
      "primary-foreground": "#faf4ed",
      muted: "#f2e9e1",
      "muted-foreground": "#797593",
      accent: "#f2e9e1",
      destructive: "#b4637a",
      border: "#dfdad9",
      "popover-border": "#cecacd",
      ring: "#907aa9",
      ...syntax("#9893a5", "#286983", "#ea9d34", "#907aa9", "#d7827e", "#56949f", "#b4637a"),
      "terminal-selection": "#dfdad9",
      ...ansi(
        "#575279", "#b4637a", "#286983", "#ea9d34", "#56949f", "#907aa9", "#d7827e", "#797593",
        "#9893a5", "#b4637a", "#286983", "#ea9d34", "#56949f", "#907aa9", "#d7827e", "#575279",
      ),
    },
  },
  {
    id: "rose-pine",
    name: "Rosé Pine",
    kind: "dark",
    colors: {
      background: "#191724",
      foreground: "#e0def4",
      card: "#1f1d2e",
      primary: "#ebbcba",
      "primary-foreground": "#191724",
      muted: "#26233a",
      "muted-foreground": "#908caa",
      accent: "#26233a",
      destructive: "#eb6f92",
      border: "#2f2c44",
      "popover-border": "#403d52",
      input: "#403d52",
      ring: "#c4a7e7",
      ...syntax("#6e6a86", "#31748f", "#f6c177", "#c4a7e7", "#ebbcba", "#9ccfd8", "#eb6f92"),
      "terminal-selection": "#403d52",
      ...ansi(
        "#26233a", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#e0def4",
        "#6e6a86", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#e0def4",
      ),
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    kind: "dark",
    colors: {
      background: "#282a36",
      foreground: "#f8f8f2",
      card: "#21222c",
      primary: "#bd93f9",
      "primary-foreground": "#282a36",
      muted: "#343746",
      "muted-foreground": "#a4abcf",
      accent: "#44475a",
      destructive: "#ff5555",
      border: "#3c3f51",
      "popover-border": "#4d5066",
      input: "#44475a",
      ring: "#bd93f9",
      ...syntax("#6272a4", "#ff79c6", "#f1fa8c", "#bd93f9", "#50fa7b", "#8be9fd", "#ff79c6"),
      "terminal-selection": "#44475a",
      ...ansi(
        "#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2",
        "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff",
      ),
    },
  },
  {
    id: "nord",
    name: "Nord",
    kind: "dark",
    colors: {
      background: "#2e3440",
      foreground: "#d8dee9",
      card: "#3b4252",
      primary: "#88c0d0",
      "primary-foreground": "#2e3440",
      muted: "#3b4252",
      "muted-foreground": "#a3acbd",
      accent: "#434c5e",
      destructive: "#bf616a",
      border: "#434c5e",
      "popover-border": "#4c566a",
      input: "#4c566a",
      ring: "#88c0d0",
      ...syntax("#7b88a1", "#81a1c1", "#a3be8c", "#b48ead", "#88c0d0", "#8fbcbb", "#81a1c1"),
      "terminal-selection": "#434c5e",
      ...ansi(
        "#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0",
        "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4",
      ),
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    kind: "dark",
    colors: {
      background: "#1a1b26",
      foreground: "#c0caf5",
      card: "#16161e",
      primary: "#7aa2f7",
      "primary-foreground": "#1a1b26",
      muted: "#24283b",
      "muted-foreground": "#8089b3",
      accent: "#292e42",
      destructive: "#f7768e",
      border: "#2a2e42",
      "popover-border": "#3b4261",
      input: "#3b4261",
      ring: "#7aa2f7",
      ...syntax("#5f6996", "#bb9af7", "#9ece6a", "#ff9e64", "#7aa2f7", "#2ac3de", "#f7768e"),
      "terminal-selection": "#33467c",
      ...ansi(
        "#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6",
        "#414868", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5",
      ),
    },
  },
];

const BUILTIN_BY_ID = new Map(BUILTIN_THEMES.map((t) => [t.id, t]));
export const builtinTheme = (id: string) => BUILTIN_BY_ID.get(id);

/** The colours a theme may leave out, and the one each falls back on — in an order that resolves in one pass. */
const DERIVED: readonly (readonly [string, string])[] = [
  ["card", "background"],
  ["card-foreground", "foreground"],
  ["popover", "card"],
  ["popover-foreground", "card-foreground"],
  ["secondary", "muted"],
  ["secondary-foreground", "foreground"],
  ["accent", "muted"],
  ["accent-foreground", "foreground"],
  ["input", "border"],
  ["popover-border", "border"],
  ["ring", "primary"],
  ["terminal-background", "background"],
  ["terminal-foreground", "foreground"],
  ["terminal-cursor", "terminal-foreground"],
  ["terminal-selection", "accent"],
];

/** Every token filled in, the derived ones from the rest. */
export function completeColors(colors: ThemeColors): ThemeColors {
  const out = { ...colors };
  for (const [token, from] of DERIVED) if (!out[token] && out[from]) out[token] = out[from];
  return out;
}

/** The value a token would have without the theme's own override of it — what "reset" goes back to. */
export function inheritedValue(base: ThemeColors, overrides: ThemeColors, token: string): string | undefined {
  const rest = { ...overrides };
  delete rest[token];
  return completeColors({ ...base, ...rest })[token];
}

/**
 * Whether the browser takes a value as a colour. The server has already held every value to a colour's
 * alphabet; this is the stricter check, and the one that matters, since a value lands in a style.
 */
export function isColor(value: string): boolean {
  try {
    return typeof CSS !== "undefined" && CSS.supports("color", value);
  } catch {
    return false;
  }
}

let probe: CanvasRenderingContext2D | null = null;

/**
 * Any CSS colour as #rrggbb, for an <input type="color"> — which takes nothing else. Painted onto a
 * pixel and read back, so oklch() and color-mix() come out as the browser itself would draw them.
 * Alpha is dropped: a colour picked from there on is opaque.
 */
export function toHex(value: string): string {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(value))
    return ("#" + value.slice(1).split("").map((c) => c + c).join("")).toLowerCase();
  try {
    probe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (!probe) return "#000000";
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = "#000";
    probe.fillStyle = value;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
    return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
  } catch {
    return "#000000";
  }
}
