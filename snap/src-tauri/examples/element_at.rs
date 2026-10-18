//! Prints the elements under a screen point, innermost first: `cargo run --example element_at -- X Y`.
//! `--wake` first asks the window for its UI Automation tree and gives it two seconds (Chromium windows only); `--list` prints
//! the windows on screen. For trying the element snapping against a real app without the overlay.

fn main() {
    #[cfg(windows)]
    unsafe {
        use windows::core::BOOL;
        use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT};
        use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
        use windows::Win32::UI::WindowsAndMessaging::{
            EnumWindows, GetAncestor, GetWindowRect, GetWindowTextW, IsWindowVisible, WindowFromPoint, GA_ROOT,
        };
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let flags: Vec<String> = std::env::args().skip(1).filter(|a| a.starts_with("--")).collect();
        if flags.iter().any(|f| f == "--list") {
            unsafe extern "system" fn each(h: HWND, _: LPARAM) -> BOOL {
                unsafe {
                    let mut buf = [0u16; 120];
                    let n = GetWindowTextW(h, &mut buf);
                    let mut r = RECT::default();
                    if IsWindowVisible(h).as_bool() && n > 0 && GetWindowRect(h, &mut r).is_ok() {
                        println!("{:>8x} {:>6},{:>6} {:>5}x{:<5} {}", h.0 as usize, r.left, r.top, r.right - r.left, r.bottom - r.top, String::from_utf16_lossy(&buf[..n as usize]));
                    }
                }
                true.into()
            }
            let _ = EnumWindows(Some(each), LPARAM(0));
            return;
        }
        let all: Vec<String> = std::env::args().skip(1).collect();
        let args: Vec<i32> = all
            .iter()
            .enumerate()
            .filter(|(i, a)| !a.starts_with("--") && (*i == 0 || all[i - 1] != "--hwnd"))
            .filter_map(|(_, a)| a.parse().ok())
            .collect();
        let [x, y] = args[..] else {
            eprintln!("usage: element_at [--wake] [--hwnd HEX] X Y | --list");
            return;
        };
        let given = std::env::args().skip_while(|a| a != "--hwnd").nth(1).and_then(|h| isize::from_str_radix(&h, 16).ok());
        let top = match given {
            Some(h) => HWND(h as _),
            None => GetAncestor(WindowFromPoint(POINT { x, y }), GA_ROOT),
        };
        if flags.iter().any(|f| f == "--wake") {
            let t = std::time::Instant::now();
            hangar_snap_lib::elements::wake(top.0 as isize);
            println!("woke in {:?}", t.elapsed());
        }
        for round in 0..4 {
            let t = std::time::Instant::now();
            let chain = hangar_snap_lib::elements::chain_at(top.0 as isize, x, y);
            println!("after {}ms: {} elements in {:?}", round * 500, chain.len(), t.elapsed());
            for e in chain.iter().take(6) {
                println!("  {:>9} {:?}  {}", e.role, e.rect, e.name.chars().take(50).collect::<String>());
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    }
}
