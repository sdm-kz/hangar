# Hangar Tray App

Hangar in the tray, on Windows, macOS and Linux (`Hangar.Tray`). It does two things:

- **The tray menu.** It follows a Hangar server: the server's state, its running sessions, and the
  server controls, for a server on this machine.
- **Screenshots.** Press a hotkey, pick part of the screen, mark it up, type a message, and send both to
  one of the server's sessions. The picture lands in the session's prompt exactly as an image pasted in
  the web UI does.

It replaces two apps: the Windows-only tray icon (WinForms) and Hangar Snap, the screenshot app it grew
out of. On its first run it carries Snap's settings over (the server, its sign-in, the hotkeys) and takes
Snap out of the sign-in items.

Built with [Tauri 2](https://tauri.app): a small Rust shell (tray, hotkeys, screen capture, talking to
the server) and a React page for the overlay, the editor and the settings.

## The menu

```
Open Hangar
Activity  1/3         ▸  Waiting on you · 1    (only while anything is busy, waiting or finished)
                         Working · 1
                         Finished · 1
Sessions  (12)        ▸  Running — 12
                         App  (5)            ▸  (folder groups, sessions, forks)
                         No project  (7)     ▸
                         Recent — 30         ▸
                         ───
                         nas — 3 running     ▸  (a submenu per paired machine)
───
Capture region        Ctrl+Shift+1
Capture window        Ctrl+Shift+2
Capture full screen   Ctrl+Shift+3
Capture freeform      Ctrl+Shift+4
───
Settings…
✓ Start when I sign in
───
Stop 2 orphaned session(s)…     (only when there are any)
Stop server…
Quit Hangar Tray App
```

**Sessions** lays the running sessions out the way the web UI's sidebar does with its grouped view and
active-only filter: a submenu per project, with its virtual folders first, then its folder groups (the
folder heading dropped where the project links just that one folder), and forks under the session they
came from. Clicking one opens it in the browser, on this server or on the paired machine it runs on.

**Activity** is the web UI's Sessions-tab fraction: of the sessions doing anything, here and on the
paired machines, how many have finished a turn. It opens onto them grouped as that fraction's list is:
waiting on you (a prompt, the watchdog asking, a turn that failed), working, and finished. "Finished" is
the tray's own: a turn that ended since you last opened that session from the tray. A browser keeps its
own the same way, so the two can differ. Opening a session, or **Mark all seen**, clears it.

- On **Windows** a left click on the icon opens Hangar and a right click opens the menu. On **macOS**
  and **Linux** a click opens the menu.
- The icon is **greyed out** while the server isn't answering, and the menu then says why: not running,
  not responding, or asking for a sign-in. For a stopped server on this machine it offers **Start
  server** — the `hangar.service` user unit or the `com.hangar.server` launch agent that
  `scripts/install-unix.sh` set up, or else the `Hangar` executable beside this one.
- **Stop server…** and **Stop … orphaned session(s)…** are there only for a server on this machine, and
  ask first. Stopping the server doesn't end a session; stopping an orphan does (it is a running
  `claude` no server tracks any more).
- **Quit** closes the app. The server and its sessions keep running.

## Screenshots

| Hotkey (default) | Capture | How |
|---|---|---|
| `Ctrl+Shift+1` | Region | Drag a rectangle. Or click: what is outlined under the pointer (a window, or on Windows a part of one), or the whole screen on the desktop. Shift squares it, Space moves it while dragging. |
| `Ctrl+Shift+2` | Window | Hover to see which window, or which part of it, click to take it. |
| `Ctrl+Shift+3` | Full screen | The screen under the pointer, straight into the editor. |
| `Ctrl+Shift+4` | Freeform | Trace any shape; everything outside it comes out transparent. |

`Esc` cancels; a right-click drops a drag in progress. The screens are frozen the moment the hotkey
fires, so open menus, hover states and tooltips are captured as they were. A loupe shows the exact pixel
under the pointer.

On Windows, hovering outlines the innermost part of the window under the pointer: a button, an image, a
paragraph, a table cell. Scrolling up steps outwards through what holds it (the card, the panel, the
page) out to the whole window, and scrolling down steps back in. Browsers (Chrome, Edge, Brave and the
other Chromium ones) answer for every element of the page; they build that tree in the second after the
hotkey, so a pointer that lands at once may see only the window until then. Electron apps (VS Code,
Slack, Teams) are not asked to build it, since some take that for a screen reader starting (VS Code
switches to screen-reader mode), so they show only what they already expose, often just the window.
Packaged apps that draw their content with WebView2 inside WinUI (the WhatsApp app) only show the whole
window. macOS and Linux snap to whole windows.

The **editor** opens with the message box focused. The quickest path is: capture, type, `Ctrl+Enter`
(`⌘↵` on a Mac).

**Several pictures, one message.** *Add a capture* (the picture-plus button in the toolbar,
`Ctrl+Shift+N`, `⌘⇧N`) steps the editor aside and picks a region as the hotkey does; the cut-out joins
this editor instead of opening one of its own, and `Esc` comes back without one. With more than one, a
strip over the picture shows them in the order they will go: click one to draw on it (each keeps its
own drawing, crop, undo and zoom), drag one to move it, × to drop it; `Ctrl+PageUp`/`Ctrl+PageDown` step
through them. Send, Postpone and New session take them all, with the one message, up to 10 (as many as
a Hangar message takes). Copy and Save act on the one on show.

**Postpone** (`Ctrl+Shift+Enter`, `⌘⇧↵`) puts the picture and the message in the session's postponed
messages instead of its prompt, for when Claude is busy: they wait in the Postponed bar under the
session in Hangar, to be sent from there or by its auto-send. Needs a Hangar that has
`POST /api/sessions/{id}/postponed/items`; an older one says to update it.

**New session** (the `+` over the session list) starts a session for the capture instead of sending
it to a running one. Pick a project (optional), the folder (its project's folders and the recent ones
are one click away; with a local server, Browse opens a folder picker) and a group of that project
(optional); the message becomes the session's first prompt, with the picture. A folder no project has
yet is linked into the chosen project; one that is already another project's is refused. The form
remembers what it was last set to.

- Tools: select `V`, arrow `A`, rectangle `R`, ellipse `E`, line `L`, pen `P`, highlighter `H`,
  text `T`, numbered step `N`, pixelate `B`, crop `C`. These single-letter keys work while focus isn't in
  a text box; `Esc` leaves the message box.
- Crop: drag the area to keep; it can be moved and resized while the crop tool is out. `Enter`, the
  green ✓ or a double-click inside it applies it, and the picture becomes just that area, to draw on and
  send; `Ctrl+Z` brings the rest back. × drops a crop being set, or shows the whole picture again.
- A shape drawn, moved or resized past the picture's edge grows the picture to take it in, on white,
  with a little room to spare. It is part of the same step: `Ctrl+Z` takes the shape and the margin back
  together.
- `Shift` snaps lines to 45° and squares shapes.
- Any shape can be dragged, and clicking it selects it: then `Delete` removes it, and colour and weight
  apply to it. Double-click text to edit it.
- `Ctrl+Z` undoes, `Ctrl+Shift+Z` redoes; `Ctrl+C` copies the image and `Ctrl+S` saves it.
- Zoom: `Ctrl`+wheel (or a touchpad pinch) zooms about the pointer, `Ctrl+=`/`Ctrl+-` step it, `Ctrl+0`
  fits the window and `Ctrl+1` shows the real size; the percentage in the toolbar switches between those
  two. Zoomed in, the wheel scrolls (`Shift`+wheel sideways), and dragging with the middle button or with
  `Space` held moves the picture. Past the real size each pixel shows as a sharp square. Zoom changes only
  the view: what is sent is the capture at its own resolution.
- The tool, colour and weight you used last are kept for the next capture.

The **session picker** lists the server's running sessions, the ones you sent to most recently first.
`Alt+↑/↓` changes the target from the message box. `/` searches by name, project or folder. Double-click
a row to send straight to it.

## Installing

It ships with Hangar: `scripts\build.ps1` builds it into `publish\` as `Hangar.Tray.exe`, beside the
server, and `scripts\deploy.ps1`, the in-app updater and `scripts\register-autostart.ps1` handle it
the way they handled the old tray. On Linux and macOS, `scripts/build.sh` builds it as `Hangar.Tray`
when building for the machine it runs on (a Tauri app can't be cross-built) and `install-unix.sh`
installs it with the rest.

It is a single executable, with the pages compiled in. Settings and recents live in the app's local
data folder (`%LOCALAPPDATA%\io.github.sdm-kz.hangar.tray`, `~/Library/Application Support/…`,
`~/.local/share/…`) and survive a reinstall. Starting at sign-in is a toggle in the tray menu (*Start
when I sign in*) and in Settings: the same `Hangar.Tray` entry `register-autostart.ps1` writes.

An update replaces it with the rest of the install. On Windows a running exe can't be overwritten, so
when the server says an update is being applied the tray exits and a hidden PowerShell starts it again
once the new server answers. On Linux and macOS the update renames the new file into place; the tray
sees the file has changed when it reconnects, and restarts into it.

## Connecting to a server

Settings → *Hangar address*. A first run takes the port from the `appsettings.json` beside it, so an
installed tray follows its own server from the start. On the machine that runs the server
(`http://127.0.0.1:5099`) there is nothing else to do: the app reads the server's instance file and
uses the token in it. Any other address asks for the server's password once; the token is kept in the
app's settings file (readable only by you on macOS/Linux) until it expires, then the menu and the
editor ask you to sign in again. The menu's server controls (start, stop, orphans) are only offered for
a server on this machine.

## Platform notes

- **macOS** asks for *Screen Recording* permission on the first capture (System Settings → Privacy &
  Security). Without it, captures show only the wallpaper. The app runs in the menu bar, with no Dock icon.
- **Linux, X11**: everything works. The tray needs `libayatana-appindicator3`.
- **Linux, Wayland**: apps can't register global hotkeys or list windows, so bind
  `Hangar.Tray --capture region` (or `window`, `fullscreen`, `freeform`) in your desktop's keyboard
  settings. Region and freeform still work on the frozen screen; window mode falls back to the whole
  screen.
- **Windows**: `Ctrl+Shift+digit` overrides apps that use those keys (Excel's number formats, for
  example). Change them in Settings; a combo another app already holds is reported there.

`Hangar.Tray --capture <mode>` works on every platform, and goes to the running instance.

## Developing

```sh
npm install
npm run tauri dev        # the app, with the page hot-reloading
npm test                 # frontend unit tests (vitest)
cd src-tauri && cargo test   # Rust unit tests
npm run tauri build      # installers for this platform
```

Linux needs the [Tauri prerequisites](https://tauri.app/start/prerequisites/) plus `libxcb1-dev
libxrandr-dev libdbus-1-dev libpipewire-0.3-dev libwayland-dev libegl-dev libgbm-dev` for screen capture.

Set `HANGAR_TRAY_CONFIG_DIR` to keep a test run's settings and recents apart from your real ones
(otherwise they live in the app's local data folder, e.g. `%LOCALAPPDATA%\io.github.sdm-kz.hangar.tray`). A
run with one also skips the single-instance check, so it runs beside the installed tray. In a debug
build, `HANGAR_TRAY_TEST_FRAMES=1` makes every capture a generated picture per screen, for
exercising the overlays and editor where there is nothing to capture (a disconnected remote session, CI).
The log (`…\logs`) records how long each overlay and editor took to come up.

### How it fits together

- `src-tauri/src/server.rs` holds the server's `/hub/events` socket open (`?client=tray`, the hub's slow
  tick) for the session list and the paired machines, re-reads `/api/projects` when the snapshot's
  `projectsRev` moves, and the orphaned pty hosts (`/api/pty/orphans`) when the session list changes. It
  publishes a `View`, and the menu is rebuilt only when that changes — never on a keepalive.
  `session_tree.rs` arranges the running sessions as the sidebar does; `menu.rs` turns that into the
  menu. Which project a session is in is the server's answer (`projectId`), not a second copy of the rule.
  `progress.rs` reads what each session is doing for **Activity**, and keeps the tray's "finished" ticks.
- `host.rs` is this machine's side: whether the server's process is alive, starting it, and stepping
  aside for an update.
- `src-tauri/src/capture.rs` freezes every monitor and lists the windows (via `xcap`).
  `geometry.rs` maps a window onto its monitor's frame. The OS reports both in the same units: points
  on macOS, pixels elsewhere.
- `elements.rs` finds the parts of a window under a point (Windows): MSAA's `accHitTest`, which tests
  inside a given window. UI Automation can only test a point on screen, and while picking, that point
  is our own overlay. Chromium builds a page's tree only once a UI Automation client has looked into
  the page, so the capture asks each browser window for its document (`elements::wake`) while the
  overlays come up. A hung app is never asked: it would never answer. To try it against an app without the overlay: `cargo run --example element_at --
  X Y` (screen pixels), or the ignored `probe_screen` test.
- `windows.rs` puts an overlay over each monitor and opens the editor on the monitor the capture came
  from. The overlays and one spare editor stay loaded and hidden between captures: building a webview
  is the slow part (and with none alive WebView2 shuts its browser process down too), so a warm overlay
  is up in about 60 ms against about 650 ms cold. The price is roughly 300 MB of WebView2 memory
  while idle.
- The session picker shows each session's project as the server files it (`projectId` on
  `/api/sessions`) and its colours from the web UI's own table (`@web/lib/sessionColors`), so neither
  rule has a second copy here.
- The editor (`src/editor`) draws with Konva in the capture's own pixels. It exports the full-resolution
  PNGs and hands them back over IPC in one body, each after its length. `api.rs` uploads them one by one
  (`POST /api/sessions/{id}/fs/upload-image`) and sends the message with the uploaded paths
  (`POST /api/sessions/{id}/message`, `images`), which types them into the session the way the web
  composer does.
- An editor holds several captures as pages (`src/editor/pages.ts`). Only the one on show has a Konva
  stage; the others keep their drawing and the PNG they were flattened to when left, so sending doesn't
  have to draw them again. *Add a capture* (`add_capture`) hides the editor, waits for it to be off the
  screen, and runs a capture whose result goes to that editor (`capture-added`) instead of a new one. Postpone sends the same body to
  `POST /api/sessions/{id}/postponed/items`, which the server adds to the pool itself, under the lock
  its other writers take, rather than this app rewriting the whole pool and racing a browser's save.
- A new session can't be handed a picture through `upload-image`, which needs a session, so the PNGs
  go into `<folder>/.hangar/uploads` through the plain file API (`/api/fs/mkdir`,
  `/api/fs/upload`) and their paths into the first prompt (`POST /api/sessions`, `initialPrompt`), which
  Claude reads as the images they name. `projectId` and `groupId` on that request are the server's to
  settle: it links the folder and files the session, or refuses before launching anything.
