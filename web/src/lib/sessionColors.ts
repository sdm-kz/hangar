// Maps a Claude session color name (set via `/color <name>` typed in the terminal) to a concrete CSS
// color, used for the accent stripe shown in the sessions list. Mid-tone, saturated hues that stay
// legible on both the light and dark sidebar. An unknown/unset name yields null (no accent).
const PALETTE: Record<string, string> = {
  red: "#ef4444",
  orange: "#f97316",
  amber: "#f59e0b",
  yellow: "#eab308",
  lime: "#84cc16",
  green: "#22c55e",
  emerald: "#10b981",
  teal: "#14b8a6",
  cyan: "#06b6d4",
  sky: "#0ea5e9",
  blue: "#3b82f6",
  indigo: "#6366f1",
  violet: "#8b5cf6",
  purple: "#a855f7",
  magenta: "#d946ef",
  pink: "#ec4899",
  rose: "#f43f5e",
  gray: "#6b7280",
  grey: "#6b7280",
};

/** Resolve a session color name to a CSS color, or null when unset/unknown. */
export function sessionColor(name?: string | null): string | null {
  if (!name) return null;
  return PALETTE[name.toLowerCase()] ?? null;
}
