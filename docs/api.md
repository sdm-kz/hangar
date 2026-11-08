[← Hangar](../README.md)

# API

## Programmatic session creation

An external program (script, CI, automation) can launch a session without the browser login via
`POST /api/external/sessions`, authenticated with an **API key in the `X-Api-Key` header**. Set
`Auth:ApiKey` in `appsettings.Local.json` to enable it. With no `Auth:ApiKey` the endpoint answers only
while no password is set, and then only local requests, like the rest of the API. The JSON
body is exactly what the "New session" dialog sends:

```bash
curl -X POST http://localhost:5099/api/external/sessions \
  -H "X-Api-Key: <your-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "workingDirectory": "C:\\src\\myproject",
    "name": "nightly-build",
    "remoteControl": true,
    "model": "opus",
    "initialPrompt": "run the tests and fix any failures",
    "permissionMode": "auto"
  }'
```

Only `workingDirectory` is required. `model` is `opus`/`sonnet`/`haiku` (or omit for default),
`permissionMode` is `auto`/`default`/`acceptEdits`/`bypassPermissions`. On success it returns
`201` with the session JSON (same shape the UI uses); the session then appears in the web UI and,
if `remoteControl` is true, in the Claude Code app. The key authorizes `/api/external/*` only — the
rest of `/api/*` still requires the browser bearer token.

**From PowerShell**, [`scripts/hgr-new-session.ps1`](../scripts/hgr-new-session.ps1) wraps this endpoint:
every request field is a parameter, the key and URL come from `HANGAR_API_KEY` and `HANGAR_URL`
(default `http://127.0.0.1:5099`), and `-Child` nests the new session under the one the script is
running inside. Its full reference, written for agents calling it, is
[`scripts/hgr-new-session.agent.md`](../scripts/hgr-new-session.agent.md).

```powershell
$env:HANGAR_API_KEY = "<your-key>"
scripts\hgr-new-session.ps1 -WorkingDirectory C:\src\myproject -Name build -PermissionMode auto `
    -InitialPrompt 'run the tests and fix any failures'
```

**Talking to a session you started.** `POST /api/external/sessions/{id}/message` sends one message to
a running session's Claude, exactly as typing it into the terminal would — the text goes in as a
bracketed paste, so newlines in it stay part of the one message instead of submitting a line at a
time, and a single Enter follows it:

```bash
curl -X POST http://localhost:5099/api/external/sessions/<id>/message \
  -H "X-Api-Key: <your-key>" \
  -H "Content-Type: application/json" \
  -d '{"text": "now open a PR for that"}'
```

`200` when it was delivered, `404` when the id names no *running* session. Sending several in a row
needs a gap of ~150 ms between them, or Claude Code's input box merges them into one message. The
browser's own route for this is `POST /api/sessions/{id}/message`, behind the bearer token.

**Reading what a session said.** `GET /api/sessions/{id}/chat` (bearer token) is what the chat view
reads: the session's conversation as Claude writes it to its transcript, cut down to what a chat draws
(tool input and output trimmed to 4,000 characters, pasted images left out). It is incremental — pass
back the `conversation` and `offset` of the last answer and only what was written since comes back;
`reset: true` means the conversation changed (a `/clear`) and the answer starts from the top. A first
read of a very long transcript takes its last 6 MB and says `truncated: true`. Each answer also carries
`status` — the session's `model`, `contextPercent` and `contextWindow` as its status line last reported
them — once there is one; assistant entries carry their `model` and `context` (tokens in context).

**A session's status line.** `POST /api/self/statusline` (`X-Session-Id` / `X-Hook-Token`, like the
other self endpoints) is what the status-line command Hangar launches each session with calls: it posts
the JSON Claude pipes to a status line and gets back the line to show, as plain text.

**Slash commands.** `GET /api/sessions/{id}/commands` (bearer token) lists the slash commands Claude
would take in the session's folder, for the chat's autocomplete: `name`, `source` (`builtin`,
`project`, `user`, `plugin`), and, where known, `description`, `hint` (the argument) and `dialog` (it
answers in the terminal). It is read from disk — `.claude/commands` and `.claude/skills` in the folder
and its parents and in `~/.claude`, enabled and synced plugins — plus a built-in table for Claude Code
2.1, so a command a newer Claude adds can be missing until Hangar catches up.

## Self-service API for a running session

A running session can act on **itself** — rename itself, open files or pull requests in its own tab
bar, point its branch badge at a worktree, send you a notification, close itself and the sessions under it — with no browser
login and no API key: every session Hangar launches carries its own credentials in its environment,
and they are all the calls take.

| Env var             | What it is                                                       |
| ------------------- | ---------------------------------------------------------------- |
| `HANGAR_URL`        | Base URL of the app, on loopback (e.g. `http://127.0.0.1:5099`)  |
| `HANGAR_SESSION_ID` | This session's id — also the session the calls act on            |
| `HANGAR_HOOK_TOKEN` | Local secret that authorizes the call (also used by the hooks)   |

The session id comes from the header injected at launch, so a session can only ever act on itself —
the endpoints can't be aimed at another session (the one exception, closing, reaches no further than
the sessions drawn under the caller), and they stay shut to anything that can't read that session's
environment. Same trust boundary as the `/api/hooks` callback. The token is minted once and
kept in `auth.json`, not regenerated per app run, because a session's environment is fixed when its
`claude` process starts and that process outlives the app.

All of them answer `401` when the headers are missing or wrong.

### Rename: `POST /api/self/name`

A `claude` command (or a hook, or any script the session runs) can name the session after the work it
turns out to be doing:

```bash
curl -s -X POST "$HANGAR_URL/api/self/name" \
  -H "X-Session-Id: $HANGAR_SESSION_ID" \
  -H "X-Hook-Token: $HANGAR_HOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"refactor auth middleware"}'
# {"id":"664d6618…","name":"refactor auth middleware"}
```

The name is stripped of control characters, trimmed, and capped at 100 characters. Responses are
`200` with the applied name, `400` when the name is empty, and `404` when the id names no session.

The effect is exactly the sidebar rename: the display name changes everywhere and `/rename <name>`
is injected into the session's terminal so Claude's own conversation title follows. A session that
renames itself *mid-turn* has that `/rename` land in its own input queue, so Claude runs it once the
current turn finishes.

### Notify: `POST /api/self/notify`

Puts a message in front of you on purpose: Claude saying *the benchmark finished, accuracy held*
instead of you finding the session gone quiet and reading back to see why. It goes out as a Web Push to
every subscribed device and as an OS notification in every open tab, titled with the session's name
(and `title`, when given). Tapping it opens the session.

```bash
curl -s -X POST "$HANGAR_URL/api/self/notify"   -H "X-Session-Id: $HANGAR_SESSION_ID"   -H "X-Hook-Token: $HANGAR_HOOK_TOKEN"   -H "Content-Type: application/json"   -d '{"title":"Benchmark done","message":"Accuracy 97.8% (was 97.6%), 14 min."}'
# {"id":"3f9a1c0e7b2d","devices":2}
```

`devices` is how many devices the push went to; `0` means only an open tab will show it. The title is
cut to 120 characters and the message to 1000. Responses are `400` when the message is empty, `404`
when the id names no session, and `429` after six notifications from the same session within a
minute (or twenty from all of them). To be told when something you leave running in the background ends, chain the call after
it, so it fires whether or not Claude is around to notice:
`./bench.sh; curl … -d "{\"message\":\"bench exited $?\"}"`.

### Open files: `POST /api/self/open`

Opens a file of the session's working directory as a **tab in its own tab bar**, next to
Terminal/Split/Files, the way clicking it in the Files panel would:

```bash
curl -s -X POST "$HANGAR_URL/api/self/open" \
  -H "X-Session-Id: $HANGAR_SESSION_ID" \
  -H "X-Hook-Token: $HANGAR_HOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"paths":["server/Program.cs","web/src/App.tsx"]}'
# {"id":"664d6618…","opened":["server/Program.cs","web/src/App.tsx"],"missing":[],"active":"web/src/App.tsx"}
```

`path` (one string) and `paths` (an array) are both accepted and add up; the last file opened
becomes the active tab. Paths are relative to the session's working directory — an absolute path
inside it is fine too — and anything that escapes it, names a folder, or isn't there comes back in
`missing` rather than opening. `"pin": false` puts the file in the single transient *preview* slot
that a click in the tree reuses, instead of giving it a tab of its own.

Responses are `200` with what opened, `400` when no path was given or none of them resolved, and
`404` when the id names no live session.

The tabs live in the same server-side UI bag the browsers keep them in (`session-ui.json`, keyed by
conversation), so the new tab reaches **every** device the session is open on and survives a reopen.
What the call deliberately does *not* do is take over the pane: a browser on the Terminal view keeps
it, with the tab waiting in the bar, while one already showing Files/Split/a file follows to the newly
opened file. Which surface is on screen belongs to the person looking at it; the open tabs are shared
state. Fifty tabs is the ceiling for one session; past it the oldest give way.

### Open a pull request: `POST /api/self/open-pr`

Opens a GitHub pull request as a tab in the calling session's tab bar — the tab the PR picker would
have made. Name it by `repo` and `number`, or by its `url` (the one `gh pr create` prints):

```bash
curl -s -X POST "$HANGAR_URL/api/self/open-pr" \
  -H "X-Session-Id: $HANGAR_SESSION_ID" \
  -H "X-Hook-Token: $HANGAR_HOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repo":"cli/cli","number":42}'
# {"id":"664d6618…","repo":"cli/cli","number":42,"title":"…","key":"cli/cli#42"}
```

Leave `repo` out for the session folder's own repo (its `origin` remote). Any repo `gh` can read
works — it doesn't have to be one of the repos linked to the session. GitHub is asked for the
title before the tab is made, so a wrong number or repo comes back as an error instead of a tab
that can only show one.

Responses are `200` with what opened, `400` with an `error` when the PR can't be named or read (no
number, a malformed repo or URL, a folder that isn't a GitHub repo and no `repo` given, or `gh`'s
own answer — no such PR, not signed in, offline), and `404` when the id names no live session.

The tab goes into the shared UI bag like the picker's, so it reaches every device, and a PR that
is already open is the same tab, not a second one, with its title refreshed. A *new* tab arrives
active: a browser with the session open shows it, in the group already showing a review if there
is one. Re-opening one that is already in the bar does not move anyone's view. Eight reviews is the
ceiling, as in the picker; past it the oldest gives way, along with its folds and scroll position.

### Show a worktree's branch: `POST /api/self/worktree`

A session that starts a task in a fresh worktree is still running in its main folder, so its
header's branch badge goes on naming the folder's branch rather than the one the work is on. This
points the badge at another worktree of the same repo, named by its `branch` or its `path` (absolute,
or relative to the working directory):

```bash
curl -s -X POST "$HANGAR_URL/api/self/worktree" \
  -H "X-Session-Id: $HANGAR_SESSION_ID" \
  -H "X-Hook-Token: $HANGAR_HOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"branch":"AB-123-fix-login"}'
# {"id":"664d6618…","worktree":"C:/src/myproject-worktrees/AB-123-fix-login","branch":"AB-123-fix-login"}
```

Send `{}` to go back to the session's own folder; a worktree that *is* its own folder counts as that
too, and answers `"worktree": null`. The badge then shows that worktree's branch and change count
(its icon turns to a blue folder), and clicking it opens that worktree's changes in the Files panel.
The chevron beside the badge picks the same thing by hand, and `POST /api/sessions/{id}/git/worktree`
takes the same body from the browser's side.

Responses are `200` with the worktree and its branch, `400` with an `error` when both are given or the
one given doesn't resolve (a folder that is not a worktree of the session's repo, a branch no
worktree has checked out, a session folder that isn't a repo), and `404` when the id names no
session. The pick lives in the session's shared UI bag (`gitWorktree`), so every device shows it and
it survives a reopen; a worktree removed later quietly falls back to the session's own branch.

### List the sessions under this one: `GET /api/self/children`

Everything drawn under the calling session in the list, at any depth: what it launched as a child
(`hgr-new-session.ps1 -Child`), what it forked, what was dragged under it by hand, and what those have
under them in turn. Parents come before their children.

```bash
curl -s "$HANGAR_URL/api/self/children" \
  -H "X-Session-Id: $HANGAR_SESSION_ID" \
  -H "X-Hook-Token: $HANGAR_HOOK_TOKEN"
# {"id":"664d6618…","name":"auth refactor","children":[
#   {"id":"8f2c1b…","name":"auth refactor-review","parentId":"664d6618…","depth":1,"state":"Running",
#    "busy":false,"folder":"C:\\src\\myproject","createdAt":"…"}]}
```

`state` is `Running`, `Exited`, `Failed`, or `Restorable` for a session that is closed but still in
the list; `busy` says Claude is mid-turn there. `404` when the caller is no longer a session.

### Close: `POST /api/self/close`

Closes sessions under the caller, or the caller itself, once the work they were for is done — a
review session whose report is in, a batch of sub-tasks that have all finished. Name them by `id`
(one) and/or `ids` (several), as `GET /api/self/children` lists them; `"self"` stands for the caller.

```bash
curl -s -X POST "$HANGAR_URL/api/self/close" \
  -H "X-Session-Id: $HANGAR_SESSION_ID" \
  -H "X-Hook-Token: $HANGAR_HOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ids":["8f2c1b…"]}'
# {"id":"664d6618…","closed":[{"id":"8f2c1b…","name":"auth refactor-review"}],"removed":[],"skipped":[],"self":false}
```

Closing is what the sidebar's close does: the process stops and the row stays, in its folder and
reopenable. `"remove": true` takes the rows out of the list as well (an already-closed session
included), the way removing a closed row does. Rules:

- **Only the caller and what is under it.** The hook token is shared by every session on the
  machine, so an id outside the caller's subtree — a sibling, the caller's own parent, a session
  somewhere else — is refused (`skipped`, reason `not this session or one under it`) rather than
  closed. Closing anything else is for the UI, or for `DELETE /api/sessions/{id}` behind a login.
- **A session takes its subtree with it**, deepest first, so nothing is left running under a closed
  parent.
- **A session mid-turn is skipped** (reason `busy`) unless `"force": true`, so "close all children"
  can't cut off one that is still writing its result. One already closed is skipped as `already
  closed`, unless removing.
- **The caller goes last, after the answer.** With `"self"` (or its own id) in the list, the response
  comes back with `"self": true` and the caller's own process is stopped half a second later.

Every close is logged (`SelfApi`) with the session that asked for it. Responses are `200` with what
happened to each session, `400` when no id was given, and `404` when the caller is no longer a
session.
