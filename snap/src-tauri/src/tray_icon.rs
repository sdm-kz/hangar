//! The tray icon's picture: drawn per size and per taskbar theme (see icons/tray/generate.py), and
//! picked to match the display — a 64-pixel picture squeezed into a 28-pixel slot by the OS comes out
//! blurred, and a dark glyph disappears into a dark taskbar. On Windows the app's windows wear the same
//! glyph, in their title bar and taskbar button.

use tauri::image::Image;
use tauri::{AppHandle, Manager, WebviewWindow};

macro_rules! sizes {
    ($kind:literal; $($px:literal),*) => {
        &[$(($px, include_bytes!(concat!("../icons/tray/", $kind, "-", $px, ".png")) as &[u8])),*]
    };
}

#[cfg(windows)]
const GLYPH_LIGHT: &[(u32, &[u8])] = sizes!("glyph-light"; 16, 20, 24, 28, 32, 40, 48, 56, 64);
#[cfg(windows)]
const GLYPH_DARK: &[(u32, &[u8])] = sizes!("glyph-dark"; 16, 20, 24, 28, 32, 40, 48, 56, 64);
#[cfg(target_os = "linux")]
const TILE: &[(u32, &[u8])] = sizes!("tile"; 24, 32, 48);

/// The smallest picture at least `px` across, or the biggest there is.
#[cfg_attr(target_os = "macos", allow(dead_code))] // one picture there: the template
fn pick(table: &[(u32, &'static [u8])], px: u32) -> &'static [u8] {
    table.iter().find(|(size, _)| *size >= px).unwrap_or(&table[table.len() - 1]).1
}

/// What the picture depends on, so a watcher can tell when it needs redrawing.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Look {
    pub light_taskbar: bool,
    /// The apps' mode, which windows' title bars follow.
    pub light_apps: bool,
    pub px: u32,
}

/// The tray's look right now: the taskbar's and apps' themes, and a small icon's size at the primary
/// display's scaling (Windows draws tray icons 16 logical pixels wide).
pub fn current_look(app: &AppHandle) -> Look {
    let scale = app.primary_monitor().ok().flatten().map(|m| m.scale_factor()).unwrap_or(1.0);
    Look {
        // The taskbar follows the "Windows mode", not the apps' mode.
        light_taskbar: personalize("SystemUsesLightTheme"),
        light_apps: personalize("AppsUseLightTheme"),
        px: (16.0 * scale).round() as u32,
    }
}

#[cfg(windows)]
fn personalize(value: &str) -> bool {
    windows_registry::CURRENT_USER
        .open(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
        .and_then(|key| key.get_u32(value))
        .map(|v| v != 0)
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn personalize(_value: &str) -> bool {
    false
}

pub fn image_for(look: Look) -> tauri::Result<Image<'static>> {
    #[cfg(windows)]
    let bytes = pick(if look.light_taskbar { GLYPH_LIGHT } else { GLYPH_DARK }, look.px);
    // The menu bar recolours a template image for light and dark itself.
    #[cfg(target_os = "macos")]
    let bytes: &[u8] = {
        let _ = look;
        include_bytes!("../icons/tray/template.png")
    };
    // A panel indicator is drawn at the panel's size, typically 22-24 px; it scales the picture to fit.
    #[cfg(target_os = "linux")]
    let bytes = pick(TILE, look.px.max(32));
    Image::from_bytes(bytes)
}

/// Give `window` the glyph: the small icon (title bar) in the apps' theme, the big one (taskbar button,
/// Alt+Tab) in the taskbar's. Tauri only ever sets the small one, which leaves the taskbar showing the
/// exe's own icon, so both are set here directly. Elsewhere windows keep the app icon.
#[cfg(windows)]
pub fn dress_window(window: &WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SendMessageW, ICON_BIG, ICON_SMALL, WM_SETICON};
    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = hwnd.0 as usize;
    let look = current_look(window.app_handle());
    let scale = window.scale_factor().unwrap_or(1.0);
    let icons = [
        (ICON_SMALL, look.light_apps, (16.0 * scale).round() as u32),
        (ICON_BIG, look.light_taskbar, (32.0 * scale).round() as u32),
    ];
    let _ = window.run_on_main_thread(move || {
        for (kind, light, px) in icons {
            // The icon replaced is left alone: the first is Tauri's, which frees it itself; ours are a
            // couple per theme change.
            match hicon(pick(if light { GLYPH_LIGHT } else { GLYPH_DARK }, px)) {
                Some(icon) => unsafe {
                    SendMessageW(hwnd as _, WM_SETICON, kind as usize, icon as isize);
                },
                None => log::warn!("Could not make the window icon"),
            }
        }
    });
}

/// A Windows icon from a PNG, the way tao makes its own: BGRA colour, and a mask from the alpha.
#[cfg(windows)]
fn hicon(png: &[u8]) -> Option<windows_sys::Win32::UI::WindowsAndMessaging::HICON> {
    let image = Image::from_bytes(png).ok()?;
    let (w, h) = (image.width(), image.height());
    let mut bgra = image.rgba().to_vec();
    let mut mask = Vec::with_capacity(bgra.len() / 4);
    for px in bgra.as_chunks_mut::<4>().0 {
        px.swap(0, 2);
        mask.push(px[3].wrapping_sub(u8::MAX));
    }
    let icon = unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::CreateIcon(
            std::ptr::null_mut(),
            w as i32,
            h as i32,
            1,
            32,
            mask.as_ptr(),
            bgra.as_ptr(),
        )
    };
    (!icon.is_null()).then_some(icon)
}

#[cfg(not(windows))]
pub fn dress_window(_window: &WebviewWindow) {}

/// Redraw the tray icon, and the windows' icons, when the taskbar's or apps' theme or the display's
/// scaling changes. Windows only: macOS recolours its template image itself, and a Linux panel can't be
/// asked. A poll every few seconds — three registry and monitor reads — rather than a hook into window
/// messages the app doesn't own.
pub fn watch(app: &AppHandle, tray_id: &'static str) {
    if !cfg!(windows) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut shown = current_look(&app);
        loop {
            std::thread::sleep(std::time::Duration::from_secs(3));
            let look = current_look(&app);
            if look == shown {
                continue;
            }
            shown = look;
            if let (Some(tray), Ok(image)) = (app.tray_by_id(tray_id), image_for(look)) {
                let _ = tray.set_icon(Some(image));
            }
            for window in app.webview_windows().values() {
                dress_window(window);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_exact_size_or_the_next_one_up() {
        let table: &[(u32, &'static [u8])] = &[(16, b"a"), (24, b"b"), (32, b"c")];
        assert_eq!(pick(table, 16), b"a");
        assert_eq!(pick(table, 20), b"b", "125% scaling: the 24 shrinks less than the 16 grows");
        assert_eq!(pick(table, 28), b"c");
        assert_eq!(pick(table, 64), b"c", "past the biggest, the biggest");
    }

    #[cfg(windows)]
    #[test]
    fn every_size_decodes() {
        for (_, bytes) in GLYPH_LIGHT.iter().chain(GLYPH_DARK) {
            Image::from_bytes(bytes).expect("a tray picture that decodes");
        }
    }

    #[cfg(windows)]
    #[test]
    fn every_size_makes_a_window_icon() {
        for (_, bytes) in GLYPH_LIGHT.iter().chain(GLYPH_DARK) {
            let icon = hicon(bytes).expect("an icon Windows accepts");
            unsafe { windows_sys::Win32::UI::WindowsAndMessaging::DestroyIcon(icon) };
        }
    }
}
