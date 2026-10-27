import { invoke } from "@tauri-apps/api/core";
import { packImages } from "./pack";

export type Mode = "region" | "window" | "fullscreen" | "freeform";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowBox {
  title: string;
  app: string;
  rect: Rect;
}

/** A window or a part of one (a button, a paragraph, a panel), in frame pixels. */
export interface ElementBox {
  rect: Rect;
  label: string;
}

export interface OverlayInit {
  generation: number;
  mode: Mode;
  width: number;
  height: number;
  windows: WindowBox[];
}

export type Selection =
  | { kind: "rect"; rect: Rect }
  | { kind: "freeform"; points: [number, number][] }
  | { kind: "full" };

export interface EditorInit {
  width: number;
  height: number;
  scale: number;
}

/** A capture added to an editor through its "Add a capture". */
export interface CaptureAdded {
  editor: string;
  id: string;
}

export interface SessionItem {
  /** Tells the row apart: the id, after the node's for a paired machine's session. */
  key: string;
  id: string;
  /** The paired machine it runs on, reached through the server; null for the server's own. */
  node: string | null;
  nodeName: string | null;
  name: string;
  folder: string;
  color: string | null;
  project: string | null;
  projectColor: string | null;
  busy: boolean;
  claudeSessionId: string | null;
  lastSent: number | null;
}

/** A project, as the new-session form offers it. */
export interface ProjectChoice {
  id: string;
  name: string;
  color: string | null;
  folders: string[];
  groups: { id: string; name: string }[];
}

export interface NewSessionOptions {
  projects: ProjectChoice[];
  recentFolders: string[];
  /** The server is on this machine, so a folder can be browsed for here. */
  local: boolean;
}

/** Where a new session runs and is filed. */
export interface NewSessionTarget {
  folder: string;
  projectId: string | null;
  groupId: string | null;
}

export interface StartedSession {
  id: string;
  name: string;
  note: string | null;
}

export interface SessionsView {
  items: SessionItem[];
  server: string;
}

/** An error from the server side, as `api::ApiError` serializes it. */
export interface ApiError {
  kind: "unauthorized" | "notFound" | "unreachable" | "failed";
  message?: string;
}

export interface Hotkeys {
  region: string;
  window: string;
  fullscreen: string;
  freeform: string;
}

export interface SettingsView {
  serverUrl: string;
  signedIn: boolean;
  hotkeys: Hotkeys;
  hotkeyErrors: string[];
  autostart: boolean;
  platform: "windows" | "macos" | "linux" | string;
}

export interface ConnectionStatus {
  ok: boolean;
  local: boolean;
  authRequired: boolean;
  error: ApiError | null;
}

export function apiErrorText(e: unknown): string {
  if (typeof e === "string") return e;
  const err = e as Partial<ApiError> | null;
  if (err?.kind === "unauthorized") return "The server wants you to sign in.";
  return err?.message ?? String(e);
}

const isWindows = navigator.userAgent.includes("Windows");

/** A picture served by the app's `snap:` scheme (see `serve_picture`), as each platform's webview names it. */
export function pictureUrl(path: string): string {
  return isWindows ? `http://snap.localhost/${path}` : `snap://localhost/${path}`;
}

export const api = {
  overlayInit: (frame: number) => invoke<OverlayInit>("overlay_init", { frame }),
  overlayElements: (frame: number, x: number, y: number) =>
    invoke<ElementBox[]>("overlay_elements", { frame, x, y }),
  overlayReady: () => invoke<void>("overlay_ready"),
  overlayCommit: (frame: number, selection: Selection) => invoke<void>("overlay_commit", { frame, selection }),
  overlayCancel: () => invoke<void>("overlay_cancel"),

  editorInit: (id: string) => invoke<EditorInit>("editor_init", { id }),
  capturePng: (id: string) => invoke<ArrayBuffer>("capture_png", { id }),
  editorReady: () => invoke<void>("editor_ready"),
  listSessions: () => invoke<SessionsView>("list_sessions"),
  /** Send the captures, in order, with one message into the session's prompt, or with `postpone` into
   *  its postponed messages. */
  sendCapture: (pngs: Uint8Array[], session: SessionItem, text: string, postpone = false) =>
    invoke<void>("send_capture", packImages(pngs), {
      headers: {
        "x-session-id": encodeURIComponent(session.id),
        "x-node": encodeURIComponent(session.node ?? ""),
        "x-claude-session-id": encodeURIComponent(session.claudeSessionId ?? ""),
        "x-text": encodeURIComponent(text),
        "x-postpone": postpone ? "1" : "0",
      },
    }),
  newSessionOptions: () => invoke<NewSessionOptions>("new_session_options"),
  pickFolder: (start?: string) => invoke<string | null>("pick_folder", { start: start || null }),
  /** Start a session in `target.folder`, its first prompt the message with the captures. */
  startSession: (pngs: Uint8Array[], target: NewSessionTarget, text: string) =>
    invoke<StartedSession>("start_session", packImages(pngs), {
      headers: {
        "x-folder": encodeURIComponent(target.folder.trim()),
        "x-project-id": encodeURIComponent(target.projectId ?? ""),
        "x-group-id": encodeURIComponent(target.groupId ?? ""),
        "x-text": encodeURIComponent(text),
      },
    }),
  copyImage: (png: Uint8Array) => invoke<void>("copy_image", png),
  saveImage: (png: Uint8Array) => invoke<string | null>("save_image", png),
  openHangar: (sessionId?: string) => invoke<void>("open_hangar", { sessionId: sessionId ?? null }),

  getSettings: () => invoke<SettingsView>("get_settings"),
  saveSettings: (input: { serverUrl: string; hotkeys: Hotkeys; autostart: boolean }) =>
    invoke<SettingsView>("save_settings", { input }),
  connectionStatus: () => invoke<ConnectionStatus>("connection_status"),
  signIn: (password: string) => invoke<void>("sign_in", { password }),
  signOut: () => invoke<void>("sign_out"),
  startCapture: (mode: Mode) => invoke<void>("start_capture_cmd", { mode }),
  /** Take another capture for this editor: it hides meanwhile, and hears `capture-added`. */
  addCapture: (mode: Mode) => invoke<void>("add_capture", { mode }),
  /** Let go of a capture this editor no longer holds. */
  dropCapture: (id: string) => invoke<void>("drop_capture", { id }),
  suspendHotkeys: (suspended: boolean) => invoke<void>("suspend_hotkeys", { suspended }),
  openSettings: () => invoke<void>("open_settings"),
};
