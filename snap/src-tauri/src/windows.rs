//! The app's windows: an overlay over each monitor while picking, an editor per capture, and settings.
//! All of them are one web app (index.html) told by its URL hash which one to be.
//!
//! The overlays and one editor are kept loaded and hidden between captures. Building a webview is the
//! slow part of putting one on screen — and with none alive, WebView2 also shuts its browser process
//! down and every capture pays for starting it again — so a hotkey only moves an overlay that is
//! already there and tells it which frame to show.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::geometry::Rect;

pub const OVERLAY_PREFIX: &str = "overlay-";
pub const EDITOR_PREFIX: &str = "editor-";
pub const SETTINGS: &str = "settings";

/// What an overlay is told when a capture starts: which capture, so it can tell a new one from the
/// last (and so the browser can't serve it the last one's frame from its cache).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayStart {
    pub frame: usize,
    pub generation: u64,
}

/// Put overlay `index` over `monitor` and have it show the frame of capture `generation`. It shows
/// itself once that frame has painted (`overlay_ready`), so the screen never flashes an empty window or
/// the previous capture's picture.
pub fn present_overlay(app: &AppHandle, index: usize, monitor: Rect, generation: u64) -> tauri::Result<()> {
    let window = ensure_overlay(app, index)?;
    cover_monitor(&window, monitor)?;
    app.emit("overlay-start", OverlayStart { frame: index, generation })
}

/// Overlay `index`, built (hidden) if it isn't already.
pub fn ensure_overlay(app: &AppHandle, index: usize) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window(&format!("{OVERLAY_PREFIX}{index}")) {
        return Ok(window);
    }
    let window = WebviewWindowBuilder::new(
        app,
        format!("{OVERLAY_PREFIX}{index}"),
        WebviewUrl::App(format!("index.html#overlay/{index}").into()),
    )
    .title("Homeport Snap")
    .decorations(false)
    // Mutter won't fullscreen a window that can't be resized.
    .resizable(cfg!(target_os = "linux"))
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .visible(false)
    .focused(true)
    .build()?;
    raise_above_everything(&window);
    Ok(window)
}

/// Lay `window` exactly over `monitor` (in the capture's units for the platform: points on macOS,
/// physical pixels elsewhere — the units the toolkit takes positions in there, logical and physical
/// respectively).
fn cover_monitor(window: &WebviewWindow, m: Rect) -> tauri::Result<()> {
    // macOS: size first. AppKit resizes a window about its bottom-left corner, so a resize after the
    // move would grow it upwards, off the top of the monitor; the move then pins the top-left.
    #[cfg(target_os = "macos")]
    {
        use tauri::{LogicalPosition, LogicalSize};
        window.set_size(LogicalSize::new(m.width as f64, m.height as f64))?;
        window.set_position(LogicalPosition::new(m.x as f64, m.y as f64))?;
    }
    // Elsewhere, size after position: on Windows a move onto a monitor of another DPI rescales the
    // window, and setting the size second makes it the right one for where it ended up.
    #[cfg(not(target_os = "macos"))]
    {
        use tauri::{PhysicalPosition, PhysicalSize};
        window.set_position(PhysicalPosition::new(m.x, m.y))?;
        window.set_size(PhysicalSize::new(m.width, m.height))?;
        window.set_position(PhysicalPosition::new(m.x, m.y))?;
    }
    // On Linux a fullscreen window goes over the panels, and is the only placement Wayland honours —
    // on the monitor named here, rather than wherever the compositor would put every overlay.
    #[cfg(target_os = "linux")]
    window.set_fullscreen_on_monitor(tauri::PhysicalPosition::new(
        m.x as f64 + m.width as f64 / 2.0,
        m.y as f64 + m.height as f64 / 2.0,
    ))?;
    Ok(())
}

/// Over the menu bar and the Dock too, and onto whatever Space is showing (even a full-screen app's).
/// Tauri's always-on-top is the floating level, which both of those sit above.
#[cfg(target_os = "macos")]
fn raise_above_everything(window: &WebviewWindow) {
    use objc2::runtime::AnyObject;
    const NS_SCREEN_SAVER_WINDOW_LEVEL: isize = 1000;
    // NSWindowCollectionBehavior: CanJoinAllSpaces | Stationary | FullScreenAuxiliary.
    const BEHAVIOR: usize = (1 << 0) | (1 << 4) | (1 << 8);
    let Ok(ptr) = window.ns_window() else { return };
    let ptr = ptr as usize;
    let _ = window.run_on_main_thread(move || unsafe {
        let ns_window = &*(ptr as *const AnyObject);
        let _: () = objc2::msg_send![ns_window, setLevel: NS_SCREEN_SAVER_WINDOW_LEVEL];
        let _: () = objc2::msg_send![ns_window, setCollectionBehavior: BEHAVIOR];
    });
}

#[cfg(not(target_os = "macos"))]
fn raise_above_everything(_window: &WebviewWindow) {}

/// Put the overlays away for the next capture. They drop their frame first (`overlay-end`), so a
/// hidden overlay doesn't hold a screenful of pixels.
pub fn hide_overlays(app: &AppHandle) {
    let _ = app.emit("overlay-end", ());
    for (label, window) in app.webview_windows() {
        if label.starts_with(OVERLAY_PREFIX) {
            #[cfg(target_os = "linux")]
            let _ = window.set_fullscreen(false);
            let _ = window.hide();
        }
    }
}

/// Toolbar above the picture, composer and session list below it, and the window's padding — what the
/// editor needs besides the picture, in logical pixels.
const EDITOR_CHROME_WIDTH: f64 = 48.0;
const EDITOR_CHROME_HEIGHT: f64 = 56.0 + 196.0 + 32.0;
const EDITOR_MIN: (f64, f64) = (820.0, 600.0);

/// A hidden editor for capture `id`, its page loading; `place_editor` puts it where its picture goes.
/// Made ahead of time as the spare (see `AppState::spare_editor`), or on the spot when there is none.
pub fn create_editor(app: &AppHandle, id: &str) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, format!("{EDITOR_PREFIX}{id}"), WebviewUrl::App(format!("index.html#editor/{id}").into()))
        .title("Homeport Snap")
        .inner_size(EDITOR_MIN.0, EDITOR_MIN.1)
        .visible(false)
        .build()
        .inspect(crate::tray_icon::dress_window)
}

/// Size `window` to show an `image` of physical pixels at its real size where it fits, centred on the
/// monitor it came from.
pub fn place_editor(window: &WebviewWindow, image: (u32, u32), monitor: Rect, scale: f32) -> tauri::Result<()> {
    use tauri::LogicalSize;
    let scale = if scale > 0.0 { scale as f64 } else { 1.0 };
    // The monitor's size in logical pixels: xcap's units are those already on macOS.
    let (mon_w, mon_h) = if cfg!(target_os = "macos") {
        (monitor.width as f64, monitor.height as f64)
    } else {
        (monitor.width as f64 / scale, monitor.height as f64 / scale)
    };
    let (w, h) = editor_size(image, scale, (mon_w, mon_h));
    window.set_min_size(Some(LogicalSize::new(EDITOR_MIN.0.min(mon_w), EDITOR_MIN.1.min(mon_h))))?;
    window.set_size(LogicalSize::new(w, h))?;
    place_centered(window, monitor, scale, (w, h))
}

/// The editor's logical size for an `image` of physical pixels at `scale`: the picture at 1:1 plus the
/// chrome, within 90% of the monitor and no smaller than the minimum.
pub fn editor_size(image: (u32, u32), scale: f64, monitor: (f64, f64)) -> (f64, f64) {
    let want_w = image.0 as f64 / scale + EDITOR_CHROME_WIDTH;
    let want_h = image.1 as f64 / scale + EDITOR_CHROME_HEIGHT;
    let max_w = (monitor.0 * 0.9).max(EDITOR_MIN.0.min(monitor.0));
    let max_h = (monitor.1 * 0.9).max(EDITOR_MIN.1.min(monitor.1));
    (want_w.clamp(EDITOR_MIN.0.min(max_w), max_w).round(), want_h.clamp(EDITOR_MIN.1.min(max_h), max_h).round())
}

fn place_centered(window: &WebviewWindow, m: Rect, scale: f64, size: (f64, f64)) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let _ = scale;
        use tauri::LogicalPosition;
        let x = m.x as f64 + (m.width as f64 - size.0) / 2.0;
        let y = m.y as f64 + (m.height as f64 - size.1) / 2.0;
        window.set_position(LogicalPosition::new(x, y.max(m.y as f64 + 24.0)))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri::{LogicalSize, PhysicalPosition};
        let x = m.x as f64 + (m.width as f64 - size.0 * scale) / 2.0;
        let y = m.y as f64 + (m.height as f64 - size.1 * scale) / 2.0;
        window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32))?;
        // Again after the move, in case it changed monitors and DPI on the way.
        window.set_size(LogicalSize::new(size.0, size.1))?;
    }
    Ok(())
}

/// Open settings, or bring them forward. Callable from anywhere: the window is built off the main
/// thread, since building one on it — from a synchronous command, a menu or the single-instance
/// callback — deadlocks on Windows, the event loop being the very thing the build waits on.
pub fn show_settings(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(SETTINGS) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let built = WebviewWindowBuilder::new(&app, SETTINGS, WebviewUrl::App("index.html#settings".into()))
            .title("Homeport Snap — Settings")
            .inner_size(560.0, 640.0)
            .min_inner_size(480.0, 520.0)
            .center()
            .build();
        match built {
            Ok(window) => crate::tray_icon::dress_window(&window),
            Err(e) => log::error!("Could not open settings: {e}"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_capture_gets_the_minimum_window() {
        assert_eq!(editor_size((200, 100), 1.0, (1920.0, 1080.0)), EDITOR_MIN);
    }

    #[test]
    fn capture_shows_at_real_size_when_it_fits() {
        // 1200×600 physical at 1.5× is 800×400 logical.
        let (w, h) = editor_size((1200, 600), 1.5, (2560.0, 1440.0));
        assert_eq!((w, h), (EDITOR_MIN.0.max(800.0 + EDITOR_CHROME_WIDTH), 400.0 + EDITOR_CHROME_HEIGHT));
    }

    #[test]
    fn full_screen_capture_is_held_to_90_percent_of_the_monitor() {
        assert_eq!(editor_size((3840, 2160), 2.0, (1920.0, 1080.0)), (1728.0, 972.0));
    }

    #[test]
    fn tiny_monitor_never_gets_a_window_bigger_than_itself() {
        let (w, h) = editor_size((3000, 3000), 1.0, (800.0, 500.0));
        assert!(w <= 800.0 && h <= 500.0, "got {w}×{h}");
    }
}
