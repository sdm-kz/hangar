# Detach ≠ kill: move the ConPTY into a per-session host process

**Goal.** A launched `claude` session survives a restart of `Hangar.exe` — in-app update,
`deploy.ps1`, tray **Exit**, or a crash. On the next start the web app *re-attaches* to the live
session (scrollback intact, conversation mid-turn intact) instead of relaunching it with
`--resume`/`--continue`.

**Non-goal.** Surviving a machine reboot. A ConPTY child cannot; `Sessions:ResumeOnStart` stays
exactly as it is for that case.

---

## 1. Why this shape, and no other

ConPTY hands you an `HPCON`. It is **not transferable**: there is no supported way to
`DuplicateHandle` it into another process, and the `conhost.exe --pty` backing it is bound to the
lifetime of the process that created it. When that process dies the pipes break, conhost tears
down, and the attached child gets a console-close. The codebase already records the finding:

> `server/Sessions/ClaudeSession.cs:406` — *"a ConPTY child cannot outlive the host that owns its
> pseudoconsole master."*

So there is no "detach the pty and pick it up later." The only mechanism available is:
**the process that owns the ConPTY must not be the process that restarts.**

### The good news

`TerminalChannel` is *already* the attach/detach layer — 512 KB scrollback ring, N subscribers,
replay-on-connect, single writer back to the PTY. Its own doc comment says "tmux-attach semantics."
It is correct code; it is simply hosted in the process that dies. **This work is mostly relocation,
not new logic.**

Also already in place and reusable:

- `POST /api/sessions/{id}/detach` → `Remove(id, stopProcess: false)` — forget but don't kill.
- `SessionManager.SavePersisted` / `sessions.json` — launch metadata already survives restarts.
- `TerminalSocket`'s framing (binary = VT bytes, text = JSON control) — transplants onto a named
  pipe nearly unchanged.

### Target architecture

```
Hangar.exe                         <- restarts, updates, crashes freely
   |  named pipe \\.\pipe\hangar-pty-<instance>-<sessionId>
   v
Hangar.PtyHost.exe   (one per session, DETACHED_PROCESS, own job)
   |  owns HPCON + TerminalChannel (ring, fan-out, sniffers) + watchdog
   v
claude.exe
```

**One host per session**, not one multiplexing server: crash isolation is free, the lifecycle is
trivial (host exits when its child exits), and each ConPTY spawns its own conhost regardless — so
this adds one process per session, not two.

---

## 2. Project layout

New project `ptyhost/Hangar.PtyHost.csproj`:

- `net10.0` (**not** `-windows`), `OutputType=Exe`, console subsystem, self-contained.
- References `Porta.Pty` only. No ASP.NET, no WinForms — keep it small; ~15 MB self-contained
  trimmed versus ~50 MB per process if this were a second entry point in the main exe.
- Consider NativeAOT as a **follow-up**, not now (verify `Porta.Pty` — netstandard2.0, pure managed
  — is AOT-clean before spending time on it).

Alternative considered and rejected: a `--pty-host` switch on the existing `Hangar.exe`. One
binary is simpler to publish, but every host process would then carry the WinForms + ASP.NET image,
and the side-by-side copy the updater needs (§6) is no easier for one big exe than one small one.

### Code that moves, unchanged where possible

| From | To |
| --- | --- |
| `server/Sessions/Pty/PtySession.cs` | `ptyhost/Pty/PtySession.cs` |
| `server/Sessions/Pty/TerminalChannel.cs` | `ptyhost/Pty/TerminalChannel.cs` |
| `server/Sessions/Pty/Vt.cs` | `ptyhost/Pty/Vt.cs` |
| `server/Sessions/WatchdogService.cs` | `ptyhost/WatchdogService.cs` (see §5) |

`server/Sessions/Pty/TerminalSocket.cs` **stays** in the web app — it still bridges browser
WebSocket to terminal; only what sits behind it changes.

---

## 3. The refactor trick: keep the interface, swap the implementation

Extract an interface from today's `TerminalChannel` so that `ClaudeSession`, `TerminalSocket`,
`SessionHub` and `WatchdogService` need minimal edits:

```csharp
public interface ITerminal : IDisposable
{
    Subscription Subscribe();              // Replay + ChannelReader<byte[]>, as today
    Task WriteAsync(byte[] data);
    void Resize(short cols, short rows);
    bool IsBusy { get; }
    string RecentText { get; }             // may become a cached push value — see §5
    string? RemoteUrl { get; }
    int ProcessId { get; }
    event Action<string>? RenameCommandDetected;
    event Action<string>? ColorCommandDetected;
    event Action<int>? Exited;
}
```

- In the **host**: `TerminalChannel : ITerminal` (today's class, essentially as-is).
- In the **web app**: new `server/Sessions/Pty/PtyHostClient : ITerminal` — connects the pipe,
  raises the same events from received frames, forwards writes/resizes.

`ClaudeSession.Terminal` becomes `ITerminal?`. Everything downstream compiles with near-zero churn.

---

## 4. Pipe protocol

**Pipe name:** `hangar-pty-{instanceKey}-{sessionId}`.
**`instanceKey` is load-bearing** — see §8; without it a dev instance on port 5199 will adopt (and
can then kill) the live app's sessions. Default it from the bound port.

`NamedPipeServerStream`, message mode, `maxInstances` > 1 (several browser tabs already attach to
one session today, and the host must keep serving them). `PipeSecurity` granting the current user
SID only.

**Framing** — `[1 byte type][4 byte LE length][payload]`:

| Type | Direction | Payload |
| --- | --- | --- |
| `0x01` | host to client | raw VT output |
| `0x02` | client to host | raw stdin bytes |
| `0x03` | both | UTF-8 JSON control message |

**Handshake.** Client sends `{"type":"hello","protocol":1}`; host replies
`{"type":"welcome","protocol":1,"childPid":...,"childStartTicks":...,"cols":...,"rows":...,"remoteUrl":...,"exited":false}`,
then one `0x01` frame carrying the scrollback replay, then live output.

**Control messages**

- client to host: `resize {cols,rows}` · `ping` · `watchdog {enabled}` · `shutdown {kill}`
- host to client: `pong` · `renamed {name}` · `color {color}` · `remoteUrl {url}` ·
  `state {busy, waiting, watchdogStatus}` · `exited {code}`

Keep protocol changes **additive** — a new web app must be able to attach to a host from the
previous build rather than orphan or kill it (§6).

---

## 5. What the host owns

**Scrollback + sniffers.** The ring, the busy heuristic, and the `/rename` + `/color` + remote-URL
sniffers all move with `TerminalChannel`. They must run host-side or a web-app restart loses the
screen and misses renames.

**The watchdog moves too.** It needs `RecentText` and write access, and — this is the point — a
session that stalls at 3 a.m. *during an update window* should still be recovered. Passed its
`WatchdogOptions` at spawn (JSON file beside the state file); `WatchdogEnabled` toggled live via
the `watchdog` control message; status pushed as a `state` event.

**`RecentText` over a pipe.** Do not make it a synchronous round-trip — `SessionHub` polls ~1 s per
session. The host **pushes** a `state` event on every busy / waiting / watchdogStatus transition
plus a 5 s heartbeat; `PtyHostClient` caches the last value and `IsBusy`/`RecentText` read the cache.

---

## 6. Process lifecycle — the Windows landmines

**Spawn flags.** `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`, no handle inheritance, no console.
Add `CREATE_BREAKAWAY_FROM_JOB` where the parent job permits it — if `Hangar.exe` is ever inside
a job (service host, debugger, some CI parents) the host would otherwise inherit its
kill-on-close and die with it, silently defeating the whole feature.

**Job objects.** `Porta.Pty` very likely puts the child in a job with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (that is how winpty/pty.net do it) — **verify this first**, it
shapes everything. Once the ConPTY lives in the host that job becomes the host's own, which is the
correct place for it: killing the host must still take `claude.exe` down.

**Host exits when:** its child exits (flush remaining output, stamp `exitCode` into the state file
so a late-arriving client can report it), or it receives `shutdown`. It must **not** exit when the
last client disconnects — that is the entire feature. Optional `Pty:OrphanMaxAgeHours`, default `0`
= never.

**The updater will break on this — fix it in the same change.** `apply-update.ps1` mirrors over the
install folder and would hit a locked, running host binary.

1. At spawn time the web app copies `Hangar.PtyHost.exe` into
   `%LocalAppData%\Hangar\ptyhost\<buildStamp>\` (if not already there) and launches **from
   that path**. An update then never touches a running host binary.
2. Prune `<buildStamp>` folders with no live host.
3. `stage-update.ps1` / `build.ps1` publish the host exe alongside; `apply-update.ps1` mirrors it.
4. **Audit the update path for anything that kills the session tree** — it currently assumes
   sessions die and return via `ResumeOnStart`. That assumption is now wrong.

**Service vs. tray, session 0.** A service-spawned host lives in session 0; a later interactive
tray launch must still adopt it. Named pipes cross sessions fine, but set the pipe ACL to the
launching user explicitly rather than relying on the default DACL.

---

## 7. Web-app changes, file by file

**`server/Sessions/ClaudeSession.cs`**
- `Start()` → spawn the host process, then connect `PtyHostClient`, instead of
  `TerminalChannel.Start(...)`.
- New `Attach(PtyStateFile state)` → connect to an already-running host; restore `ProcessId`,
  `_processStartTicks`, `State = Running`, start the fs watcher.
- **`Dispose()` must stop killing the tree.** Split it:
  - `Dispose()` → disconnect the pipe, dispose the fs watcher. Leaves the host alive.
  - `Stop()` → send `shutdown {kill:true}`, wait briefly, then kill the host as a backstop.
  - `KillProcessTree()` is only reachable from `Stop()`.
- Update the now-false class doc comment (lines 6-14) and the `BuildArgs` comment about ConPTY
  children dying with the host.

**`server/Sessions/SessionManager.cs`**
- `Dispose()` (line ~780-789) currently calls `s.Dispose()` on every session, which kills them.
  Change to disconnect-only.
- New adoption pass at startup, **before** the `ResumePersistedAsync` path: scan the pty state dir,
  try-connect each pipe with a short timeout. Connected → adopt as `Running`. Failed → stale, delete
  the file, fall through to today's `Restorable` / auto-resume behaviour.
- `sessions.json` remains the source of truth for metadata (name, colour, model, parent,
  watchdog); the pty state dir only answers "is it still alive?".
- Handle a pipe dropping mid-life (host crashed): mark the session for recovery, do **not** discard
  its metadata.

**`server/Program.cs`**
- Lines 64-67 / 113-117: `BeginShutdown` and host disposal must not take sessions down any more.
- No change to the `/hub/sessions/{id}/terminal` endpoint (line 258) — `TerminalSocket` now pumps
  against a `PtyHostClient`, same `ITerminal`.

**`server/Sessions/SessionHub.cs`** — busy/attention now come from cached pushed state.

**State file:** `%LocalAppData%\Hangar\pty\<instanceKey>\<sessionId>.json`

```json
{ "sessionId": "...", "hostPid": 1234, "hostStartTicks": 638,
  "pipeName": "hangar-pty-5099-abc", "childPid": 5678, "childStartTicks": 638,
  "workingDirectory": "C:\\Git\\x", "buildStamp": "...", "protocol": 1, "createdAt": "..." }
```

`hostStartTicks` / `childStartTicks` guard against PID reuse — the same guard
`ClaudeSession._processStartTicks` already applies. Written on start, deleted on clean exit.

---

## 8. Instance isolation (read this before testing)

`%LocalAppData%\Hangar\` is shared by every instance on the machine. The single-instance mutex is
already port-scoped (`Program.cs:36`), but `sessions.json` is not. **A dev instance started with
`ResumeOnStart=true` will relaunch the live app's sessions**, and once the pty state dir exists it
would also *adopt* the live app's hosts — and could then stop them.

Therefore:

- Pipe names and the pty state dir are namespaced by `instanceKey` (default: bound port,
  overridable via `Pty:InstanceKey`).
- The dev/test config must set `Sessions:ResumeOnStart=false` **and** a separate
  `Sessions:StateFile`.

---

## 9. Phasing

**Phase 1 — make detach ≠ kill work.**
Extract `ITerminal`; create the host project; move `PtySession` / `TerminalChannel` / `Vt`; pipe
protocol; spawn + attach + adoption at startup; fix the `Dispose`-kills-everything paths. Watchdog
temporarily disabled for host-backed sessions. **Ship-able and testable on its own.**

**Phase 2 — parity.**
Move the watchdog into the host; push `state` / `renamed` / `color` / `remoteUrl` events; wire
`SessionHub` to cached state.

**Phase 3 — hardening.**
Updater side-by-side host binaries + prune; orphan management; UI affordances (an "adopted" marker
in the sidebar, a tray "stop all orphaned hosts" action).

---

## 10. Acceptance tests

1. Launch a session, type in the terminal — works as before.
2. **Kill `Hangar.exe` from Task Manager** (not tray Exit) → `claude.exe` is still alive.
   Restart → the session is `Running`, terminal replays, the conversation kept its context, and
   **no `--resume` was issued**.
3. Tray **Exit** → same as (2).
4. In-app update end to end → sessions stay attached across it; browser reload reattaches.
5. **Stop** from the UI → `claude.exe` dies, host exits, state file gone.
6. `claude` exits by itself → host exits, session shows exited, no orphan.
7. Two browser tabs on one session → both attached and live.
8. Watchdog fires while the web app is stopped → recovery visible after reconnect (Phase 2).
9. Stale state file (host killed directly) → cleaned up, session offered as `Restorable`.
10. **Orphan sweep:** after stopping everything, no stray `claude.exe`, `Hangar.PtyHost.exe`, or
    `conhost.exe` remains.
11. Reboot → sessions come back via `ResumeOnStart`, exactly as today (unchanged behaviour).

---

## 11. Docs to update when done

`README.md` — the "Auto-resume across restarts" note and the architecture diagram both describe the
current kill-and-resume model. Also fix the stale "**not a terminal**" framing near the top, which
predates the xterm.js terminal entirely.
