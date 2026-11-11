[← Hangar](../README.md)

# How it works

## How a session is launched

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
[What Hangar changes outside its own folders](install.md#what-hangar-changes-outside-its-own-folders)).

Every session gets `HANGAR_URL`, `HANGAR_SESSION_ID` and `HANGAR_HOOK_TOKEN` in its environment, which
is what its hooks and the [self-service API](api.md#api) use.

## Architecture

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
   │  pseudoconsole + 512 KB scrollback ring + fan-out + busy/waiting state
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

Design notes for the larger pieces live in [docs/design/](design/):
[multi-node.md](design/multi-node.md), [pty-host-detach.md](design/pty-host-detach.md),
[session-scheduling.md](design/session-scheduling.md),
[vt-screen-model.md](design/vt-screen-model.md).
