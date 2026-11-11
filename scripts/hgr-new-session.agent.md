# `hgr-new-session.ps1` — agent reference

Launches a **new Claude Code session** on this machine through the Hangar server
(`POST /api/external/sessions`). The session runs as a real `claude` process in the folder you
name, shows up in the web UI, and — with Remote Control on — in the Claude Code app.

Call it by name once the repo's `scripts` folder is on `PATH` (for example, in PowerShell:
`[Environment]::SetEnvironmentVariable('PATH', "$env:PATH;<repo>\scripts", 'User')`, then open a new
shell), or call it by its full path, `<repo>\scripts\hgr-new-session.ps1`. The examples below assume
it is on `PATH`.

## Before you call it

1. The Hangar server must be running (default `http://127.0.0.1:5099`).
2. `$env:HANGAR_API_KEY` holds the key from `Auth:ApiKey` (the install's `appsettings.Local.json` or
   `appsettings.json`), when one is set; `-ApiKey <key>` overrides it. Without a key the request is
   sent without an `X-Api-Key` header, and a server that wants one answers 401 -- the script then
   says so.

## How to invoke

From PowerShell (PowerShell resolves `.ps1` files on `PATH`; otherwise give the full path):

```powershell
hgr-new-session.ps1 -WorkingDirectory C:\Git\myproject -Name build -Model opus
```

From bash/cmd, go through PowerShell so `PATH` lookup still applies (or use `-File <full path>`):

```bash
powershell -NoProfile -Command "hgr-new-session.ps1 -WorkingDirectory C:\Git\myproject -Name build"
```

## Parameters

Only `-WorkingDirectory` has a default. **Anything you omit is left out of the request entirely**,
so the server's own default applies — omit rather than guess.

| Parameter | Type | Default | What it does |
| --- | --- | --- | --- |
| `-WorkingDirectory` | string (positional 0) | current directory | Folder the session runs in. Must exist. Give an absolute path — the current directory is rarely what you want. |
| `-Name` | string | server-generated | Session name shown in the UI and app. |
| `-NameTimestamp` | switch | off | Appends `-MMdd-HH:mm` to `-Name` (`build` → `build-0709-14:03`). No effect without `-Name`. Use it when you launch the same named job repeatedly. |
| `-Model` | string | account default | `opus`, `sonnet`, `haiku`, or a full model id (e.g. `claude-opus-4-8`). |
| `-InitialPrompt` | string | none | Prompt sent the moment the session starts. A slash command works here (`/review`). This is how you give the new session its task. |
| `-PermissionMode` | string | `default` | One of `default`, `auto`, `acceptEdits`, `bypassPermissions`. Validated — anything else is a parameter-binding error. See the safety note below. |
| `-RemoteControl` | bool | `$true` (server-side) | `-RemoteControl:$false` keeps the session out of the Claude Code app (web UI only). |
| `-Continue` | switch | off | Resume the folder's **most recent** conversation (`claude --continue`) instead of starting fresh. |
| `-ResumeSessionId` | string | none | Resume one **specific** conversation by its Claude session id (`claude --resume <id>`). Takes precedence over `-Continue`; prefer it when you know the id, since one folder can hold many conversations. |
| `-Color` | string | none | Session color name (same values `/color` accepts), for visual grouping in the list. |
| `-NestUnderSessionId` | string | none | Draw the new session under this one in the sessions list (its `nestedUnderId`). An arrangement of the list only — the new session has its own conversation and is not a fork. It opens on the chat or the terminal, whichever that session is on. An id no session answers to is a 400, not a silently top-level session. |
| `-Child` | switch | off | Nest under the session this runs inside: fills `-NestUnderSessionId` from `$env:HANGAR_SESSION_ID`. Without it set it exits 1 instead of launching at the top level. An explicit `-NestUnderSessionId` wins. Use this whenever you launch a session from inside one. |
| `-BaseUrl` | string | `$env:HANGAR_URL` (set inside a session), else `http://127.0.0.1:5099` | Server base URL — set it when targeting another machine. |
| `-ApiKey` | string | `$env:HANGAR_API_KEY` | Sent as the `X-Api-Key` header; no header when there is no key. |
| `-PassThru` | switch | off | Return the session object instead of printing a formatted list — use this when you need to read the result. |
| `-Verbose` | switch | off | Prints the exact URL and JSON body before sending. Best first move when a call misbehaves. |

## Output and exit codes

- **Success:** exit 0. Default output is `Session created:` plus a `Format-List` dump. With
  `-PassThru` you get the object; pipe it to `ConvertTo-Json` to parse it.
- **Failure:** exit 1, message on stdout in red, plus the server's error body when there is one.
  Common causes: server not running (connection refused), wrong/missing key (401), non-existent
  `-WorkingDirectory` (400 with the reason).

Useful response fields: `id` (Hangar session id — use it against `/api/sessions/{id}`),
`name`, `state`, `processId`, `remoteUrl` (claude.ai deep link; **null right after creation** — it
only appears once the session prints it, so don't expect it in this response), `createdAt`.

```powershell
$s = hgr-new-session.ps1 -WorkingDirectory C:\Git\myproject -PassThru
$s.id; $s.state
```

## Multi-line and long prompts

`-InitialPrompt` takes the whole string, newlines and all. Use a single-quoted here-string so
PowerShell leaves `$`, backticks and quotes alone — the closing `'@` must sit at column 0:

```powershell
hgr-new-session.ps1 -WorkingDirectory C:\Git\myproject -PermissionMode auto -InitialPrompt @'
Review the diff on this branch.
Write the findings to review.md, one heading per file.
Don't commit anything.
'@
```

Two things to know:

- **Run the script with `pwsh`, not Windows PowerShell 5.1.** Under 5.1 the `.ps1` is read as ANSI
  and `Invoke-RestMethod` doesn't send the body as UTF-8, so any non-ASCII text (Cyrillic, em dashes,
  emoji) reaches the server corrupted. `pwsh` sends it byte-for-byte.
- The prompt travels to `claude` as a command-line argument, so it is bounded by the Windows
  command-line limit (32,767 characters) — far above anything you'd type, but not unlimited. Before
  the shim resolution in `ClaudeExecutableResolver`, a launch that went through `cmd.exe` capped it
  at ~8,000 characters and cut it at the first newline; if you ever see a prompt arrive truncated,
  that fallback path is the thing to check.

## Examples

```powershell
# Minimal: session in a given folder, all server defaults
hgr-new-session.ps1 -WorkingDirectory C:\Git\myproject

# Named, timestamped, with a task to run on start
hgr-new-session.ps1 -WorkingDirectory C:\Git\myproject -Name nightly -NameTimestamp `
    -Model opus -PermissionMode auto -InitialPrompt 'run the tests and fix any failures'

# Pick up where the folder left off
hgr-new-session.ps1 -WorkingDirectory C:\Git\myproject -Continue

# Under the session you're running in (fails if there is none)
hgr-new-session.ps1 -WorkingDirectory C:\Git\myproject -Child -PermissionMode auto

# Resume one exact conversation
hgr-new-session.ps1 -WorkingDirectory C:\Git\myproject -ResumeSessionId 3f2b1c8a-...

# Against another machine, web UI only, capture the id
$s = hgr-new-session.ps1 -WorkingDirectory C:\Git\myproject `
    -BaseUrl http://build-box:5099 -RemoteControl:$false -PassThru
```

## Rules for calling this

- **This starts a real, billed agent that acts on a real folder.** It is not a dry run. Create a
  session only when the user asked for one; don't retry a "failed" call until you've confirmed from
  the error which side failed — a session may already be running.
- **Never pass `-PermissionMode bypassPermissions` on your own initiative.** It disables every
  safety prompt for that session, and combined with `-InitialPrompt` it runs unattended with no
  human in the loop. Use it only on an explicit, specific request from the user.
- Give `-WorkingDirectory` explicitly. Relying on the current-directory default silently launches
  the session wherever the shell happened to be.
- `-Continue` and `-ResumeSessionId` both resume prior work; on an unfamiliar folder that can pick
  up a conversation you know nothing about. Omit both to start clean.
- Quote paths with spaces, and keep `-InitialPrompt` in single quotes (or a `@'...'@` here-string)
  so PowerShell doesn't expand `$` or backticks inside it.
