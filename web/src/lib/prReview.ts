// Review comments on a pull request, written for the session's own Claude rather than for GitHub.
// A comment is a few lines picked out of the diff and something said about them. It goes to Claude
// one of two ways: straight into the terminal as a message of its own, or into the review file — a
// Markdown file in the session's folder that collects comments until the whole review is sent as
// one message. The file is plain Markdown on purpose: it is what Claude is handed, so what the
// reader edits in it is exactly what gets sent.

import { api } from "./api";

/** The lines a comment is about. */
export interface ReviewTarget {
  path: string;
  /** Which version the line numbers count in: before the change, or after it. */
  side: "old" | "new";
  start: number;
  end: number;
  /** The lines themselves, with "…" where the selection stepped over lines the diff did not show. */
  code: string;
}

/** What the comments are about as a whole, for the words around them. */
export interface ReviewContext {
  number: number;
  /** The repo the PR is in, when it is not the one the session's folder points at. */
  repo?: string;
  title?: string;
  head?: string;
  base?: string;
  /** Set while the review is narrowed to one commit — the line numbers are that commit's. */
  commit?: string;
}

/**
 * Where a review is kept: beside the postponed messages, under the session's working directory, one
 * file per pull request. Inside the folder rather than in the app's own data so Claude can be pointed
 * at it, and so it can be opened in the Files tab like anything else.
 */
export function reviewFilePath(repo: string | undefined, number: number): string {
  const owner = repo ? `${repo.replace(/[^\w.-]+/g, "-")}-` : "";
  return `.claudeweb/reviews/${owner}pr-${number}.md`;
}

/** A code fence that the code inside it cannot close: one backtick longer than its longest run. */
function fence(code: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** The fence's language tag, from the file's extension — a hint for whoever reads the Markdown. */
function lang(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function pullName(ctx: ReviewContext): string {
  return `pull request #${ctx.number}${ctx.repo ? ` in ${ctx.repo}` : ""}`;
}

/** "`src/a.ts` lines 10–14", and which version they count in when that is not the obvious one. */
function where(t: ReviewTarget, ctx: ReviewContext): string {
  const lines = t.start === t.end ? `line ${t.start}` : `lines ${t.start}–${t.end}`;
  const version = t.side === "old" ? " of the old version (before the change)" : "";
  const commit = ctx.commit ? ` in commit ${ctx.commit}` : "";
  return `\`${t.path}\` ${lines}${version}${commit}`;
}

/** One comment as the review file holds it: where, the lines, and what was said about them. */
export function commentBlock(t: ReviewTarget, body: string, ctx: ReviewContext): string {
  const f = fence(t.code);
  return `### ${where(t, ctx)}\n\n${f}${lang(t.path)}\n${t.code}\n${f}\n\n${body.trim()}\n`;
}

/** One comment sent on its own, with enough around it to be read without the rest of the review. */
export function commentMessage(t: ReviewTarget, body: string, ctx: ReviewContext): string {
  const branch = ctx.head ? ` (branch \`${ctx.head}\`)` : "";
  return `Review comment on ${pullName(ctx)}${branch}:\n\n${commentBlock(t, body, ctx)}`;
}

/** The top of a new review file — what the comments under it are about and what to do with them. */
function reviewHeader(ctx: ReviewContext): string {
  const title = ctx.title ? ` — ${ctx.title}` : "";
  const branch = ctx.head && ctx.base ? `Branch \`${ctx.head}\` into \`${ctx.base}\`. ` : "";
  return `# Review of ${pullName(ctx)}${title}\n\n${branch}Work through each comment below.\n`;
}

/** The review with one more comment at its end, starting the file if this is the first. */
export function appendComment(review: string, block: string, ctx: ReviewContext): string {
  const head = review.trim() ? review.trimEnd() : reviewHeader(ctx).trimEnd();
  return `${head}\n\n${block}`;
}

/**
 * How many comments a review holds, by the headings that start them — the shape commentBlock
 * writes, a heading opening on a path. Not counting inside a code fence: the lines quoted under a
 * comment can be Markdown themselves, headings and all.
 */
export function countComments(review: string): number {
  let n = 0;
  let open: string | null = null; // the fence a code block was opened with, while inside one
  for (const line of review.split("\n")) {
    const run = /^(`{3,})/.exec(line)?.[1];
    if (open) {
      if (run && run.length >= open.length && !line.slice(run.length).trim()) open = null;
    } else if (run) open = run;
    else if (line.startsWith("### `")) n++;
  }
  return n;
}

/** "1 comment", "3 comments". */
export function commentCount(n: number): string {
  return `${n} ${n === 1 ? "comment" : "comments"}`;
}

/** The review as it is on disk, or "" when there is none yet. */
export async function readReview(sessionId: string, path: string): Promise<string> {
  try {
    return await api.fetchSessionFileText(sessionId, path);
  } catch (e) {
    if ((e as { status?: number }).status === 404) return "";
    throw e;
  }
}

/** Put the review on disk, making its folder the first time. */
export async function writeReview(sessionId: string, path: string, text: string): Promise<void> {
  await api.createSessionFolder(sessionId, path.slice(0, path.lastIndexOf("/")));
  await api.writeSessionFile(sessionId, path, text);
}

/** Done with: the review has been sent, or thrown away. */
export function deleteReview(sessionId: string, path: string): Promise<void> {
  return api.deleteSessionFile(sessionId, path);
}
