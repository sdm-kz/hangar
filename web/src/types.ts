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
  // The session this one was put under by hand, by dragging its row onto another. An arrangement of
  // the list and nothing about the conversation, which is why it is not parentSessionId; null leaves
  // the row where forking left it. What the tree is actually built from — see lib/sessionTree.ts.
  nestedUnderId: string | null;
  adopted: boolean; // the app re-attached to this session at startup instead of launching it
  // Pinned to the top of its folder. Server-side and keyed by conversation id, so a pin survives a
  // reopen (which mints a new session id) and is the same in every browser.
  pinned: boolean;
  // Revision of this session's server-side UI state (open file tabs, view mode, tree state). Only the
  // number rides the list; a browser holding an older one re-fetches the bag. See lib/sessionUi.ts.
  uiRev: number;
  // The virtual folder this session was filed into, or null. Server-side and keyed by conversation
  // id like the pin above, so it survives a reopen. It only applies inside the project that owns the
  // group — see groupForSession in lib/projects.ts, which is what the sidebar actually asks.
  groupId: string | null;
}

/** A pty host still running for a session the app no longer tracks (see PtyOrphanInfo server-side). */
export interface PtyOrphan {
  sessionId: string;
  hostPid: number;
  childPid: number;
  workingDirectory: string;
  createdAt: string;
  ageHours: number;
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

/**
 * A named grouping of folders — the user's own unit of work, which may span several unrelated
 * folders or none at all. Shown in the sessions sidebar above the folder groups it collects; a
 * linked folder covers itself and everything under it. Persisted server-side (`/api/projects`).
 */
export interface Project {
  id: string;
  name: string;
  color: string | null; // palette colour name (same names as a session's /color), or null
  folders: string[]; // absolute paths on the server machine
  groups: ProjectGroup[]; // virtual folders, in the order they were made
}

/**
 * A *virtual folder*: a named box inside a project holding sessions the user dropped into it, rather
 * than sessions a path put there. The folder a session runs in is often the wrong unit — three
 * sessions in one repo can be three unrelated errands — so this is the grouping the filesystem can't
 * supply. A session can only be in a group of the project its own folder belongs to.
 *
 * `sessions` holds server-side membership keys (conversation ids), not session ids: it is there so
 * the client can count a group without walking the session list, and is otherwise opaque — what a
 * row belongs to arrives on the session itself, as `SessionInfo.groupId`.
 */
export interface ProjectGroup {
  id: string;
  name: string;
  color: string | null; // palette colour name, or null for the plain heading colour
  icon: string | null; // a name from lib/groupIcons.ts; null (or unknown) draws the default
  sessions: string[];
}

/**
 * A *session template*: a named, reusable way to start a particular kind of session — the project
 * it belongs to, the folder it runs in, the prompt it opens with, and the launch settings that go
 * with it. Persisted server-side (`/api/templates`), like projects.
 *
 * `prompt` is a template: the detail typed into the New Session dialog's "details" box is
 * substituted for its `{input}` placeholder, or appended as its own paragraph when there is none —
 * see lib/templates.ts. `projectId` is a soft reference: a template whose project has been deleted
 * shows under "No project" rather than disappearing.
 */
export interface SessionTemplate {
  id: string;
  name: string;
  projectId: string | null;
  workingDirectory: string; // may be "" while the template is being set up
  prompt: string; // may be "" — a template can be folder + settings and nothing else
  model: string; // "", "opus", "sonnet", "haiku"
  remoteControl: boolean;
  permissionMode: string; // default | auto | acceptEdits | bypassPermissions
  watchdogEnabled: boolean;
  description: string | null; // one line under the name in the picker
  inputHint: string | null; // placeholder for the details box — what to paste in
}

/** A shell the SERVER machine can run, as offered in the session tab bar's "+" menu. */
export interface ShellOption {
  /** Stable handle sent back to open a tab: "cmd" | "powershell" | "pwsh" | "gitbash" | "wsl:<distro>". */
  id: string;
  /** What the menu shows, e.g. "PowerShell" or "Ubuntu-24.04 (WSL)". */
  label: string;
  /** Family, which is all the icon needs: "cmd" | "powershell" | "pwsh" | "bash" | "wsl". */
  kind: string;
  /** Where it was found — an exe path, or the distribution name. Shown as the tooltip. */
  detail: string;
}

/** An open shell tab. Lives on the server, so every browser on the session sees the same ones. */
export interface ShellInfo {
  id: string;
  /** The session it belongs to; null for a shell opened outside one. */
  sessionId: string | null;
  workingDirectory: string;
  /** The ShellOption.id it was launched with. */
  shell: string;
  /** That option's label and family at launch time, so the tab still names itself if the shell
   *  is later uninstalled. */
  label: string;
  kind: string;
  processId: number;
  createdAt: string;
  /** False once the shell process has ended; the tab stays until it is closed. */
  running: boolean;
}

/**
 * A web page pinned to a session — the Jira issue it is working from, the doc it is following, the
 * dashboard it is watching — shown as a tab beside the terminal and the files.
 *
 * Stored in the session's UI bag (see lib/sessionUi.ts), keyed by conversation, so the links follow
 * the session to every device and survive a reopen. They are the user's own notes about the work,
 * not state of a process, which is why they need no server-side store of their own.
 */
export interface SessionLink {
  /** Stable id, so a tab keeps its identity when the URL behind it is edited. */
  id: string;
  url: string;
  /** What the tab says: the page's own title, or whatever the user renamed it to. */
  title: string;
  /** Favicon URL, loaded straight from the site by the browser. */
  icon?: string;
  /**
   * Show the page inside a tab. False sends it to a browser tab instead — the user's choice, or the
   * standing answer for a site whose headers refuse to be framed.
   */
  embed: boolean;
  /** The probe's verdict when the link was added, so the tab can explain a blank frame. */
  blockedBy?: string;
}

/** What the server could learn about a URL — see server/Web/LinkProbe.cs. */
export interface LinkProbe {
  /** The URL after redirects; this is what the tab should point at. */
  url: string;
  title?: string | null;
  icon?: string | null;
  /** Whether the page allows framing. Null when it could not be reached at all. */
  embeddable?: boolean | null;
  /** The header refusing to be framed, quoted, when one does. */
  blockedBy?: string | null;
  /** Why the probe failed, when it did — the link is still addable. */
  error?: string | null;
}
