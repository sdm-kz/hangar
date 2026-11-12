[← Hangar](../README.md)

# Slash commands for sessions

Hangar ships a set of Claude Code slash commands that let a session use Hangar itself: name itself
after its work, put files and pull requests in front of you, ping your phone, and start and close
sessions of its own. Type them in a session's terminal or chat like any other command
(`/hgr-notify when the build finishes`), or ask for what they do in plain words ("tell me when the
tests are done") and Claude picks the command up on its own.

They are thin wrappers over the [self-service API](api.md#self-service-api-for-a-running-session): each
one tells Claude how to make the call, what the answer means, and when not to make it.

| Command | What it does | Arguments |
| --- | --- | --- |
| `/hgr-rename-session` | Renames this session in the sidebar (and Claude's own title with it) | The name, or nothing for one picked from the work so far |
| `/hgr-notify` | Sends you a notification: a push to your phone and an alert in every open Hangar tab. Now, or armed to fire when a background command ends | The message, `when <what> finishes`, or nothing for what just finished |
| `/hgr-open-file` | Opens files as tabs in this session's tab bar, on every device the session is open on | Paths in the session's folder, or nothing for the files the conversation is about |
| `/hgr-open-pr` | Opens a GitHub pull request as a review tab in this session's tab bar | A PR URL, a number, or `owner/name 42`; nothing for the PR just created |
| `/hgr-run-session` | Starts a new session nested under this one in the sidebar, with a task of its own | Folder, name, model, prompt, `--mode`, `--continue`/`--resume <id>`, `--parent <id>`, `--top-level` |
| `/hgr-run-session-review` | Starts a child session that reviews this branch, writes `.review/review-<branch>.md` and messages this session when it's done. A second run sends the same reviewer a new round instead | `all` (default), `uncommitted` or `branch`; a base branch; an extra focus |
| `/hgr-close-session` | Closes sessions under this one, or this one itself: by name, id, `it` (the one that just reported), or a description like `all review sessions` | The target; `--remove` takes them out of the list too, `--force` closes one mid-turn |

They work in sessions Hangar started. Anywhere else the session credentials aren't there, and the
command says so and stops.

## How they get installed

Every time Hangar starts, it writes them into **`~/.claude/commands`** (`%USERPROFILE%\.claude\commands`
on Windows), on every kind of install: the one-line installer, a checkout's `deploy.ps1` or
`install-unix.sh`, a Windows service, an in-app update, a paired node. An update therefore brings the
commands that match its API. The source is the repo's [`claude-commands`](../claude-commands) folder,
built into the executable.

Each file Hangar writes ends with a line that marks it as Hangar's:

```
<!-- hangar-managed: Hangar installs this file and rewrites it on every start. Delete this line to keep your own version. -->
```

- **A file with that line is Hangar's.** It is rewritten when the build ships something different, and
  deleted when a build no longer ships it.
- **A file without it is yours, and is never touched.** That covers a command of the same name you
  wrote before Hangar shipped one: Hangar leaves it in place and says so in its log. Delete it to get
  Hangar's.
- **To change one of Hangar's commands**, edit it and delete the marker line. From then on it is yours
  and updates pass it by. To go back, delete the file and restart Hangar.
- **To install none of them**, set `ClaudeCommands:Enabled=false` ([Configuration](configuration.md)).
  Files already written stay until you delete them.

Dev instances (`scripts/dev.ps1`, `scripts/run.ps1`, the debug launch profile) don't write them:
`~/.claude/commands` is shared by every `claude` on the machine, and the installed app keeps them at the
version it serves.

## What they need

- **`curl`**, which Windows 10 and later, macOS and most Linux systems have. In PowerShell, Claude uses
  `Invoke-RestMethod` instead.
- **For `/hgr-run-session` and `/hgr-run-session-review`:** these start sessions through
  `POST /api/external/sessions` ([API](api.md#programmatic-session-creation)). While no password is set
  that needs nothing more. Once one is, set `Auth:ApiKey` on the server and put the same key in
  `HANGAR_API_KEY` in the environment Hangar runs in, so its sessions inherit it. Without the key the
  command reports a `401` and launches nothing. To build the request, they use Python's `json` module
  in bash, or `ConvertTo-Json` in PowerShell.
- **For `/hgr-open-pr`:** the [GitHub CLI](https://cli.github.com/) signed in on the machine Hangar runs
  on, as for the pull-request tabs.
- **For `/hgr-run-session-review` reporting back:** Claude Code's cross-session messaging
  (`ListAgents` / `SendMessage`). Without it the review file is still written; only the
  finished-message is missing.

The reviewer works from the brief the command writes. If you have a review command of your own (a
`/review` in `~/.claude/commands`), keep a copy of `hgr-run-session-review` without the marker and
start its brief with that command.

## Removing them

Uninstalling Hangar leaves them in place. Delete `~/.claude/commands/hgr-*.md`, or only those that end
with the `hangar-managed` line if some are your own.
