export type SessionState = "Running" | "Exited" | "Failed" | "Restorable";

/**
 * A message a session sent you on purpose through POST /api/self/notify (SessionNotice on the server).
 * The hub carries the last few minutes of them; each one is raised once as an OS notification.
 */
export interface SessionNotice {
  id: string;
  sessionId: string;
  /** What the session called it; null to go by the session's name alone. */
  title: string | null;
  message: string;
  /** Unix ms. */
  at: number;
}

/** One part of a transcript entry, as GET /api/sessions/{id}/chat cuts it down (ChatBlock on the server). */
export interface ChatBlock {
  type: "text" | "thinking" | "tool_use" | "tool_result" | "image";
  text?: string | null;
  /** The tool call's id, on a tool_use and on the tool_result that answers it. */
  id?: string | null;
  name?: string | null;
  /** A tool_use's input as JSON text, possibly cut short. */
  input?: string | null;
  isError?: boolean;
  /** An image's place among its line's images: with the line's `at` and uuid, what fetches it. */
  n?: number | null;
  /** On a tool_result, the places (as `n`) of the images it came with — a Read of a picture. */
  images?: number[] | null;
}

/**
 * One line of Claude's transcript. `other` has nothing to draw but is still a link in the parent chain
 * the chat walks to find the conversation's live branch. `queue` is a change to the messages waiting for
 * Claude's turn to end — `subtype` enqueue, dequeue, remove or popAll — and is in no chain.
 */
export interface ChatEntry {
  uuid: string;
  parent: string | null;
  kind: "user" | "assistant" | "system" | "other" | "queue";
  time: string | null;
  messageId?: string | null;
  meta?: boolean;
  compactSummary?: boolean;
  subtype?: string | null;
  blocks?: ChatBlock[] | null;
  /** The model an assistant line came from (claude-opus-5-5). */
  model?: string | null;
  /** Tokens in the context when an assistant line was written. */
  context?: number;
  /** A message typed while Claude was working, which it read before the turn was over. */
  queued?: boolean;
  /** Where the line starts in the transcript, on a line with images. */
  at?: number | null;
}

/** A session's model and context use, as its status line last reported them. */
export interface SessionStatus {
  /** Claude's display name for it ("Opus 5.5"). */
  model?: string | null;
  contextPercent?: number | null;
  contextWindow?: number | null;
}

/** A read of the transcript from an offset on; `reset` drops what the reader had before. */
export interface ChatChunk {
  conversation: string | null;
  offset: number;
  reset: boolean;
  truncated: boolean;
  entries: ChatEntry[];
  status?: SessionStatus | null;
}

/** A slash command Claude takes in a session's folder (GET /api/sessions/{id}/commands). */
export interface SlashCommand {
  name: string;
  source: "builtin" | "project" | "user" | "plugin";
  description?: string;
  /** What goes after the name, as the command describes it ("<path>", "[model]"). */
  hint?: string;
  /** Answers in the terminal (a picker, a panel, output the transcript never gets), not in the conversation. */
  dialog?: boolean;
}

export interface SessionInfo {
  id: string;
  /**
   * The node the session is on, filled in by the client from the stream it came in on: absent (or null)
   * for the node this page was loaded from, a node id for a peer's. Not sent by the server.
   */
  nodeId?: string | null;
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
  // The pool is on auto-send: the server types the next stashed message in each time a turn ends.
  // Optional only because a server that predates it sends nothing, which reads as off.
  postponedAutoSend?: boolean;
  // Claude's own id for this conversation, once its first hook has reported one. The handle that
  // outlives the session — ours is minted afresh on every reopen — so anything meant to find this
  // conversation again later (a schedule) holds this rather than `id`.
  claudeSessionId: string | null;
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
  // Its activity is paused: its own row still shows what it is doing, but it is left out of the marks
  // and counts above it (headings, the session it is nested under, the Sessions tab's fraction, the
  // favicon). Server-side and keyed like a pin. Absent from a peer on an older build.
  activityPaused?: boolean;
  // Revision of this session's server-side UI state (open file tabs, view mode, tree state). Only the
  // number rides the list; a browser holding an older one re-fetches the bag. See lib/sessionUi.ts.
  uiRev: number;
  // The virtual folder this session was filed into, or null. Server-side and keyed by conversation
  // id like the pin above, so it survives a reopen. It only applies inside the project that owns the
  // group — see groupForSession in lib/projects.ts, which is what the sidebar actually asks.
  groupId: string | null;
  // The schedule that started this session, or that pokes it; null when a person started it. Drawn as
  // a mark before the name, beside the fork mark, because "a clock did this" is provenance — see the
  // note on ActivityMark in SessionSidebar for why it is not a sixth corner dot.
  scheduleId: string | null;
  // That schedule's clock in a few words ("0 9 * * 1-5", "every 10 min"), for the mark's tooltip.
  scheduleLabel: string | null;
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
  forkSession?: boolean; // with resumeSessionId: branch it into a new conversation (--fork-session) rather than continue it
  color?: string | null;
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

/** Where a path typed into the Files panel leads: the folder to open, and the file it named, if any. */
export interface FsResolved {
  found: boolean;
  dir: string | null;
  file: string | null;
  path: string | null; // the path as resolved, when nothing was found there
  error: string | null;
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

/**
 * What a staged build says it changed, written by `scripts\stage-update.ps1` into the payload's
 * build.json. Optional throughout: a build staged by hand carries none, and the update dialog then
 * says nothing about it rather than promising notes that never arrive.
 */
export interface ReleaseNotes {
  summary: string | null; // one line, for the button's tooltip
  changes: string[] | null; // the changes themselves, newest first
  since: string | null; // commit the range was measured from (the installed build's)
}

/** Identity of one build of the app, written by scripts\build.ps1 as build.json next to the exe. */
export interface BuildStamp {
  buildId: string; // UTC build timestamp + short commit; two builds are the same iff this matches
  version: string | null; // the release version ("1.2.3") of a build made from a release tag
  releaseUrl?: string | null; // the release's page, for a build staged from GitHub
  commit: string | null;
  branch: string | null;
  builtAtUtc: string | null;
  notes: ReleaseNotes | null; // what this build brought, when whoever staged it said
}

/**
 * Whether Claude's hooks in ~/.claude/settings.json point at this Hangar. They are global, one
 * registration for every Claude Code session on the machine, and an instance that finds another live
 * one owning them leaves them there (server/Sessions/ClaudeHookStatus.cs).
 */
export interface ClaudeHooksStatus {
  state: "ours" | "elsewhere" | "failed" | "off";
  port: number; // this instance's
  ownerPort: number | null; // where they point instead, for "elsewhere"
  ownerIsHangar: boolean | null; // whether a Hangar answers there
}

/** The updater's view of itself: what's running, what's staged, and whether one is being installed. */
export interface UpdateStatus {
  enabled: boolean; // the updater is switched on server-side (Update:Enabled)
  available: boolean; // a build is staged and it isn't the one running
  current: BuildStamp | null; // null when the app wasn't built by scripts\build.ps1
  staged: BuildStamp | null;
  state: "Idle" | "Applying" | "Failed";
  error: string | null; // why the last apply attempt failed, when state is Failed
  releases?: ReleaseCheck | null; // the last look at GitHub's releases; null when this build doesn't look
}

/** What the last look at GitHub's releases came to (server/Update/GitHubReleaseSource.cs). */
export interface ReleaseCheck {
  repo: string; // "owner/name"
  checkedAtUtc: string | null; // null before the first look has answered
  latest: string | null; // the newest release there for this machine
  error: string | null;
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
  groups: ProjectGroup[]; // virtual folders, in the order they are drawn (arranged by dragging)
  // GitHub repos ("owner/name") every session under this project can review, whatever its own
  // folder points at. A project is a piece of work, and the work usually spans more than one repo.
  repos: string[];
  // A name from lib/groupIcons.ts; null, missing (an older server) or unknown draws the default.
  icon?: string | null;
  // SSH connections saved with the project — never a password or passphrase, which are typed at
  // connect time. Missing on an older server.
  connections?: RemoteConnection[];
}

/** How a remote files tab authenticates: a typed password, a key file on the server, or the agent. */
export type RemoteAuth = "password" | "key" | "agent";

/**
 * The parameters of an SSH connection, everything but the secret. `host` may be an alias from the
 * server user's ~/.ssh/config, whose HostName/User/Port/IdentityFile fill in what is left blank.
 */
export interface RemoteConnection {
  id: string;
  name: string;
  host: string;
  port: number; // 0 = the config's, or 22
  user: string | null;
  auth: RemoteAuth;
  keyPath: string | null; // "key" auth only; null = the config's IdentityFile or ~/.ssh/id_*
  startPath: string | null; // null = the remote home
}

/** A remote files tab: which connection it is, and where it was left. Lives in the session's UI bag. */
export interface SessionRemote {
  /** Also the id the server keys the live connection by. */
  id: string;
  connection: RemoteConnection;
}

export interface RemoteConnectResult {
  status: "connected" | "hostKey" | "secret" | "error";
  error?: string | null;
  home?: string | null;
  target?: string | null;
  fingerprint?: string | null;
  keyType?: string | null;
  changed?: boolean;
  /** An unknown key from a host that already has a trusted key of another type. */
  otherTypeKnown?: boolean;
  secret?: "password" | "passphrase" | null;
}

export interface RemoteStatus {
  connected: boolean;
  home?: string | null;
  target?: string | null;
  error?: string | null;
}

export interface RemoteEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified?: string | null;
  isLink: boolean;
}

export interface RemoteListing {
  path: string;
  parent: string | null;
  entries: RemoteEntry[];
}

export interface SshHostConfig {
  alias: string;
  hostName: string | null;
  user: string | null;
  port: number | null;
  identityFile: string | null;
}

export interface SshConfigInfo {
  hosts: SshHostConfig[];
  keys: string[];
  sshDir: string;
}

/** One end of a paste: a remote tab, or one of a session's roots (`dir` as the Files panel uses it). */
export type TransferSide =
  | { kind: "remote"; tab: string }
  // `node`: the node the session is on, when it isn't the one the paste is sent to (a copy between machines).
  | { kind: "session"; sessionId: string; dir?: string; node?: string };

/** A memory file Claude keeps for a folder (`~/.claude/projects/<folder>/memory/`), as another machine is offered it. */
export interface ClaudeMemoryFile {
  name: string;
  description: string | null;
  /** Null when it is too large to carry. */
  content: string | null;
  size: number;
  modifiedUtc: string;
  /** Its line in MEMORY.md, the index; null when the index doesn't list it. */
  indexLine: string | null;
}

export interface ClaudeMemoryListing {
  folder: string;
  files: ClaudeMemoryFile[];
}

/** What a merge of memory into a folder did, file by file. */
export interface ClaudeMemoryImport {
  copied: string[];
  same: string[];
  kept: string[];
  missing: string[];
}

export interface TransferResult {
  paths: string[];
  errors: { path: string; error: string }[];
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

/** How a schedule's fire turns into work. See ScheduleStore server-side. */
export type ScheduleMode =
  /** A one-shot `claude -p` with no session row: the right shape for a frequent stateless check. */
  | "Headless"
  /** A full session per fire, as if you had filled in the New Session dialog. */
  | "NewSession"
  /** Send the prompt into a session already running, continuing one conversation. */
  | "ReuseSession";

/** One past fire, so a schedule that ran while you slept still left a trace. */
export interface ScheduleRun {
  at: string;
  sessionId: string | null;
  outcome: "ok" | "blocked" | "failed" | "skipped" | "postponed";
  detail: string | null;
  durationSeconds: number | null;
}

/**
 * A *schedule*: a {@link SessionTemplate} plus a clock. The template already holds what to run —
 * folder, prompt, model, permission mode — so this adds only when to fire it, what to do about a
 * moment the machine was off for, and what to do with the result.
 *
 * `cron` and `intervalMinutes` are alternatives, not two spellings of one thing: cron fires on a
 * wall clock, while an interval fires N minutes after the target's last turn *finished* — which is
 * what makes an every-N-minutes schedule unable to collide with itself.
 */
export interface SessionSchedule {
  id: string;
  name: string;
  enabled: boolean;
  templateId: string | null;
  input: string | null; // fills the template's {input} on every fire
  mode: ScheduleMode;
  cron: string; // 5-field cron, read in timeZoneId; "" when driven by an interval
  timeZoneId: string;
  intervalMinutes: number | null;
  onMissed: "Skip" | "RunOnce";
  graceMinutes: number;
  overlap: "Skip" | "Queue";
  maxRunMinutes: number;
  maxRuns: number | null;
  stopWhenDone: boolean;
  keepRuns: number;
  targetConversationId: string | null; // ReuseSession: the conversation it pokes
  lastFiredAt: string | null;
  runCount: number;
  history: ScheduleRun[];
}

/**
 * A schedule as the list endpoint sends it: the record plus what only the server can work out —
 * when it next fires (it owns the cron parser, and after a reboot only it knows when the schedule
 * last actually ran) and whether it can fire at all.
 */
export interface ScheduleEntry {
  schedule: SessionSchedule;
  nextFireAt: string | null;
  blocked: boolean;
  /**
   * Why it can never fire as it stands, in words, or null when nothing is stopping it. The server
   * says which, because the client can't tell a bad cron from a deleted template without a parser —
   * and naming the wrong one is worse than saying nothing.
   */
  blockedReason: string | null;
  /**
   * The zone the cron will ACTUALLY be read in, which is not always `schedule.timeZoneId`: the
   * server is built with InvariantGlobalization, so an IANA id a browser reports ("Europe/Berlin")
   * doesn't resolve on Windows and falls back to the machine's own zone. Show this one.
   */
  resolvedTimeZoneId: string;
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
  /** For an SSH shell (kind "ssh"), where it is connected to: "user@host:port". */
  remote?: string | null;
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

/** A pull request as the picker lists it. */
export interface GitHubPull {
  number: number;
  title: string;
  /** The author's GitHub login. */
  author: string;
  /** OPEN | CLOSED | MERGED — GitHub's own spelling. */
  state: string;
  draft: boolean;
  headRefName: string;
  baseRefName: string;
  url: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** The commits the two sides point at, so a file can be read whole at either. "" on a list row. */
  headRefOid: string;
  baseRefOid: string;
}

export interface GitHubPullList {
  isGitHub: boolean;
  nameWithOwner: string | null;
  pulls: GitHubPull[];
  /** Why GitHub could not be asked — no gh, not signed in, offline. Distinct from "no PRs". */
  error: string | null;
}

/** One file of a pull request, carrying its own slice of the unified diff. */
export interface GitHubPullFile {
  path: string;
  /** Where the file came from, for a rename or a copy; null otherwise. */
  oldPath: string | null;
  /** A | M | D | R | C — the alphabet the working-tree status uses. */
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
  /** The diff was cut short because the file's changes are enormous. */
  truncated: boolean;
  diff: string;
  /**
   * The blob sha of this file's side of the change — what says whether it is still the same file
   * somebody marked as read. Empty when GitHub did not give one, which is what stops it being
   * markable at all: a mark with nothing to compare against could never reset.
   */
  sha: string;
}

/** A line elsewhere in the code that names a word (git grep), for going to its declaration. */
export interface GrepMatch {
  /** Relative to the folder searched — or, for a pull request, to its repo. */
  path: string;
  line: number;
  /** The line itself, cut short past a few hundred characters. */
  text: string;
}

export interface GrepResult {
  matches: GrepMatch[];
  /** The search stopped at its cap (or its time limit) rather than at the end. */
  truncated: boolean;
  error: string | null;
}

/** One file of a pull request read whole at a commit, rather than as a diff. */
export interface GitHubFileContent {
  path: string;
  ref: string;
  content: string;
  /** The file was too large to send; `content` is empty. */
  truncated: boolean;
  error: string | null;
}

/**
 * One commit of a pull request. `parent` is its first parent — the side a diff of just this commit is
 * drawn against, and where a file it deletes can still be read whole. "" where GitHub gave none.
 */
export interface GitHubPullCommit {
  sha: string;
  parent: string;
  /** The GitHub login where the commit is tied to an account, otherwise the name git recorded. */
  author: string;
  date: string;
  /** The whole message; its first line is the headline. */
  message: string;
}

export interface GitHubPullCommits {
  /** Oldest first — the order they were made in. */
  commits: GitHubPullCommit[];
  error: string | null;
}

/** What one commit changes, in the same shape as a whole review's files. */
export interface GitHubCommitDiff {
  sha: string;
  files: GitHubPullFile[];
  error: string | null;
}

export interface GitHubPullDetail {
  pull: GitHubPull | null;
  /** The PR description, as Markdown. */
  body: string;
  files: GitHubPullFile[];
  error: string | null;
  /**
   * Paths marked as read whose file has not changed since. The server does the comparison, because
   * it is the side that holds the marks and the shas — a file the author has pushed over is simply
   * absent here, which is the whole of the per-file reset as the client sees it.
   */
  viewed: string[];
}

/**
 * A GitHub repo a session can review pull requests from, and where it came from: its own folder's
 * remote, a repo linked to the folder, or one the folder's project names. The source is shown in the
 * picker and decides what can be unlinked there — a folder's own repo is a fact, not a choice.
 */
export interface SessionRepo {
  nameWithOwner: string;
  source: "folder" | "session" | "project";
}

/**
 * A pull request opened as a tab in a session's tab bar. Only what the tab itself says is kept —
 * the review below it is fetched fresh, since a PR moves while you are working on it.
 *
 * Stored in the session's UI bag (see lib/sessionUi.ts) beside the links, so an open PR follows the
 * session to every device and survives a reload. Repo and number together are the identity (pullKey),
 * so opening #42 twice means going back to the tab that is already there — while #42 of one repo and
 * #42 of another are two reviews, which is the whole point of a session reaching more than one repo.
 */
export interface SessionPull {
  number: number;
  /** The title as it was when the tab was opened — what the tab says before the PR has loaded. */
  title: string;
  /**
   * The repo the PR is in ("owner/name"), when it is not the one the session's own folder points at.
   * Left off for the folder's own repo, which is both the common case and what keeps a tab opened
   * before repos could be linked identical to the same tab opened now — see pullKey.
   */
  repo?: string;
}

/**
 * Which files of a review are folded away, as a baseline and the exceptions to it rather than a flag
 * per file. The shape is chosen for size: the session's UI bag is capped server-side, and a bag over
 * the cap is dropped whole rather than trimmed, which would take the open tabs and the open files
 * down with it.
 *
 * So a bulk fold is one boolean however many files it covered. The exceptions are what grow — every
 * file opened or folded by hand, including one opened by clicking it in the sidebar of a review that
 * was collapsed — and they are held to a budget across all of a session's reviews (MAX_FOLD_PATHS in
 * PullRequestView), past which the oldest give up and return to the baseline.
 */
export interface PullFolds {
  /** What Collapse all / Expand all last said. Undefined leaves each file to its own size default. */
  all?: boolean;
  /** Paths whose state is the opposite of that baseline — the files folded or opened by hand. */
  except?: string[];
}

// ---- Nodes: other machines running Hangar (plans/multi-node.md) ----

/** A node's identity, as `GET /api/node` answers it. */
export interface NodeInfo {
  id: string;
  name: string;
  color: string | null;
  /** The address peers reach this node at; null when each pairing works it out from the request. */
  url: string | null;
  version: string | null;
  os: "windows" | "linux" | "macos" | "other";
  capabilities: string[];
}

/** A peer this node reaches. */
export interface PeerNode {
  id: string;
  name: string;
  url: string;
  color: string | null;
  /** The pinned certificate (a self-signed https peer); null for http, or a certificate the OS trusts. */
  fingerprint: string | null;
  enabled: boolean;
  addedAt: string;
}

/** A node allowed to reach this one: a peer token this node issued. */
export interface AllowedNode {
  key: string;
  nodeId: string;
  name: string | null;
  url: string | null;
  issuedAt: string;
  lastUsedAt: string | null;
}

export interface NodesOverview {
  self: NodeInfo;
  peers: PeerNode[];
  allowed: AllowedNode[];
}

/** What a peer's TLS handshake showed. */
export interface CertificateSeen {
  fingerprint: string | null;
  subject: string | null;
  /** Whether the OS trusts it on its own. */
  valid: boolean;
}

export interface PeerStatus {
  status: "online" | "offline" | "unauthorized" | "incompatible" | "certificate";
  node: NodeInfo | null;
  error: string | null;
  certificate: CertificateSeen | null;
}
