//! Hangar Snap: a tray app that takes a screenshot on a hotkey, lets you mark it up, and sends it —
//! with a message — to one of the Claude sessions a Hangar server is running.
//!
//! The flow, end to end:
//! 1. A hotkey (or the tray menu, or `hangar-snap --capture <mode>`) freezes every monitor
//!    ([`capture::take`]).
//! 2. Full screen goes straight to the editor; the other modes put an overlay over each monitor showing
//!    its frozen frame, where the person drags a region, clicks a window or traces a shape.
//! 3. The cut-out opens in an editor window: draw on it, type a message, pick a session, send. The
//!    editor flattens the drawing into a PNG and hands it back here, and [`api::Client`] uploads it and
//!    types the message into the session.

mod api;
mod capture;
mod config;
#[doc(hidden)] // public for examples/element_at.rs
pub mod elements;
mod geometry;
mod imageops;
mod tray_icon;
mod windows;

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::http::{header, Response, StatusCode};
use tauri::ipc::{InvokeBody, Request};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;

use api::{ApiError, Client};
use capture::{Mode, Selection, Snapshot};
use config::{Hotkeys, Settings, Store};

const TRAY_ID: &str = "main";

/// A finished capture, waiting in its editor.
struct Capture {
    png: Vec<u8>,
    width: u32,
    height: u32,
    scale: f32,
}

struct AppState {
    store: Store,
    settings: Mutex<Settings>,
    /// The frozen screens while overlays are up.
    snapshot: Mutex<Option<Arc<Snapshot>>>,
    /// Set from the hotkey until the overlays close: a second hotkey meanwhile is ignored rather than
    /// freezing the screen with our own overlays on it.
    capturing: AtomicBool,
    /// Bumped per capture, so a stale watchdog can tell its capture has already finished.
    generation: AtomicU64,
    overlays_ready: AtomicU64,
    captures: Mutex<HashMap<String, Arc<Capture>>>,
    next_capture: AtomicU64,
    /// The id of the hidden editor kept loaded for the next capture: the window exists (labelled with
    /// it) and its page waits for a capture under that id to arrive.
    spare_editor: Mutex<Option<String>>,
    /// When the hotkey of the capture in progress fired, and when its selection was made: for logging
    /// how long the overlay and the editor took to come up.
    started: Mutex<Option<Instant>>,
    committed: Mutex<Option<Instant>>,
    /// Registered hotkeys, by the shortcut's id.
    hotkeys: Mutex<HashMap<u32, Mode>>,
    hotkey_errors: Mutex<Vec<String>>,
}

fn state(app: &AppHandle) -> tauri::State<'_, AppState> {
    app.state::<AppState>()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn notify_error(app: &AppHandle, message: impl Into<String>) {
    let message = message.into();
    log::error!("{message}");
    app.dialog().message(message).title("Hangar Snap").kind(tauri_plugin_dialog::MessageDialogKind::Error).show(|_| {});
}

// ---- Capturing ------------------------------------------------------------------------------------

/// Freeze the screens and start picking. Runs off the main thread: capturing several monitors takes
/// a moment, and the windows it opens are created by dispatching to the event loop anyway.
///
/// While the overlays are up, `AppState::snapshot` holds the frozen screens, and whoever `take`s it out
/// ends the capture: a commit on one overlay, Esc on another, an overlay closed by the OS. Taking it is
/// atomic, so only the first of those acts — a second monitor's click a moment later finds it gone.
pub fn start_capture(app: &AppHandle, mode: Mode) {
    let st = state(app);
    if st.capturing.swap(true, Ordering::SeqCst) {
        log::info!("Ignoring {mode:?}: a capture is already in progress");
        return;
    }
    let generation = st.generation.fetch_add(1, Ordering::SeqCst) + 1;
    st.overlays_ready.store(0, Ordering::SeqCst);
    *st.started.lock().unwrap() = Some(Instant::now());
    let app = app.clone();
    std::thread::spawn(move || {
        let snapshot = match capture::take(mode) {
            Ok(s) => Arc::new(s),
            Err(e) => {
                state(&app).capturing.store(false, Ordering::SeqCst);
                notify_error(&app, e);
                return;
            }
        };
        if mode == Mode::Fullscreen {
            let index = frame_under_cursor(&app, &snapshot);
            *state(&app).committed.lock().unwrap() = Some(Instant::now());
            finish(&app, &snapshot, index, &Selection::Full);
            return;
        }
        // Encode every frame now, in parallel, so each overlay's request finds its picture ready.
        for i in 0..snapshot.frames.len() {
            let s = snapshot.clone();
            std::thread::spawn(move || {
                s.frames[i].png();
            });
        }
        *state(&app).snapshot.lock().unwrap() = Some(snapshot.clone());
        for (i, frame) in snapshot.frames.iter().enumerate() {
            if let Err(e) = windows::present_overlay(&app, i, frame.monitor, generation) {
                log::error!("Could not open the overlay for screen {i}: {e}");
            }
        }
        // Not held across the wait below: the frames are hundreds of megabytes on big screens.
        drop(snapshot);
        // An overlay that never reports ready (its page failed) would leave the hotkey dead; give up on
        // the capture instead.
        std::thread::sleep(Duration::from_secs(10));
        let st = state(&app);
        if st.generation.load(Ordering::SeqCst) == generation && st.overlays_ready.load(Ordering::SeqCst) == 0 {
            log::error!("No overlay came up; abandoning the capture");
            cancel_capture(&app);
        }
    });
}

/// The frame of the monitor the pointer is on — the primary one when that can't be told.
fn frame_under_cursor(app: &AppHandle, snapshot: &Snapshot) -> usize {
    let primary = snapshot.frames.iter().position(|f| f.primary).unwrap_or(0);
    let Ok(cursor) = app.cursor_position() else { return primary };
    // The frames' monitors are in xcap's units: physical pixels, except on macOS, where they are points
    // — and where tao reports the cursor as points times the *primary* display's scale.
    #[cfg(target_os = "macos")]
    let (x, y) = {
        let scale = app.primary_monitor().ok().flatten().map(|m| m.scale_factor()).unwrap_or(1.0);
        (cursor.x / scale, cursor.y / scale)
    };
    #[cfg(not(target_os = "macos"))]
    let (x, y) = (cursor.x, cursor.y);
    snapshot
        .frames
        .iter()
        .position(|f| geometry::contains(&f.monitor, x, y))
        .unwrap_or(primary)
}

/// Cut the selection out of frame `index` and open it in an editor, then end the capture. The caller
/// has already taken the snapshot out of the state (or never put it there, for full screen).
///
/// The editor is created (hidden) before the overlays close: with no webview left in between, WebView2
/// shuts its browser process down and the editor waits on a cold start of a new one.
fn finish(app: &AppHandle, snapshot: &Snapshot, index: usize, selection: &Selection) {
    if let Some(frame) = snapshot.frames.get(index) {
        match capture::cut(frame, selection) {
            Some(image) => open_editor(app, image, frame),
            None => log::info!("Nothing selected"),
        }
    }
    windows::hide_overlays(app);
    state(app).capturing.store(false, Ordering::SeqCst);
}

/// Hand the capture to the spare editor — already loaded, so it only has to draw the picture — or
/// build an editor for it when there is no spare. Then get the next spare ready.
fn open_editor(app: &AppHandle, image: image::RgbaImage, frame: &capture::Frame) {
    let st = state(app);
    let (width, height) = image.dimensions();
    let capture = Arc::new(Capture { png: imageops::encode_png_fast(&image), width, height, scale: frame.scale });
    // Only a spare whose window is already built: one still being built stays the spare, for the
    // capture after this, rather than ending up a hidden editor nothing will ever use.
    let spare = {
        let mut spare = st.spare_editor.lock().unwrap();
        let found = spare
            .clone()
            .and_then(|id| app.get_webview_window(&format!("{}{id}", windows::EDITOR_PREFIX)).map(|w| (id, w)));
        if found.is_some() {
            *spare = None;
        }
        found
    };
    let (id, window) = match spare {
        Some(spare) => spare,
        None => {
            let id = st.next_capture.fetch_add(1, Ordering::SeqCst).to_string();
            match windows::create_editor(app, &id) {
                Ok(w) => (id, w),
                Err(e) => return notify_error(app, format!("Could not open the editor: {e}")),
            }
        }
    };
    st.captures.lock().unwrap().insert(id.clone(), capture);
    if let Err(e) = windows::place_editor(&window, (width, height), frame.monitor, frame.scale) {
        log::warn!("Could not place the editor: {e}");
    }
    let _ = app.emit("capture-ready", &id);
    // Not straight away: the editor that just got the capture is drawing it, and a page loading
    // beside it would only slow that down.
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        prepare_spare_editor(&app);
    });
}

/// Load a hidden editor for the next capture, unless one is ready already. Called only from the
/// background threads that make spares, one at a time in practice (startup, then after each capture).
///
/// No lock is held while the window is built: building waits on the main thread, which may itself be
/// waiting for `spare_editor` (in `editor_init`, or the window-destroyed handler).
fn prepare_spare_editor(app: &AppHandle) {
    let st = state(app);
    let ready = st.spare_editor.lock().unwrap().clone();
    if ready.is_some_and(|id| app.get_webview_window(&format!("{}{id}", windows::EDITOR_PREFIX)).is_some()) {
        return;
    }
    let id = st.next_capture.fetch_add(1, Ordering::SeqCst).to_string();
    // Claimed before the page loads, so its first `editor_init` reads as "pending", not "gone".
    *st.spare_editor.lock().unwrap() = Some(id.clone());
    if let Err(e) = windows::create_editor(app, &id) {
        log::warn!("Could not prepare an editor: {e}");
        let mut spare = st.spare_editor.lock().unwrap();
        if spare.as_deref() == Some(id.as_str()) {
            *spare = None;
        }
    }
}

/// Load what the next capture needs, hidden: an overlay per monitor and an editor. Off the main
/// thread, like every window build (see `windows::show_settings`).
fn prewarm(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let monitors = xcap::Monitor::all().map(|m| m.len()).unwrap_or(1).max(1);
        for i in 0..monitors {
            if let Err(e) = windows::ensure_overlay(&app, i) {
                log::warn!("Could not prepare the overlay for screen {i}: {e}");
            }
        }
        prepare_spare_editor(&app);
    });
}

/// End the capture in progress without a picture — unless someone else already ended it.
fn cancel_capture(app: &AppHandle) {
    let st = state(app);
    if st.snapshot.lock().unwrap().take().is_none() {
        return;
    }
    windows::hide_overlays(app);
    st.capturing.store(false, Ordering::SeqCst);
}

// ---- Overlay commands -----------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayInit {
    generation: u64,
    mode: Mode,
    width: u32,
    height: u32,
    windows: Vec<capture::WindowBox>,
}

#[tauri::command]
fn overlay_init(app: AppHandle, frame: usize) -> Result<OverlayInit, String> {
    let snapshot = state(&app).snapshot.lock().unwrap().clone().ok_or("No capture in progress")?;
    let f = snapshot.frames.get(frame).ok_or("No such screen")?;
    Ok(OverlayInit {
        generation: state(&app).generation.load(Ordering::SeqCst),
        mode: snapshot.mode,
        width: f.image.width(),
        height: f.image.height(),
        windows: snapshot.windows.get(frame).cloned().unwrap_or_default(),
    })
}

/// What is under a point of an overlay's frame, innermost first, ending with the window. Off the main
/// thread: it asks the window's app, which may take a moment.
#[tauri::command]
async fn overlay_elements(app: AppHandle, frame: usize, x: f64, y: f64) -> Vec<capture::ElementBox> {
    let Some(snapshot) = state(&app).snapshot.lock().unwrap().clone() else { return Vec::new() };
    tauri::async_runtime::spawn_blocking(move || capture::elements_at(&snapshot, frame, x, y))
        .await
        .unwrap_or_default()
}

#[tauri::command]
fn overlay_ready(app: AppHandle, window: WebviewWindow) {
    let st = state(&app);
    if st.snapshot.lock().unwrap().is_none() {
        return; // the capture ended while this overlay was still painting
    }
    if st.overlays_ready.fetch_add(1, Ordering::SeqCst) == 0 {
        if let Some(t) = *st.started.lock().unwrap() {
            log::info!("Overlay up {} ms after the hotkey", t.elapsed().as_millis());
        }
    }
    let _ = window.show();
    let _ = window.set_focus();
}

#[tauri::command]
fn overlay_commit(app: AppHandle, frame: usize, selection: Selection) {
    // Taking it is what makes this overlay's commit the one that counts.
    let Some(snapshot) = state(&app).snapshot.lock().unwrap().take() else { return };
    *state(&app).committed.lock().unwrap() = Some(Instant::now());
    // Off the main thread: cropping and encoding a big selection takes a moment.
    std::thread::spawn(move || finish(&app, &snapshot, frame, &selection));
}

#[tauri::command]
fn overlay_cancel(app: AppHandle) {
    cancel_capture(&app);
}

// ---- Editor commands ------------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EditorInit {
    width: u32,
    height: u32,
    /// Physical pixels per logical pixel on the monitor it came from, to show it at real size.
    scale: f32,
}

#[tauri::command]
fn editor_init(app: AppHandle, id: String) -> Result<EditorInit, String> {
    let st = state(&app);
    let captures = st.captures.lock().unwrap();
    let Some(c) = captures.get(&id) else {
        // The spare editor asks before its capture exists; it waits for `capture-ready`.
        let pending = st.spare_editor.lock().unwrap().as_deref() == Some(id.as_str());
        return Err(if pending { "pending" } else { "This capture is gone" }.into());
    };
    Ok(EditorInit { width: c.width, height: c.height, scale: c.scale })
}

/// The capture's PNG, as raw bytes. Over IPC rather than the `snap:` scheme: the editor exports what it
/// draws, and a picture from another origin would taint its canvas — a page may show such a picture
/// but never read it back.
#[tauri::command]
fn capture_png(app: AppHandle, id: String) -> Result<tauri::ipc::Response, String> {
    let st = state(&app);
    let captures = st.captures.lock().unwrap();
    let c = captures.get(&id).ok_or("This capture is gone")?;
    Ok(tauri::ipc::Response::new(c.png.clone()))
}

#[tauri::command]
fn editor_ready(app: AppHandle, window: WebviewWindow) {
    if let Some(t) = state(&app).committed.lock().unwrap().take() {
        log::info!("Editor up {} ms after the selection", t.elapsed().as_millis());
    }
    let _ = window.show();
    let _ = window.set_focus();
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionsView {
    items: Vec<api::SessionItem>,
    server: String,
}

fn client(app: &AppHandle) -> Result<(Client, String), ApiError> {
    let settings = state(app).settings.lock().unwrap().clone();
    let creds = api::resolve_credentials(
        &settings.server_url,
        settings.token.as_deref(),
        &api::default_instances_dirs(),
    )
    .map_err(ApiError::Failed)?;
    Ok((Client::new(creds), settings.server_url))
}

#[tauri::command]
async fn list_sessions(app: AppHandle) -> Result<SessionsView, ApiError> {
    let (client, server) = client(&app)?;
    let sessions = client.sessions().await?;
    // Busy dots and project names are garnish: the list is still worth showing without them.
    let busy = client.busy().await.unwrap_or_default();
    let projects = client.projects().await.unwrap_or_default();
    let recents = state(&app).store.load_recents();
    Ok(SessionsView { items: api::picker_items(sessions, &busy, &projects, &recents, &server), server })
}

fn raw_body(request: &Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        _ => Err("Expected the image as the request body".into()),
    }
}

fn header_text(request: &Request<'_>, name: &str) -> Option<String> {
    let value = request.headers().get(name)?.to_str().ok()?;
    Some(percent_encoding::percent_decode_str(value).decode_utf8_lossy().into_owned())
}

/// Send the flattened PNG (the request body) and the message (`x-text`, percent-encoded) to the session
/// `x-session-id`.
#[tauri::command]
async fn send_capture(app: AppHandle, request: Request<'_>) -> Result<(), ApiError> {
    let png = raw_body(&request).map_err(ApiError::Failed)?;
    let session_id = header_text(&request, "x-session-id").ok_or(ApiError::Failed("No session chosen".into()))?;
    let claude_session_id = header_text(&request, "x-claude-session-id").filter(|s| !s.is_empty());
    let text = header_text(&request, "x-text").unwrap_or_default();
    // Into the session's postponed messages rather than its prompt.
    let postpone = header_text(&request, "x-postpone").is_some_and(|v| v == "1");

    let (client, server) = client(&app)?;
    let path = client.upload_image(&session_id, &png).await?;
    if postpone {
        client.postpone(&session_id, text.trim(), &[path]).await?;
    } else {
        client.message(&session_id, text.trim(), &[path]).await?;
    }
    if let Err(e) = state(&app).store.touch_recent(&server, &session_id, claude_session_id.as_deref(), now_ms()) {
        log::warn!("Could not remember the session: {e}");
    }
    Ok(())
}

/// What the new-session form offers: the projects with their folders and groups, the folders used
/// lately, and whether the server is on this machine (so a folder can be browsed for here).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NewSessionOptions {
    projects: Vec<api::ServerProject>,
    recent_folders: Vec<String>,
    local: bool,
}

#[tauri::command]
async fn new_session_options(app: AppHandle) -> Result<NewSessionOptions, ApiError> {
    let (client, _) = client(&app)?;
    let projects = client.projects().await?;
    // Recents are a convenience: the form works without them.
    let recent_folders = client.recent_folders().await.unwrap_or_default();
    Ok(NewSessionOptions { projects, recent_folders, local: client.credentials().local })
}

/// A folder from this machine's own picker — meaningful only when the server is on this machine.
#[tauri::command]
async fn pick_folder(app: AppHandle, start: Option<String>) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_title("Folder for the new session");
    if let Some(dir) = start.filter(|d| std::path::Path::new(d).is_dir()) {
        dialog = dialog.set_directory(dir);
    }
    dialog.pick_folder(move |path| {
        let _ = tx.send(path);
    });
    let Some(path) = rx.await.map_err(|e| e.to_string())? else { return Ok(None) };
    Ok(Some(path.into_path().map_err(|e| e.to_string())?.display().to_string()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartedSession {
    id: String,
    name: String,
    /// Something the person should know although it started: a Hangar too old to file it.
    note: Option<String>,
}

/// Start a new session in `x-folder` (optionally `x-project-id`, `x-group-id`), told the message
/// (`x-text`) and shown the PNG in the request body. The picture goes into the folder's uploads
/// first and its path into the first prompt, which is how a session that isn't running yet can be
/// handed one: Claude reads an image it is given the path of.
#[tauri::command]
async fn start_session(app: AppHandle, request: Request<'_>) -> Result<StartedSession, ApiError> {
    let png = raw_body(&request).map_err(ApiError::Failed)?;
    let folder = header_text(&request, "x-folder").map(|f| f.trim().to_string()).filter(|f| !f.is_empty());
    let folder = folder.ok_or(ApiError::Failed("Choose a folder for the session".into()))?;
    let project = header_text(&request, "x-project-id").filter(|s| !s.is_empty());
    let group = header_text(&request, "x-group-id").filter(|s| !s.is_empty());
    let text = header_text(&request, "x-text").unwrap_or_default();

    let (client, server) = client(&app)?;
    // Before anything is written there: the upload creates the folders it needs, and a mistyped path
    // would otherwise come into being and have the session start in it.
    let folder = client.resolve_folder(&folder).await?;
    let uploads = format!("{}/.claudeweb/uploads", folder.trim_end_matches(['/', '\\']));
    let name = format!("pasted-{}.png", chrono::Local::now().format("%Y%m%d-%H%M%S-%3f"));
    let image = client.upload_to_folder(&uploads, &name, &png).await?;
    let created = client
        .create_session(&api::NewSession {
            folder: &folder,
            project_id: project.as_deref(),
            group_id: group.as_deref(),
            prompt: &initial_prompt(&text, &image),
        })
        .await?;
    if let Err(e) = client.add_recent_folder(&folder).await {
        log::warn!("Could not remember the folder: {e}");
    }
    if let Err(e) = state(&app).store.touch_recent(&server, &created.id, created.claude_session_id.as_deref(), now_ms()) {
        log::warn!("Could not remember the session: {e}");
    }
    let note = (group.is_some() && created.group_id != group)
        .then(|| "Started, but this Hangar can't file it in a group yet. Update it.".to_string());
    Ok(StartedSession { id: created.id, name: created.name, note })
}

/// The first prompt of a session started from a capture: the message, then the picture's path on a
/// line of its own, which Claude reads as the image it names.
fn initial_prompt(text: &str, image_path: &str) -> String {
    let text = text.trim();
    if text.is_empty() {
        image_path.to_string()
    } else {
        format!("{text}\n\n{image_path}")
    }
}

// Async, so its decoding and retries run off the main thread instead of freezing every window.
#[tauri::command]
async fn copy_image(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let png = raw_body(&request)?;
    let rgba = image::load_from_memory(&png).map_err(|e| e.to_string())?.to_rgba8();
    let (w, h) = rgba.dimensions();
    let image = tauri::image::Image::new_owned(rgba.into_raw(), w, h);
    // Windows lets one process hold the clipboard open at a time, and clipboard managers open it on
    // every change; a write that lands in that moment fails, and the next one a few ms later doesn't.
    let mut attempt = 0;
    loop {
        match app.clipboard().write_image(&image) {
            Ok(()) => return Ok(()),
            Err(e) if attempt >= 8 => return Err(format!("Could not copy: {e}")),
            Err(_) => {
                attempt += 1;
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
        }
    }
}

#[tauri::command]
async fn save_image(app: AppHandle, request: Request<'_>) -> Result<Option<String>, String> {
    let png = raw_body(&request)?;
    let name = format!("Screenshot {}.png", screenshot_stamp());
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().add_filter("PNG image", &["png"]).set_file_name(&name);
    if let Some(dir) = dirs::picture_dir().or_else(dirs::desktop_dir) {
        dialog = dialog.set_directory(dir);
    }
    dialog.save_file(move |path| {
        let _ = tx.send(path);
    });
    let Some(path) = rx.await.map_err(|e| e.to_string())? else { return Ok(None) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, png).map_err(|e| format!("Could not save {}: {e}", path.display()))?;
    Ok(Some(path.display().to_string()))
}

/// Local time the way the OS names its own screenshots: `2026-10-07 at 14.03.22`.
fn screenshot_stamp() -> String {
    chrono::Local::now().format("%Y-%m-%d at %H.%M.%S").to_string()
}

#[tauri::command]
fn open_hangar(app: AppHandle, session_id: Option<String>) -> Result<(), String> {
    let base = state(&app).settings.lock().unwrap().server_url.clone();
    let mut url = url::Url::parse(&base).map_err(|e| e.to_string())?;
    if let Some(id) = session_id {
        url.query_pairs_mut().append_pair("session", &id);
    }
    app.opener().open_url(url.as_str(), None::<&str>).map_err(|e| e.to_string())
}

// ---- Settings commands ----------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsView {
    server_url: String,
    signed_in: bool,
    hotkeys: Hotkeys,
    hotkey_errors: Vec<String>,
    autostart: bool,
    platform: &'static str,
}

fn settings_view(app: &AppHandle) -> SettingsView {
    let st = state(app);
    let settings = st.settings.lock().unwrap().clone();
    let hotkey_errors = st.hotkey_errors.lock().unwrap().clone();
    SettingsView {
        server_url: settings.server_url,
        signed_in: settings.token.is_some(),
        hotkeys: settings.hotkeys,
        hotkey_errors,
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
        platform: std::env::consts::OS,
    }
}

#[tauri::command]
fn get_settings(app: AppHandle) -> SettingsView {
    settings_view(&app)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsInput {
    server_url: String,
    hotkeys: Hotkeys,
    autostart: bool,
}

#[tauri::command]
fn save_settings(app: AppHandle, input: SettingsInput) -> Result<SettingsView, String> {
    let server_url = input.server_url.trim().trim_end_matches('/').to_string();
    api::resolve_credentials(&server_url, None, &[])?;
    let st = state(&app);
    {
        let mut settings = st.settings.lock().unwrap();
        if settings.server_url != server_url {
            // A token is the old server's; it means nothing to the new one.
            settings.token = None;
        }
        settings.server_url = server_url;
        settings.hotkeys = input.hotkeys;
        st.store.save_settings(&settings)?;
    }
    set_autostart(&app, input.autostart);
    // After the autostart change: this also rebuilds the tray menu, whose tick shows it.
    apply_hotkeys(&app);
    Ok(settings_view(&app))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionStatus {
    ok: bool,
    /// Connected through the server's instance file: it runs on this machine, no sign-in needed.
    local: bool,
    auth_required: bool,
    error: Option<ApiError>,
}

#[tauri::command]
async fn connection_status(app: AppHandle) -> ConnectionStatus {
    let (client, _) = match client(&app) {
        Ok(c) => c,
        Err(e) => return ConnectionStatus { ok: false, local: false, auth_required: false, error: Some(e) },
    };
    let local = client.credentials().local;
    let auth_required = client.auth_required().await;
    match client.sessions().await {
        Ok(_) => ConnectionStatus { ok: true, local, auth_required: auth_required.unwrap_or(false), error: None },
        Err(e) => ConnectionStatus { ok: false, local, auth_required: auth_required.unwrap_or(true), error: Some(e) },
    }
}

#[tauri::command]
async fn sign_in(app: AppHandle, password: String) -> Result<(), ApiError> {
    let (client, _) = client(&app)?;
    let token = client.login(&password).await?;
    let st = state(&app);
    let mut settings = st.settings.lock().unwrap();
    settings.token = Some(token);
    st.store.save_settings(&settings).map_err(ApiError::Failed)
}

#[tauri::command]
fn sign_out(app: AppHandle) -> Result<(), String> {
    let st = state(&app);
    let mut settings = st.settings.lock().unwrap();
    settings.token = None;
    st.store.save_settings(&settings)
}

#[tauri::command]
fn start_capture_cmd(app: AppHandle, mode: Mode) {
    start_capture(&app, mode);
}

/// Let go of the hotkeys while the settings page records a new one — else pressing the current combo
/// would take a screenshot instead of reaching the page.
#[tauri::command]
fn suspend_hotkeys(app: AppHandle, suspended: bool) {
    if suspended {
        let _ = app.global_shortcut().unregister_all();
    } else {
        apply_hotkeys(&app);
    }
}

#[tauri::command]
fn open_settings(app: AppHandle) {
    windows::show_settings(&app);
}

// ---- Hotkeys and tray -----------------------------------------------------------------------------

fn hotkey_for(hotkeys: &Hotkeys, mode: Mode) -> &str {
    match mode {
        Mode::Region => &hotkeys.region,
        Mode::Window => &hotkeys.window,
        Mode::Fullscreen => &hotkeys.fullscreen,
        Mode::Freeform => &hotkeys.freeform,
    }
}

/// (Re-)register the hotkeys from the settings, and rebuild the tray menu that lists them. A hotkey
/// that can't be had — malformed, or taken by another app — is reported, not fatal.
fn apply_hotkeys(app: &AppHandle) {
    let st = state(app);
    let hotkeys = st.settings.lock().unwrap().hotkeys.clone();
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let mut map = HashMap::new();
    let mut errors = Vec::new();
    for mode in Mode::ALL {
        let text = hotkey_for(&hotkeys, mode).trim();
        if text.is_empty() {
            continue;
        }
        match Shortcut::from_str(text) {
            Ok(shortcut) => match gs.register(shortcut) {
                Ok(()) => {
                    map.insert(shortcut.id(), mode);
                }
                Err(e) => errors.push(format!("{}: {text} is not available ({e})", mode.label())),
            },
            Err(e) => errors.push(format!("{}: {text} is not a valid shortcut ({e})", mode.label())),
        }
    }
    for e in &errors {
        log::warn!("{e}");
    }
    *st.hotkeys.lock().unwrap() = map;
    *st.hotkey_errors.lock().unwrap() = errors;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        match build_menu(app, &hotkeys) {
            Ok(menu) => {
                let _ = tray.set_menu(Some(menu));
            }
            Err(e) => log::error!("Could not rebuild the tray menu: {e}"),
        }
    }
    let _ = app.emit("settings-changed", ());
}

fn build_menu(app: &AppHandle, hotkeys: &Hotkeys) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    for mode in Mode::ALL {
        let accel = hotkey_for(hotkeys, mode).trim();
        let id = format!("capture:{}", serde_json::to_value(mode).unwrap().as_str().unwrap());
        let label = format!("Capture {}", mode.label().to_lowercase());
        // The accelerator is only shown, not bound, in a tray menu; one the menu can't parse is left off.
        let item = MenuItem::with_id(app, &id, &label, true, (!accel.is_empty()).then_some(accel))
            .or_else(|_| MenuItem::with_id(app, &id, &label, true, None::<&str>))?;
        menu.append(&item)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "open", "Open Hangar", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?)?;
    let autostart = app.autolaunch().is_enabled().unwrap_or(false);
    menu.append(&CheckMenuItem::with_id(app, "autostart", "Start when I sign in", true, autostart, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quit Hangar Snap", true, None::<&str>)?)?;
    Ok(menu)
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "open" => {
            if let Err(e) = open_hangar(app.clone(), None) {
                notify_error(app, e);
            }
        }
        "settings" => windows::show_settings(app),
        "autostart" => {
            let on = app.autolaunch().is_enabled().unwrap_or(false);
            set_autostart(app, !on);
            // Rebuilt rather than trusting the item's own toggle: if the change failed, the tick
            // must say so. Also tells an open Settings window.
            apply_hotkeys(app);
        }
        "quit" => app.exit(0),
        other => {
            if let Some(mode) = other.strip_prefix("capture:").and_then(Mode::parse) {
                start_capture(app, mode);
            }
        }
    }
}

/// Start (or stop starting) at sign-in, as this executable: the entry names the path the app runs
/// from now, so after a move it is re-pointed by switching it off and on (or by `deploy-snap.ps1`).
fn set_autostart(app: &AppHandle, on: bool) {
    let autolaunch = app.autolaunch();
    let result = if on { autolaunch.enable() } else { autolaunch.disable() };
    if let Err(e) = result {
        notify_error(app, format!("Could not change starting at sign-in: {e}"));
    }
}

fn build_tray(app: &AppHandle, hotkeys: &Hotkeys) -> tauri::Result<()> {
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(tray_icon::image_for(tray_icon::current_look(app))?)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("Hangar Snap")
        .menu(&build_menu(app, hotkeys)?)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .build(app)?;
    tray_icon::watch(app, TRAY_ID);
    Ok(())
}

/// `--capture <mode>`: what a desktop's own shortcut settings can bind where global hotkeys aren't
/// available to apps (GNOME on Wayland), and what the tray uses when it is already running.
fn capture_arg(args: &[String]) -> Option<Mode> {
    let i = args.iter().position(|a| a == "--capture")?;
    Mode::parse(args.get(i + 1).map(String::as_str).unwrap_or("region"))
}

/// The `snap://` scheme the overlays load their pictures from: `frame/<n>` is the frozen screen under
/// overlay n. (Only shown, never read back — the editor gets its picture over IPC; see `capture_png`.)
fn serve_picture(app: &AppHandle, path: &str) -> Response<Vec<u8>> {
    let st = state(app);
    let mut parts = path.trim_start_matches('/').splitn(2, '/');
    let body = match (parts.next(), parts.next()) {
        (Some("frame"), Some(n)) => {
            let snapshot = st.snapshot.lock().unwrap().clone();
            n.parse::<usize>()
                .ok()
                .and_then(|n| snapshot.as_ref().and_then(|s| s.frames.get(n).map(|f| f.png().to_vec())))
        }
        _ => None,
    };
    match body {
        Some(bytes) => Response::builder()
            .header(header::CONTENT_TYPE, "image/png")
            .header(header::CACHE_CONTROL, "no-store")
            .body(bytes)
            .unwrap(),
        None => Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()).unwrap(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            match capture_arg(&args) {
                Some(mode) => start_capture(app, mode),
                None => windows::show_settings(app),
            }
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                // xcap logs an ERROR for every elevated process whose name it can't read; it still
                // lists the window, so that is noise, not news.
                .level_for("xcap", log::LevelFilter::Off)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: None }),
                ])
                .build(),
        )
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let mode = state(app).hotkeys.lock().unwrap().get(&shortcut.id()).copied();
                    if let Some(mode) = mode {
                        start_capture(app, mode);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .register_asynchronous_uri_scheme_protocol("snap", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_string();
            std::thread::spawn(move || responder.respond(serve_picture(&app, &path)));
        })
        .invoke_handler(tauri::generate_handler![
            overlay_init,
            overlay_elements,
            overlay_ready,
            overlay_commit,
            overlay_cancel,
            editor_init,
            capture_png,
            editor_ready,
            list_sessions,
            send_capture,
            new_session_options,
            pick_folder,
            start_session,
            copy_image,
            save_image,
            open_hangar,
            get_settings,
            save_settings,
            connection_status,
            sign_in,
            sign_out,
            start_capture_cmd,
            suspend_hotkeys,
            open_settings,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // HANGAR_SNAP_CONFIG_DIR keeps a test run's settings and recents away from the real ones.
            let dir = match std::env::var_os("HANGAR_SNAP_CONFIG_DIR") {
                Some(d) => std::path::PathBuf::from(d),
                // The local, not the roaming, folder on Windows: the settings hold a bearer token,
                // which has no business following a roaming profile to other machines.
                None => app.path().app_local_data_dir()?,
            };
            let first_run = !dir.join("settings.json").exists();
            let store = Store::new(dir);
            let settings = store.load_settings();
            if first_run {
                // Written now, so "first run" (which opens settings) means the first run only, whether
                // or not anything is changed and saved in them.
                if let Err(e) = store.save_settings(&settings) {
                    log::warn!("Could not save the default settings: {e}");
                }
            }
            let hotkeys = settings.hotkeys.clone();
            app.manage(AppState {
                store,
                settings: Mutex::new(settings),
                snapshot: Mutex::new(None),
                capturing: AtomicBool::new(false),
                generation: AtomicU64::new(0),
                overlays_ready: AtomicU64::new(0),
                captures: Mutex::new(HashMap::new()),
                next_capture: AtomicU64::new(1),
                spare_editor: Mutex::new(None),
                started: Mutex::new(None),
                committed: Mutex::new(None),
                hotkeys: Mutex::new(HashMap::new()),
                hotkey_errors: Mutex::new(Vec::new()),
            });
            let handle = app.handle().clone();
            build_tray(&handle, &hotkeys)?;
            apply_hotkeys(&handle);
            prewarm(&handle);

            let args: Vec<String> = std::env::args().collect();
            if let Some(mode) = capture_arg(&args) {
                start_capture(&handle, mode);
            } else if first_run && !args.iter().any(|a| a == "--autostart") {
                windows::show_settings(&handle);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Alt+F4 on an overlay: a cancel, and the overlay stays loaded for the next capture.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label().starts_with(windows::OVERLAY_PREFIX) {
                    api.prevent_close();
                    cancel_capture(window.app_handle());
                }
            }
            if let tauri::WindowEvent::Destroyed = event {
                let app = window.app_handle();
                let label = window.label();
                if let Some(id) = label.strip_prefix(windows::EDITOR_PREFIX) {
                    let st = state(app);
                    st.captures.lock().unwrap().remove(id);
                    let mut spare = st.spare_editor.lock().unwrap();
                    if spare.as_deref() == Some(id) {
                        *spare = None;
                    }
                } else if label.starts_with(windows::OVERLAY_PREFIX) {
                    // Closed by the OS (Alt+F4) rather than by us: that's a cancel. When we closed it,
                    // the capture is already over and this does nothing.
                    cancel_capture(app);
                } else if label == windows::SETTINGS {
                    // Closed while recording a hotkey, the hotkeys would stay suspended.
                    apply_hotkeys(app);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Hangar Snap")
        // A tray app: closing the last window doesn't quit it.
        .run(|_app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_prompt_is_the_message_then_the_picture() {
        assert_eq!(initial_prompt("  what is wrong here?\n", r"C:\w\a.png"), "what is wrong here?\n\nC:\\w\\a.png");
        assert_eq!(initial_prompt("   ", "/w/a.png"), "/w/a.png", "no message: the picture alone");
    }

    #[test]
    fn capture_argument_parses_mode() {
        let args = |s: &[&str]| s.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(capture_arg(&args(&["snap", "--capture", "window"])), Some(Mode::Window));
        assert_eq!(capture_arg(&args(&["snap", "--capture"])), Some(Mode::Region));
        assert_eq!(capture_arg(&args(&["snap", "--autostart"])), None);
        assert_eq!(capture_arg(&args(&["snap", "--capture", "bogus"])), None);
    }
}
