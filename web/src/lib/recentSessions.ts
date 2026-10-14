import type { SessionInfo } from "@/types";
import { folderName } from "./recentFolders";

/** A reusable session preset: everything needed to relaunch the same session. */
export interface RecentSession {
  workingDirectory: string;
  name: string; // may be "" (defaults to folder name)
  command: string; // initial prompt, may be ""
  model: string; // "", "opus", "sonnet", "haiku"
  remoteControl: boolean;
  permissionMode: string; // default | auto | acceptEdits | bypassPermissions
  /**
   * Claude's own session id for the conversation this preset last launched, stamped in by the server
   * once a hook reports it. When set, "continue" resumes that exact conversation instead of whichever
   * one in the folder is most recent. Absent until the server has seen a hook for the launch.
   */
  claudeSessionId?: string | null;
  /** When the preset was last saved (ISO). Stamped by the server; absent on presets saved before. */
  lastUsedAt?: string | null;
}

/**
 * The remembered launch presets and folders. Persisted server-side (see the /api/recents
 * endpoints) so they follow the user across devices — they used to live in browser localStorage.
 */
export interface Recents {
  sessions: RecentSession[];
  folders: string[];
}

/**
 * Whether two presets are the same entry. Mirrors the server's dedupe signature (RecentsStore.Sig) —
 * everything that defines a launch, but not the conversation id the server stamps on afterwards.
 */
export function sameRecent(a: RecentSession, b: RecentSession): boolean {
  return (
    a.workingDirectory.toLowerCase() === b.workingDirectory.toLowerCase() &&
    a.name === b.name &&
    a.command === b.command &&
    a.model === b.model &&
    a.remoteControl === b.remoteControl &&
    a.permissionMode === b.permissionMode
  );
}

/**
 * A launch preset describing an existing session, for relaunching it through the New Session dialog.
 * The one-time initial prompt isn't recoverable from a session, so the command starts empty; the
 * conversation id rides along (Restorable entries carry one) so "continue" resumes that exact
 * conversation rather than the folder's most recent one.
 */
export function presetFromSession(s: SessionInfo): RecentSession {
  return {
    workingDirectory: s.workingDirectory,
    name: s.name,
    command: "",
    model: s.model ?? "",
    remoteControl: s.remoteControl,
    permissionMode: s.permissionMode || "auto",
    claudeSessionId: s.claudeSessionId,
  };
}

/** A short human label for a preset (custom name, else folder name). */
export function recentLabel(r: RecentSession): string {
  return r.name.trim() || folderName(r.workingDirectory);
}

/**
 * When a preset was last used, short enough for the end of a sidebar row: minutes, then hours for a day,
 * days within the week, then the date -- with the year once it is not this one. Empty when unknown.
 */
export function recentWhen(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = new Date(iso);
  const ms = now - t.getTime();
  if (Number.isNaN(ms)) return "";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  if (min < 24 * 60) return `${Math.floor(min / 60)}h`;
  if (min < 7 * 24 * 60) return `${Math.floor(min / (24 * 60))}d`;
  const sameYear = t.getFullYear() === new Date(now).getFullYear();
  return t.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", year: "numeric" });
}
