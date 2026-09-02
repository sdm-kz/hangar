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
  GitWorktree,
  Project,
  PtyOrphan,
  SessionInfo,
  UpdateStatus,
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
  // Forks a session: a new session in the same folder branching its conversation (--fork-session),
  // leaving the original untouched. A blank name falls back to "<parent> (fork)" server-side.
  forkSession(id: string, name: string): Promise<SessionInfo> {
    return request(`/api/sessions/${id}/fork`, { method: "POST", body: JSON.stringify({ name }) });
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
  /**
   * Pin/unpin a session. The server keys the pin by the session's conversation (so it outlives a
   * reopen) and answers nothing: the new state arrives on the next session-list push, which is also
   * what carries it to every other browser.
   */
  setPinned(id: string, pinned: boolean): Promise<void> {
    return request(`/api/sessions/${id}/pin`, {
      method: "POST",
      body: JSON.stringify({ pinned }),
    });
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

  // Sessions still running that the app no longer tracks — usually the result of a detach.
  listOrphans(): Promise<PtyOrphan[]> {
    return request("/api/pty/orphans");
  },

  // Ends them for real (each is a live claude process). No id = all of them.
  stopOrphans(sessionId?: string): Promise<{ stopped: number }> {
    return request("/api/pty/orphans/stop", {
      method: "POST",
      body: JSON.stringify({ sessionId: sessionId ?? null }),
    });
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
  fsDelete(path: string): Promise<void> {
    return request("/api/fs/delete", { method: "POST", body: JSON.stringify({ path }) });
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

  // ---- Postponed messages (server-backed per session, in .claudeweb/postponed/<id>.json) ----
  // Stored server-side so the pool survives a reload and is shared across devices. Returns the raw
  // parsed JSON (an array); the caller validates the shape.
  getPostponed(sessionId: string): Promise<unknown> {
    return request(`/api/sessions/${sessionId}/postponed`);
  },
  putPostponed(sessionId: string, body: string): Promise<void> {
    return request(`/api/sessions/${sessionId}/postponed`, { method: "PUT", body });
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

  // ---- Projects (named groupings of folders, server-backed like the recents above) ----
  // Every mutation answers with the whole list: linking a folder to one project also unlinks it from
  // another, so the response is the only thing that reliably describes the result.
  getProjects(): Promise<Project[]> {
    return request("/api/projects");
  },
  createProject(name: string, color?: string | null, folders?: string[]): Promise<Project[]> {
    return request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name, color: color ?? null, folders: folders ?? [] }),
    });
  },
  // Omit a field to leave it as it is; pass "" as the color to clear the accent.
  updateProject(id: string, patch: { name?: string; color?: string | null }): Promise<Project[]> {
    return request(`/api/projects/${id}`, { method: "POST", body: JSON.stringify(patch) });
  },
  deleteProject(id: string): Promise<Project[]> {
    return request(`/api/projects/${id}`, { method: "DELETE" });
  },
  addProjectFolder(id: string, path: string): Promise<Project[]> {
    return request(`/api/projects/${id}/folders`, { method: "POST", body: JSON.stringify({ path }) });
  },
  removeProjectFolder(id: string, path: string): Promise<Project[]> {
    return request(`/api/projects/${id}/folders/remove`, {
      method: "POST",
      body: JSON.stringify({ path }),
    });
  },

  // ---- In-app update (a build staged by scripts\stage-update.ps1) ----
  // Normally the status arrives on the /hub/events snapshot; this is the first read and the fallback
  // for when the stream is down.
  getUpdate(): Promise<UpdateStatus> {
    return request("/api/update");
  },
  /**
   * Install the staged build. The server answers, then stops itself and hands the install off to a
   * detached script — so this is the last thing this build says. Wait for the new one to answer
   * /api/update with the staged build id, then reload to pick up its assets.
   */
  applyUpdate(): Promise<UpdateStatus> {
    return request("/api/update/apply", { method: "POST" });
  },

  // ---- Web Push (background notifications) ----
  // The VAPID public key the browser needs to create a subscription (public, no auth required).
  pushConfig(): Promise<{ publicKey: string }> {
    return request("/api/push/config");
  },
  pushSubscribe(sub: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<void> {
    return request("/api/push/subscribe", { method: "POST", body: JSON.stringify(sub) });
  },
  pushUnsubscribe(endpoint: string): Promise<void> {
    return request("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint }) });
  },

  // ---- Folders linked to a session (server-backed, keyed by its working directory so they survive
  // a restart and a resumed session's new id). Each mutation returns the updated list. ----
  async linkedFolders(id: string): Promise<string[]> {
    const r = await request<{ folders: string[] }>(`/api/sessions/${id}/linked-folders`);
    return r.folders;
  },
  async linkFolder(id: string, path: string): Promise<string[]> {
    const r = await request<{ folders: string[] }>(`/api/sessions/${id}/linked-folders`, {
      method: "POST",
      body: JSON.stringify({ path }),
    });
    return r.folders;
  },
  async unlinkFolder(id: string, path: string): Promise<string[]> {
    const r = await request<{ folders: string[] }>(`/api/sessions/${id}/linked-folders/remove`, {
      method: "POST",
      body: JSON.stringify({ path }),
    });
    return r.folders;
  },

  // ---- Per-session files ----
  // Throughout, `dir` selects the root: omitted = the session's working dir, otherwise another
  // worktree of its repo (read-only) or one of its linked folders.
  listSessionFiles(id: string, path?: string, dir?: string): Promise<FileListing> {
    const q = new URLSearchParams();
    if (path) q.set("path", path);
    if (dir) q.set("dir", dir);
    const s = q.toString();
    return request(`/api/sessions/${id}/fs/list${s ? `?${s}` : ""}`);
  },
  async fetchSessionFileText(id: string, path: string, dir?: string): Promise<string> {
    const res = await fetch(sessionFileUrl(id, path, false, dir));
    if (!res.ok) throw new ApiError(res.status, res.statusText);
    return res.text();
  },
  // Git status/diff for the session's working dir, or another worktree of the same repo via `dir`.
  gitStatus(id: string, dir?: string): Promise<GitStatus> {
    const q = dir ? `?dir=${encodeURIComponent(dir)}` : "";
    return request(`/api/sessions/${id}/git/status${q}`);
  },
  gitDiff(id: string, path: string, dir?: string): Promise<GitDiff> {
    const q = dir ? `&dir=${encodeURIComponent(dir)}` : "";
    return request(`/api/sessions/${id}/git/diff?path=${encodeURIComponent(path)}${q}`);
  },
  gitWorktrees(id: string): Promise<GitWorktree[]> {
    return request(`/api/sessions/${id}/git/worktrees`);
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
  writeSessionFile(id: string, path: string, content: string, dir?: string): Promise<void> {
    return request(`/api/sessions/${id}/fs/write`, {
      method: "POST",
      body: JSON.stringify({ path, content, dir }),
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
  // Upload arbitrary files into a folder under the write root ("" = its root). Sent as multipart so
  // the browser sets the boundary; returns the paths written (de-duplicated server-side).
  async uploadSessionFiles(id: string, folder: string, files: File[], dir?: string): Promise<{ paths: string[] }> {
    const form = new FormData();
    form.append("path", folder);
    if (dir) form.append("dir", dir);
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
  // Create a folder (may be nested, e.g. "a/b/c") under the write root; returns its rel path.
  createSessionFolder(id: string, path: string, dir?: string): Promise<{ path: string }> {
    return request(`/api/sessions/${id}/fs/mkdir`, {
      method: "POST",
      body: JSON.stringify({ path, dir }),
    });
  },
  // Rename a file/folder within the write root (bare new name, same parent).
  renameSessionFile(id: string, path: string, newName: string, dir?: string): Promise<void> {
    return request(`/api/sessions/${id}/fs/rename`, {
      method: "POST",
      body: JSON.stringify({ path, newName, dir }),
    });
  },
  // Delete a file/folder (recursively) within the write root.
  deleteSessionFile(id: string, path: string, dir?: string): Promise<void> {
    return request(`/api/sessions/${id}/fs/delete`, {
      method: "POST",
      body: JSON.stringify({ path, dir }),
    });
  },
  searchSessionFiles(id: string, q: string, dir?: string): Promise<FileListing> {
    const d = dir ? `&dir=${encodeURIComponent(dir)}` : "";
    return request(`/api/sessions/${id}/fs/search?q=${encodeURIComponent(q)}${d}`);
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

/**
 * URL for a session file's raw bytes; token is passed in the query so it works in <img>/<a>.
 * `dir` reads the file from another root of the session — a worktree of the same repo, or one of
 * its linked folders — instead of the session's own working dir.
 */
export function sessionFileUrl(id: string, path: string, download = false, dir?: string): string {
  const token = getToken() ?? "";
  const params = new URLSearchParams({ path });
  if (download) params.set("download", "true");
  if (dir) params.set("dir", dir);
  if (token) params.set("access_token", token);
  return `/api/sessions/${id}/fs/raw?${params.toString()}`;
}

export { ApiError };
