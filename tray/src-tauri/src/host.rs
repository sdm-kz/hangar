//! This machine's side of the tray's server controls: whether a server's process is alive, starting
//! one, and getting out of an update's way. Everything here is for a server on this machine; one on
//! another machine is only ever spoken to over its API.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::SystemTime;

use tauri::AppHandle;

use crate::api::Instance;

/// This executable as it was when the app started: its path, and when the file was last written. On
/// Linux and macOS an update replaces the file by a rename while the app keeps running the old one, so
/// a changed time is how the app knows there is a newer build of itself to start.
static EXE: OnceLock<(PathBuf, Option<SystemTime>)> = OnceLock::new();

/// Note where this executable is. Call first thing, before an update can have replaced it.
pub fn remember_exe() {
    if let Ok(exe) = std::env::current_exe() {
        let modified = std::fs::metadata(&exe).and_then(|m| m.modified()).ok();
        let _ = EXE.set((exe, modified));
    }
}

fn exe() -> Option<&'static Path> {
    EXE.get().map(|(p, _)| p.as_path())
}

/// Whether process `pid` is running. A crashed server leaves its instance file behind; this is how
/// that file is told apart from a live one.
#[cfg(windows)]
pub fn process_alive(pid: u32) -> bool {
    use windows::Win32::Foundation::{CloseHandle, E_ACCESSDENIED, STILL_ACTIVE};
    use windows::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    if pid == 0 {
        return false;
    }
    unsafe {
        let handle = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(h) => h,
            // There, just not ours to look into: a server running as a service under another account.
            Err(e) => return e.code() == E_ACCESSDENIED,
        };
        let mut code = 0u32;
        let alive = GetExitCodeProcess(handle, &mut code).is_ok() && code == STILL_ACTIVE.0 as u32;
        let _ = CloseHandle(handle);
        alive
    }
}

#[cfg(unix)]
pub fn process_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    // Signal 0 only asks whether it could be sent; EPERM means the process is there, just not ours.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM) }
}

/// How a stopped server on this machine can be started from the tray.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Starter {
    /// The user unit `scripts/install-unix.sh` registered.
    Systemd,
    Launchd,
    /// The server executable beside this one, where an install puts both.
    Exe(PathBuf),
}

const SYSTEMD_UNIT: &str = "hangar.service";
const LAUNCHD_LABEL: &str = "com.hangar.server";

/// The way to start the server here, or none — a dev build has no server beside it.
pub fn starter() -> Option<Starter> {
    if cfg!(target_os = "linux") {
        let unit = dirs::config_dir().map(|d| d.join("systemd/user").join(SYSTEMD_UNIT));
        if unit.is_some_and(|u| u.is_file()) {
            return Some(Starter::Systemd);
        }
    }
    if cfg!(target_os = "macos") {
        let plist = dirs::home_dir().map(|d| d.join("Library/LaunchAgents").join(format!("{LAUNCHD_LABEL}.plist")));
        if plist.is_some_and(|p| p.is_file()) {
            return Some(Starter::Launchd);
        }
    }
    let name = if cfg!(windows) { "Hangar.exe" } else { "Hangar" };
    let server = exe()?.parent()?.join(name);
    server.is_file().then_some(Starter::Exe(server))
}

pub fn start_server(starter: &Starter) -> Result<(), String> {
    let mut command = match starter {
        Starter::Systemd => {
            let mut c = Command::new("systemctl");
            c.args(["--user", "start", SYSTEMD_UNIT]);
            c
        }
        Starter::Launchd => {
            let mut c = Command::new("launchctl");
            c.arg("kickstart").arg(format!("gui/{}/{LAUNCHD_LABEL}", uid()));
            c
        }
        Starter::Exe(server) => {
            let mut c = Command::new(server);
            if let Some(dir) = server.parent() {
                c.current_dir(dir);
            }
            detach(&mut c);
            c
        }
    };
    match starter {
        // The server itself: it runs on, and is never waited for.
        Starter::Exe(_) => command.spawn().map(|_| ()).map_err(|e| e.to_string())?,
        // A service manager's command: it returns once the start is under way, and says if it failed.
        Starter::Systemd | Starter::Launchd => {
            let out = command.output().map_err(|e| e.to_string())?;
            if !out.status.success() {
                return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
            }
        }
    }
    log::info!("Started the server ({starter:?})");
    Ok(())
}

#[cfg(unix)]
fn uid() -> u32 {
    unsafe { libc::getuid() }
}

#[cfg(not(unix))]
fn uid() -> u32 {
    0
}

/// Let `command` outlive the tray, with no console window of its own.
fn detach(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own process group, so a signal meant for the tray's doesn't reach it.
        command.process_group(0);
    }
    command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
}

/// Whether this tray is part of the install `instance`'s server runs from: the two side by side.
fn same_install(instance: &Instance) -> bool {
    let (Some(ours), Some(theirs)) = (exe().and_then(Path::parent), instance.exe_path.as_deref().map(Path::new).and_then(Path::parent))
    else {
        return false;
    };
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let (a, b) = (canon(ours), canon(theirs));
    if cfg!(windows) {
        a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy())
    } else {
        a == b
    }
}

/// The server is about to be replaced by an update, and the updater will copy the new build over the
/// install — this executable included. On Windows a running exe can't be overwritten, so the tray hands
/// off to a small hidden PowerShell that waits for the old server to exit and the new one to answer,
/// then starts the tray again from the (by then updated) folder; and exits. Elsewhere the update
/// replaces files by a rename, which a running program doesn't block, and the tray restarts into the
/// new build once it reconnects ([`relaunch_if_replaced`]).
pub fn step_aside_for_update(app: &AppHandle, instance: &Instance) {
    if !cfg!(windows) || !same_install(instance) {
        return;
    }
    match spawn_windows_relauncher(instance) {
        Ok(()) => log::info!("Update in progress: exiting so the tray can be replaced; it comes back once the server does"),
        Err(e) => log::error!("Could not arrange for the tray to come back after the update: {e}"),
    }
    app.exit(0);
}

#[cfg(windows)]
fn spawn_windows_relauncher(instance: &Instance) -> Result<(), String> {
    use base64::Engine;
    let exe = exe().ok_or("This executable's path is unknown")?;
    // Only a number is spliced into the script. The path and the URL reach it as environment
    // variables, so no character in them can end a string early and run the rest as commands.
    let script = format!(
        r#"$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
Wait-Process -Id {pid} -Timeout 180
$deadline = (Get-Date).AddMinutes(10)
while ((Get-Date) -lt $deadline) {{
  try {{ Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri $env:HANGAR_RELAUNCH_PROBE | Out-Null; break }}
  catch {{ Start-Sleep -Seconds 2 }}
}}
Start-Process -FilePath $env:HANGAR_RELAUNCH_EXE -ArgumentList '--autostart'
"#,
        pid = instance.pid
    );
    let encoded: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let system = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    // By full path: a bare name is looked up beside this exe first.
    let powershell = system.join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    let mut command = Command::new(powershell);
    command
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-EncodedCommand"])
        .arg(base64::engine::general_purpose::STANDARD.encode(encoded))
        .env("HANGAR_RELAUNCH_EXE", exe)
        // Public: it answers before any sign-in.
        .env("HANGAR_RELAUNCH_PROBE", format!("{}/api/auth/config", instance.local_url.trim_end_matches('/')))
        // Anywhere but the install folder, which the updater is about to copy over.
        .current_dir(std::env::temp_dir());
    detach(&mut command);
    command.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn spawn_windows_relauncher(_instance: &Instance) -> Result<(), String> {
    Ok(())
}

/// Linux and macOS: when this executable has been replaced on disk since the app started (an update,
/// or a reinstall), start the new one and exit. A small shell waits for this process to be gone first,
/// since the app is single-instance and the new one would otherwise hand itself to this one.
pub fn relaunch_if_replaced(app: &AppHandle) {
    if cfg!(windows) {
        return;
    }
    let Some((path, Some(started))) = EXE.get() else { return };
    let Ok(now) = std::fs::metadata(path).and_then(|m| m.modified()) else { return };
    if now == *started {
        return;
    }
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(r#"while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; exec "$2" --autostart"#)
        .arg("sh")
        .arg(std::process::id().to_string())
        .arg(path);
    detach(&mut command);
    match command.spawn() {
        Ok(_) => {
            log::info!("{} was replaced; restarting into the new build", path.display());
            app.exit(0);
        }
        Err(e) => log::error!("Could not restart into the new build: {e}"),
    }
}
