import type { ChatChunk, ChatEntry } from "@/types";

/**
 * The chat view's copy of a session's transcript: every entry read so far, and where to read on from.
 * Entries are kept as Claude wrote them; what the chat shows is worked out from them on each render
 * (see {@link chatItems}), since a later line can change what an earlier one means — a tool's result
 * lands under its call, a rewind abandons a branch.
 */
export interface ChatTranscript {
  conversation: string | null;
  offset: number;
  /** The first read started near the end of a long transcript; what came before isn't here. */
  truncated: boolean;
  entries: ChatEntry[];
}

export const EMPTY_TRANSCRIPT: ChatTranscript = { conversation: null, offset: 0, truncated: false, entries: [] };

/** Fold one read into the copy. A reset (a new conversation, a rewritten file) replaces it. */
export function applyChunk(t: ChatTranscript, c: ChatChunk): ChatTranscript {
  if (c.reset || c.conversation !== t.conversation)
    return { conversation: c.conversation, offset: c.offset, truncated: c.truncated, entries: c.entries };
  if (!c.entries.length && c.offset === t.offset) return t;
  return { ...t, offset: c.offset, entries: c.entries.length ? [...t.entries, ...c.entries] : t.entries };
}

/**
 * The entries of the conversation as it stands. A transcript is a tree: each line names its parent.
 * Most of the side branches in it are not abandoned at all — parallel tool calls hang their calls and
 * results off the main line as short dead ends — so everything is kept in file order except what a rewind
 * (Esc Esc) or an edited prompt left behind: a prompt hanging off the live line beside another prompt
 * that is on it, and everything under that prompt. The live line is the walk back from the newest entry.
 */
export function liveBranch(entries: ChatEntry[]): ChatEntry[] {
  let leaf = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    // A system line counts: a local command (/usage, /model) is written as two of them, chained after
    // the last message.
    if (entries[i].kind !== "other") {
      leaf = i;
      break;
    }
  }
  if (leaf < 0) return entries;
  const index = new Map<string, number>();
  entries.forEach((e, i) => index.set(e.uuid, i));
  const parentOf = (i: number) => {
    const p = entries[i].parent;
    return p ? index.get(p) : undefined;
  };
  const live = new Set<number>();
  let root = leaf;
  for (let at: number | undefined = leaf; at !== undefined && !live.has(at); at = parentOf(at)) {
    live.add(at);
    root = at;
  }
  // A rewind to the very first prompt leaves two prompts with no parent at all, the old and the new:
  // the one the live line starts from is the conversation, the other was abandoned with all under it.
  const rootIsPrompt = entries[root].parent === null && isPrompt(entries[root]);
  // Live entries that a prompt on the live line answers to: the places a rewind can have branched from.
  const forks = new Set<number>();
  for (const i of live) {
    const p = parentOf(i);
    if (p !== undefined && live.has(p) && isPrompt(entries[i])) forks.add(p);
  }
  const abandoned = new Map<number, boolean>();
  const isAbandoned = (i: number): boolean => {
    const path: number[] = [];
    let verdict = false;
    for (let at: number | undefined = i; ; ) {
      if (at === undefined || live.has(at)) break;
      const known = abandoned.get(at);
      if (known !== undefined) {
        verdict = known;
        break;
      }
      if (path.includes(at)) break;
      path.push(at);
      if (rootIsPrompt && entries[at].parent === null) {
        verdict = isPrompt(entries[at]);
        break;
      }
      const p = parentOf(at);
      if (p !== undefined && live.has(p)) {
        verdict = isPrompt(entries[at]) && forks.has(p);
        break;
      }
      at = p;
    }
    for (const k of path) abandoned.set(k, verdict);
    return verdict;
  };
  return entries.filter((_, i) => !isAbandoned(i));
}

/** Something typed: a user line that isn't Claude's bookkeeping or a tool's result. */
function isPrompt(e: ChatEntry): boolean {
  return e.kind === "user" && !e.meta && !(e.blocks ?? []).some((b) => b.type === "tool_result");
}

/** What the chat draws, one item per bubble, card or note. */
export type ChatItem =
  | { kind: "user"; key: string; text: string; images: number; time: string | null }
  | { kind: "command"; key: string; text: string }
  | { kind: "output"; key: string; text: string }
  | { kind: "notice"; key: string; text: string; tone?: "error" }
  | { kind: "summary"; key: string; text: string }
  | { kind: "assistant"; key: string; text: string; time: string | null }
  | { kind: "thinking"; key: string; text: string }
  | { kind: "tool"; key: string; id: string | null; name: string; input: string | null; result?: ToolResult };

export interface ToolResult {
  text: string;
  isError: boolean;
}

// Colors and styles from a terminal command's output (a /compact's dimmed "Compacted").
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

const tag = (text: string, name: string) => {
  const m = text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : null;
};

/**
 * The items to draw for a transcript. Claude writes a slash command, its output, a shell escape and a
 * background task's report as user messages wrapped in tags of its own; those become their own kinds of
 * item rather than bubbles that read as something you typed. Bookkeeping Claude adds for itself (meta
 * lines, system reminders, hook summaries) is left out.
 */
export function chatItems(entries: ChatEntry[]): ChatItem[] {
  const items: ChatItem[] = [];
  const tools = new Map<string, Extract<ChatItem, { kind: "tool" }>>();
  for (const e of liveBranch(entries)) {
    const blocks = e.blocks ?? [];
    if (e.kind === "system") {
      const text = blocks.find((b) => b.type === "text")?.text ?? "";
      if (e.subtype === "compact_boundary") items.push({ kind: "notice", key: e.uuid, text: "Conversation compacted" });
      else if (e.subtype === "api_error")
        items.push({ kind: "notice", key: e.uuid, text: text || "API error", tone: "error" });
      else if (e.subtype === "local_command" && text) {
        // The command and its output, in the same tags a command typed into a turn is written with.
        const item = taggedItem(e.uuid, text);
        if (item) items.push(item);
        else if (item === undefined) items.push({ kind: "output", key: e.uuid, text: clean(text) });
      }
      continue;
    }
    if (e.kind === "assistant") {
      blocks.forEach((b, i) => {
        const key = `${e.uuid}:${i}`;
        if (b.type === "text" && b.text?.trim()) items.push({ kind: "assistant", key, text: b.text, time: e.time });
        else if (b.type === "thinking" && b.text?.trim()) items.push({ kind: "thinking", key, text: b.text });
        else if (b.type === "tool_use") {
          const item = { kind: "tool" as const, key, id: b.id ?? null, name: b.name ?? "tool", input: b.input ?? null };
          if (b.id) tools.set(b.id, item);
          items.push(item);
        }
      });
      continue;
    }
    if (e.kind !== "user") continue;
    // Tool results answer a call drawn earlier: they go into its card, not a message of their own.
    for (const b of blocks) {
      if (b.type !== "tool_result" || !b.id) continue;
      const call = tools.get(b.id);
      if (call) call.result = { text: clean(b.text ?? ""), isError: !!b.isError };
    }
    if (e.meta) continue;
    const text = blocks
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text!)
      .filter((t) => !t.trimStart().startsWith("<system-reminder>"))
      .join("\n\n");
    const images = blocks.filter((b) => b.type === "image").length;
    if (e.compactSummary) {
      items.push({ kind: "summary", key: e.uuid, text });
      continue;
    }
    if (!text.trim() && !images) continue;
    const special = taggedItem(e.uuid, text);
    if (special !== undefined) {
      if (special) items.push(special);
      continue;
    }
    items.push({ kind: "user", key: e.uuid, text: text.trim(), images, time: e.time });
  }
  return items;
}

/** A user line Claude wrote itself, in one of its tag formats: the item for it, null to drop it, undefined if it isn't one. */
function taggedItem(key: string, text: string): ChatItem | null | undefined {
  const t = text.trimStart();
  const command = tag(t, "command-name");
  if (command !== null) {
    const args = tag(t, "command-args")?.trim();
    return { kind: "command", key, text: args ? `${command} ${args}` : command };
  }
  for (const name of ["local-command-stdout", "local-command-stderr", "bash-stdout", "bash-stderr"]) {
    if (t.startsWith(`<${name}>`)) {
      const out = clean(tag(t, name) ?? "");
      return out.trim() ? { kind: "output", key, text: out } : null;
    }
  }
  if (t.startsWith("<bash-input>")) return { kind: "command", key, text: `! ${tag(t, "bash-input") ?? ""}` };
  if (t.startsWith("<local-command-caveat>")) return null;
  if (t.startsWith("<task-notification>")) {
    const summary = tag(t, "summary")?.trim();
    return { kind: "notice", key, text: summary ? `Background task: ${summary}` : "A background task finished" };
  }
  if (t.startsWith("[Request interrupted")) return { kind: "notice", key, text: "Interrupted" };
  return undefined;
}

const clean = (text: string) => text.replace(ANSI, "");

/** The part of a tool call worth putting in its card's heading: the command, the file, the pattern. */
export function toolSummary(input: string | null): string {
  if (!input) return "";
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(input);
  } catch {
    return "";
  }
  if (!o || typeof o !== "object") return "";
  const pick = (...keys: string[]) => {
    for (const k of keys) if (typeof o[k] === "string" && o[k]) return o[k] as string;
    return null;
  };
  const s =
    pick("command", "file_path", "notebook_path", "pattern", "url", "query", "description", "prompt", "skill") ??
    Object.values(o).find((v): v is string => typeof v === "string") ??
    "";
  return s.split("\n")[0];
}

/** A tool call's input as something to read: the JSON pretty-printed, or as it came when it was cut short. */
export function prettyInput(input: string | null): string {
  if (!input) return "";
  try {
    return JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    return input;
  }
}
