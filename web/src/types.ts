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
  color: string | null; // color name set via /color in the terminal; shown in the sessions list
  resumeExact: boolean; // Restorable: reopen can --resume the exact conversation (vs --continue fallback)
  postponedCount: number; // number of "postponed" messages stashed for this session (0 = none)
  claudeSessionId: string | null; // Restorable: the conversation id behind resumeExact; null when live
  canFork: boolean; // its conversation id is known, so it can be forked (false for the first seconds)
  parentSessionId: string | null; // the session this one was forked from; null for an ordinary session
  parentName: string | null; // the parent's name at fork time — shown even once the parent is gone
}

export interface CreateSessionRequest {
  workingDirectory: string;
  name?: string | null;
  remoteControl: boolean;
  model?: string | null;
  initialPrompt?: string | null;
  permissionMode?: string | null;
  watchdogEnabled?: boolean; // opt into the hang watchdog (auto-continue on API errors); off by default
  continue?: boolean; // resume the folder's most recent conversation (claude --continue) instead of starting fresh
  resumeSessionId?: string | null; // resume this exact Claude conversation (claude --resume <id>); wins over `continue`
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

// General server-filesystem entries (absolute paths) for the sidebar Files panel.
export interface FsNode {
  name: string;
  path: string; // absolute path on the server machine
  isDir: boolean;
  size: number;
}

export interface FsListing {
  current: string | null; // the directory that was listed
  parent: string | null;
  drives: DirEntry[]; // drive roots, so the tree can start at the top
  entries: FsNode[];
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

export interface GitFileContent {
  isRepo: boolean;
  path: string;
  exists: boolean;
  content: string;
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

export interface GitRef {
  name: string;
  isCurrent: boolean;
  worktreePath: string | null; // set only when checked out in a different worktree
}

export interface GitRefs {
  isRepo: boolean;
  current: string | null;
  branches: GitRef[];
}

export interface GitWorktree {
  path: string; // absolute folder of the worktree
  branch: string | null;
  isCurrent: boolean; // the session's own working directory
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

/** Identity of one build of the app, written by scripts\build.ps1 as build.json next to the exe. */
export interface BuildStamp {
  buildId: string; // UTC build timestamp + short commit; two builds are the same iff this matches
  commit: string | null;
  branch: string | null;
  builtAtUtc: string | null;
}

/** The updater's view of itself: what's running, what's staged, and whether one is being installed. */
export interface UpdateStatus {
  enabled: boolean; // the updater is switched on server-side (Update:Enabled)
  available: boolean; // a build is staged and it isn't the one running
  current: BuildStamp | null; // null when the app wasn't built by scripts\build.ps1
  staged: BuildStamp | null;
  state: "Idle" | "Applying" | "Failed";
  error: string | null; // why the last apply attempt failed, when state is Failed
}
