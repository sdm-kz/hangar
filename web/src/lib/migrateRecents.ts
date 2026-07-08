import { api } from "./api";
import type { RecentSession } from "./recentSessions";

// One-time migration of pre-server "recent" presets/folders out of localStorage.
// Older builds stored these per-browser (keys below); move anything found into the shared
// server store, then drop the local copies so this runs at most once per browser.
const SESS_KEY = "claudeweb.recentSessions";
const FOLD_KEY = "claudeweb.recentFolders";

export async function migrateLegacyRecents(): Promise<void> {
  let rawSessions: unknown = [];
  let rawFolders: unknown = [];
  try { rawSessions = JSON.parse(localStorage.getItem(SESS_KEY) || "[]"); } catch { /* ignore */ }
  try { rawFolders = JSON.parse(localStorage.getItem(FOLD_KEY) || "[]"); } catch { /* ignore */ }

  const folders = Array.isArray(rawFolders)
    ? rawFolders.filter((x): x is string => typeof x === "string")
    : [];
  const sessions = Array.isArray(rawSessions)
    ? rawSessions.filter((x) => x && typeof x.workingDirectory === "string")
    : [];

  if (folders.length === 0 && sessions.length === 0) {
    // Nothing to migrate — clear the keys anyway so we never re-check on future loads.
    localStorage.removeItem(SESS_KEY);
    localStorage.removeItem(FOLD_KEY);
    return;
  }

  // Push oldest-first so the newest entry ends up at the front of the server list.
  for (const p of [...folders].reverse()) {
    await api.addRecentFolder(p).catch(() => {});
  }
  for (const x of [...sessions].reverse()) {
    const r: RecentSession = {
      workingDirectory: x.workingDirectory,
      name: typeof x.name === "string" ? x.name : "",
      command: typeof x.command === "string" ? x.command : "",
      model: typeof x.model === "string" ? x.model : "",
      remoteControl: x.remoteControl !== false,
      // Legacy presets used a boolean autoAccept that meant acceptEdits.
      permissionMode:
        typeof x.permissionMode === "string"
          ? x.permissionMode
          : x.autoAccept === true
            ? "acceptEdits"
            : "default",
    };
    await api.addRecentSession(r).catch(() => {});
  }

  localStorage.removeItem(SESS_KEY);
  localStorage.removeItem(FOLD_KEY);
}
