# Hangar Snap

A tray app for Windows, macOS and Linux: press a hotkey, pick part of the screen, mark it up, type a
message, and send both to one of the Claude sessions a Hangar server is running. The picture lands in
the session's prompt exactly as an image pasted in the web UI does.

Built with [Tauri 2](https://tauri.app): a small Rust shell (tray, hotkeys, screen capture, talking to
the server) and a React page for the overlay, the editor and the settings.

## Using it

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

## Installing (Windows)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\deploy-snap.ps1            # build, install to C:\apps\hangar-snap, start
powershell -ExecutionPolicy Bypass -File scripts\deploy-snap.ps1 -Autostart # …and start it at sign-in
```

It builds the release exe (`-SkipBuild` reuses the last one), stops any running copy, installs, and
starts it. Settings and recents live in `%LOCALAPPDATA%\io.github.sdm-kz.homeport.snap` and survive a reinstall.
Starting at sign-in is a toggle in the tray menu (*Start when I sign in*) and in Settings; a reinstall
points an existing registration at the installed exe.

## Connecting to a server

Settings → *Hangar address*. On the machine that runs Hangar (`http://127.0.0.1:5099`) there is
nothing else to do: Snap reads the server's instance file, the same way the tray does. Any other address
asks for the server's password once; the token is kept in the app's settings file (readable only by you
on macOS/Linux) until it expires, then the editor asks you to sign in again.

## Platform notes

- **macOS** asks for *Screen Recording* permission on the first capture (System Settings → Privacy &
  Security). Without it, captures show only the wallpaper. Snap runs as a menu-bar app with no Dock icon.
- **Linux, X11**: everything works. The tray needs `libayatana-appindicator3`.
- **Linux, Wayland**: apps can't register global hotkeys or list windows, so bind
  `hangar-snap --capture region` (or `window`, `fullscreen`, `freeform`) in your desktop's keyboard
  settings. Region and freeform still work on the frozen screen; window mode falls back to the whole
  screen.
- **Windows**: `Ctrl+Shift+digit` overrides apps that use those keys (Excel's number formats, for
  example). Change them in Settings; a combo another app already holds is reported there.

`hangar-snap --capture <mode>` works on every platform, and goes to the running instance.

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

Set `HANGAR_SNAP_CONFIG_DIR` to keep a test run's settings and recents apart from your real ones
(otherwise they live in the app's local data folder, e.g. `%LOCALAPPDATA%\io.github.sdm-kz.homeport.snap`). In
a debug build, `HANGAR_SNAP_TEST_FRAMES=1` makes every capture a generated picture per screen, for
exercising the overlays and editor where there is nothing to capture (a disconnected remote session, CI).
The log (`…\logs`) records how long each overlay and editor took to come up.

### How it fits together

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
  PNG and hands it back over IPC. `api.rs` uploads it (`POST /api/sessions/{id}/fs/upload-image`) and
  sends the message with the uploaded path (`POST /api/sessions/{id}/message`, `images`), which types
  both into the session the way the web composer does. Postpone sends the same body to
  `POST /api/sessions/{id}/postponed/items`, which the server adds to the pool itself, under the lock
  its other writers take, rather than this app rewriting the whole pool and racing a browser's save.
- A new session can't be handed a picture through `upload-image`, which needs a session, so the PNG
  goes into `<folder>/.hangar/uploads` through the plain file API (`/api/fs/mkdir`,
  `/api/fs/upload`) and its path into the first prompt (`POST /api/sessions`, `initialPrompt`), which
  Claude reads as the image it names. `projectId` and `groupId` on that request are the server's to
  settle: it links the folder and files the session, or refuses before launching anything.
