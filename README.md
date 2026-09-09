# Homeport

> **Name:** the project will be renamed to **Homeport** (the home port your remote sessions launch
> from). The rename (repo, `ClaudeWeb.exe`, namespaces) is not done yet — for now the executable is
> still `ClaudeWeb.exe`.

A .NET 10 **Windows tray application** (backend + web UI in one `.exe`) that **launches Claude Code
CLI sessions with Remote Control enabled** so you can drive them from the **Claude Code app**
(claude.ai/code and mobile) — from any device on your LAN.

Run `ClaudeWeb.exe` and it starts the web host in-process and drops an icon in the system tray:

- **Left-click** the tray icon → opens the web UI in your browser.
- **Right-click** → menu listing running sessions, plus **Exit**. Each project is a submenu, and
  inside it the sessions are laid out the way the sidebar's grouped view lays them out with its
  active-only filter on: virtual folders first, then folder groups (dropped where the project links
  only that folder and there is no virtual folder to tell it apart from), forks under the session
  they came from, and no submenu for a project with nothing running in it. Click a session to open it.
- Runs as a single instance; launching it again just reopens the UI.
- The same exe also runs headless as a **Windows service** (auto-detected) if you prefer.

The web UI is a **session manager with a full terminal**:

- **Create / select sessions** — each session is a live `claude --remote-control` process in a
  working folder of your choice.
- **Control from the Claude Code app** — launched sessions register for Remote Control and appear
  by name in the app's session list (computer icon + green dot). All interaction happens there.
- **Fork a session** — branch a conversation in two from the sessions list or the session header:
  name the fork, and it launches beside the original with the same folder and settings, picking up
  its history (`claude --resume <id> --fork-session`). The original keeps running, untouched. Forks
  nest under their parent in the sessions list, and each one's header links back to it.
- **Projects** — name a project, give it a colour, and link the folders it spans (any number,
  unrelated to each other). Projects head both session views: grouped, the folder groups sit under
  their project; flat, the sessions themselves do, with no folder headings in between. A project
  that is just one folder drops the folder heading in the grouped view too — its sessions hang
  straight off the project, since the two headings would say the same thing. Anything unfiled
  follows under *No project*. A linked folder covers everything **under** it too, so a new
  worktree or nested repo — and any session started there — joins by itself. Drag a folder group
  onto a project to move it (or onto *No project* to take it out), or use the folder's ⋯ menu. The
  **+** on a project heading starts a session in it: the create dialog offers the project's linked
  folders as one-click picks (filling it in when there's only one) and still takes any other folder.
  Stored server-side, so projects follow you across devices.
- **Virtual folders** — named boxes inside a project, each with its own colour and icon, holding
  sessions you put there by hand. The folder a session runs in is often the wrong unit: three
  sessions in one repo can be three unrelated errands, and two sessions in different repos can be
  one piece of work. Add them in the project's settings, then **drag a session onto a box** to file
  it there. The row's ⋯ menu offers the same move without a drag — the only way on touch — listing
  the project's groups the way it lists its projects, with **New group…** at the end: name it, give
  it a colour and an icon, and the session you opened the menu from is in it. Drag it back
  onto the project heading to take it out. A filed session is drawn in its box and nowhere else, so
  the folder groups thin out as you use them; the boxes sit above the folder groups in both views,
  and fold away like any other heading. A session can only go into a box of the project its own
  folder belongs to — a group refines where a session sits, it never moves it between projects — so
  a folder that later leaves the project quietly hands its sessions back to the folder grouping,
  and putting the folder back brings the grouping back with it. Membership is keyed by the
  conversation, like a pin, so it survives reopening the session, and lives server-side alongside
  the project.
- **Folder picker** — autocomplete over the *server machine's* filesystem, with keyboard
  navigation (↑/↓/Enter) and recently-used folders.
- **File browser** per session — a lazy directory tree on the left, preview on the right:
  - **Text/code** files rendered inline and **editable** (Edit → Save writes the file);
    **images** with a full-page **zoom/pan** lightbox; **Markdown** rendered (Rendered/Raw toggle);
    anything else is downloadable.
  - **Git**: if the folder is a repo, the current **branch** is shown, changed files are
    **marked** (M/A/U/D) in the tree, and each changed file has a **Diff** view.
  - **Search** the whole tree, **download** any file, and the tree **auto-refreshes** as files
    change on disk (via a filesystem watcher) while preserving expanded folders.
  - **Linked folders** — attach extra folders to a session and browse/edit them from the same panel
    via the root picker. Saved server-side against the session's working folder, so they survive a
    restart (and a resumed session's new id).
- **Shell tabs** per session — a real shell in the session's folder, beside the Claude terminal and
  the files, opened from the **+** at the end of the tab bar. The chevron next to it lists what the
  *server machine* actually has: **PowerShell 7**, **Windows PowerShell**, **Command Prompt**,
  **Git Bash**, and one entry per installed **WSL distribution** (a WSL tab opens with `--cd`, so it
  starts in the same folder as `/mnt/c/…`). A bare **+** reopens whichever you picked last. The tabs
  live server-side, so they show up on every device looking at that session — and each one runs in
  its own pty host, so a build left running in a shell **survives a restart of the app** exactly as a
  session does. Closing a tab kills what's in it; stopping the session closes its shells with it.

  The **Files** tree offers the same thing for any folder, session or not: the terminal button on a
  folder row (and in the panel's toolbar, for touch) opens that folder's shells in the main area,
  where a previewed file would go. It starts one straight away and takes the same **+** for more.
  A folder's shells are its own — a session running in the same folder keeps its tabs in its own tab
  bar — and closing the last one hands the main area back.
- **Web links** — the page a session is working *from* — the Jira issue, the PR, the spec — pinned
  to its tab bar by the **+** at the end of the row. Paste an address (the `https://` is optional);
  the page is named and given its favicon automatically, and clicking its tab shows it in the pane
  beside the terminal. Links live server-side against the conversation, like the open file tabs, so
  they follow the session to every device and survive a reopen. Double-click a tab (or the pencil in
  its toolbar) to rename or re-point it.

  **Not every site can be shown.** Most SaaS worth linking to — Atlassian, GitHub, Google — sends
  `X-Frame-Options` or a CSP `frame-ancestors` that forbids being framed by anyone else, and a
  browser obeys that by drawing nothing at all, with no error a page can catch. So the server reads
  those headers before the tab exists (`GET /api/web/link-probe`) and says so in the add dialog: a
  page that refuses framing becomes a **bookmark tab** instead, marked with an arrow, whose pane
  names the page and opens it in a browser tab in one click. You can force either behaviour with the
  *Show the page in the tab* checkbox. A page that does frame but needs you signed in may still ask
  again — a frame is a separate context as far as the browser's cookie rules go.
- **Responsive** — collapsible session sidebar on desktop; a slide-over drawer on mobile.
- **Light / dark** theme toggle.
- **Start / stop** — stop kills the process; the app just manages lifecycle.

## How a session is launched

`claude` insists on an **interactive** terminal: without one it falls back to non-interactive
`--print` mode, the TUI never renders, and Remote Control never registers. So every session is
attached to a Windows **pseudoconsole** (ConPTY) — a real terminal as far as the child is concerned,
whose VT stream we pipe out and render in the browser with xterm.js. The same session can also be
driven from the Claude Code app over Remote Control; both are views of one process.

Each session is launched as:

```
claude --remote-control <name> --name <name> [--model <m>]
```

The pseudoconsole is owned by a per-session `ClaudeWeb.PtyHost.exe` rather than by the app itself,
which is what lets a session outlive an app restart — see **Architecture** above.

Permission mode is chosen per session at launch. The default leaves decisions to the Claude Code app;
`bypassPermissions` passes `--dangerously-skip-permissions`, whose one-time acceptance screen would
otherwise block startup, so the app pre-accepts it.

## Architecture

```
ClaudeWeb.exe  (Windows tray app — WinForms NotifyIcon + in-process web host)
   │                                        ↑ restarts, updates and crashes freely
   ├─ system tray: left-click → open UI · right-click → sessions + Exit
   │
   ▼
Browser (React + Vite + TS + Tailwind + shadcn/ui)
   │  REST /api/*     ──►  auth, session create/list/stop, filesystem browse
   │  WS /hub/events  ──►  live session list · WS /hub/sessions/{id}/terminal ──► xterm.js
   ▼
.NET 10 (ASP.NET Core Minimal API, in-process)   ← also runnable as a Windows service
   │  named pipe \\.\pipe\claudeweb-pty-<instance>-<sessionId>
   ▼
ClaudeWeb.PtyHost.exe   (one per session — and one per shell tab — detached; owns the pseudoconsole)
   │  ConPTY + 512 KB scrollback ring + fan-out + the hang watchdog
   ▼
claude --remote-control <name> --name <name>
   │  registers with api.anthropic.com  ──►  appears in the Claude Code app
   ▼
You drive it from the in-app terminal, claude.ai/code, or the Claude mobile app
```

The pty host is the reason a session **survives a restart of the app**. A pseudoconsole (`HPCON`)
cannot be handed to another process, and its `conhost` is bound to whoever created it — so the only
way to keep a session alive across an update is for the process that owns the pseudoconsole not to be
the process that restarts. The app attaches and detaches; the host holds the session.

## Prerequisites

- Windows 11, **.NET 10 SDK**, **Node 20+**
- **Claude Code v2.1.51+** installed and authenticated (OAuth / claude.ai login) for your user
  account. Remote Control requires a Pro/Max/Team/Enterprise plan.
  - If you have **multiple claude installs**, the app uses the first `claude` on `PATH`. Make sure
    that's the up-to-date one (`claude --version`), or pin the full path via
    `Sessions:ClaudeExecutable` in `appsettings.json`.

## Develop

```powershell
# Windows PowerShell (pwsh 7 also works):
powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
# Backend  → http://127.0.0.1:5099
# Frontend → http://localhost:5173  (proxies /api to the backend)
```

Since the SPA is built into the backend's `wwwroot`, you can also just run the backend and use it
directly at its port — no Vite needed:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\run.ps1
```

Set the login password by putting it in `server/appsettings.json` (`Auth:Password`) and starting
the app once — it hashes the password to `%LocalAppData%\ClaudeWeb\auth.json` and logs a reminder
to clear the plaintext. After that first run, blank `Auth:Password`; the persisted hash is used
for login and no recoverable password is left on disk.

## Build the desktop app

```powershell
# Builds the SPA and publishes a single self-contained ClaudeWeb.exe into .\publish
powershell -ExecutionPolicy Bypass -File scripts\build.ps1
```

Output: `publish\ClaudeWeb.exe` (self-contained — no .NET runtime needed) plus `wwwroot\` and
`appsettings.json` beside it. Edit `appsettings.json` to set `Auth:Password` (hashed on first
launch — see above) and `Server:Urls` (port), then **double-click `ClaudeWeb.exe`**. It appears
in the tray; left-click to open.

**Start on login** (current user, no admin needed):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\register-autostart.ps1 -ExePath .\publish\ClaudeWeb.exe
# remove it later:
powershell -ExecutionPolicy Bypass -File scripts\register-autostart.ps1 -Remove
```

Browse to `http://<this-pc>:5099` from any device on your network, launch a session, and pick it up
in the Claude Code app.

## Optional: run as a Windows service (headless, no tray)

```powershell
# Install as a service under your user account (elevated prompt; prompts for your password)
powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 -PublishPath .\publish
# Uninstall
powershell -ExecutionPolicy Bypass -File scripts\uninstall-service.ps1
```

The same exe detects it's running under the service manager and skips the tray, running headless.

## Updating from inside the app

`scripts\deploy.ps1` builds and installs in one shot, which means it stops the app from the machine
it runs on. The in-app updater splits that in two, so a new build can be published from anywhere and
installed with a click in the UI:

```powershell
# Build and publish a pending update. Does NOT touch the running app.
powershell -ExecutionPolicy Bypass -File scripts\stage-update.ps1
```

That drops the published build into `C:\apps\claude-web-updates\payload` (override with `-Staging`).
The running app watches that folder, compares the staged `build.json` with its own, and puts an
**Update** button next to the "Claude Web" title in the sidebar as soon as they differ. Clicking it
shows both build stamps and, on confirmation:

1. the app answers the request, then stops itself — gracefully, so each session's process tree goes
   down with it rather than being orphaned;
2. a detached `apply-update.ps1` (embedded in the exe, extracted to `%LocalAppData%\ClaudeWeb\update`)
   waits for the process to exit, mirrors the payload over the install folder and restarts the app the
   same way it was running — the service if there is one, otherwise the tray exe;
3. the sessions that were running come back on their own, exactly as after a `deploy.ps1` redeploy
   (see `Sessions:ResumeOnStart`);
4. the browser sits behind an "Installing the update…" overlay until the new build answers, then
   reloads so it picks up the new frontend assets too.

`appsettings*.json` in the install folder are preserved, never overwritten by the payload. The
updater logs every step to `%LocalAppData%\ClaudeWeb\logs\update.log`, and on any failure it restarts
the app rather than leaving the machine with nothing running.

Staging is safe at any time — it only writes to the staging folder, and the payload is swapped into
place at the end so the app never reads a half-copied build. Set `Update:Enabled` to `false` to turn
the whole thing off and go back to `deploy.ps1` only.

## Notes & gotchas

- **Workspace trust.** A brand-new folder normally triggers Claude's one-time trust prompt, which
  would block an unattended launch. With `Sessions:AutoTrustFolders` on (default), the app
  pre-accepts trust for the folder before launching by adding `hasTrustDialogAccepted` to
  `~/.claude.json` (it backs the file up once to `~/.claude.json.claudeweb-backup`, writes
  atomically, and only adds entries for folders not already present). Set it to `false` to disable
  and accept the prompt manually from the Claude Code app instead.
- **Sessions survive an app restart.** Each session's pseudoconsole lives in its own detached
  `ClaudeWeb.PtyHost.exe`, so an in-app update, a `deploy.ps1`, tray **Exit** or even a crash leaves
  the session running. On the next start the app **re-attaches** to it: same session id, scrollback
  replayed into the terminal, and a conversation that was mid-turn simply carries on. Nothing is
  relaunched and no `--resume` is issued. What ends a session is **Stop** in the UI, `claude` exiting
  on its own, or the machine rebooting.
- **Auto-resume after a reboot.** A ConPTY child cannot survive a reboot, so for that case the
  persisted launch metadata still does the work: on the next start the app **relaunches the sessions
  that were running**, each resuming its own conversation (`--resume <id>` when Claude's session id
  was captured from a hook, else `--continue`). The original prompt is not re-fired and the watchdog
  setting is carried over; a relaunched session gets a **new id** in the UI. Sessions that had
  already exited on their own are not resurrected, and a folder that's gone (or a failed launch)
  just stays a manual **Reopen** entry. Turn it off with `Sessions:ResumeOnStart=false`, or per
  launch with `--no-resume-sessions`. Pair it with **Start on login** above and a reboot restores
  your working set by itself.
- **Hang watchdog.** Claude Code sometimes stalls on an API or streaming error and sits there. When
  a session opts in, the watchdog notices the error banner on screen and writes `continue` for it. It
  never acts while Claude is emitting (that covers Claude's own retry) or while a permission prompt
  is on screen, waits out `Watchdog:CooldownMs` between attempts, and after `Watchdog:MaxConsecutive`
  tries gives up and flags the session for **attention** in the sidebar instead. Toggle it per
  session in the UI; a manual **Continue** clears the give-up flag.

  It runs **inside each session's pty host**, not in the web app — so a session that stalls overnight,
  or during an in-app update, is recovered whether or not the app is running, and you see what
  happened when the browser reconnects. A host keeps the options it was launched with, so a change
  under `Watchdog:` in `appsettings.json` applies to sessions started after it.
- **Shells survive an app restart too**, for the same reason sessions do — each shell tab is its own
  pty host — so a build or a `tail -f` left running in one is still going, and still streaming, after
  an update. They are namespaced separately (`<instance>-sh`), which is what keeps a shell from
  showing up in the sidebar's orphaned-session list. What they do *not* get is auto-resume: a shell
  whose process is gone (a reboot) is simply forgotten, since its value was the scrollback and the
  state in it, and both died with it.
- **Shell arguments go out verbatim.** The pty library quotes every argument, which most programs
  unquote again — but `wsl.exe` parses its own command line and reads `"-d"` as a *command* to run,
  so a WSL tab came up as `bash: -d: command not found`. Shells are therefore spawned with
  `PtySpawnRequest.VerbatimArguments`, quoting only the tokens that need it (a path with spaces).
  The `claude` launch is unchanged and still uses the quoted path.
- **Keep the process alive.** Remote Control lives in the launched `claude` process; stopping it
  (or the machine going offline for ~10 min) ends the session in the app.
- **`ANTHROPIC_BASE_URL`** must be unset / pointed at `api.anthropic.com`, or Remote Control is
  disabled (Claude Code v2.1.196+).

## Configuration (`server/appsettings.json`)

| Key                         | Meaning                                              | Default              |
| --------------------------- | ---------------------------------------------------- | -------------------- |
| `Server:Urls`               | Kestrel bind address(es); `0.0.0.0` = LAN-reachable  | `http://0.0.0.0:5099`|
| `Auth:Password`             | Bootstrap-only plaintext; hashed to `auth.json` on start, then clear it. Empty (with no stored hash) = **no auth** (dev only) | `""` |
| `Auth:ApiKey`               | API key for `POST /api/external/sessions`. Empty = off| `""`                 |
| `Sessions:ClaudeExecutable` | Path or command for the CLI (pin a full path here)   | `claude`             |
| `Sessions:AutoTrustFolders` | Pre-accept Claude's workspace-trust prompt per folder| `true`               |
| `Sessions:ResumeOnStart`    | On start, relaunch the sessions that were running at the last exit | `true` |
| `Sessions:ResumeDelayMs`    | Settling delay before auto-resume starts (lets a booting PC come up)| `5000`  |
| `Sessions:ResumeStaggerMs`  | Pause between consecutive auto-resumed launches      | `2000`               |
| `Sessions:SelfUrl`          | URL a session calls back on (`CLAUDEWEB_URL`); empty = derived from the bound port | `""` |
| `Pty:InstanceKey`           | Namespaces this instance's pty pipes and state dir; empty = the bound port. Keeps a dev instance from adopting the live app's sessions | `""` |
| `Pty:HostExecutable`        | Path to `ClaudeWeb.PtyHost.exe`; empty = beside the app | `""`                 |
| `Pty:AttachTimeoutMs`       | How long a host has to answer its pipe before its state file is called stale | `3000` |
| `Pty:StartTimeoutMs`        | How long a freshly launched host has to come up and accept a connection | `20000` |
| `Pty:OrphanMaxAgeHours`     | Auto-stop untracked sessions older than this; `0` never does (they are listed in the sidebar and tray instead) | `0` |
| `Watchdog:Enabled`          | Master switch for auto-recovery; off means no host ever auto-continues | `true` |
| `Watchdog:PollIntervalMs`   | How often a host re-examines its own session      | `2000`               |
| `Watchdog:CooldownMs`       | Minimum gap between auto-continues for one session| `20000`              |
| `Watchdog:MaxConsecutive`   | Attempts before giving up and flagging for attention | `3`               |
| `Watchdog:SendSequence`     | What is typed to recover, and by the manual **Continue** button | `continue\r` |
| `Watchdog:ErrorPatterns`    | Case-insensitive regexes that mean "this session looks hung" | (API/stream errors) |
| `Watchdog:PromptGuardPatterns` | Regexes for an on-screen prompt; any match and the watchdog stays silent | (dialog wording) |
| `Update:Enabled`            | Offer in-app updates staged by `scripts\stage-update.ps1` | `true`           |
| `Update:StagingPath`        | Folder updates are staged into (the build lands in its `payload` subfolder) | `C:\apps\claude-web-updates` |
| `Update:PollSeconds`        | Re-read the staged build this often (a watcher already catches it sooner) | `30` |
| `Update:InstallPath`        | Install folder to update; empty = the folder the running exe is in | `""`   |
| `Update:ShutdownWaitSeconds`| How long the updater lets the app close before forcing it down | `45`       |
| `FileSystem:DefaultFolder`  | Folder the picker opens at when creating a session   | `C:\Git`             |

## Programmatic session creation (API)

An external program (script, CI, automation) can launch a session without the browser login via
`POST /api/external/sessions`, authenticated with an **API key in the `X-Api-Key` header**. Set
`Auth:ApiKey` in `appsettings.json` to enable it (empty = the endpoint is disabled). The JSON body
is exactly what the "New session" dialog sends:

```bash
curl -X POST http://<this-pc>:5099/api/external/sessions \
  -H "X-Api-Key: <your-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "workingDirectory": "C:\\Git\\myproject",
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
if `remoteControl` is true, in the Claude Code app. The key authorizes this endpoint only — the
rest of `/api/*` still requires the browser bearer token.

## Renaming a session from inside it (API)

A running session can rename **itself**, so a `claude` command (or a hook, or any script the session
runs) can name the session after the work it turns out to be doing. `POST /api/self/name` needs no
browser login and no API key: every session ClaudeWeb launches already carries its own credentials in
its environment, and they are all the call takes.

| Env var                | What it is                                                       |
| ---------------------- | ---------------------------------------------------------------- |
| `CLAUDEWEB_URL`        | Base URL of the app, on loopback (e.g. `http://127.0.0.1:5099`)  |
| `CLAUDEWEB_SESSION_ID` | This session's id — also the session the call renames             |
| `CLAUDEWEB_HOOK_TOKEN` | Local secret that authorizes the call (also used by the hooks)   |

```bash
curl -s -X POST "$CLAUDEWEB_URL/api/self/name" \
  -H "X-Session-Id: $CLAUDEWEB_SESSION_ID" \
  -H "X-Hook-Token: $CLAUDEWEB_HOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"refactor auth middleware"}'
# {"id":"664d6618…","name":"refactor auth middleware"}
```

The name is stripped of control characters, trimmed, and capped at 100 characters. Responses are
`200` with the applied name, `400` when the name is empty, `401` when the headers are missing or
wrong, and `404` when the id names no session.

The token is minted once and kept in `auth.json`, not regenerated per app run. A session's
environment is fixed when its `claude` process starts, and that process outlives the app — a restart
or a redeploy re-adopts the still-running session but cannot re-inject anything into it — so a
per-run secret left every surviving session silently 401'ing on this endpoint and on its hooks.
Sessions launched *before* this changed still carry a token that no longer exists: their self-rename
fails with `401` (logged server-side) until they are restarted, and typing `/rename <name>` in the
terminal is the way to rename them in the meantime.

The effect is exactly the sidebar rename: the display name changes everywhere and `/rename <name>`
is injected into the session's terminal so Claude's own conversation title follows. A session that
renames itself *mid-turn* has that `/rename` land in its own input queue, so Claude runs it once the
current turn finishes.

The session id comes from the header we injected at launch, so a session can only ever rename
itself — the endpoint can't be aimed at another session, and it stays shut to anything that can't
read that session's environment. Same trust boundary as the `/api/hooks` callback.

## Security notes

- Auth is a single shared password that mints an in-memory bearer token. The password is stored
  only as a salted PBKDF2 hash in `%LocalAppData%\ClaudeWeb\auth.json` — no plaintext in config
  once you clear `Auth:Password` after first launch. Serve over your trusted LAN; put it behind a
  reverse proxy with TLS if you expose it more widely.
- Launched sessions run in Claude's normal permission mode — you approve actions from the app.

## Layout

```
server/   .NET 10 tray app + Minimal API host (Program.cs, Tray/, Sessions/, Auth/, FileSystem/, Logging/, Update/)
web/      React + Vite + TS + Tailwind + shadcn/ui launcher UI
scripts/  dev.ps1, run.ps1, build.ps1, install-service.ps1, uninstall-service.ps1,
          stage-update.ps1 + apply-update.ps1 (the two halves of the in-app updater)
```
