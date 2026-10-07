import type { SessionItem } from "@/lib/tauri";

/** Sessions whose name, project or folder holds every word of `query`, in the order given. */
export function filterSessions(items: SessionItem[], query: string): SessionItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return items;
  return items.filter((s) => {
    const hay = `${s.name} ${s.project ?? ""} ${s.folder}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** The selection after the list changed: kept if still there, else the first (the most recent target). */
export function keepSelection(items: SessionItem[], selected: string | null): string | null {
  if (selected && items.some((s) => s.id === selected)) return selected;
  return items[0]?.id ?? null;
}

/** Move the selection `delta` rows, stopping at the ends. */
export function stepSelection(items: SessionItem[], selected: string | null, delta: number): string | null {
  if (items.length === 0) return null;
  const i = items.findIndex((s) => s.id === selected);
  const next = i < 0 ? 0 : Math.min(items.length - 1, Math.max(0, i + delta));
  return items[next].id;
}

/** "just now", "5m ago", "3h ago", "2d ago". */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
