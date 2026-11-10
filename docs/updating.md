[← Hangar](../README.md)

# Updating

## From a release

An install from a release updates itself. A minute after it starts, and every 6 hours from then
(`Update:CheckHours`), it looks at the [releases](https://github.com/sdm-kz/hangar/releases). When there
is a newer one, it downloads this machine's archive, checks it against the release's `SHA256SUMS` and
that file's signature by the [release key](releasing.md#the-release-signing-key), and stages it; a release
that isn't signed with it is not offered. The **Update** button then appears with the release's "what's
new", and the rest is the [in-app update](#in-app-updates) below. `POST /api/update/check` looks right away. Prereleases are left
out unless `Update:Prereleases` is `true`; `Update:Source` and `Update:Repo` choose where updates come
from ([configuration](configuration.md)). A build staged from a checkout, newer than the one running
and not installed yet, is not replaced by a release.

The in-app update replaces what is in the install folder, as a redeploy does. When a release changes
the installer itself (the service or unit it writes, a menu entry), its notes say so: run the
[one-line installer](install.md#from-a-release) again. It installs the latest release over the one you
have, keeping settings (`appsettings*.json`), the app's data, running sessions and, on Windows, your
sign-in entries.

A build made from a checkout never looks for releases: it is updated by a redeploy or by staging, as
below.

## From a checkout on the same machine

Pull and redeploy. Settings are preserved and running sessions survive:

```powershell
git pull
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1
```

```bash
git pull && scripts/build.sh && scripts/install-unix.sh
```

## In-app updates

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

## Updating another machine

A machine with no .NET SDK or Node of its own — a small home server, say — is updated from one that
has them: `scripts/stage-update-remote.sh <ssh host>` builds for it here (its own runtime, read from
it), copies the payload into that machine's staging folder over ssh, and its Update button does the
rest. `--notes whats-new.md` carries a "what's new" in `stage-update.ps1`'s format; without it, the
commit subjects since the build installed there. Paired with another node, its Update button is also
on its heading there.
