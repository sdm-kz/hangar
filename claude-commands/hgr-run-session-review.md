---
description: Launch a child Claude session (via /hgr-run-session, nested under this one in Hangar) that reviews this branch's changes, writes .review/review-<branch>.md (git-ignored) in the repo root, and messages this session when it's done
argument-hint: [all|uncommitted|branch] [base branch] [extra focus, e.g. "security"]
allowed-tools: Bash, PowerShell, Read, Glob, Skill
---

# Run session review

Collect everything needed to review the current repo's changes, then hand it to a **new Claude
session** — launched with `/hgr-run-session` as a **child of this session**, so Hangar draws it
nested under this one in the sessions list — that reviews them, writes the result to a markdown file
in the repo's git-ignored `.review/` folder, named after the branch, and then **messages this
session** to say it's finished and which file to read.

The review happens in the other session — this one only gathers facts, launches it, and waits for the
message.

User request: **$ARGUMENTS**

## Step 1 — Gather the context

Run these in the current working directory. Everything here becomes ground truth for the new
session, so record the actual output; don't paraphrase or assume.

```bash
git rev-parse --show-toplevel                       # repo/worktree root -> ROOT
git rev-parse --abbrev-ref HEAD                     # current branch -> BRANCH
git rev-parse --git-dir; git rev-parse --git-common-dir   # differ => linked worktree
git worktree list                                   # all worktrees, if this is one
git rev-parse --abbrev-ref '@{upstream}' 2>/dev/null # upstream, if any
git remote -v
```

Then get **this** session's name (`PARENT`) — the new session is named after it, and it is also the
**address the review session sends its finished-message to**, so get it exactly right. Hangar
answers it, renames included:

```bash
curl -s "${HANGAR_URL:-http://127.0.0.1:5099}/api/self/children" \
  -H "X-Session-Id: $HANGAR_SESSION_ID" -H "X-Hook-Token: $HANGAR_HOOK_TOKEN"
# {"id":"…","name":"auth refactor","children":[…]}  -> PARENT is "name"
```

If `HANGAR_SESSION_ID` is empty (this session wasn't launched by Hangar) or the call doesn't answer
with JSON, fall back to the repo folder's name (the last part of `ROOT`) and say which you used.

If `PARENT` came from that fallback, this session is probably **not addressable** by that name from
another session. Say so, and tell the launched session to skip the notification rather than guess a
recipient — see Step 4.

Pick the **base branch** (`BASE`) in this order, first hit wins: an explicit base in `$ARGUMENTS` →
the upstream's target branch → `origin/main` → `origin/master` → local `main`/`master`. Verify it
resolves (`git rev-parse --verify <BASE>`) before using it; if nothing resolves, say so and review
uncommitted changes only.

```bash
git merge-base HEAD <BASE>                          # fork point
git log --oneline <BASE>..HEAD                      # commits on this branch
git status --short                                  # uncommitted (staged + unstaged + untracked)
git diff <BASE>...HEAD --stat                       # committed changes vs base
git diff --stat; git diff --cached --stat           # working tree / index
```

## Step 2 — Decide the scope

From `$ARGUMENTS`:

| Arg | Scope | Diff the new session reviews |
| --- | --- | --- |
| `all` (**default**) | committed branch work **and** uncommitted changes | `git diff <BASE>` — base against the working tree, both in one diff |
| `uncommitted` | working tree only | `git diff` + `git diff --cached` + untracked files |
| `branch` / `committed` | commits on this branch only | `git diff <BASE>...HEAD` |

State the scope you chose and why when you report back.

## Step 3 — Work out the review file

- Slug: `BRANCH` lowercased with `/` and any non-alphanumeric run collapsed to `-`
  (`feature/AB-123_login-fix` → `feature-ab-123-login-fix`).
- Path: `<ROOT>/.review/review-<slug>.md`. Review reports live in the `.review/` folder at the repo
  root, never loose in the root itself.
- Check whether it already exists — the new session must **append**, never overwrite. Tell it which
  case it's in. A report left over from before this layout (`<ROOT>/review-<slug>.md`) is moved into
  `.review/` first, so the history carries on in one file.
- Make sure `.review/` is git-ignored, so a report can never be committed by accident:

  ```bash
  git -C <ROOT> check-ignore -q .review/probe.md && echo ignored || echo NOT-ignored
  ```

  If it is not ignored (a repo without the `.review/` rule in its `.gitignore`), append `.review/` to
  the repo's local exclude file — `$(git -C <ROOT> rev-parse --git-common-dir)/info/exclude` — rather
  than editing a tracked `.gitignore`, and mention it in the report so the user can add the rule to
  `.gitignore` properly if they want.

## Step 3a — Reuse a live review session (repeat rounds)

There should be **one review session per branch**, not one per round. Before launching anything, load
`ListAgents`/`SendMessage` (they may be deferred — `ToolSearch` with `select:ListAgents,SendMessage`)
and call `ListAgents`. Look for a row named exactly **`<PARENT>-review`**. If there are several, use
the most recent one's ` [ref]`.

- **Found** → a previous round's reviewer is still alive. It already holds the earlier diff and its
  findings in context. **Do not launch a new session.** `SendMessage` it a re-review brief instead:

  ```
  New review round for <BRANCH> — the author has fixed findings since your last section.
  Scope <scope> vs <BASE>, review with: <DIFF COMMAND>.
  Commits now on the branch: <git log --oneline>; uncommitted: <git status --short or "none">;
  changed files: <diff --stat>.
  <extra focus, if any>
  Re-read the current diffs (not your memory of them), then APPEND a new
  `## <YYYY-MM-DD HH:mm> — <scope> vs <BASE>` section to <ROOT>/.review/review-<slug>.md, answering every
  earlier finding as `- Re: <finding> — Fixed | Still present | Won't fix (<why>)`, then new findings.
  Same rules as before: review only, no fixes, no git add/commit, never edit earlier sections.
  When the file is saved, message me exactly once, in the same shape as last time.
  ```

  Then skip Step 4. In Step 5, report that the existing session was reused (its name and ref) rather
  than launched, and that its finished-message will arrive as before.
- **Found, but the message fails** (the row is stale, or the session ended between the listing and the
  send) → fall through to Step 4 and launch a fresh one.
- **Not found** → Step 4.

## Step 4 — Launch the session

Launch it the way `/hgr-run-session` does — invoke that skill, or send its request yourself — with
these values:

- parent: **this session** — `nestedUnderId` is `$HANGAR_SESSION_ID`. If that variable is empty (the
  same case where Step 1 fell back to a folder name for `PARENT`), launch it top-level instead and say
  so.
- view: nothing to send. Nested under this session, the reviewer opens on the chat or the terminal,
  whichever this session is on (the server copies it at launch). A top-level fallback opens on the
  terminal.
- folder: `ROOT` (the worktree root, not the main checkout)
- name: **`<PARENT>-review`** — this session's name with a `-review` suffix, so the review session is
  visibly tied to the one that spawned it (`auth refactor` → `auth refactor-review`). Send it
  verbatim, with no timestamp suffix. A repeat run normally reuses the live session (Step 3a), and
  when a fresh one has to be launched, it keeps the same name and stays grouped. Only if `PARENT`
  already ends in `-review` (a review of a review) add `-2`, `-3`, …
- permission mode: `auto` (it has to read the diffs and write the review file unattended; `auto`
  waves through routine reads, greps and file writes while still stopping at genuinely destructive
  actions — which a review session should never reach anyway)
- initial prompt: the brief below, with every `<PLACEHOLDER>` replaced by real values. It is long
  free text full of quotes and backticks: build the request body with a JSON encoder, as
  `/hgr-run-session` shows, never by hand.

### The initial prompt

```
Review this branch and write the result to a file. Context (already verified — trust it):

- Repo root / worktree: <ROOT>
- Worktree: <"linked worktree of <MAIN_CHECKOUT>" | "main checkout">; other worktrees: <LIST or none>
- Branch: <BRANCH>   Upstream: <UPSTREAM or none>
- Base: <BASE>   Fork point: <MERGE_BASE>
- Scope: <all | uncommitted | branch> — review with: <DIFF COMMAND from step 2>
- Commits on this branch (<N>):
<git log --oneline output>
- Uncommitted changes:
<git status --short output, or "none">
- Changed files:
<diff --stat output>
- Session that launched you: <PARENT>
<extra focus from $ARGUMENTS, if any>

Read the actual diffs and the full files around them before judging anything — the lists above are
scope, not evidence. Look for correctness bugs first (wrong results, crashes, races, data loss,
security holes), then for what makes the change harder to maintain than it needs to be.

Then write the review to <ROOT>/.review/review-<slug>.md (create the `.review` folder if it is missing):
- If the file does NOT exist: create it with `# Review — <BRANCH>` as the title, then a
  `## <YYYY-MM-DD HH:mm> — <scope> vs <BASE>` section holding this review.
- If it DOES exist (it currently <does / does not>): keep every existing line untouched and APPEND a
  new `## <YYYY-MM-DD HH:mm> — <scope> vs <BASE>` section at the end. Re-check the findings from
  earlier sections and reply to each one inside your new section as
  `- Re: <finding> — Fixed | Still present | Won't fix (<one line why>)`, then list new findings.
  Never edit or delete an earlier section.
- In each section: one-line summary of what changed, then findings grouped High / Medium / Low, each
  with a `path:line` reference, the concrete failure it causes, and a suggested fix. "No issues
  found" is a valid result — say it plainly instead of padding.
- The timestamp is the local time when you write the section.

Once the file is written and saved, report back to the session that launched you — this is the last
thing you do:

1. Call `ListAgents` and find the row named exactly `<PARENT>`. That session spawned you; its name
   is the address.
2. Call `SendMessage` with `to: "<PARENT>"` and a short message in this shape:

   Review finished: <ROOT>/.review/review-<slug>.md (<created | appended a new section>).
   Scope <scope> vs <BASE>, <N> files changed. Findings: <H> High, <M> Medium, <L> Low —
   <the single most important one in one line, or "no issues found">.

   Keep it to those few lines. The file holds the detail; the message only points at it.
3. If nothing matches `<PARENT>`: when `ListAgents` shows several rows whose names begin with it,
   retry once using the ` [ref]` printed for the right row (`to: "<PARENT> [ref]"`). If the name is
   simply absent, that session has ended — do not message a different session and do not retry in a
   loop. Say in your final output that the review is complete, give the file path, and note that the
   parent session could not be reached.

Send that message exactly once. No progress updates while you review, and no questions to the parent
session — it is not waiting to answer, only to be told you're done.

After that, stay idle. <PARENT> may later message you for a **new review round** once it has fixed
findings. Treat that as a fresh pass under these same rules: re-read the current diffs, append a new
section answering every earlier finding, and send one finished-message again.

Do not commit, stage (`git add`), push, or fix anything — this is review only. The one file you write
is <ROOT>/.review/review-<slug>.md; the `.review/` folder is git-ignored, keep it that way. No AI attribution, signatures, or emojis in it.
```

If you have a review command of your own (a `/review` in `~/.claude/commands`, say), put it at the
very start of the brief — `/review Review this branch…` — so the reviewer runs it with the brief as
its arguments. Claude Code only expands a slash command at the very start of a message.

If Step 1 fell back to a folder name for `PARENT`, drop the whole "Once the file is written…" block
and put this in its place: `You have no session to report back to — just state the file path in your
final output.` A `SendMessage` to a name that is not a live session only wastes a turn.

## Step 5 — Report back

Give the user: the new session's `id`, `name` and `state`, that it is nested under this session and
opens on the same chat/terminal view (or that it launched top-level, and why), the folder it runs in,
the scope and base it was given, the full path of the review file it will write under `.review/`
(noting create vs append, and whether you had to add `.review/` to `info/exclude`), and that
**it will message this session when it finishes** — so they can leave it running instead of watching
it. Mention that `remoteUrl` is null right after creation — the deep link shows up in the Hangar
UI or the Claude Code app once the session prints it.

Don't poll `ListAgents` or send "are you done?" messages meanwhile; the finished-message arrives on
its own, wrapped as `<cross-session-message from="<PARENT>-review">`. When it lands, relay it to the
user in a line or two and offer to walk through the review — read the file first if they want the
findings discussed.

## Closing the reviewer

Leave the review session running after it reports: Step 3a reuses it for the next round, with the
earlier diffs and findings still in its context. Close it once the branch is done (merged, abandoned,
or the user says no more rounds) with `/hgr-close-session it` right after its finished-message, or
`/hgr-close-session <PARENT>-review` later. Don't close it unprompted after a round.

## Rules

- This launches a real, billed session. One per invocation — if the launch errors, read the error
  before retrying (connection refused = server down, 401 = a password is set and `HANGAR_API_KEY`
  doesn't hold the server's `Auth:ApiKey`, 400 = bad folder, or `No session '<id>' to put this one
  under` when the parent id is stale — nothing was launched then).
- Not a git repo → stop and say so; there's nothing to review.
- No changes at all in scope → say so and **don't** launch a session.
- Never escalate to `bypassPermissions`. `auto` is enough to read the diffs and write one markdown
  file, and it keeps the destructive-action prompts in place.
- Never launch the review session in a different folder than the worktree the changes live in — a
  review of `git diff` run in the wrong worktree reviews the wrong code.
- The reviewing session must not fix what it finds unless the user separately asks for that.
- The notification is a courtesy, not the deliverable — the review file is. An undelivered message
  doesn't make the run a failure.
