[← Hangar](../README.md)

# Configuration

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
