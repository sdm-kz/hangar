---
description: Launch a new Claude Code session via Hangar, nested under this one as a child session (POST /api/external/sessions with nestedUnderId)
argument-hint: [folder] [name] [model] [prompt/slash-command] [--continue|--resume <id>] [--mode auto|acceptEdits|default] [--parent <session-id>] [--top-level]
allowed-tools: Bash, PowerShell, Read, Glob
---

# Run session

Launch a **new Claude Code session** on this machine through the Hangar server, as a
**child of this session**: it is drawn nested under this one in the sessions list, so the sub-task
stays visibly attached to the session that launched it.

Nesting is only an arrangement of the list. The child gets its own conversation in whatever folder
you give it and is not a fork of this session. The one thing it inherits is the **view**: it opens
on the chat or the terminal, whichever this session is on (the server copies the parent's choice
at launch — there is no field for it, so send nothing). A top-level launch has no parent to take
it from and opens on the terminal, unless the browser has a choice of its own. The user can move it out
later (row menu → **Move out**). The server files the child where the parent is — the parent's
virtual folder, and the parent's project when the child's folder belongs to no project. A folder that
another project already claims keeps that project, so the child is drawn under that project instead;
say so when you report the launch.

User request: **$ARGUMENTS**

## Child or top-level

- **Child (the default):** send `"nestedUnderId": "$HANGAR_SESSION_ID"` — Hangar sets that variable in
  every session it launches, so the parent is this session. When the user names a different parent
  (`--parent <id>`), send that id instead; that also works from a session Hangar didn't launch.
- **Top-level:** leave `nestedUnderId` out. Only when the user asks for a top-level/unnested session
  (`--top-level`), or when `HANGAR_SESSION_ID` is empty (this session wasn't launched by Hangar, so
  there is no parent to nest under). In the second case, say that you fell back to a top-level session
  and why.

## What to do

1. Check the environment:

   ```bash
   echo "url=[$HANGAR_URL] id=[$HANGAR_SESSION_ID] key=[${HANGAR_API_KEY:+present}]"
   ```

   `HANGAR_URL` empty → use `http://127.0.0.1:5099` and mention it.
2. Parse `$ARGUMENTS` into request fields using the table below. The arguments are free-form — map
   them by meaning, not position (a path → `workingDirectory`, `opus`/`sonnet`/`haiku` → `model`, a
   quoted sentence or `/slash-command` → `initialPrompt`, `--parent <id>` or "under session X" →
   `nestedUnderId`, and so on).
3. Fill the gaps:
   - No folder given → the current project's root directory, as an absolute path; say which you chose.
   - No permission mode given → `"permissionMode": "auto"`. This is the one field to fill in rather
     than leave to the server; see Fields below.
   - A task described but no name → derive a short `name` from it and append `-MMdd-HH:mm` (the
     local time, e.g. `nightly-0709-14:03`).
   - Nothing else given → send nothing else; the server's defaults are correct.
4. Pick child or top-level (above).
5. Show the request you're about to send, then send it (next section).
6. Report the result: session `id`, `name`, `state`, `processId`, the folder, and whether it was
   nested under this session (or under the id given; it then opens on that session's chat/terminal
   view) or launched top-level. Mention that `remoteUrl` (the claude.ai deep link) is null right after
   creation — it appears once the session prints it, so check the Hangar UI or the Claude Code app.

Ask before launching only when the request is ambiguous in a way that changes what launches —
which folder, or whether to resume existing work versus start clean. Otherwise just launch it.

## Send the request

Build the JSON with an encoder, not by pasting text into a string: a prompt is free text, and one
quote or backslash in it breaks a hand-written body.

```bash
python -c 'import json,sys; print(json.dumps({
  "workingDirectory": sys.argv[1], "name": sys.argv[2], "permissionMode": "auto",
  "nestedUnderId": sys.argv[3], "initialPrompt": sys.argv[4]}))' \
  "/home/me/src/myproject" "nightly-0709-14:03" "$HANGAR_SESSION_ID" "run the tests and fix any failures" |
curl -s -w '\n%{http_code}\n' -X POST "${HANGAR_URL:-http://127.0.0.1:5099}/api/external/sessions" \
  ${HANGAR_API_KEY:+-H "X-Api-Key: $HANGAR_API_KEY"} \
  -H "Content-Type: application/json; charset=utf-8" --data-binary @-
```

(`python3` where `python` isn't one. Drop the keys you aren't sending from the dict.)

PowerShell, where `ConvertTo-Json` does the escaping:

```powershell
$url = if ($env:HANGAR_URL) { $env:HANGAR_URL } else { 'http://127.0.0.1:5099' }
$body = @{
  workingDirectory = 'C:\src\myproject'; name = 'nightly-0709-14:03'; permissionMode = 'auto'
  nestedUnderId = $env:HANGAR_SESSION_ID; initialPrompt = 'run the tests and fix any failures'
} | ConvertTo-Json -Compress
$headers = @{}; if ($env:HANGAR_API_KEY) { $headers['X-Api-Key'] = $env:HANGAR_API_KEY }
Invoke-RestMethod "$url/api/external/sessions" -Method Post -Headers $headers `
  -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
```

Hangar's `scripts/hgr-new-session.ps1` wraps the same request (`-Child` fills in `nestedUnderId`),
if it is on `PATH` and you'd rather call it.

| Code | Meaning | What to do |
| --- | --- | --- |
| `201` | Launched. Body is the session (`id`, `name`, `state`, `processId`, …) | Report it |
| `400` | Bad folder or field, with the reason in the body — or `No session '<id>' to put this one under` (the parent is gone) | Nothing was launched. Fix what it names |
| `401` | A password is set and no valid key was sent | Say `HANGAR_API_KEY` must hold the server's `Auth:ApiKey`, and stop. Don't go looking for the key in config files |
| connection refused | Hangar isn't running | Say so |

## Fields

Only `workingDirectory` is required. **Anything you omit is left out of the request**, so the
server applies its own default — omit rather than guess. The single exception is `permissionMode`:
always send it, defaulting to `auto`.

| Field | Default | What it does |
| --- | --- | --- |
| `workingDirectory` | — (required) | Folder the session runs in. Must exist. Always an absolute path. |
| `nestedUnderId` | none (top-level) | **Send it** (unless top-level): the session to nest under — `$HANGAR_SESSION_ID`, or the `--parent` id. |
| `name` | server-generated | Session name in the web UI and the Claude Code app. |
| `model` | account default | `opus`, `sonnet`, `haiku`, or a full model id. |
| `initialPrompt` | none | Prompt sent as soon as the session starts — this is how the new session gets its task. A slash command works (`/my-command args`), and must then come first. |
| `permissionMode` | **send `auto`** (server default is `default`) | `default` \| `auto` \| `acceptEdits` \| `bypassPermissions`. `auto` auto-approves routine actions (edits, most commands) but still asks before genuinely destructive ones like force-push or production deploys. |
| `remoteControl` | `true` | `false` keeps it out of the Claude Code app (web UI only). |
| `continue` | `false` | `true` resumes the folder's **most recent** conversation (`claude --continue`). |
| `resumeSessionId` | none | Resume one **specific** conversation by Claude session id (`claude --resume <id>`). Beats `continue`; prefer it when the id is known, since a folder can hold many conversations. |
| `color` | none | Session color name (as set by `/color`), for grouping in the list. |

## Rules

- **Never let a child silently become top-level.** If the server answers `No session '<id>' to put
  this one under` (400 — the parent was closed and forgotten), nothing was launched. Report it; fall
  back to a top-level launch only in the no-`HANGAR_SESSION_ID` case described above, and never retry
  with the same bad parent id.
- **This starts a real, billed agent that acts on a real folder.** It is not a dry run. Launch one
  session per request; if a call errors, read the error before retrying — a session may already be
  running.
- **Never choose `bypassPermissions` yourself.** It disables every safety prompt for that session, and
  with an `initialPrompt` it then runs unattended with no human in the loop. Use it only when the user
  explicitly asks for it by name.
- **`auto` is the default for this command** — send it unless the user names a different mode. It
  auto-approves routine actions but still stops for genuinely destructive ones, so the launched
  session gets on with its task without a human at the terminal. Use `default` when the user wants to
  drive the new session interactively, and `acceptEdits` when they want file writes waved through but
  every command confirmed.
- Only send `continue` / `resumeSessionId` when the user asked to resume. On an unfamiliar folder
  they can silently pick up a conversation neither of you knows about.
