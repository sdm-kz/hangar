export type SessionState = "Running" | "Exited" | "Failed" | "Restorable";

export interface SessionInfo {
  id: string;
  name: string;
  workingDirectory: string;
  remoteControl: boolean;
  model: string | null;
  permissionMode: string | null; // default | auto | acceptEdits | bypassPermissions
  state: SessionState;
  processId: number;
  createdAt: string;
  remoteUrl: string | null; // claude.ai deep link to this session, once printed to its terminal
  watchdogEnabled: boolean; // whether the hang watchdog may auto-continue this session
  watchdogStatus: "healthy" | "recovering" | "attention"; // watchdog's view of the session
}

export interface CreateSessionRequest {
  workingDirectory: string;
  name?: string | null;
  remoteControl: boolean;
  model?: string | null;
  initialPrompt?: string | null;
  permissionMode?: string | null;
}

export interface DirEntry {
  name: string;
  path: string;
}

export interface FileEntry {
  name: string;
  path: string; // relative to the session working directory, forward slashes
  isDir: boolean;
  size: number;
}

export interface FileListing {
  path: string;
  entries: FileEntry[];
}

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  files: Record<string, string>; // relative path -> status letter (M/A/D/R/U)
}

export interface GitDiff {
  isRepo: boolean;
  path: string;
  status: string;
  diff: string;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string; // YYYY-MM-DD
  relativeDate: string; // e.g. "3 days ago"
  refs: string; // decorations pointing here, e.g. "HEAD -> main, origin/main, tag: v1" (usually empty)
}

export interface GitLog {
  isRepo: boolean;
  commits: GitCommit[];
  hasMore: boolean;
}

export interface GitCommitFile {
  path: string;
  status: string; // status letter (M/A/D/R)
}

export interface GitCommitDetail {
  isRepo: boolean;
  hash: string;
  shortHash: string;
  subject: string;
  body: string; // full commit message body (may be empty / multiline)
  author: string;
  authorEmail: string;
  date: string; // YYYY-MM-DD
  relativeDate: string;
  files: GitCommitFile[];
}

export interface BrowseResult {
  current: string | null;
  parent: string | null;
  directories: DirEntry[];
  drives: DirEntry[];
}
