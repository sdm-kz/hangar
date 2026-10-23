//! Moving over from Hangar Snap, the screenshot app this one grew out of. Snap kept its settings
//! under its own identifier, and registered itself to start at sign-in under its own name; left alone,
//! the first run here would forget the server, its sign-in and the hotkeys, and sign-in would go on
//! starting Snap beside this app, both of them claiming the same hotkeys.

use std::path::Path;

/// The identifier Snap kept its data under.
const SNAP_IDENTIFIER: &str = "io.github.sdm-kz.homeport.snap";
/// The name Snap's sign-in entry went by.
const SNAP_NAME: &str = "Hangar Snap";

/// Copy Snap's settings and recents into `dir` — once: only while `dir` has no settings of its own.
pub fn migrate_settings(dir: &Path) {
    if dir.join("settings.json").exists() {
        return;
    }
    let Some(old) = dir.parent().map(|p| p.join(SNAP_IDENTIFIER)) else { return };
    if !old.join("settings.json").is_file() {
        return;
    }
    if let Err(e) = std::fs::create_dir_all(dir) {
        log::warn!("Could not create {}: {e}", dir.display());
        return;
    }
    for name in ["settings.json", "recents.json"] {
        let from = old.join(name);
        if from.is_file() {
            match std::fs::copy(&from, dir.join(name)) {
                Ok(_) => log::info!("Carried {} over from Hangar Snap", from.display()),
                Err(e) => log::warn!("Could not carry {} over: {e}", from.display()),
            }
        }
    }
}

/// Take Snap out of the sign-in items — this app does everything it did — and put this app in its
/// place when Snap was starting at sign-in, so the screenshots go on being there after the next one.
/// A Snap still running is stopped too: it holds the capture hotkeys this app registers.
pub fn retire_snap(app: &tauri::AppHandle) {
    use tauri_plugin_autostart::ManagerExt as _;
    let path = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default();
    let mut was_on = false;
    // "Homeport Snap" is the name from before the rename to Hangar.
    for name in [SNAP_NAME, "Homeport Snap"] {
        let mut builder = auto_launch::AutoLaunchBuilder::new();
        builder.set_app_name(name).set_app_path(&path).set_macos_launch_mode(auto_launch::MacOSLaunchMode::LaunchAgent);
        let Ok(entry) = builder.build() else { continue };
        if entry.is_enabled().unwrap_or(false) {
            was_on = true;
            match entry.disable() {
                Ok(()) => log::info!("Removed the '{name}' sign-in entry; {} replaces it", crate::PRODUCT),
                Err(e) => log::warn!("Could not remove the '{name}' sign-in entry: {e}"),
            }
        }
    }
    if !was_on {
        return;
    }
    let autolaunch = app.autolaunch();
    if !autolaunch.is_enabled().unwrap_or(false) {
        if let Err(e) = autolaunch.enable() {
            log::warn!("Could not start {} at sign-in in Snap's place: {e}", crate::PRODUCT);
        }
    }
    stop_snap();
}

/// End a running Snap, by its executable's name (Snap's, never this app's).
fn stop_snap() {
    let mut command = if cfg!(windows) {
        let mut c = std::process::Command::new("taskkill");
        c.args(["/F", "/IM", "hangar-snap.exe", "/IM", "homeport-snap.exe"]);
        c
    } else {
        let mut c = std::process::Command::new("pkill");
        c.args(["-x", "hangar-snap|homeport-snap"]);
        c
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    // Nothing to stop is the usual answer, and not worth a line.
    let _ = command.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn carries_snaps_settings_over_once() {
        let root = std::env::temp_dir().join(format!("hangar-tray-legacy-{}", std::process::id()));
        let old = root.join(SNAP_IDENTIFIER);
        let new = root.join("io.github.sdm-kz.hangar.tray");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("settings.json"), r#"{"serverUrl":"http://nas:5099"}"#).unwrap();
        std::fs::write(old.join("recents.json"), "[]").unwrap();

        migrate_settings(&new);
        assert!(std::fs::read_to_string(new.join("settings.json")).unwrap().contains("nas"));
        assert!(new.join("recents.json").is_file());

        std::fs::write(new.join("settings.json"), "{}").unwrap();
        migrate_settings(&new);
        assert_eq!(std::fs::read_to_string(new.join("settings.json")).unwrap(), "{}", "its own settings are never overwritten");
        let _ = std::fs::remove_dir_all(root);
    }
}
