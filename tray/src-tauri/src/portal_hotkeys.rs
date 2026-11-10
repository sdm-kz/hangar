//! Global hotkeys on Wayland, through the desktop's GlobalShortcuts portal.
//!
//! Wayland lets no app grab keys for itself. tauri-plugin-global-shortcut grabs them the X11 way, and
//! under Wayland that grab sees only what reaches an X11 (XWayland) window: the hotkeys worked while a
//! browser had focus and nowhere else. The portal (xdg-desktop-portal: GNOME 48+, KDE Plasma 5.27+,
//! Hyprland) is how an app asks the desktop for a shortcut instead: the desktop shows the user the
//! shortcuts once, to accept or change, keeps the choice, and reports each press. Where it is there and
//! the user accepts, it replaces the X11 grab. Where it isn't (an X11 session, an older desktop), or the
//! user declines, the grab stays as it was.

use std::sync::atomic::{AtomicBool, Ordering};

use ashpd::desktop::global_shortcuts::{GlobalShortcuts, NewShortcut};
use futures_util::StreamExt;
use tauri::AppHandle;

use crate::capture::Mode;
use crate::config::Hotkeys;

/// The id the portal knows the tray by. The bundle identifier with its `-` made `_` (an app id may
/// have one in its last part only), and the name of the app-menu entry install-unix.sh writes, which
/// is where the desktop takes the name and icon its dialog shows.
const APP_ID: &str = "io.github.sdm_kz.hangar.tray";

static ACTIVE: AtomicBool = AtomicBool::new(false);

/// Whether the portal holds the hotkeys, so the X11 grab must stay let go.
pub fn active() -> bool {
    ACTIVE.load(Ordering::Relaxed)
}

/// Whether to ask the portal at all: on Wayland, where the X11 grab can't do the job.
pub fn wanted() -> bool {
    crate::capture::is_wayland()
}

/// Ask the portal for the hotkeys, in the background: binding them waits on the user's answer to the
/// desktop's dialog the first time. Once they are bound, the X11 grab is let go and each press starts a
/// capture, for as long as the tray runs.
pub fn start(app: &AppHandle, hotkeys: Hotkeys) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run(&app, &hotkeys).await {
            log::info!(
                "No global shortcuts from the desktop portal ({e}); the hotkeys stay an X11 grab, which \
                 sees them only while an X11 window has focus"
            );
        }
        if ACTIVE.swap(false, Ordering::Relaxed) {
            log::warn!("The desktop portal stopped reporting the hotkeys; back to the X11 grab");
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || crate::apply_hotkeys(&handle));
        }
    });
}

async fn run(app: &AppHandle, hotkeys: &Hotkeys) -> ashpd::Result<()> {
    // A host app has no app id of its own to the portal, and without one there is nothing to keep the
    // user's choice under. An older portal has no registry: carry on, it may manage without.
    if let Err(e) = ashpd::register_host_app(APP_ID.parse()?).await {
        log::warn!("Could not register with the desktop portal as {APP_ID}: {e}");
    }
    let shortcuts: Vec<NewShortcut> = Mode::ALL
        .into_iter()
        .filter_map(|mode| {
            let text = crate::hotkey_for(hotkeys, mode).trim();
            (!text.is_empty()).then(|| {
                NewShortcut::new(id(mode), format!("Capture: {}", mode.label()))
                    .preferred_trigger(xdg_trigger(text).as_deref())
            })
        })
        .collect();
    if shortcuts.is_empty() {
        return Ok(());
    }

    let portal = GlobalShortcuts::new().await?;
    // Open for as long as the presses are wanted: closing the session unbinds them.
    let session = portal.create_session(Default::default()).await?;
    let bound = portal.bind_shortcuts(&session, &shortcuts, None, Default::default()).await?.response()?;
    for s in bound.shortcuts() {
        log::info!("Hotkey from the desktop portal: {} = {}", s.id(), s.trigger_description());
    }
    let mut presses = portal.receive_activated().await?;
    // The ends of the session: the portal closing it, or the portal service itself going away (an
    // upgrade restarts it), which takes its sessions with it and says nothing on its way out. Either way
    // the presses stop coming, and the hotkeys go back to the X11 grab rather than to nothing.
    let mut closed = session.receive_closed().await?;
    let connection = ashpd::zbus::Connection::session().await?;
    let bus = ashpd::zbus::fdo::DBusProxy::new(&connection).await?;
    let mut portal_owner = bus
        .receive_name_owner_changed_with_args(&[(0, "org.freedesktop.portal.Desktop")])
        .await?;

    ACTIVE.store(true, Ordering::Relaxed);
    // Lets the X11 grab go, now that the portal has them; on the event loop, where it always runs.
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || crate::apply_hotkeys(&handle));
    loop {
        tokio::select! {
            press = presses.next() => match press {
                Some(press) => {
                    if let Some(mode) = Mode::ALL.into_iter().find(|&m| id(m) == press.shortcut_id()) {
                        crate::start_capture(app, mode);
                    }
                }
                None => break,
            },
            _ = closed.next() => break,
            _ = portal_owner.next() => break,
        }
    }
    let _ = session.close().await;
    Ok(())
}

fn id(mode: Mode) -> &'static str {
    match mode {
        Mode::Region => "region",
        Mode::Window => "window",
        Mode::Fullscreen => "fullscreen",
        Mode::Freeform => "freeform",
    }
}

/// A hotkey as the settings spell it ("Ctrl+Shift+1", Tauri's form) in the form of the XDG shortcuts
/// specification the portal takes ("CTRL+SHIFT+1"). Only the trigger the tray would like: the desktop
/// shows it to the user, who may pick another. None for one that doesn't translate.
fn xdg_trigger(text: &str) -> Option<String> {
    let mut parts = Vec::new();
    for part in text.split('+').map(str::trim) {
        let mapped = match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" | "commandorcontrol" | "cmdorctrl" | "cmdorcontrol" => "CTRL".to_string(),
            "shift" => "SHIFT".to_string(),
            "alt" | "option" => "ALT".to_string(),
            "super" | "meta" | "cmd" | "command" | "win" | "logo" => "LOGO".to_string(),
            "" => return None,
            key if key.chars().count() == 1 => key.to_string(),
            key => match keysym(key) {
                Some(name) => name.to_string(),
                // F1…F24, Home, End, Insert, Delete, Tab: the keysym is the same word.
                None => part.to_string(),
            },
        };
        parts.push(mapped);
    }
    Some(parts.join("+"))
}

/// The X keysym name of a key the settings name differently (they keep a browser's KeyboardEvent.code,
/// shortened). Lowercased on the way in.
fn keysym(key: &str) -> Option<&'static str> {
    Some(match key {
        "space" => "space",
        "printscreen" | "print" => "Print",
        "enter" | "return" => "Return",
        "escape" | "esc" => "Escape",
        "backspace" => "BackSpace",
        "arrowup" | "up" => "Up",
        "arrowdown" | "down" => "Down",
        "arrowleft" | "left" => "Left",
        "arrowright" | "right" => "Right",
        "pageup" => "Page_Up",
        "pagedown" => "Page_Down",
        "minus" => "minus",
        "equal" => "equal",
        "comma" => "comma",
        "period" => "period",
        "slash" => "slash",
        "backslash" => "backslash",
        "semicolon" => "semicolon",
        "quote" => "apostrophe",
        "backquote" => "grave",
        "bracketleft" => "bracketleft",
        "bracketright" => "bracketright",
        "scrolllock" => "Scroll_Lock",
        "pause" => "Pause",
        "num0" | "numpad0" => "KP_0",
        "num1" | "numpad1" => "KP_1",
        "num2" | "numpad2" => "KP_2",
        "num3" | "numpad3" => "KP_3",
        "num4" | "numpad4" => "KP_4",
        "num5" | "numpad5" => "KP_5",
        "num6" | "numpad6" => "KP_6",
        "num7" | "numpad7" => "KP_7",
        "num8" | "numpad8" => "KP_8",
        "num9" | "numpad9" => "KP_9",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translates_hotkeys_to_xdg_triggers() {
        assert_eq!(xdg_trigger("Ctrl+Shift+1").as_deref(), Some("CTRL+SHIFT+1"));
        assert_eq!(xdg_trigger("CommandOrControl+Alt+S").as_deref(), Some("CTRL+ALT+s"));
        assert_eq!(xdg_trigger("Super+PrintScreen").as_deref(), Some("LOGO+Print"));
        assert_eq!(xdg_trigger("Shift+F5").as_deref(), Some("SHIFT+F5"));
        assert_eq!(xdg_trigger("Ctrl+ArrowUp").as_deref(), Some("CTRL+Up"));
        assert_eq!(xdg_trigger("Ctrl+Alt+Minus").as_deref(), Some("CTRL+ALT+minus"));
        assert_eq!(xdg_trigger("Ctrl+Num1").as_deref(), Some("CTRL+KP_1"));
        assert_eq!(xdg_trigger("Ctrl++"), None);
    }
}
