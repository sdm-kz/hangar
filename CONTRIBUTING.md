# Contributing to Hangar

Thanks for helping. This page covers the dev loop, the checks to run before sending a change, and the
one rule that keeps a dev instance from breaking the Hangar you actually use.

Report security issues as described in [SECURITY.md](SECURITY.md), **not** in public issues.

## Glossary

The **installed instance** is the Hangar you run day to day: deployed to `%LocalAppData%\Programs\Hangar`
(or `~/.local/opt/hangar`), on port 5099, with its data in `%LocalAppData%\Hangar` (or
`~/.local/share/Hangar`, `~/Library/Application Support/Hangar`). A **dev instance** is one run from
this checkout (`scripts\dev.ps1`, `scripts\run.ps1`, `dotnet run`) or from a disposable copy of a build,
for testing. The **pty host** (`Hangar.PtyHost`) is the small detached process that owns one session's
(or one shell tab's) pseudoconsole; it outlives the server, which is how sessions survive restarts. A
**node** is another machine running Hangar, paired with this one.

## Setting up

Prerequisites are listed in the [install guide](docs/install.md#prerequisites): the .NET 10 SDK, Node 22.12+ (`.nvmrc`
says 24), Git, a logged-in Claude Code CLI, and Rust only if you work on the tray.

**Windows:**

```powershell
# Backend on http://127.0.0.1:5199 (separate window) + Vite on http://localhost:5173, which proxies /api and /hub
powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
# Just the backend, serving the built SPA from server\wwwroot, on http://127.0.0.1:5199
powershell -ExecutionPolicy Bypass -File scripts\run.ps1
```

Both take `-Port`, `-DataRoot` and `-SharedData` (see the safety rules below and the scripts' help).

**Linux / macOS:** there is no dev script; run the backend from `server/` with the same isolation, and
Vite from `web/` if you want hot reload:

```bash
cd server
HANGAR_TEST_ROOT="$HOME/.hangar-dev" dotnet run --no-launch-profile -- \
  --Server:Urls=http://127.0.0.1:5199 --Hooks:Enabled=false --Sessions:ResumeOnStart=false

cd web && BACKEND_URL=http://127.0.0.1:5199 npm run dev
```

`scripts/build.sh` builds the full set (SPA, server, pty host and, when it can, the tray) into
`publish/`.

**Tray:** see [tray/README.md](tray/README.md#developing). Give a dev tray its own settings folder with
`HANGAR_TRAY_CONFIG_DIR`, which also lets it run beside the installed one.

## Safety rules for dev and test instances

A dev instance runs as you, on the same machine as your installed Hangar, so it can damage that
installation in two ways. Both are prevented by default; keep it that way.

1. **Never share the installed instance's data folder.** Sessions, settings, the node identity and the
   pty hosts' state all live there. The app reads `HANGAR_TEST_ROOT` as a stand-in for
   `%LocalAppData%` (setting `LOCALAPPDATA` itself does nothing), so a dev instance with
   `HANGAR_TEST_ROOT=X` keeps its data in `X\Hangar`. `dev.ps1` and `run.ps1` set it to
   `%LocalAppData%\Hangar-dev` unless it is already set. `-SharedData` uses the real data folder; only
   ever with the installed app stopped.
2. **Never let a dev instance register Claude Code hooks.** `~/.claude/settings.json` is global: every
   `claude` on the machine posts its events to the one port registered there. A dev instance that
   registered itself would take those events from the installed one and, once stopped, leave every
   session failing hook calls with `ECONNREFUSED`. Dev instances run with `Hooks:Enabled=false`;
   `dev.ps1`, `run.ps1` and the `Hangar (debug 5199, no hooks)` launch profile all set it. If you start
   the server any other way, pass `--Hooks:Enabled=false` yourself.

Also:

- Use a port other than 5099 (dev scripts default to **5199**). Pass the port as `Server:Urls`;
  `dotnet run --urls` is overridden by the settings files. `--no-launch-profile` keeps the launch
  profile from putting its own port back.
- To try a published build, copy it to a disposable folder and run it from there with
  `HANGAR_TEST_ROOT` set and hooks off. Don't run a second copy in place over the install.
- **Stop test instances by executable path, never by image name.** `Stop-Process -Name Hangar` or
  `taskkill /im Hangar.exe` also kills the installed server. Match the path instead:

  ```powershell
  Get-Process Hangar | Where-Object { $_.Path -eq 'C:\scratch\hangar-test\Hangar.exe' } | Stop-Process
  ```

  Leave `Hangar.PtyHost` processes alone unless you mean to end the sessions in them.

## Repository layout

```
server/   .NET 10 daemon, the Minimal API host (Program.cs, Sessions/, Auth/, Nodes/, FileSystem/, Diagnostics/, Logging/, Update/)
ptyhost/  the per-session pty host that owns each pseudoconsole
shared/   source shared between projects: Pty/ (daemon <-> pty host), Common/, Contract/ (the wire records the tray reads)
web/      React + Vite + TS + Tailwind + shadcn/ui web UI
tray/     the tray app: tray menu and screenshots, a client of the daemon's API (Tauri: Rust + React)
docs/     the documentation (install, features, configuration, updating, API, how it works, troubleshooting,
          releasing), screenshots (images/) and design notes (design/)
.github/  workflows/release.yml: a v* tag builds every platform and drafts a GitHub release (docs/releasing.md)
scripts/  build.ps1, deploy.ps1, register-autostart.ps1, uninstall.ps1, install-service.ps1, uninstall-service.ps1,
          dev.ps1, run.ps1, deploy-wwwroot.ps1, stage-update.ps1 + apply-update.ps1 (the two halves of the in-app updater),
          _paths.ps1 (install/staging/data folder resolution, dot-sourced by the others), hgr-new-session.ps1;
          build.sh, install-unix.sh, stage-update.sh + apply-update.sh (the same, for Linux and macOS);
          stage-update-remote.sh (stage a Linux/macOS build on another machine over ssh);
          install.sh, install.ps1 (the one-line installers, attached to each release)
```

## Checks

Run the ones for the parts you changed. There is no single test command.

**Server** (`server/`, `ptyhost/`, `shared/`):

```bash
dotnet build server
dotnet build ptyhost
```

**Web UI** (`web/`):

```bash
cd web
npm ci
npx tsc --noEmit -p tsconfig.app.json
npm run build
```

Note that `npx tsc -p .` type-checks nothing: the root `tsconfig.json` only references the others. Use
`-p tsconfig.app.json` (or `npm run build`, which runs `tsc -b`).

**Tray** (`tray/`):

```bash
cd tray
npm ci
npm test                         # frontend unit tests (vitest)
cd src-tauri
cargo test
cargo clippy --all-targets
```

If you change the UI, look at it in a running dev instance, in both light and dark themes and at a
phone width.

## Commits and pull requests

Commits follow [Conventional Commits](https://www.conventionalcommits.org/), with a scope naming the
area, as in the existing history:

```
feat(tray): an Activity submenu with the web app's sessions fraction
fix(sessions): the branch badge stays on the picked worktree while its folder changes
refactor(scripts): fold hgr-new-child-session into hgr-new-session -Child
```

Common types are `feat`, `fix`, `refactor`, `style`, `docs` and `chore`; common scopes include
`sessions`, `files`, `nodes`, `tray`, `terminal`, `sidebar` and `scripts`. The subject says what is
true after the change, in plain words. Use the body for the why when it isn't obvious.

Keep a pull request to one change, describe how you tested it, and update the docs (README.md and docs/) when
behaviour, configuration or scripts change.

By contributing you agree that your contribution is licensed under the project's [MIT license](LICENSE).
