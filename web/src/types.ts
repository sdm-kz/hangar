export type SessionState = "Running" | "Exited" | "Failed";

export interface SessionInfo {
  id: string;
  name: string;
  workingDirectory: string;
  remoteControl: boolean;
  model: string | null;
  autoAccept: boolean;
  state: SessionState;
  processId: number;
  createdAt: string;
}

export interface CreateSessionRequest {
  workingDirectory: string;
  name?: string | null;
  remoteControl: boolean;
  model?: string | null;
  initialPrompt?: string | null;
  autoAccept?: boolean;
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
