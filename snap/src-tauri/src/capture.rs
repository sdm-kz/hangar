//! Freezing the screen: every monitor's frame, and where the windows on them are, taken the moment a
//! hotkey fires — before any overlay of ours is on screen to get in the way. The overlays then show
//! these frames and the person picks out of them, so what they capture is exactly what was there when
//! they pressed the key: an open menu, a hover state, a tooltip.

use std::sync::{Arc, OnceLock};

use image::RgbaImage;
use serde::{Deserialize, Serialize};

use crate::geometry::{window_on_frame, Rect};
use crate::imageops;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    Region,
    Window,
    Fullscreen,
    Freeform,
}

impl Mode {
    pub const ALL: [Mode; 4] = [Mode::Region, Mode::Window, Mode::Fullscreen, Mode::Freeform];

    pub fn label(self) -> &'static str {
        match self {
            Mode::Region => "Region",
            Mode::Window => "Window",
            Mode::Fullscreen => "Full screen",
            Mode::Freeform => "Freeform",
        }
    }

    pub fn parse(s: &str) -> Option<Mode> {
        match s.to_ascii_lowercase().as_str() {
            "region" | "rect" | "rectangle" => Some(Mode::Region),
            "window" => Some(Mode::Window),
            "fullscreen" | "full" | "screen" => Some(Mode::Fullscreen),
            "freeform" | "free" | "lasso" => Some(Mode::Freeform),
            _ => None,
        }
    }
}

pub struct Frame {
    /// The monitor, in the OS units xcap reports it in (see `geometry`).
    pub monitor: Rect,
    pub scale: f32,
    pub primary: bool,
    pub image: Arc<RgbaImage>,
    png: OnceLock<Vec<u8>>,
}

impl Frame {
    pub fn new(monitor: Rect, scale: f32, primary: bool, image: RgbaImage) -> Self {
        Self { monitor, scale, primary, image: Arc::new(image), png: OnceLock::new() }
    }

    /// The frame as PNG, encoded once.
    pub fn png(&self) -> &[u8] {
        self.png.get_or_init(|| imageops::encode_png_fast(&self.image))
    }
}

/// A window the overlay can snap to, already placed on one frame.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBox {
    pub title: String,
    pub app: String,
    /// In that frame's pixels, clipped to it.
    pub rect: Rect,
}

pub struct Snapshot {
    pub mode: Mode,
    pub frames: Vec<Frame>,
    /// For each frame, the windows on it, topmost first.
    pub windows: Vec<Vec<WindowBox>>,
}

/// A window as the OS listed it, before it is placed on any frame.
#[derive(Debug, Clone)]
pub struct RawWindow {
    pub title: String,
    pub app: String,
    pub rect: Rect,
    pub minimized: bool,
    pub pid: u32,
}

/// Smaller than this on either side isn't a window anyone means to capture — status-bar items, the
/// slivers a few apps keep on screen.
const MIN_WINDOW_SIDE: u32 = 24;

/// Place the OS's window list (topmost first) on each frame: windows of ours dropped, and the
/// minimized and slivers too.
pub fn windows_per_frame(frames: &[Frame], windows: &[RawWindow], own_pid: u32) -> Vec<Vec<WindowBox>> {
    frames
        .iter()
        .map(|f| {
            windows
                .iter()
                .filter(|w| !w.minimized && w.pid != own_pid)
                .filter(|w| w.rect.width >= MIN_WINDOW_SIDE && w.rect.height >= MIN_WINDOW_SIDE)
                .filter_map(|w| {
                    let rect = window_on_frame(&w.rect, &f.monitor, f.image.width(), f.image.height())?;
                    Some(WindowBox { title: w.title.clone(), app: w.app.clone(), rect })
                })
                .collect()
        })
        .collect()
}

/// Capture every monitor, and list the windows unless the mode can't use them.
pub fn take(mode: Mode) -> Result<Snapshot, String> {
    let monitors = xcap::Monitor::all().map_err(|e| format!("Could not list the screens: {e}"))?;
    let mut frames = Vec::with_capacity(monitors.len());
    for m in &monitors {
        let rect = monitor_rect(
            Rect::new(m.x().unwrap_or(0), m.y().unwrap_or(0), m.width().unwrap_or(0), m.height().unwrap_or(0)),
            m.scale_factor().unwrap_or(1.0),
        );
        match capture_monitor(m, rect) {
            Ok(image) => frames.push(Frame::new(
                rect,
                m.scale_factor().unwrap_or(1.0),
                m.is_primary().unwrap_or(false),
                image,
            )),
            Err(e) => log::warn!("Could not capture screen at {rect:?}: {e}"),
        }
    }
    if frames.is_empty() {
        return Err(capture_failure_hint());
    }

    let windows = if matches!(mode, Mode::Region | Mode::Window) && !is_wayland() {
        let raw = list_windows();
        windows_per_frame(&frames, &raw, std::process::id())
    } else {
        frames.iter().map(|_| Vec::new()).collect()
    };
    Ok(Snapshot { mode, frames, windows })
}

fn list_windows() -> Vec<RawWindow> {
    match xcap::Window::all() {
        Ok(all) => all
            .iter()
            .filter_map(|w| {
                Some(RawWindow {
                    title: w.title().unwrap_or_default(),
                    app: w.app_name().unwrap_or_default(),
                    rect: Rect::new(w.x().ok()?, w.y().ok()?, w.width().ok()?, w.height().ok()?),
                    // macOS lists on-screen windows only, so none is minimized — and every xcap
                    // accessor there re-reads the whole window list, which adds up before the overlay.
                    minimized: !cfg!(target_os = "macos") && w.is_minimized().unwrap_or(false),
                    pid: w.pid().unwrap_or(0),
                })
            })
            .collect(),
        Err(e) => {
            log::info!("No window list: {e}");
            Vec::new()
        }
    }
}

fn capture_monitor(m: &xcap::Monitor, rect: Rect) -> xcap::XCapResult<RgbaImage> {
    // Debug builds only: HOMEPORT_SNAP_TEST_FRAMES stands a generated picture in for each screen, so
    // the overlays and editor can be exercised where there is no screen to capture — a disconnected
    // remote session, a CI machine.
    #[cfg(debug_assertions)]
    if std::env::var_os("HOMEPORT_SNAP_TEST_FRAMES").is_some() {
        let scale = if cfg!(target_os = "macos") { m.scale_factor().unwrap_or(1.0) } else { 1.0 };
        let (w, h) = ((rect.width as f32 * scale) as u32, (rect.height as f32 * scale) as u32);
        return Ok(RgbaImage::from_fn(w.max(1), h.max(1), |x, y| {
            let band = ((x / 160) + (y / 160)) % 2 == 0;
            image::Rgba([(x * 255 / w.max(1)) as u8, (y * 255 / h.max(1)) as u8, if band { 200 } else { 90 }, 255])
        }));
    }
    let _ = rect;
    m.capture_image()
}

/// The monitor in the units its windows are reported in (see `geometry`). On Linux xcap divides the
/// monitor's geometry by its scale factor but reports windows as X11 has them, in physical pixels; put
/// the monitor back into those.
fn monitor_rect(r: Rect, scale: f32) -> Rect {
    if cfg!(target_os = "linux") && scale > 0.0 && (scale - 1.0).abs() > f32::EPSILON {
        let s = scale as f64;
        Rect::new(
            (r.x as f64 * s).round() as i32,
            (r.y as f64 * s).round() as i32,
            (r.width as f64 * s).round() as u32,
            (r.height as f64 * s).round() as u32,
        )
    } else {
        r
    }
}

/// Under Wayland the only windows xcap can list are XWayland ones — a partial list is worse than none,
/// so region and window modes work off the frames alone there.
fn is_wayland() -> bool {
    cfg!(target_os = "linux")
        && (std::env::var("XDG_SESSION_TYPE").is_ok_and(|v| v.eq_ignore_ascii_case("wayland"))
            || std::env::var_os("WAYLAND_DISPLAY").is_some())
}

fn capture_failure_hint() -> String {
    if cfg!(target_os = "macos") {
        "Could not capture the screen. Allow Homeport Snap under System Settings → Privacy & Security → Screen Recording, then try again.".into()
    } else {
        "Could not capture the screen.".into()
    }
}

/// What the person picked on a frame.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Selection {
    /// A rectangle in frame pixels — a dragged region, or a window snapped to.
    Rect { rect: Rect },
    /// A traced outline in frame pixels.
    Freeform { points: Vec<(f64, f64)> },
    /// The whole frame.
    Full,
}

pub fn cut(frame: &Frame, selection: &Selection) -> Option<RgbaImage> {
    match selection {
        Selection::Rect { rect } => imageops::crop(&frame.image, rect),
        Selection::Freeform { points } => imageops::freeform(&frame.image, points),
        Selection::Full => Some((*frame.image).clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(monitor: Rect, w: u32, h: u32) -> Frame {
        Frame::new(monitor, 1.0, false, RgbaImage::new(w, h))
    }

    fn raw(rect: Rect, pid: u32) -> RawWindow {
        RawWindow { title: "t".into(), app: "a".into(), rect, minimized: false, pid }
    }

    #[test]
    fn windows_land_on_the_frames_they_overlap_in_z_order() {
        let frames = [frame(Rect::new(0, 0, 1920, 1080), 1920, 1080), frame(Rect::new(1920, 0, 1280, 1024), 1280, 1024)];
        let windows = [
            raw(Rect::new(100, 100, 400, 300), 10),   // top, on the first
            raw(Rect::new(1800, 0, 400, 300), 11),    // straddles both
            raw(Rect::new(2000, 50, 300, 200), 12),   // on the second only
        ];
        let placed = windows_per_frame(&frames, &windows, 1);
        assert_eq!(placed[0].iter().map(|w| w.rect).collect::<Vec<_>>(),
            vec![Rect::new(100, 100, 400, 300), Rect::new(1800, 0, 120, 300)]);
        assert_eq!(placed[1].iter().map(|w| w.rect).collect::<Vec<_>>(),
            vec![Rect::new(0, 0, 280, 300), Rect::new(80, 50, 300, 200)]);
    }

    #[test]
    fn own_minimized_and_tiny_windows_are_dropped() {
        let frames = [frame(Rect::new(0, 0, 800, 600), 800, 600)];
        let mut minimized = raw(Rect::new(0, 0, 100, 100), 10);
        minimized.minimized = true;
        let windows = [raw(Rect::new(0, 0, 100, 100), 42), minimized, raw(Rect::new(0, 0, 10, 300), 10), raw(Rect::new(5, 5, 50, 50), 10)];
        let placed = windows_per_frame(&frames, &windows, 42);
        assert_eq!(placed[0].len(), 1);
        assert_eq!(placed[0][0].rect, Rect::new(5, 5, 50, 50));
    }

    #[test]
    fn monitors_come_back_in_window_units() {
        let logical = Rect::new(1280, 0, 1280, 720);
        let expected = if cfg!(target_os = "linux") { Rect::new(1920, 0, 1920, 1080) } else { logical };
        assert_eq!(monitor_rect(logical, 1.5), expected);
        assert_eq!(monitor_rect(logical, 1.0), logical);
    }

    #[test]
    fn modes_parse_from_the_command_line() {
        assert_eq!(Mode::parse("Region"), Some(Mode::Region));
        assert_eq!(Mode::parse("fullscreen"), Some(Mode::Fullscreen));
        assert_eq!(Mode::parse("lasso"), Some(Mode::Freeform));
        assert_eq!(Mode::parse("nope"), None);
    }

    #[test]
    fn cut_full_rect_and_freeform() {
        let f = frame(Rect::new(0, 0, 40, 30), 40, 30);
        assert_eq!(cut(&f, &Selection::Full).unwrap().dimensions(), (40, 30));
        assert_eq!(cut(&f, &Selection::Rect { rect: Rect::new(5, 5, 10, 10) }).unwrap().dimensions(), (10, 10));
        let lasso = Selection::Freeform { points: vec![(0.0, 0.0), (20.0, 0.0), (0.0, 20.0)] };
        assert_eq!(cut(&f, &lasso).unwrap().dimensions(), (20, 20));
    }
}
