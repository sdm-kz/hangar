[← Hangar](../README.md)

# Installing Hangar

## From a release

**Linux and macOS:**

```bash
curl -fsSL https://github.com/sdm-kz/hangar/releases/latest/download/install.sh | sh
```

**Windows**, in PowerShell (Windows PowerShell 5.1 or PowerShell 7):

```powershell
irm https://github.com/sdm-kz/hangar/releases/latest/download/install.ps1 | iex
```

The installer downloads the build for your machine from the latest release, checks it against the
release's `SHA256SUMS`, and installs it with the same scripts a build from source uses:

- **Linux and macOS:** into `~/.local/opt/hangar`, started now and at sign-in, as a systemd user unit or a
  launchd agent (see [Linux and macOS](#linux-and-macos)).
- **Windows:** into `%LocalAppData%\Programs\Hangar`, started now, and at sign-in from the first install
  (see [Windows](#windows)). The tray starts too.

Then open **http://localhost:5099**, and [set a password](#first-run-set-a-password) before you reach it
from anywhere else.

**Run it again to update.** Settings (`appsettings*.json`), the app's data and running sessions are kept,
and on Windows so are your sign-in entries. The in-app Update button works too.

Settings, as environment variables:

| Variable | |
|---|---|
| `HANGAR_VERSION` | A release to install instead of the latest, such as `0.1.0`, or a prerelease such as `0.2.0-rc.1` |
| `HANGAR_INSTALL_DIR` | Where to install it |
| `HANGAR_NO_AUTOSTART=1` | Windows: add no sign-in entries on a first install |

```bash
curl -fsSL https://github.com/sdm-kz/hangar/releases/latest/download/install.sh | HANGAR_VERSION=0.1.0 sh
```

```powershell
$env:HANGAR_VERSION = "0.1.0"; irm https://github.com/sdm-kz/hangar/releases/latest/download/install.ps1 | iex
```

**Builds:** Windows x64 and arm64, macOS on Apple silicon and Intel, Linux x64 and arm64. The Linux tray
needs glibc 2.39 or later (Ubuntu 24.04, Debian 13); the server runs on older systems too. On macOS the
tray is signed with Hangar's release certificate, so the permissions you grant it (Screen Recording,
Accessibility) carry over from one release to the next.

**Before you pipe it to a shell**, you can read it: open the same URL in a browser. To check that a
download was built by this repository's release workflow, from the tagged commit:

```bash
gh attestation verify hangar-linux-x64.tar.gz --repo sdm-kz/hangar
```

**Uninstalling** uses the scripts the installer keeps in the install folder:
`~/.local/opt/hangar/scripts/install-unix.sh --uninstall`, or
`%LocalAppData%\Programs\Hangar\scripts\uninstall.ps1`. See [Uninstall](#uninstall).

## Prerequisites

To run Hangar, from a release or from source:

- **Claude Code CLI**, installed and logged in for your user account with a Claude subscription
  (Remote Control needs a Pro, Max, Team or Enterprise plan, and Claude Code v2.1.51 or later). Run
  `claude` once in a terminal and log in before starting Hangar.

To build it from source, also:

- **Git**.
- **.NET 10 SDK** (pinned by [`global.json`](../global.json)).
- **Node.js 22.12+** ([`.nvmrc`](../.nvmrc) names 24).
- **PowerShell** on Windows (Windows PowerShell 5.1 or PowerShell 7); **bash** on Linux and macOS.
- Optional: **GitHub CLI (`gh`)**, signed in (`gh auth login`), for the pull-request features.
- Optional, only for the **tray app**: **Rust** (cargo) plus the platform's webview toolchain: the MSVC
  build tools on Windows, the [Tauri prerequisites](https://tauri.app/start/prerequisites/) on Linux
  (`webkit2gtk-4.1` and friends) plus `libayatana-appindicator3` and the screen-capture libraries listed
  in [tray/README.md](../tray/README.md#developing), Xcode command line tools on macOS. Without Rust the
  build simply leaves the tray out.
- Optional, Windows: the **MSVC build tools** ("Desktop development with C++"). With them, a `build.ps1`
  for the machine's own CPU compiles the per-session pty host to native code, which is smaller and
  lighter on memory; without them (or for another CPU) it ships the same host as a larger trimmed .NET file.

The builds are self-contained: the machine that only *runs* Hangar needs no .NET runtime or Node.

## Windows

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

## Linux and macOS

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
- On macOS, run `scripts/setup-macos-signing.sh` once to keep the tray's *Screen Recording* and
  *Accessibility* permissions across updates. An ad-hoc build is a new app to macOS each time, and its
  captures come out blank until the permission is granted again. The script makes a self-signed
  code-signing certificate on the Mac, and `build.sh` and `stage-update-remote.sh` sign with it from then
  on. Its header has the details and the trade-off.

More in [Linux and macOS details](#linux-and-macos-details).

## First run: set a password

Without a password Hangar works from this machine only, which is fine for trying it out. Before using
it from anywhere else, set one. Opened on the machine itself, Hangar offers that under the sidebar's
header: **Set a password…** asks for it twice (at least 8 characters), stores its hash in the data
folder (`auth.json`) and keeps this browser signed in, with no restart.

To set it without the page, or to **change** a password that is set (which the page doesn't do):

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

## Running as a Windows service

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

## Linux and macOS details

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

## Uninstall

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
| HTTP **hooks** for `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SubagentStart`, `Notification`, `PermissionRequest`, `Stop`, `StopFailure`, each pointing at `http://127.0.0.1:<port>/api/hooks`, and a **command** hook for `SessionStart` that posts to the same URL with `curl` | `~/.claude/settings.json`, under `hooks` | Every server start | `Hooks:Enabled=false` (session status then falls back to terminal heuristics) |
| `skipDangerousModePermissionPrompt: true` (pre-accepts the one-time warning for `--dangerously-skip-permissions`) | `~/.claude/settings.json` | The first time a session is started with `bypassPermissions` | Don't use that mode |
| `projects["<folder>"].hasTrustDialogAccepted: true` (pre-accepts workspace trust) | `~/.claude.json` | Before launching a session in a folder not already listed | `Sessions:AutoTrustFolders=false` (then accept the prompt yourself in the Claude Code app) |

About the hooks:

- They are **global**: every `claude` on the machine calls them. A `claude` that Hangar didn't launch
  carries no session headers, and the server ignores its calls.
- `SessionStart` is a command because Claude runs no `http` hook for that event, and it is the one that
  names the conversation a `/clear` starts (the chat view follows it there at once). It needs `curl`,
  which Windows 10 and later, macOS and most Linux systems have; it posts only for a session Hangar
  launched, prints nothing and never fails. Without it, the chat catches up with a `/clear` at the next
  prompt instead.
- A second Hangar on another port does not take them over while the instance they name is still
  listening (`Hooks:Force=true` overrides that). Dev instances never register them (see
  [Development](../CONTRIBUTING.md#safety-rules-for-dev-and-test-instances)).
- **Uninstalling does not remove them.** While nothing listens on that port, Claude Code reports hook
  errors (`ECONNREFUSED`) on tool calls in every session. Open `~/.claude/settings.json`
  (`%USERPROFILE%\.claude\settings.json` on Windows) and delete the hook handlers whose `url` ends in
  `/api/hooks` and the `SessionStart` command that posts to it, keeping any others.
  `skipDangerousModePermissionPrompt` and the trust entries in
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
