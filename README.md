<p align="center"><img src="assets/hangar-logo.png" alt="Hangar" width="140"></p>

# Hangar

Hangar is a self-hosted app that **launches Claude Code CLI sessions with Remote Control enabled** on
your own machine, and gives you a web UI to run them from any device: a session manager with a full
terminal, a file browser, shell tabs, pull-request reviews, saved templates and schedules. Each session
is a real `claude` process in a folder of your choice, so you can drive it from the in-app terminal,
from the Claude Code app (claude.ai/code and mobile), or both at once. Sessions survive restarts and
updates of Hangar itself. The server runs on Windows, Linux and macOS, and an optional tray app adds a
menu and screenshot-to-session capture.

> Hangar is an independent project. It is not affiliated with or endorsed by Anthropic. Claude and
> Claude Code are trademarks of Anthropic.

**Contents:** [Security model](#security-model) · [Quick start](#quick-start) ·
[What Hangar changes outside its folders](#what-hangar-changes-outside-its-own-folders) ·
[Features](#features) · [How it works](#how-it-works) · [Configuration](#configuration) ·
[Updating](#updating) · [API](#api) · [Development](#development) ·
[Troubleshooting](#troubleshooting) · [Repository layout](#repository-layout)

## Security model

Hangar launches Claude Code processes as you and exposes a file browser, file editing and terminals in
the browser. **Anyone who can log in to Hangar effectively has a shell on your machine as your user.**
Treat its password the way you would treat your account's.

- **It binds `127.0.0.1` by default** (`Server:Urls` = `http://127.0.0.1:5099`), so nothing else on the
  network can reach it until you change that.
- **With no password set, it answers only requests made on this machine**: from loopback, addressed to
  a loopback name, carrying no proxy headers, and — when a browser sends them — with Hangar's own page
  as the `Origin` and `Sec-Fetch-Site` saying the request is not cross-site. Another website open in
  your browser therefore cannot drive it, and neither can another local web server's page. Everything else
  (the UI, the API, the sockets) gets a `403` telling you to set a password.
- **Set `Auth:Password` before exposing it** on your LAN or behind a reverse proxy. It is hashed (PBKDF2)
  into the data folder on first start; then remove the plaintext. See [First run](#first-run-set-a-password).
- **Always set a password behind a reverse proxy.** A proxy on the same machine connects from loopback.
  Hangar recognises a proxied request by its forwarding headers (`X-Forwarded-For`, `Forwarded`, …),
  and a proxy that adds none (nginx at its defaults, for one) is indistinguishable from you sitting at
  the keyboard.
- **Logins are rate-limited per client**: 5 free attempts, then a lockout starting at 30 s and doubling
  up to 15 minutes (`429` with `Retry-After`). Node pairing checks the same password and draws on the
  same budget. A browser's token expires after 30 days.
- **Use HTTPS for anything beyond this machine.** Web Push notifications and installing the web app on
  a phone (PWA) both need a secure origin; put Hangar behind a TLS reverse proxy or `tailscale serve`.
- A **paired node** (another machine running Hangar) can do anything on this one that you can. Pair
  only machines you would give the password to.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md), not in public issues.

## Quick start

### Prerequisites

- **Claude Code CLI**, installed and logged in for your user account with a Claude subscription
  (Remote Control needs a Pro, Max, Team or Enterprise plan, and Claude Code v2.1.51 or later). Run
  `claude` once in a terminal and log in before starting Hangar.
- **Git**.
- **.NET 10 SDK** (pinned by [`global.json`](global.json)).
- **Node.js 22.12+** ([`.nvmrc`](.nvmrc) names 24).
- **PowerShell** on Windows (Windows PowerShell 5.1 or PowerShell 7); **bash** on Linux and macOS.
- Optional: **GitHub CLI (`gh`)**, signed in (`gh auth login`), for the pull-request features.
- Optional, only for the **tray app**: **Rust** (cargo) plus the platform's webview toolchain: the MSVC
  build tools on Windows, the [Tauri prerequisites](https://tauri.app/start/prerequisites/) on Linux
  (`webkit2gtk-4.1` and friends) plus `libayatana-appindicator3` and the screen-capture libraries listed
  in [tray/README.md](tray/README.md#developing), Xcode command line tools on macOS. Without Rust the
  build simply leaves the tray out.

The builds are self-contained: the machine that only *runs* Hangar needs no .NET runtime or Node.

### Windows

From a PowerShell prompt:

```powershell
git clone https://github.com/sdm-kz/hangar.git
cd hangar

# Build the web UI and publish Hangar.exe, Hangar.PtyHost.exe and (if Rust is there) Hangar.Tray.exe into .\publish
powershell -ExecutionPolicy Bypass -File scripts\build.ps1            # -NoTray to skip the tray; -Rid win-x64 | win-arm64

# Install into %LocalAppData%\Programs\Hangar and start it
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1 -SkipBuild

# Optional: start the server (and tray) at every sign-in
powershell -ExecutionPolicy Bypass -File scripts\register-autostart.ps1   # -NoTray for the server only
```

Then open **http://localhost:5099**.

- `deploy.ps1` runs `build.ps1` itself unless you pass `-SkipBuild`, so `deploy.ps1` alone is also
  "build and install". It copies the build into the install folder, **seeds `appsettings.json` on the
  first deploy and never overwrites any `appsettings*.json` afterwards**, stops this install's running
  server and tray (matched by exe path, so other copies are left alone), and starts them again.
  Running sessions survive a redeploy. `-NoRestart` leaves it stopped. The tray is restarted only if
  it was running; the first time, start `Hangar.Tray.exe` from the install folder yourself (or sign out
  and in after `register-autostart.ps1`).
- The install folder is `-Target` (deploy) / `-InstallPath` / `-ExePath` (the other scripts) when given,
  else `%HANGAR_INSTALL_DIR%`, else `%LocalAppData%\Programs\Hangar`.
- `register-autostart.ps1` adds `Hangar` and `Hangar.Tray` to your per-user Run key (no admin rights);
  `-Remove` takes them out. Why sign-in rather than a service: the server never logs in to anything, it
  *inherits* a login. `claude`'s credentials, its settings and its trust list all live in your profile,
  as does every store Hangar keeps. Started at sign-in it runs as you, with your profile and `PATH`,
  and a desktop to open a browser on if `claude` ever needs you to log in again. For a server that must
  run while nobody is signed in, see [Running as a Windows service](#running-as-a-windows-service).

### Linux and macOS

```bash
git clone https://github.com/sdm-kz/hangar.git
cd hangar

scripts/build.sh                 # this machine's runtime; or: scripts/build.sh [--no-tray] linux-x64 | linux-arm64 | osx-arm64 | osx-x64
scripts/install-unix.sh          # ./publish -> ~/.local/opt/hangar, started at sign-in
```

Then open **http://localhost:5099**.

- `install-unix.sh [publish dir] [install dir]` installs to `~/.local/opt/hangar` by default and keeps
  any `appsettings*.json` already there. It runs the server as **you**: a **systemd user unit**
  (`~/.config/systemd/user/hangar.service`) on Linux, a **launchd agent**
  (`~/Library/LaunchAgents/com.hangar.server.plist`) on macOS. On Linux it runs while you are signed in;
  `loginctl enable-linger $USER` keeps it running with nobody signed in.
- The unit gets the `PATH` of the shell you run the script from (a unit otherwise starts with little more
  than `/usr/bin:/bin`, and every session and shell inherits the server's `PATH`). Re-run it after
  installing tools somewhere new.
- A macOS build made on another OS comes out unsigned; `install-unix.sh` removes the quarantine flag and
  signs the binaries ad hoc when it installs them.

More in [Linux and macOS details](#linux-and-macos-details).

### First run: set a password

Without a password Hangar works from this machine only, which is fine for trying it out. Before using
it from anywhere else:

1. Create **`appsettings.Local.json`** next to the executable (`%LocalAppData%\Programs\Hangar\` on
   Windows, `~/.local/opt/hangar/` on Linux and macOS):

   ```json
   {
     "Auth": { "Password": "a long passphrase" }
   }
   ```

2. Restart the server (the tray's **Stop server…** then **Start server**, `deploy.ps1 -SkipBuild` again,
   `systemctl --user restart hangar`, or `launchctl kickstart -k gui/$(id -u)/com.hangar.server`). On
   start it hashes the password into the data folder (`auth.json`) and logs a reminder.
3. **Remove the `Password` line** again. The stored hash is what logins are checked against; a password
   left in the file would simply be re-applied on every start. Setting it again later rotates it.

To reach it from other devices on your LAN, also set `"Server": { "Urls": "http://0.0.0.0:5099" }` in
the same file (Windows shows a firewall prompt for `Hangar.exe` the first time). On Linux there is no
firewall prompt: prefer a reverse proxy, or limit the port with `ufw`/`nftables`. For HTTPS (needed for
push notifications and the phone PWA), keep the `127.0.0.1` bind and put a TLS proxy or
`tailscale serve` in front, and set `Server:PublicUrl` to the address people should be sent to.

### Uninstall

**Windows:**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1                         # stop it, remove the sign-in entries
powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -RemoveFiles -RemoveData # ...and delete the install and data folders
```

Without `-RemoveData`, running sessions keep running (each lives in its own pty host process).
`-RemoveData` stops them and deletes `%LocalAppData%\Hangar`. A Windows service is removed first with
`scripts\uninstall-service.ps1` (elevated). A staging folder you moved outside the data folder is left
for you to delete.

**Linux / macOS:**

```bash
scripts/install-unix.sh --uninstall      # stops and removes the unit; files and data are kept
rm -rf ~/.local/opt/hangar               # the install
rm -rf ~/.local/share/Hangar             # the data (Linux); ~/Library/Application Support/Hangar on macOS
```

**On every platform**, then remove the hooks Hangar registered in Claude Code's global settings, or
every Claude Code session on the machine keeps calling a port nobody answers: see
[What Hangar changes outside its own folders](#what-hangar-changes-outside-its-own-folders).

## What Hangar changes outside its own folders

Hangar edits Claude Code's **global** configuration so that unattended sessions don't stall on
first-run prompts and so it can tell what each session is doing. Each file is backed up once (to
`<file>.hangar-backup`) before the first change and written atomically; only Hangar's own entries are
added or refreshed.

| What | Where | When | Turn it off |
|---|---|---|---|
| HTTP **hooks** for `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SubagentStart`, `Notification`, `PermissionRequest`, `Stop`, `StopFailure`, each pointing at `http://127.0.0.1:<port>/api/hooks` | `~/.claude/settings.json`, under `hooks` | Every server start | `Hooks:Enabled=false` (session status then falls back to terminal heuristics) |
| `skipDangerousModePermissionPrompt: true` (pre-accepts the one-time warning for `--dangerously-skip-permissions`) | `~/.claude/settings.json` | The first time a session is started with `bypassPermissions` | Don't use that mode |
| `projects["<folder>"].hasTrustDialogAccepted: true` (pre-accepts workspace trust) | `~/.claude.json` | Before launching a session in a folder not already listed | `Sessions:AutoTrustFolders=false` (then accept the prompt yourself in the Claude Code app) |

About the hooks:

- They are **global**: every `claude` on the machine calls them. A `claude` that Hangar didn't launch
  carries no session headers, and the server ignores its calls.
- A second Hangar on another port does not take them over while the instance they name is still
  listening (`Hooks:Force=true` overrides that). Dev instances never register them (see
  [Development](#development)).
- **Uninstalling does not remove them.** While nothing listens on that port, Claude Code reports hook
  errors (`ECONNREFUSED`) on tool calls in every session. Open `~/.claude/settings.json`
  (`%USERPROFILE%\.claude\settings.json` on Windows) and delete the hook handlers whose `url` ends in
  `/api/hooks`, keeping any others. `skipDangerousModePermissionPrompt` and the trust entries in
  `~/.claude.json` are harmless to leave, or can be removed by hand the same way.

Hangar also writes:

- **Its data folder**: `%LocalAppData%\Hangar` (Windows), `~/.local/share/Hangar` (Linux),
  `~/Library/Application Support/Hangar` (macOS): sessions, projects, templates, schedules, the password
  hash and tokens, logs, staged updates, the node identity. `HANGAR_TEST_ROOT`, when set, stands in for
  the parent folder.
- **`.hangar/` in a session's working folder**: images pasted into the session, its postponed messages
  and pull-request reviews, where Claude can be pointed at them. The folder contains a `.gitignore` of
  `*`, so it never shows up in `git status`.
- **Autostart entries**: the `Hangar` / `Hangar.Tray` values in `HKCU\…\Run` (Windows), or the user
  unit / launch agent (Linux, macOS).
- **The tray's settings**: `%LOCALAPPDATA%\io.github.sdm-kz.hangar.tray` (Windows),
  `~/Library/Application Support/io.github.sdm-kz.hangar.tray` (macOS),
  `~/.local/share/io.github.sdm-kz.hangar.tray` (Linux).

## Features

Hangar is two programs:

- **`Hangar` (`Hangar.exe`) — the server.** A headless daemon that owns everything: the sessions, the
  web UI and its API, every store. It starts at sign-in as you — or, when it has to run while nobody is
  signed in, as a Windows service under your account — and there is one per port: launching it again
  just opens the UI.
- **`Hangar.Tray` — the tray app** (`tray/`), for Windows, macOS and Linux. Optional, and a client of
  the server's API, nothing more:
  - **Left-click** (Windows) opens the web UI in your browser. On macOS and Linux a click opens the
    menu, which starts with **Open Hangar**.
  - **Sessions** in the menu lists the running sessions. Each project is a submenu, and inside it the
    sessions are laid out the way the sidebar's grouped view lays them out with its active-only filter
    on: virtual folders first, then folder groups (dropped where the project links only that folder
    and there is no virtual folder to tell it apart from), forks under the session they came from, and
    no submenu for a project with nothing running in it. Below them, **Recent** (closed sessions) and a
    submenu per paired machine. Click a session to open it.
  - **Screenshots.** A hotkey freezes the screen; you pick a region, window, screen or freeform shape,
    mark it up, type a message, and send both to one of the server's running sessions — the picture
    lands in the prompt as a pasted image would.
  - **Quit** closes the app; **Stop server…** stops the server. Neither ends a session (see
    [Sessions survive an app restart](#session-lifecycle)). The icon greys out while the server isn't
    running, and the menu then offers **Start server**. Both server items are there only for a server
    on the same machine: the app can follow a server anywhere it can reach (Settings → *Hangar address*).

  See [tray/README.md](tray/README.md).

The web UI is a **session manager with a full terminal**:

- **Create / select sessions** — each session is a live `claude --remote-control` process in a
  working folder of your choice.
- **Control from the Claude Code app** — launched sessions register for Remote Control and appear
  by name in the app's session list (computer icon + green dot), so you can carry on from there.
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
  the project. A session launched from one that is filed — a fork, or a child session started under
  it — goes into the same box, so a branch is drawn under the session it came from instead of
  falling out of it into the folder grouping. A child session started in a folder no project
  claims takes its host's project too: the link is the only way to say which project a session is
  in, and a child launched into another repo would otherwise land under *No project*, away from
  the session that started it. A folder another project already claims is left where it is.
- **Session templates** — a saved way to start the *same kind* of session again: a project, a folder,
  a prompt, and the launch settings that go with them. The same errands come back week after week —
  *look into this log entry*, *review this support request*, *fix this issue* — and each one is
  the same launch every time except for one detail. A template holds everything but that detail.
  The **New session** dialog has a **Templates** tab beside the form: the templates listed under
  their projects, and under the one you pick a single box for what this run is about. Paste the error
  in, hit Create, and the session starts in the right folder with the prompt already sent. Where the
  detail lands is the template's business: `{input}` in the prompt is replaced by what you typed (so
  `/fix-issue {input}` becomes a slash command with the issue key in it), and a prompt without
  the placeholder gets it appended as a paragraph at the end. *What Claude will be sent* shows the
  result before you launch. Everything the template decided — folder, name, model, permission mode —
  is still there under **Session settings**, folded away, and changing it there changes this run
  only. Write them from the same tab (**New template**) or from a project's settings, where the
  project's templates are listed beside its groups. Stored server-side like projects, so they follow
  you across devices.
- **Schedules** — a template plus a clock, so the errands that come back on their own run on their
  own. The calendar button in the sidebar's toolbar lists them; each one picks a template, a clock,
  and what a run actually *is*:
  - **One-shot (headless)** — `claude -p` runs once and exits. No session row, nothing accumulates,
    and the output is kept in the schedule's history. The right shape for the frequent stateless
    check ("is the deploy green?"), and the one to reach for before the other two.
  - **New session each run** — a full interactive session per fire, as if you had filled in the New
    Session dialog. **Stop when done** closes it once its turn ends (the Stop hook is what says so),
    and **sessions to keep** drops the older runs, so a daily schedule doesn't leave thirty rows
    behind it.
  - **Continue an existing session** — sends the prompt into a session already running, keeping one
    conversation's context. Its clock is *not* a wall clock: it fires **N minutes after the last turn
    finished**, which is what makes a run unable to land on top of the one before it. It never types
    over a permission prompt, and a prompt it cannot deliver is stashed in that session's
    **postponed messages** rather than dropped — so the badge says a schedule has been stuck instead
    of the silence saying nothing. Worth knowing: one conversation poked every few minutes grows
    until it compacts and drifts, so anything that doesn't truly need the history holds up far
    better as a one-shot.

  The clock is a five-field cron read in a stored timezone (you edit these from a phone, which may be
  somewhere else), with presets for the usual shapes. A fire the machine was **off or asleep** for
  runs once on the next start if it is inside its grace window — several missed slots still produce
  one run, not one each. **Run now** fires one without touching its clock, which is how you check it
  does what you meant before leaving it to run at 03:00.

  Schedules live in the server, so they survive a restart of the app and a reboot — as reliably as
  the server itself starts (at sign-in, with autologin, or a user systemd/launchd unit elsewhere).
  That ceiling is why every row leads with **when it last ran** and flags itself **overdue**: a
  schedule silenced by a broken autologin otherwise looks exactly like one with nothing to do. A
  session a clock started wears a calendar mark before its name, beside the fork mark — "a clock did
  this" is provenance, not activity.

  Runs are unattended, so the template's **permission mode** is doing real work: a run that hits a
  permission prompt just sits there, and the watchdog deliberately won't answer it. Web Push already
  fires on "newly waiting on a prompt", so a 03:00 run that blocks wakes your phone.
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
  *server machine* actually has: on Windows **PowerShell 7**, **Windows PowerShell**, **Command
  Prompt**, **Git Bash**, and one entry per installed **WSL distribution** (a WSL tab opens with `--cd`,
  so it starts in the same folder as `/mnt/c/…`); on Linux and macOS your login shell first, then the
  others installed. A bare **+** reopens whichever you picked last. The tabs live server-side, so they
  show up on every device looking at that session — and each one runs in its own pty host, so a build
  left running in a shell **survives a restart of the app** exactly as a session does. Closing a tab
  kills what's in it; stopping the session closes its shells with it.

  The **Files** tree offers the same thing for any folder, session or not: the terminal button on a
  folder row (and in the panel's toolbar, for touch) opens that folder's shells in the main area,
  where a previewed file would go. It starts one straight away and takes the same **+** for more.
  A folder's shells are its own — a session running in the same folder keeps its tabs in its own tab
  bar — and closing the last one hands the main area back.
- **Web links** — the page a session is working *from* — the issue, the PR, the spec — pinned
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
- **Remote files over SSH** — another machine's files as a tab of the session, from **Remote files
  (SSH)…** under the **+** at the end of the tab bar. The tab is laid out like the session's own
  Files panel: a lazy tree on the left, and the file previewed on the right in the same viewer
  (text, Markdown, images, video, PDF, Office), editable and saved straight back over SFTP. New file,
  new folder, rename, delete, upload (button or drop), download, dotfiles on or off, and a path bar to
  jump anywhere.

  The connect dialog takes a host (an alias from the server user's `~/.ssh/config` works, and its
  aliases are offered as quick picks), port, user, a start folder, and one of three ways in: a
  **password**, a **key file** on the server machine (its passphrase asked for when it has one), or
  the **SSH agent** (Windows' OpenSSH agent, or Pageant). A connection can be **saved in the
  project** — never with its password or passphrase — and the project's settings get a
  **Connections** tab to add, edit and forget them. Host keys are trusted on first use: the first
  connection shows the fingerprint to accept, the app remembers it (in its own
  `ssh-known-hosts.json`, not your `~/.ssh/known_hosts`), and a changed key later is refused with a
  warning unless you trust the new one deliberately.

  The tab lives in the session's UI bag like a pinned page, so it is on every device and survives a
  reload. The connection itself is held by the server, in memory, with the secret that opened it —
  a dropped link reopens by itself on the next click; after a restart of the app the tab asks again
  (or just reconnects, for an agent or an unencrypted key). Closing the tab ends the connection.

  **Copy, cut and paste work across panels**: copy on the remote host and paste into the session's
  Files panel, or the other way round, or between two SSH tabs, or within one host (where a copy is
  a native `cp -a`). The selection bar and Ctrl+C / Ctrl+X / Ctrl+V in either tree do the same. A
  paste never overwrites — a name already taken gets " (1)", as an upload does.
- **Nodes (other machines running Hangar)** — the network button at the bottom of the sidebar opens
  **Nodes**: this machine's name, colour and the address other nodes reach it at, the nodes it is
  paired with, and the nodes allowed to reach it. **Pair** takes the other node's address and
  password, once; the password is not kept — each side keeps a token the other minted instead (in
  `nodes.json`, sealed with DPAPI on Windows; the tokens it issued are kept hashed in
  `peers-in.json`). Pairing is both ways by default, so the other node lists this one too; untick
  *Both ways* for a node that should be reachable but not see the others. Both nodes need a password
  set — an open node refuses to pair. An `https://` node whose certificate the OS doesn't trust (a
  self-signed one on a home server) shows its fingerprint to confirm, the way an SSH host key does,
  and a changed certificate later is refused until you trust the new one. *Forget* stops reaching a
  node and tells it to drop its token; *Revoke* takes a node's way in away.

  A paired node's whole API and its sockets are reachable through this one at `/n/<node id>/…`, with
  this node's login — the groundwork for one sidebar over every machine
  ([docs/design/multi-node.md](docs/design/multi-node.md)). A paired node can do anything on this one
  that you can, so pair only machines you would give the password to. A paired node's token grants
  what a browser login does, except managing this node's pairings, and it never reaches past this
  node (`/n/…` refuses a request that came from another node). A peer's `401` reaches the browser as a
  `502`, so a node that revoked this one doesn't sign you out here.
- **GitHub pull requests** — a session whose folder is a GitHub repo gets a **PRs** button right
  after *Files*, and the repo's pull requests one click behind it: **Open** ones by default, with
  **Closed** (which includes merged) and **All** on the tabs beside it, and a box that filters the
  list by number, title, author or branch. Pick one and it opens as a **tab of its own** — `#42` and
  the title — right after the Files tab, and stays there: the open reviews live server-side against
  the conversation like the linked pages do, so a PR opened on the laptop is on the phone too, and a
  reload finds it where you left it. Eight at once is the cap, and a ninth pushes out the oldest tab
  rather than refusing — a row of reviews being worked through is what the tabs are for.

  The tab is a **review**: the changed files down a collapsible left sidebar, and the diffs beside
  them, old on the left and new on the right the way GitHub draws them. Each file folds away by its
  header (and the header stays put as you read through it); clicking one in the sidebar opens it and
  scrolls to it. Both dividers drag: the one beside the file list, and the one down the middle of a
  diff — that one sets the ratio for **every** file at once, so the two columns stay in step down the
  page. Double-click either to put it back. (The middle divider is for the wrapped view; unwrapped,
  the halves are as wide as their longest line and scroll together, and there is no width to
  divide.) **A file that was added has no left side to show**, so it isn't given one — the new
  content is drawn as a single full-width column, and a deleted file the same way round. Long lines
  wrap by default, because this pane is often half a screen wide rather than a whole one; the button
  in the header turns that off for GitHub's own behaviour, where the two halves scroll together.
  The **−/+** beside it sizes the code, on the same stops every other zoomable view in the app uses,
  and the percentage resets it. It sizes the code and nothing else: the file paths, the sidebar and
  the header stay where they are, because the point is reading a diff on a laptop screen rather than
  rescaling the furniture around it.

  Both are **syntax highlighted**, in the same palette the file preview uses. Each side of a diff is
  coloured as one text rather than a line at a time, so a comment or a string running over several
  lines is still one of those where it is drawn — what a diff cannot show is the code between hunks,
  so a block opened in a part of the file nobody touched reads as closed. A whole file has no such
  gap and is coloured exactly as a compiler would read it.

  Every file's header also offers **Diff / File**: the change, or the file itself, read whole at the
  commit this pull request proposes — the base commit for a file the request deletes, since that is
  the only side it still exists on. A file being read whole gets a **copy** button beside the toggle,
  which is where copying belongs: a diff copied wholesale is a mix of both sides with markers down
  the left, which is not the file anyone means.

  The counts under the title end in **N commits**, which is GitHub's *Changes from* menu: the whole
  pull request first, then each commit oldest first. Pick one and the review narrows to what that
  commit alone changed — same diffs, same *File* view (read at that commit, or just before it for a
  file it deletes) — with the commit's message where the description was and arrows to step to the
  commits either side. *All changes* goes back, to the place in the review you left. A commit's folds
  and scrolling are its own and are not remembered, and the *Viewed* boxes stay with the whole
  review, since a mark says a file has been read as the pull request proposes it.

  Each file has a **Viewed** box, the way GitHub's has: tick it and the file folds away, and the
  header keeps the count. Ticked at the end of a long file, the pane goes back to that file's header,
  so the next file starts right below it rather than somewhere off in its middle. The marks are held
  against the *pull request* rather than the session, so they are the same in every browser, outlast
  the session being closed and reopened, and are shared by every session working in that repo. A mark
  records the file's blob as it was when you read it, which is what makes a push reset **only the
  files it touched** — the rest of the review stays read.

  **Comments for the session's Claude.** Select some lines in a diff, or in a file read whole, and a
  **Comment** button appears under them. It turns the selection into whole lines on one side — a
  drag in a split diff stays in the column it started in — and opens a small card to say what
  should change. **Send now** (Ctrl+Enter) puts the comment straight into the session's terminal,
  with the file, the line numbers and the lines themselves. **Add to review** (Ctrl+Shift+Enter)
  keeps it in the pull request's review file instead, `.hangar/reviews/<repo>-pr-<n>.md` in the
  session's folder, and a **Review** count appears in the header. That opens the file for a last
  read: it is plain Markdown and exactly what will be sent, so edit it freely, then **Send review**
  hands the whole of it to the session as one message and deletes the file. Lines on the old side
  are said to be the old version's, and in a single commit's view, that commit's. A closed session
  still collects comments; sending waits until it is running.

  How far through a review you had got is kept: which files you folded away, and where the pane was
  scrolled to, against the repo and number of the pull request in the session's own state — so it
  follows the session to your other devices, and a tab that goes away takes it with it, whether you
  closed it or it made way for a ninth. *Collapse all* and *Expand all* are stored as that, one word,
  rather than as a decision per file; the files you then fold or open one at a time are stored by
  name, and a session keeps a hundred of those across all its reviews before the oldest go back to
  following the rest.

  A review is fetched when its tab is first opened and then stays as it was, so one left open behind
  the terminal is as old as when you last looked at it — the **reload** in its header is what catches
  it up. A file whose diff is enormous arrives folded rather than drawn, and one past the size the
  server will send is listed with its counts and left on GitHub.

  **A session is not limited to the repo it sits in.** Claude changes one repo in answer to another
  often enough, and a folder opened a level up over several checkouts has no remote of its own to
  speak for it — so the top of the picker is a strip of the repos this session can review, and the
  **+** beside it links another by name (`owner/name`) or by pasting its URL. Nothing is checked out
  to do it: gh answers for any repo by name, so a repo you only have to read is one line of typing.
  Pick a repo in the strip and the list below is its pull requests; a review opened from one that
  isn't the session's own says which repo it is in, on its tab and in the picker, since `#42` of two
  repos would otherwise read as one review. The strip also carries the repos of the **project** the
  folder belongs to — *Linked repositories* in the project's settings — which is where a repo the
  whole project cares about belongs, rather than being linked again in every session under it. Only
  what a session linked itself can be unlinked from the strip; its own folder's repo is a fact about
  the folder, and a project's is the project's to take back. A session with **no** repo at all has no
  button in the bar — *Pull request…* in the **+** menu opens the same popup, which is where its
  first repo gets linked.

  It all runs through the **`gh` CLI on the server machine**, which is what makes it work without a
  token of its own: gh already holds your GitHub credentials and resolves the repo from the folder's
  remotes. `gh auth login` there is the whole of the setup, and whatever gh says when it can't answer
  — not installed, not signed in, no such repo — is what the picker says back. Whether a folder is a
  GitHub repo at all is read from its git remote, so a session in a folder that isn't one starts with
  an empty strip, and nothing on the network was asked to find that out.
- **What each session is doing** — every row carries a mark, read off Claude's own hook callbacks
  rather than scraped off the terminal: a green pulse while it works, a cooler one while it compacts,
  an **amber ring** when it is blocked on you, a **red cross** when the last turn died on an API
  error, and a green tick for a turn that finished while you were looking elsewhere (that one clears
  once you have read it). The two that want you name themselves: hover a waiting row and it says
  which command the permission dialog is asking to run — *Wants to run Bash: git push --force* — and
  a failed one says what it died on, a rate limit being the usual answer. A failed turn is worth its
  own mark because it is invisible otherwise: a turn that hit its limit stops printing exactly like
  one that finished, so without this the session just looks done. Both also raise a notification —
  in the page, and as a Web Push alert to every subscribed device, so the phone gets it with every
  tab closed — carrying the same line. A folder or project heading shows the most urgent mark under
  it, so a collapsed group can't hide a question.
- **Responsive** — collapsible session sidebar on desktop; a slide-over drawer on mobile, installable
  as a PWA over HTTPS.
- **Light / dark** theme toggle.
- **Start / stop** — stop kills the process; the app just manages lifecycle.

### Session lifecycle

- **Sessions survive an app restart.** Each session's pseudoconsole lives in its own detached
  `Hangar.PtyHost` process, so an in-app update, a `deploy.ps1`, the tray's **Stop server** or even a
  crash of the server leaves the session running — and closing the tray never touches a session at
  all. On the next start the server **re-attaches** to it: same session id, scrollback
  replayed into the terminal, and a conversation that was mid-turn simply carries on. Nothing is
  relaunched and no `--resume` is issued. What ends a session is **Stop** in the UI, `claude` exiting
  on its own, or the machine rebooting.
- **Auto-resume after a reboot.** A pseudoconsole child cannot survive a reboot, so for that case the
  persisted launch metadata does the work: on the next start the app **relaunches the sessions
  that were running**, each resuming its own conversation (`--resume <id>` when Claude's session id
  was captured from a hook, else `--continue`). The original prompt is not re-fired and the watchdog
  setting is carried over; a relaunched session gets a **new id** in the UI. Sessions that had
  already exited on their own are not resurrected, and a folder that's gone (or a failed launch)
  just stays a manual **Reopen** entry. Turn it off with `Sessions:ResumeOnStart=false`, or per
  launch with `--no-resume-sessions`. Pair it with starting at sign-in and a reboot restores your
  working set by itself.
- **Hang watchdog.** Claude Code sometimes stalls on an API or streaming error and sits there. When
  a session opts in, the watchdog notices the error banner on screen and writes `continue` for it. It
  never acts while Claude is emitting (that covers Claude's own retry) or while a permission prompt
  is on screen, waits out `Watchdog:CooldownMs` between attempts, and after `Watchdog:MaxConsecutive`
  tries gives up and flags the session for **attention** in the sidebar instead. Toggle it per
  session in the UI; a manual **Continue** clears the give-up flag.

  It runs **inside each session's pty host**, not in the web app — so a session that stalls overnight,
  or during an in-app update, is recovered whether or not the app is running, and you see what
  happened when the browser reconnects. A host keeps the options it was launched with, so a change
  under `Watchdog:` in the settings applies to sessions started after it.
- **Shells survive an app restart too**, for the same reason sessions do — each shell tab is its own
  pty host — so a build or a `tail -f` left running in one is still going, and still streaming, after
  an update. They are namespaced separately (`<instance>-sh`), which is what keeps a shell from
  showing up in the sidebar's orphaned-session list. What they do *not* get is auto-resume: a shell
  whose process is gone (a reboot) is simply forgotten, since its value was the scrollback and the
  state in it, and both died with it.
- **Keep the process alive.** Remote Control lives in the launched `claude` process; stopping it
  (or the machine going offline for ~10 min) ends the session in the Claude Code app.

## How it works

### How a session is launched

`claude` insists on an **interactive** terminal: without one it falls back to non-interactive
`--print` mode, the TUI never renders, and Remote Control never registers. So every session is
attached to a **pseudoconsole** (ConPTY on Windows, `forkpty` on Linux and macOS) — a real terminal as
far as the child is concerned, whose VT stream is piped out and rendered in the browser with xterm.js.
The same session can also be driven from the Claude Code app over Remote Control; both are views of
one process.

Each session is launched as:

```
claude [--resume=<id> | --continue] [--fork-session]
       [--permission-mode auto|acceptEdits | --dangerously-skip-permissions]
       --remote-control=<name> --name=<name> [--model=<m>] [-- <initial prompt>]
```

The initial prompt goes after `--`, so a prompt that starts with a dash is still read as text. On
Linux and macOS it is typed into the input box once it is up instead (any user can read a command line
with `ps` there).

Permission mode is chosen per session at launch. The default leaves decisions to you, in the terminal
or the Claude Code app; `bypassPermissions` passes `--dangerously-skip-permissions`, whose one-time
acceptance screen would otherwise block startup, so Hangar pre-accepts it (see
[What Hangar changes outside its own folders](#what-hangar-changes-outside-its-own-folders)).

Every session gets `HANGAR_URL`, `HANGAR_SESSION_ID` and `HANGAR_HOOK_TOKEN` in its environment, which
is what its hooks and the [self-service API](#api) use.

### Architecture

```
Browser (React + Vite + TS + Tailwind + shadcn/ui)       Hangar.Tray  (tray app, Tauri)
   │  REST /api/*     ──►  auth, session create/list/stop,  │  the same REST + /hub/events, with a
   │                       filesystem browse                │  per-run token from the instance file
   │  WS /hub/events  ──►  live session list                │
   │  WS /hub/sessions/{id}/terminal  ──►  xterm.js         │
   ▼                                                        ▼
Hangar  (the daemon: ASP.NET Core Minimal API, headless)   ← restarts, updates and crashes freely
   │  started at sign-in as the user, or as a Windows service under the user's account
   │  named pipe \\.\pipe\hangar-pty-<instance>-<sessionId>  (a Unix socket on Linux/macOS)
   ▼
Hangar.PtyHost   (one per session — and one per shell tab — detached; owns the pseudoconsole)
   │  pseudoconsole + 512 KB scrollback ring + fan-out + the hang watchdog
   ▼
claude --remote-control=<name> --name=<name>
   │  registers with api.anthropic.com  ──►  appears in the Claude Code app
   ▼
You drive it from the in-app terminal, claude.ai/code, or the Claude mobile app
```

The pty host is the reason a session **survives a restart of the app**. A pseudoconsole (`HPCON`)
cannot be handed to another process, and its `conhost` is bound to whoever created it — so the only
way to keep a session alive across an update is for the process that owns the pseudoconsole not to be
the process that restarts. The daemon attaches and detaches; the host holds the session.

The tray is split off from the daemon for a similar reason, one level up. The daemon has nothing to
draw, so it can run before anyone signs in, and a tray that crashes or is closed takes nothing with it.
The tray finds the daemon through an **instance file**: once listening, the daemon writes
`<data>/instances/<port>.json` — its pid, its loopback and public URLs, and a bearer token minted for
that run — and removes it on the way down. The file is created readable by your account alone (an
explicit ACL, not whatever the folder passes down), the token grants nothing that account couldn't
already read in the same folder (the browser tokens live there too), and loopback stays
authenticated for every other process on the machine.

Design notes for the larger pieces live in [docs/design/](docs/design/):
[multi-node.md](docs/design/multi-node.md), [pty-host-detach.md](docs/design/pty-host-detach.md),
[session-scheduling.md](docs/design/session-scheduling.md),
[vt-screen-model.md](docs/design/vt-screen-model.md).

### Running as a Windows service

For a server that has to keep running while nobody is signed in. Install it with `deploy.ps1` first,
then from an **elevated** prompt:

```powershell
# Install as a service under your user account (prompts for your Windows password)
powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1     # -InstallPath <folder> -UserName <account>
# Uninstall
powershell -ExecutionPolicy Bypass -File scripts\uninstall-service.ps1
```

The service runs `Hangar.exe` from the install folder (`-InstallPath`, default as for `deploy.ps1`;
the old `-PublishPath` name is still accepted) under your account, since `claude`'s login and
settings live in your profile. The password is handed to Windows as a credential object
(`New-Service -Credential`), never on a command line. The same exe detects it's running under the
service manager, `deploy.ps1` stops and starts the service around each deploy, and the tray works
against it just the same (the tray itself still starts at sign-in, in your session). Things to know
first:

- **Log in to `claude` interactively before installing.** A service runs in session 0, where `claude`
  can't open a browser, so the service should only ever read a login you have already made.
- **Microsoft accounts**: type the account's *password* at the prompt, not the Windows Hello PIN; an
  account set to sign in without a password has to have that turned off first. **Work or school (Entra
  ID) accounts** can't run services this way; use a local or domain account. See the script's help
  (`Get-Help scripts\install-service.ps1 -Full`).
- **Mapped drives aren't visible** to a service — they belong to a logon session. Use UNC paths for
  project folders and for `FileSystem:DefaultFolder`.

### Linux and macOS details

The server, the pty host and the tray app all run on Linux (x64, arm64) and macOS (Apple silicon,
Intel); it is the same app everywhere — the web UI, sessions that survive a restart of the server,
shell tabs, schedules, the in-app updater, the tray menu.

`build.sh` cross-builds from anywhere the .NET SDK and Node run (Git Bash on Windows too) into
`publish/`: `Hangar` and `Hangar.PtyHost`, self-contained, no .NET runtime needed. The tray
(`Hangar.Tray`) builds only on the machine it is for, so it comes along when the build is for this
machine and Rust is installed, and is left out of a cross-build (a headless server has no desktop to
put it on anyway). An update leaves a running tray on its old build until it reconnects to the new
server; it then restarts into the new one by itself.

Two settings in the units `install-unix.sh` writes are load-bearing — keep them if you write your own:

- **`KillMode=process`** (systemd) / **`AbandonProcessGroup`** (launchd). A session lives in its own
  `Hangar.PtyHost`, which outlives the server on purpose. Left at their defaults, both managers
  kill everything the server started when it stops, and every restart becomes a resume.
- **`Restart=on-failure`** / **`KeepAlive.SuccessfulExit=false`**, not "always". The updater stops the
  server cleanly and starts it again itself once the files are in place.

The launchd agent also gives the server your login keychain, which is where `claude` keeps its
credentials on macOS.

What is different from Windows:

| | Windows | Linux / macOS |
|---|---|---|
| Pseudoconsole | ConPTY, in a kill-on-close job | `forkpty`; the host `setsid`s, and ends the child's process group (hang-up, then kill) |
| Host pipe | named pipe, ACL for this user | Unix socket in `<data>/sock` (0700), peer uid checked |
| Data folder (`<data>`) | `%LocalAppData%\Hangar` | `~/.local/share/Hangar` (Linux), `~/Library/Application Support/Hangar` (macOS); made 0700 |
| Shells (**+** menu) | PowerShell, cmd, Git Bash, WSL | your login shell first, then bash, zsh, fish, pwsh, sh — each as a login shell |
| Updater | `apply-update.ps1`, robocopy | `apply-update.sh`: each top-level entry replaced by a rename (wwwroot whole), extra files kept; restarts the systemd unit / launchd job / process |
| Staging folder default | `%LocalAppData%\Hangar\updates` | `<data>/updates` (`scripts/stage-update.sh` builds into it) |
| `claude` lookup | PATH, unwrapping npm `.cmd` shims | PATH, then `~/.local/bin`, `~/.claude/local`, Homebrew, `/usr/local/bin` |
| Launch prompt | on `claude`'s command line, after `--` | typed in once its input box is up (bracketed paste on, the box on screen with no dialog in front of it, paint settled), so it waits behind a first-run dialog until someone answers it; a headless schedule passes it on stdin. Not delivered within 10 minutes (or the server stopped first) → the session's postponed messages |

Shell integration (the "running" mark on a shell tab) comes from bash's `PROMPT_COMMAND`/`PS0` and
PowerShell's prompt hook, as on Windows; zsh, fish and sh tabs open without it.

## Configuration

Settings are read in this order, each overriding the one before:

1. **`appsettings.json`** beside the executable — the committed template, copied into the build.
2. **`appsettings.Local.json`** beside it — **your settings go here.** It is git-ignored, never copied
   into a build, and never overwritten by `deploy.ps1`, `install-unix.sh` or the in-app updater (they
   preserve every `appsettings*.json` already installed).
3. **Environment variables**, `Section__Key` (for example `Auth__Password`, `Server__Urls`).
4. **Command-line arguments**, `--Section:Key=value`.

For a dev checkout, `server/appsettings.Local.json` plays the same role. Restart the server after
editing; a pty host keeps the `Watchdog` options it was started with.

The tray's first run takes the server's port from `Server:Urls` in the `appsettings.json` beside it
(or `Server__Urls`); after that the address is the tray's own setting (Settings → *Hangar address*).

| Key                         | Meaning                                              | Default              |
| --------------------------- | ---------------------------------------------------- | -------------------- |
| `Server:Urls`               | Kestrel bind address(es). `http://0.0.0.0:5099` = reachable from the LAN (set a password first) | `http://127.0.0.1:5099` |
| `Server:PublicUrl`          | The address people are sent to (by the tray, a second launch, and as the Web Push subject), e.g. your reverse proxy's `https://` URL; unset = loopback on the bound port | (unset) |
| `Auth:Password`             | Bootstrap-only plaintext; hashed to `auth.json` in the data folder on start, then remove it. Empty with no stored hash = no login, and **only requests made on this machine are answered** | `""` |
| `Auth:ApiKey`               | API key for `/api/external/*` (`X-Api-Key` header). Empty = the external API is off, except for local requests while no password is set | `""` |
| `Sessions:ClaudeExecutable` | Path or command for the CLI. An **absolute path is recommended**; a bare name is resolved through `PATH`, first match wins | `claude` |
| `Sessions:AutoTrustFolders` | Pre-accept Claude's workspace-trust prompt per folder (writes `~/.claude.json`) | `true` |
| `Sessions:ResumeOnStart`    | On start, relaunch the sessions that were running at the last exit | `true` |
| `Sessions:ResumeDelayMs`    | Settling delay before auto-resume starts (lets a booting PC come up) | `5000` |
| `Sessions:ResumeStaggerMs`  | Pause between consecutive auto-resumed launches      | `2000`               |
| `Sessions:SelfUrl`          | URL a session calls back on (`HANGAR_URL`); empty = derived from the bound port | `""` |
| `Hooks:Enabled`             | Register this instance's hooks in `~/.claude/settings.json` (drives busy/waiting/failed status). Off = terminal heuristics only | `true` |
| `Hooks:Force`               | Claim that registration even when another instance is live on the port it currently names | `false` |
| `Pty:InstanceKey`           | Namespaces this instance's pty pipes and state dir; empty = the bound port. Keeps a second instance from adopting another's sessions | `""` |
| `Pty:HostExecutable`        | Path to the pty host; empty = beside the app        | `""`                 |
| `Pty:AttachTimeoutMs`       | How long a host has to answer its pipe before its state file is called stale | `3000` |
| `Pty:StartTimeoutMs`        | How long a freshly launched host has to come up and accept a connection | `20000` |
| `Pty:OrphanMaxAgeHours`     | Auto-stop untracked sessions older than this; `0` never does (they are listed in the sidebar and tray instead) | `0` |
| `Schedules:Enabled`         | Master switch for the clock; off means no schedule ever fires | `true`      |
| `Schedules:MaxConcurrentRuns` | Most scheduled runs in flight at once, across every schedule | `4`         |
| `Schedules:DoneAfterIdleSeconds` | How long a run must sit idle before **Stop when done** stops it | `20`   |
| `Schedules:RestoreWaitSeconds` | How long to wait for a reopened session's terminal before giving up on poking it | `45` |
| `Watchdog:Enabled`          | Master switch for auto-recovery; off means no host ever auto-continues | `true` |
| `Watchdog:PollIntervalMs`   | How often a host re-examines its own session      | `2000`               |
| `Watchdog:CooldownMs`       | Minimum gap between auto-continues for one session| `20000`              |
| `Watchdog:MaxConsecutive`   | Attempts before giving up and flagging for attention | `3`               |
| `Watchdog:SendSequence`     | What is typed to recover, and by the manual **Continue** button | `continue\r` |
| `Watchdog:ErrorPatterns`    | Case-insensitive regexes that mean "this session looks hung" | (API/stream errors) |
| `Watchdog:PromptGuardPatterns` | Regexes for an on-screen prompt; any match and the watchdog stays silent | (dialog wording) |
| `Update:Enabled`            | Offer in-app updates from the staging folder        | `true`               |
| `Update:StagingPath`        | Folder updates are staged into (the build lands in its `payload` subfolder). Must be writable only by you: whatever lands there runs as you. A relative path is taken from the install folder | `<data>/updates` |
| `Update:PollSeconds`        | Re-read the staged build this often (a watcher already catches it sooner) | `30` |
| `Update:InstallPath`        | Install folder to update; empty = the folder the running exe is in | `""`   |
| `Update:ShutdownWaitSeconds`| How long the updater lets the app close before forcing it down | `45`       |
| `FileSystem:DefaultFolder`  | Folder the picker opens at when creating a session; empty = your user profile | `""` |
| `Push:Subject`              | VAPID subject for Web Push (`mailto:` or `https:`); unset = `Server:PublicUrl` | (unset) |

## Updating

### From a checkout on the same machine

Pull and redeploy. Settings are preserved and running sessions survive:

```powershell
git pull
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1
```

```bash
git pull && scripts/build.sh && scripts/install-unix.sh
```

### In-app updates

The in-app updater splits build and install in two, so a new build can be published without touching
the running app and installed with a click in the UI:

```powershell
# Build and stage a pending update. Does NOT touch the running app.
powershell -ExecutionPolicy Bypass -File scripts\stage-update.ps1     # -NotesFile whats-new.md, -NoTray, -Staging <folder>
```

```bash
scripts/stage-update.sh [--skip-build] [rid] [staging dir]
```

That drops the build into the staging folder's `payload` subfolder. On Windows the folder is
`-Staging` when given, else `%Update__StagingPath%`, else `Update:StagingPath` from the install's
`appsettings.Local.json`, else from its `appsettings.json`, else `%LocalAppData%\Hangar\updates` —
the same folder the app watches. On Linux and macOS it is `<data>/updates` unless you pass one.

The running app compares the staged `build.json` with its own and puts an **Update** button next to
the "Hangar" title in the sidebar as soon as they differ. Clicking it shows both build stamps (and the
"what's new" notes, if staged with them) and, on confirmation:

1. the server answers the request, then stops itself — gracefully, detaching from each session's pty
   host, so the sessions themselves keep running;
2. the tray hears the update coming over `/hub/events` and steps aside so its executable can be
   replaced, and comes back once the new server answers;
3. a detached `apply-update.ps1` / `apply-update.sh` (embedded in the server, extracted to the data
   folder) waits for the server to exit, copies the payload over the install folder and restarts the
   server the same way it was running — the service or unit if there is one, otherwise the exe;
4. the sessions that were running are re-attached, exactly as after a redeploy (one that did die is
   resumed instead — see `Sessions:ResumeOnStart`);
5. the browser sits behind an "Installing the update…" overlay until the new build answers, then
   reloads so it picks up the new frontend assets too.

`appsettings*.json` in the install folder are preserved, never overwritten by the payload. The
updater logs every step to `<data>/logs/update.log`, and on any failure it restarts the app rather
than leaving the machine with nothing running.

Staging is safe at any time — it only writes to the staging folder, and the payload is swapped into
place at the end so the app never reads a half-copied build. `stage-update.ps1` refuses a build that
lacks commits the installed one has (`-AllowDroppingCommits` overrides). Set `Update:Enabled` to
`false` to turn the whole thing off and update with `deploy.ps1` only.

### Updating another machine

A machine with no .NET SDK or Node of its own — a small home server, say — is updated from one that
has them: `scripts/stage-update-remote.sh <ssh host>` builds for it here (its own runtime, read from
it), copies the payload into that machine's staging folder over ssh, and its Update button does the
rest. `--notes whats-new.md` carries a "what's new" in `stage-update.ps1`'s format; without it, the
commit subjects since the build installed there. Paired with another node, its Update button is also
on its heading there.

## API

### Programmatic session creation

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

**From PowerShell**, [`scripts/hgr-new-session.ps1`](scripts/hgr-new-session.ps1) wraps this endpoint:
every request field is a parameter, the key and URL come from `HANGAR_API_KEY` and `HANGAR_URL`
(default `http://127.0.0.1:5099`), and `-Child` nests the new session under the one the script is
running inside. Its full reference, written for agents calling it, is
[`scripts/hgr-new-session.agent.md`](scripts/hgr-new-session.agent.md).

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

### Self-service API for a running session

A running session can act on **itself** — rename itself, open files or pull requests in its own tab
bar, point its branch badge at a worktree — with no browser login and no API key: every session
Hangar launches carries its own credentials in its environment, and they are all the calls take.

| Env var             | What it is                                                       |
| ------------------- | ---------------------------------------------------------------- |
| `HANGAR_URL`        | Base URL of the app, on loopback (e.g. `http://127.0.0.1:5099`)  |
| `HANGAR_SESSION_ID` | This session's id — also the session the calls act on            |
| `HANGAR_HOOK_TOKEN` | Local secret that authorizes the call (also used by the hooks)   |

The session id comes from the header injected at launch, so a session can only ever act on itself —
the endpoints can't be aimed at another session, and they stay shut to anything that can't read that
session's environment. Same trust boundary as the `/api/hooks` callback. The token is minted once and
kept in `auth.json`, not regenerated per app run, because a session's environment is fixed when its
`claude` process starts and that process outlives the app.

All of them answer `401` when the headers are missing or wrong.

#### Rename: `POST /api/self/name`

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

#### Open files: `POST /api/self/open`

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

#### Open a pull request: `POST /api/self/open-pr`

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

#### Show a worktree's branch: `POST /api/self/worktree`

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

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the checks to run and the rules for running a dev instance
beside an installed one. In short:

```powershell
# Windows: backend on http://127.0.0.1:5199 + Vite on http://localhost:5173 (proxies /api and /hub)
powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
# or just the backend, serving the built SPA, on http://127.0.0.1:5199
powershell -ExecutionPolicy Bypass -File scripts\run.ps1
```

Both run a **dev instance** that is safe beside an installed Hangar:

- it listens on `-Port` (default **5199**, not the installed app's 5099);
- its data folder is its own: `HANGAR_TEST_ROOT` is set to `-DataRoot` (default
  `%LocalAppData%\Hangar-dev`), so its sessions, settings, node identity and pty hosts live in
  `%LocalAppData%\Hangar-dev\Hangar`. `-SharedData` uses the real `%LocalAppData%\Hangar` instead —
  only with the installed app stopped;
- **Claude hooks are always off** (`Hooks:Enabled=false`): `~/.claude/settings.json` is global, and a
  dev instance that registered itself would point every Claude Code session on the machine at its
  port — and leave them all failing hook calls once it stopped;
- sessions are not resumed on start (`Sessions:ResumeOnStart=false`).

On Linux and macOS, run the backend from `server/` the same way:
`HANGAR_TEST_ROOT=~/.hangar-dev dotnet run --no-launch-profile -- --Server:Urls=http://127.0.0.1:5199 --Hooks:Enabled=false --Sessions:ResumeOnStart=false`.

Neither script starts the tray. A dev copy of the tray with a settings folder of its own runs beside
the installed one (it skips the single-instance check), and is pointed at a dev server in its Settings:

```powershell
cd tray
$env:HANGAR_TRAY_CONFIG_DIR = "$env:TEMP\hangar-tray-dev"; npm run tauri dev
```

## Troubleshooting

**"This Hangar has no password set, so it only answers requests made on this machine."** You opened it
from another device, or through a proxy, with no password set. Set `Auth:Password`
([First run](#first-run-set-a-password)).

**"Too many wrong passwords."** Login is rate-limited per client (5 free attempts, then 30 s doubling up
to 15 min). Wait for the time it names, or restart the server, which forgets the counts.

**Sessions that won't authenticate, a `claude` that "isn't installed", folders that come up empty.**
These usually mean the server is running as a different identity, or with a different environment,
than the one you use `claude` from. The server reports its own at startup — one `Environment:` line in
`<data>/logs/hangar.log`, plus a warning for each problem it finds — and on demand:

```bash
# any logged-in browser's token, or the "token" in <data>/instances/<port>.json
curl -H "Authorization: Bearer <token>" http://localhost:5099/api/health/environment
```

It names the user, whether it is a service (and which Windows session), the `claude` and `git` it
resolved, the profile and data folders, and whether `~/.claude/settings.json`, `~/.claude.json` and
`claude`'s credentials file exist there and can be read.

**The wrong `claude` is launched.** With several installs, a bare `claude` resolves to the first one on
the server's `PATH`. Check `claude --version`, and set `Sessions:ClaudeExecutable` to an absolute path.
On Linux and macOS, re-run `install-unix.sh` after installing tools somewhere new so the unit's `PATH`
picks them up.

**Sessions don't show up in the Claude Code app.** Remote Control needs a supported plan, a recent
Claude Code, and `ANTHROPIC_BASE_URL` unset or pointed at `api.anthropic.com` — otherwise Remote
Control is disabled (Claude Code v2.1.196+).

**`hook error connect ECONNREFUSED` in Claude Code sessions.** `~/.claude/settings.json` names a Hangar
port nothing listens on: Hangar is stopped or uninstalled, or was moved to another port. Start it again
(it re-registers its port on start), or remove the hook entries
([details](#what-hangar-changes-outside-its-own-folders)).

**A schedule says overdue.** The server wasn't running at the time. Schedules are only as reliable as
the server's own start: at sign-in (with autologin for an unattended machine), a service, or a lingering
systemd user unit.

**macOS captures show only the wallpaper.** Grant the tray *Screen Recording* permission (System
Settings → Privacy & Security). See [tray/README.md](tray/README.md#platform-notes) for Wayland.

**Update button never appears.** The staging folder the script used is not the one the app watches.
Check `Update:StagingPath` in the install's `appsettings.Local.json` / `appsettings.json`, or pass
`-Staging`.

Logs: `<data>/logs/hangar.log` (server) and `<data>/logs/update.log` (updater).

## Repository layout

```
server/   .NET 10 daemon, the Minimal API host (Program.cs, Sessions/, Auth/, Nodes/, FileSystem/, Diagnostics/, Logging/, Update/)
ptyhost/  the per-session pty host that owns each pseudoconsole
shared/   source shared between projects: Pty/ (daemon <-> pty host), Common/, Contract/ (the wire records the tray reads)
web/      React + Vite + TS + Tailwind + shadcn/ui web UI
tray/     the tray app: tray menu and screenshots, a client of the daemon's API (Tauri: Rust + React)
docs/     design notes
scripts/  build.ps1, deploy.ps1, register-autostart.ps1, uninstall.ps1, install-service.ps1, uninstall-service.ps1,
          dev.ps1, run.ps1, deploy-wwwroot.ps1, stage-update.ps1 + apply-update.ps1 (the two halves of the in-app updater),
          _paths.ps1 (install/staging/data folder resolution, dot-sourced by the others), hgr-new-session.ps1;
          build.sh, install-unix.sh, stage-update.sh + apply-update.sh (the same, for Linux and macOS);
          stage-update-remote.sh (stage a Linux/macOS build on another machine over ssh)
```

## License

[MIT](LICENSE).
