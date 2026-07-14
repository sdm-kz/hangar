import type {
  BrowseResult,
  CreateSessionRequest,
  FileListing,
  FsListing,
  GitCommitDetail,
  GitDiff,
  GitFileContent,
  GitLog,
  GitRefs,
  GitStatus,
  SessionInfo,
} from "@/types";
import type { Recents, RecentSession } from "@/lib/recentSessions";

const TOKEN_KEY = "claudeweb.token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");

  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) {
    setToken(null);
    throw new ApiError(401, "unauthorized");
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      msg = body.error ?? msg;
    } catch { /* ignore */ }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204 || res.headers.get("content-length") === "0")
    return undefined as T;
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export const api = {
  async authConfig(): Promise<{ authRequired: boolean }> {
    return request("/api/auth/config");
  },
  async login(password: string): Promise<string> {
    const res = await request<{ token: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    setToken(res.token);
    return res.token;
  },
  async logout(): Promise<void> {
    try {
      await request("/api/auth/logout", { method: "POST" });
    } finally {
      setToken(null);
    }
  },
  listSessions(): Promise<SessionInfo[]> {
    return request("/api/sessions");
  },
  // Ids of sessions Claude is actively generating in; polled frequently to drive the "active" dot.
  sessionActivity(): Promise<string[]> {
    return request("/api/sessions/activity");
  },
  createSession(req: CreateSessionRequest): Promise<SessionInfo> {
    return request("/api/sessions", { method: "POST", body: JSON.stringify(req) });
  },
  // Reopens a Restorable session from a previous run (relaunches with --continue).
  restoreSession(id: string): Promise<SessionInfo> {
    return request(`/api/sessions/${id}/restore`, { method: "POST" });
  },
  // Stops the claude process and forgets the session.
  deleteSession(id: string): Promise<void> {
    return request(`/api/sessions/${id}`, { method: "DELETE" });
  },
  // Rename a session; the server also injects `/rename <name>` into a live terminal so Claude follows.
  renameSession(id: string, name: string): Promise<void> {
    return request(`/api/sessions/${id}/name`, { method: "POST", body: JSON.stringify({ name }) });
  },
  // Forgets the session but leaves its Remote Control process running.
  detachSession(id: string): Promise<void> {
    return request(`/api/sessions/${id}/detach`, { method: "POST" });
  },
  // Enable/disable the hang watchdog (auto-continue) for a session.
  setWatchdog(id: string, enabled: boolean): Promise<void> {
    return request(`/api/sessions/${id}/watchdog`, {
      method: "POST",
      body: JSON.stringify({ enabled }),
    });
  },
  // Manually send "continue" to a session and clear its watchdog give-up state.
  continueSession(id: string): Promise<void> {
    return request(`/api/sessions/${id}/continue`, { method: "POST" });
  },
  browse(path?: string): Promise<BrowseResult> {
    const q = path ? `?path=${encodeURIComponent(path)}` : "";
    return request(`/api/fs/browse${q}`);
  },

  // ---- General server-filesystem browsing (absolute paths) for the sidebar Files panel ----
  fsList(path?: string): Promise<FsListing> {
    const q = path ? `?path=${encodeURIComponent(path)}` : "";
    return request(`/api/fs/list${q}`);
  },
  async fetchServerFileText(path: string): Promise<string> {
    const res = await fetch(serverFileUrl(path));
    if (!res.ok) throw new ApiError(res.status, res.statusText);
    return res.text();
  },
  fsWrite(path: string, content: string): Promise<void> {
    return request("/api/fs/write", { method: "POST", body: JSON.stringify({ path, content }) });
  },
  fsMkdir(path: string): Promise<{ path: string }> {
    return request("/api/fs/mkdir", { method: "POST", body: JSON.stringify({ path }) });
  },
  fsNewFile(path: string): Promise<{ path: string }> {
    return request("/api/fs/new-file", { method: "POST", body: JSON.stringify({ path }) });
  },
  fsRename(path: string, newName: string): Promise<{ path: string }> {
    return request("/api/fs/rename", { method: "POST", body: JSON.stringify({ path, newName }) });
  },
  async fsUpload(folder: string, files: File[]): Promise<{ paths: string[] }> {
    const form = new FormData();
    form.append("path", folder);
    for (const f of files) form.append("files", f);
    const headers = new Headers();
    const token = getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const res = await fetch("/api/fs/upload", { method: "POST", body: form, headers });
    if (res.status === 401) {
      setToken(null);
      throw new ApiError(401, "unauthorized");
    }
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).error ?? msg; } catch { /* ignore */ }
      throw new ApiError(res.status, msg);
    }
    return res.json();
  },

  // ---- Recent launch presets & folders (server-backed, shared across devices) ----
  // Each mutation returns the full updated set so the caller can setState from the response.
  getRecents(): Promise<Recents> {
    return request("/api/recents");
  },
  addRecentSession(r: RecentSession): Promise<Recents> {
    return request("/api/recents/sessions", { method: "POST", body: JSON.stringify(r) });
  },
  removeRecentSession(r: RecentSession): Promise<Recents> {
    return request("/api/recents/sessions/remove", { method: "POST", body: JSON.stringify(r) });
  },
  // Persist a user-chosen ordering of the recent presets (drag-to-reorder in the sidebar).
  reorderRecentSessions(sessions: RecentSession[]): Promise<Recents> {
    return request("/api/recents/sessions/reorder", { method: "POST", body: JSON.stringify(sessions) });
  },
  addRecentFolder(path: string): Promise<Recents> {
    return request("/api/recents/folders", { method: "POST", body: JSON.stringify({ path }) });
  },
  removeRecentFolder(path: string): Promise<Recents> {
    return request("/api/recents/folders/remove", { method: "POST", body: JSON.stringify({ path }) });
  },

  // ---- Per-session files ----
  listSessionFiles(id: string, path?: string): Promise<FileListing> {
    const q = path ? `?path=${encodeURIComponent(path)}` : "";
    return request(`/api/sessions/${id}/fs/list${q}`);
  },
  async fetchSessionFileText(id: string, path: string): Promise<string> {
    const res = await fetch(sessionFileUrl(id, path));
    if (!res.ok) throw new ApiError(res.status, res.statusText);
    return res.text();
  },
  gitStatus(id: string): Promise<GitStatus> {
    return request(`/api/sessions/${id}/git/status`);
  },
  gitDiff(id: string, path: string): Promise<GitDiff> {
    return request(`/api/sessions/${id}/git/diff?path=${encodeURIComponent(path)}`);
  },
  // Commit history. scope: undefined/"HEAD" = the folder's current branch, "*" = all branches
  // (--all), or a branch name to view that specific branch (possibly living in another worktree).
  gitLog(id: string, skip = 0, count = 50, scope?: string): Promise<GitLog> {
    const q = new URLSearchParams({ skip: String(skip), count: String(count) });
    if (scope === "*") q.set("all", "true");
    else if (scope && scope !== "HEAD") q.set("ref", scope);
    return request(`/api/sessions/${id}/git/log?${q.toString()}`);
  },
  gitBranches(id: string): Promise<GitRefs> {
    return request(`/api/sessions/${id}/git/branches`);
  },
  gitCommit(id: string, hash: string): Promise<GitCommitDetail> {
    return request(`/api/sessions/${id}/git/commit?hash=${encodeURIComponent(hash)}`);
  },
  gitCommitDiff(id: string, hash: string, path: string): Promise<GitDiff> {
    return request(
      `/api/sessions/${id}/git/commit-diff?hash=${encodeURIComponent(hash)}&path=${encodeURIComponent(path)}`
    );
  },
  // Full content of a file as of a commit (for the "full" view in the commit preview).
  gitCommitFile(id: string, hash: string, path: string): Promise<GitFileContent> {
    return request(
      `/api/sessions/${id}/git/commit-file?hash=${encodeURIComponent(hash)}&path=${encodeURIComponent(path)}`
    );
  },
  writeSessionFile(id: string, path: string, content: string): Promise<void> {
    return request(`/api/sessions/${id}/fs/write`, {
      method: "POST",
      body: JSON.stringify({ path, content }),
    });
  },
  // Save a pasted image under .claudeweb/uploads/ in the working dir; returns its path so we can
  // hand it to the Claude session.
  uploadSessionImage(id: string, dataBase64: string, ext: string): Promise<{ path: string; fullPath: string }> {
    return request(`/api/sessions/${id}/fs/upload-image`, {
      method: "POST",
      body: JSON.stringify({ dataBase64, ext }),
    });
  },
  // Upload arbitrary files into a folder under the working dir ("" = root). Sent as multipart so
  // the browser sets the boundary; returns the paths written (de-duplicated server-side).
  async uploadSessionFiles(id: string, folder: string, files: File[]): Promise<{ paths: string[] }> {
    const form = new FormData();
    form.append("path", folder);
    for (const f of files) form.append("files", f);
    const headers = new Headers();
    const token = getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const res = await fetch(`/api/sessions/${id}/fs/upload`, { method: "POST", body: form, headers });
    if (res.status === 401) {
      setToken(null);
      throw new ApiError(401, "unauthorized");
    }
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).error ?? msg; } catch { /* ignore */ }
      throw new ApiError(res.status, msg);
    }
    return res.json();
  },
  // Create a folder (may be nested, e.g. "a/b/c") under the working dir; returns its rel path.
  createSessionFolder(id: string, path: string): Promise<{ path: string }> {
    return request(`/api/sessions/${id}/fs/mkdir`, {
      method: "POST",
      body: JSON.stringify({ path }),
    });
  },
  searchSessionFiles(id: string, q: string): Promise<FileListing> {
    return request(`/api/sessions/${id}/fs/search?q=${encodeURIComponent(q)}`);
  },
  async fsVersion(id: string): Promise<number> {
    const r = await request<{ version: number }>(`/api/sessions/${id}/fs/version`);
    return r.version;
  },
};

/**
 * WebSocket URL for the live session-list stream (`/hub/events`). Pushes `{ sessions, busy }`
 * whenever the server state changes, replacing the list + activity polls. The token rides in the
 * query string because a WS handshake can't set an Authorization header.
 */
export function sessionsStreamUrl(): string {
  const token = getToken() ?? "";
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const q = token ? `?access_token=${encodeURIComponent(token)}` : "";
  return `${proto}://${location.host}/hub/events${q}`;
}

/** URL for a general server file's raw bytes (absolute path); token in the query so it works in <img>/<a>. */
export function serverFileUrl(path: string, download = false): string {
  const token = getToken() ?? "";
  const params = new URLSearchParams({ path });
  if (download) params.set("download", "true");
  if (token) params.set("access_token", token);
  return `/api/fs/file?${params.toString()}`;
}

/** URL for a session file's raw bytes; token is passed in the query so it works in <img>/<a>. */
export function sessionFileUrl(id: string, path: string, download = false): string {
  const token = getToken() ?? "";
  const params = new URLSearchParams({ path });
  if (download) params.set("download", "true");
  if (token) params.set("access_token", token);
  return `/api/sessions/${id}/fs/raw?${params.toString()}`;
}

export { ApiError };
