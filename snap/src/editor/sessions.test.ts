import { describe, expect, it } from "vitest";
import type { SessionItem } from "@/lib/tauri";
import { ago, filterSessions, keepSelection, stepSelection } from "./sessions";

const item = (id: string, name: string, project: string | null, folder: string): SessionItem => ({
  id,
  name,
  folder,
  project,
  color: null,
  projectColor: null,
  busy: false,
  claudeSessionId: null,
  lastSent: null,
});

const items = [
  item("1", "Fix login", "Homeport", "claude-web"),
  item("2", "Invoices", "Finance", "invoices"),
  item("3", "Snap app", "Homeport", "feat-snap"),
];

describe("filterSessions", () => {
  it("matches every word across name, project and folder", () => {
    expect(filterSessions(items, "home snap").map((s) => s.id)).toEqual(["3"]);
    expect(filterSessions(items, "HOMEPORT").map((s) => s.id)).toEqual(["1", "3"]);
    expect(filterSessions(items, "  ")).toBe(items);
    expect(filterSessions(items, "nothing")).toEqual([]);
  });
});

describe("selection", () => {
  it("keeps a selection that survives a refresh, else takes the first", () => {
    expect(keepSelection(items, "2")).toBe("2");
    expect(keepSelection(items, "gone")).toBe("1");
    expect(keepSelection([], "2")).toBeNull();
  });
  it("steps and stops at the ends", () => {
    expect(stepSelection(items, "1", 1)).toBe("2");
    expect(stepSelection(items, "3", 1)).toBe("3");
    expect(stepSelection(items, "1", -1)).toBe("1");
    expect(stepSelection(items, null, 1)).toBe("1");
    expect(stepSelection([], "1", 1)).toBeNull();
  });
});

describe("ago", () => {
  it("reads in the largest sensible unit", () => {
    const now = 1_000_000_000;
    expect(ago(now - 10_000, now)).toBe("just now");
    expect(ago(now - 5 * 60_000, now)).toBe("5m ago");
    expect(ago(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(ago(now - 2 * 86_400_000, now)).toBe("2d ago");
  });
});
