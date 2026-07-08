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

export interface BrowseResult {
  current: string | null;
  parent: string | null;
  directories: DirEntry[];
  drives: DirEntry[];
}
