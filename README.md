# Homeport

> **Name:** the project will be renamed to **Homeport** (the home port your remote sessions launch
> from). The rename (repo, `ClaudeWeb.exe`, namespaces) is not done yet — for now the executable is
> still `ClaudeWeb.exe`.

A .NET 10 **Windows tray application** (backend + web UI in one `.exe`) that **launches Claude Code
CLI sessions with Remote Control enabled** so you can drive them from the **Claude Code app**
(claude.ai/code and mobile) — from any device on your LAN.

Run `ClaudeWeb.exe` and it starts the web host in-process and drops an icon in the system tray:

- **Left-click** the tray icon → opens the web UI in your browser.
- **Right-click** → menu listing running sessions, plus **Exit**.
- Runs as a single instance; launching it again just reopens the UI.
- The same exe also runs headless as a **Windows service** (auto-detected) if you prefer.

The web UI is a **launcher / session manager**, not a terminal:

- **Create / select sessions** — each session is a live `claude --remote-control` process in a
  working folder of your choice.
- **Control from the Claude Code app** — launched sessions register for Remote Control and appear
  by name in the app's session list (computer icon + green dot). All interaction happens there.
- **Fork a session** — branch a conversation in two from the sessions list or the session header:
  name the fork, and it launches beside the original with the same folder and settings, picking up
  its history (`claude --resume <id> --fork-session`). The original keeps running, untouched. Forks
  nest under their parent in the sessions list, and each one's header links back to it.
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
- **Responsive** — collapsible session sidebar on desktop; a slide-over drawer on mobile.
- **Light / dark** theme toggle.
- **Start / stop** — stop kills the process; the app just manages lifecycle.

## Why a launcher (and not a chat/terminal)

Remote Control requires an **interactive** `claude` session attached to a real console — it then
registers with the Anthropic API and is driven from the Claude Code app. So this app's job is to
**start those sessions headlessly and manage them**; the actual conversation lives in the app.

Each session is launched as:

```
claude --remote-control <name> --name <name> [--model <m>]
```

in its own new console (`CREATE_NEW_CONSOLE`). Under a Windows service (session 0) that console is
invisible, so sessions are effectively headless. Notably we do **not** pass
`--permission-mode bypassPermissions` — that shows a blocking startup prompt and is unsafe;
permission decisions are made in the Claude Code app instead.

## Architecture

```
ClaudeWeb.exe  (Windows tray app — WinForms NotifyIcon + in-process web host)
   │
   ├─ system tray: left-click → open UI · right-click → sessions + Exit
   │
   ▼
Browser (React + Vite + TS + Tailwind + shadcn/ui)
   │  REST /api/*  ──►  auth, session create/list/stop, filesystem browse
   ▼
.NET 10 (ASP.NET Core Minimal API, in-process)   ← also runnable as a Windows service
   │  one child process per session (new console, no stdio redirect):
   ▼
claude --remote-control <name> --name <name>
   │  registers with api.anthropic.com  ──►  appears in the Claude Code app
   ▼
You drive it from claude.ai/code or the Claude mobile app
```

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

## Notes & gotchas

- **Workspace trust.** A brand-new folder normally triggers Claude's one-time trust prompt, which
  would block an unattended launch. With `Sessions:AutoTrustFolders` on (default), the app
  pre-accepts trust for the folder before launching by adding `hasTrustDialogAccepted` to
  `~/.claude.json` (it backs the file up once to `~/.claude.json.claudeweb-backup`, writes
  atomically, and only adds entries for folders not already present). Set it to `false` to disable
  and accept the prompt manually from the Claude Code app instead.
- **Auto-resume across restarts.** A launched `claude` runs on a pseudoconsole this app owns, so it
  dies with the app — a PC shutdown, a redeploy or tray **Exit** takes every session down. Their
  launch metadata is persisted, and on the next start the app **relaunches the ones that were
  running**, each resuming its own conversation (`--resume <id>` when Claude's session id was
  captured from a hook, else `--continue`). The original prompt is not re-fired and the watchdog
  setting is carried over; a resumed session gets a **new id** in the UI. Sessions that had already
  exited on their own are not resurrected, and a folder that's gone (or a failed launch) just stays
  a manual **Reopen** entry. Turn it off with `Sessions:ResumeOnStart=false`, or per launch with
  `--no-resume-sessions`. Pair it with **Start on login** above and a reboot restores your working
  set by itself.
- **Keep the process alive.** Remote Control lives in the launched `claude` process; stopping it
  (or the machine going offline for ~10 min) ends the session in the app. The service keeps
  processes running across web-UI restarts (stopping the service does not kill launched sessions).
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
| `CLAUDEWEB_HOOK_TOKEN` | Per-app-run secret that authorizes the call                       |

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
server/   .NET 10 tray app + Minimal API host (Program.cs, Tray/, Sessions/, Auth/, FileSystem/, Logging/)
web/      React + Vite + TS + Tailwind + shadcn/ui launcher UI
scripts/  dev.ps1, run.ps1, build.ps1, install-service.ps1, uninstall-service.ps1
```
