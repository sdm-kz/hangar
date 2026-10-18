// No console window behind the tray app on Windows, in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    hangar_snap_lib::run()
}
