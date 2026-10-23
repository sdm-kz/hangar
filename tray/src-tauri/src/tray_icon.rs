//! The tray icon's picture: the Hangar logo, drawn per size (scripts/make-icons.py) and picked to match
//! the display — a 64-pixel picture squeezed into a 28-pixel slot by the OS comes out blurred. The logo
//! is in its own colours, which read on light and dark taskbars alike. On Windows the app's windows wear
//! it too, in their title bar and taskbar button.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::image::Image;
use tauri::{AppHandle, Manager, WebviewWindow};

macro_rules! sizes {
    ($($px:literal),*) => {
        &[$(($px, include_bytes!(concat!("../icons/tray/logo-", $px, ".png")) as &[u8])),*]
    };
}

#[cfg_attr(target_os = "macos", allow(dead_code))] // the menu bar takes a template instead
const LOGO: &[(u32, &[u8])] = sizes!(16, 20, 24, 28, 32, 40, 48, 56, 64);

/// The smallest picture at least `px` across, or the biggest there is.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn pick(table: &[(u32, &'static [u8])], px: u32) -> &'static [u8] {
    table.iter().find(|(size, _)| *size >= px).unwrap_or(&table[table.len() - 1]).1
}

/// What the picture depends on, so a watcher can tell when it needs redrawing: a small icon's size at
/// the primary display's scaling (Windows draws tray icons 16 logical pixels wide).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Look {
    pub px: u32,
}

pub fn current_look(app: &AppHandle) -> Look {
    let scale = app.primary_monitor().ok().flatten().map(|m| m.scale_factor()).unwrap_or(1.0);
    Look { px: (16.0 * scale).round() as u32 }
}

/// Whether the tray is following a server that answers. The icon is greyed out while it isn't, as the
/// first sign that the server is down.
static ONLINE: AtomicBool = AtomicBool::new(false);

/// Grey the icon out, or bring its colour back, when the server goes away or comes back.
pub fn set_online(app: &AppHandle, tray_id: &str, online: bool) {
    if ONLINE.swap(online, Ordering::SeqCst) == online {
        return;
    }
    if let (Some(tray), Ok(image)) = (app.tray_by_id(tray_id), image_for(current_look(app))) {
        let _ = tray.set_icon(Some(image));
        let _ = tray.set_icon_as_template(cfg!(target_os = "macos"));
    }
}

/// The picture faded to grey: colour drained, and well under half as opaque.
fn dimmed(image: Image<'_>) -> Image<'static> {
    let (w, h) = (image.width(), image.height());
    let mut rgba = image.rgba().to_vec();
    for px in rgba.as_chunks_mut::<4>().0 {
        let grey = ((px[0] as u32 * 30 + px[1] as u32 * 59 + px[2] as u32 * 11) / 100) as u8;
        px[0] = grey;
        px[1] = grey;
        px[2] = grey;
        px[3] = (px[3] as u32 * 2 / 5) as u8;
    }
    Image::new_owned(rgba, w, h)
}

pub fn image_for(look: Look) -> tauri::Result<Image<'static>> {
    let image = picture_for(look)?;
    Ok(if ONLINE.load(Ordering::SeqCst) { image } else { dimmed(image) })
}

fn picture_for(look: Look) -> tauri::Result<Image<'static>> {
    // The menu bar wants a template — the logo's silhouette in black — and recolours it for light and
    // dark itself.
    #[cfg(target_os = "macos")]
    let bytes: &[u8] = {
        let _ = look;
        include_bytes!("../icons/tray/template.png")
    };
    // A Linux panel indicator is drawn at the panel's size, typically 22-24 px, and scales the picture
    // to fit.
    #[cfg(target_os = "linux")]
    let bytes = pick(LOGO, look.px.max(32));
    #[cfg(windows)]
    let bytes = pick(LOGO, look.px);
    Image::from_bytes(bytes)
}

/// Give `window` the logo: the small icon (title bar) and the big one (taskbar button, Alt+Tab).
/// Tauri only ever sets the small one, which leaves the taskbar showing the exe's own icon, so both are
/// set here directly, each at its size for the window's scaling. Elsewhere windows keep the app icon.
#[cfg(windows)]
pub fn dress_window(window: &WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SendMessageW, ICON_BIG, ICON_SMALL, WM_SETICON};
    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = hwnd.0 as usize;
    let scale = window.scale_factor().unwrap_or(1.0);
    let icons = [(ICON_SMALL, (16.0 * scale).round() as u32), (ICON_BIG, (32.0 * scale).round() as u32)];
    let _ = window.run_on_main_thread(move || {
        for (kind, px) in icons {
            // The icon replaced is left alone: the first is Tauri's, which frees it itself; ours are a
            // couple per scaling change.
            match hicon(pick(LOGO, px)) {
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

/// Redraw the tray icon, and the windows' icons, when the display's scaling changes. Windows only:
/// macOS and a Linux panel size the picture themselves. A poll every few seconds — one monitor read —
/// rather than a hook into window messages the app doesn't own.
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

    #[test]
    fn dimming_greys_and_fades_every_pixel() {
        let image = dimmed(Image::new_owned(vec![200, 100, 0, 255, 0, 0, 0, 0], 2, 1));
        assert_eq!(image.rgba(), &[119, 119, 119, 102, 0, 0, 0, 0]);
    }

    #[test]
    fn every_size_decodes_at_its_size() {
        for (px, bytes) in LOGO {
            let image = Image::from_bytes(bytes).expect("a tray picture that decodes");
            assert_eq!((image.width(), image.height()), (*px, *px));
        }
        Image::from_bytes(include_bytes!("../icons/tray/template.png")).expect("the menu-bar template decodes");
    }

    #[cfg(windows)]
    #[test]
    fn every_size_makes_a_window_icon() {
        for (_, bytes) in LOGO {
            let icon = hicon(bytes).expect("an icon Windows accepts");
            unsafe { windows_sys::Win32::UI::WindowsAndMessaging::DestroyIcon(icon) };
        }
    }
}
