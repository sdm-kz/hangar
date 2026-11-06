[← Hangar](../README.md)

# Troubleshooting

**"This Hangar has no password set, so it only answers requests made on this machine."** You opened it
from another device, or through a proxy, with no password set. Set `Auth:Password`
([First run](install.md#first-run-set-a-password)).

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
([details](install.md#what-hangar-changes-outside-its-own-folders)).

**A schedule says overdue.** The server wasn't running at the time. Schedules are only as reliable as
the server's own start: at sign-in (with autologin for an unattended machine), a service, or a lingering
systemd user unit.

**macOS captures show only the wallpaper, or come out blank.** Grant the tray *Screen Recording*
permission (System Settings → Privacy & Security), then quit and reopen it. Switched on but blank after
an update: the permission belongs to the build before. Remove Hangar Tray App from the list with **−**,
capture again and allow it, and run `scripts/setup-macos-signing.sh` so the next update keeps it. See
[tray/README.md](../tray/README.md#platform-notes) for Wayland.

**Update button never appears.** The staging folder the script used is not the one the app watches.
Check `Update:StagingPath` in the install's `appsettings.Local.json` / `appsettings.json`, or pass
`-Staging`.

Logs: `<data>/logs/hangar.log` (server) and `<data>/logs/update.log` (updater).
