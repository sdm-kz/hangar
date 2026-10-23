//! Rectangles, and the one mapping every capture depends on: from the units the OS reports a monitor
//! and its windows in, to pixels of the frame captured from that monitor.
//!
//! A monitor and the windows on it are described in the same units, whatever those are on the platform
//! — physical pixels on Windows and Linux (see `capture::monitor_rect`), points on macOS — while the
//! frame captured from it is always in physical pixels. So the frame's size over the monitor's size is the scale between the two, and no
//! code has to know which platform it is on.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    pub const fn new(x: i32, y: i32, width: u32, height: u32) -> Self {
        Self { x, y, width, height }
    }

    pub fn right(&self) -> i64 {
        self.x as i64 + self.width as i64
    }

    pub fn bottom(&self) -> i64 {
        self.y as i64 + self.height as i64
    }

    /// The overlap of two rectangles, or None when they don't overlap.
    pub fn intersect(&self, other: &Rect) -> Option<Rect> {
        let x = self.x.max(other.x);
        let y = self.y.max(other.y);
        let right = self.right().min(other.right());
        let bottom = self.bottom().min(other.bottom());
        if right <= x as i64 || bottom <= y as i64 {
            return None;
        }
        Some(Rect::new(x, y, (right - x as i64) as u32, (bottom - y as i64) as u32))
    }

    /// This rectangle clipped to a `width` × `height` image at the origin.
    pub fn clamp_to(&self, width: u32, height: u32) -> Option<Rect> {
        self.intersect(&Rect::new(0, 0, width, height))
    }

    /// The smallest rectangle holding every point, in whole pixels — rounded outwards, so a point on
    /// a pixel's far edge still takes that pixel in.
    pub fn bounding(points: &[(f64, f64)]) -> Option<Rect> {
        let first = points.first()?;
        let (mut min_x, mut min_y, mut max_x, mut max_y) = (first.0, first.1, first.0, first.1);
        for &(x, y) in &points[1..] {
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
        }
        let (x, y) = (min_x.floor() as i32, min_y.floor() as i32);
        let (w, h) = (max_x.ceil() as i64 - x as i64, max_y.ceil() as i64 - y as i64);
        (w > 0 && h > 0).then(|| Rect::new(x, y, w as u32, h as u32))
    }
}

/// How many frame pixels one OS unit is, along each axis, for a monitor of `monitor` size whose frame
/// came back `frame_width` × `frame_height`.
pub fn frame_scale(monitor: &Rect, frame_width: u32, frame_height: u32) -> (f64, f64) {
    let sx = if monitor.width == 0 { 1.0 } else { frame_width as f64 / monitor.width as f64 };
    let sy = if monitor.height == 0 { 1.0 } else { frame_height as f64 / monitor.height as f64 };
    (sx, sy)
}

/// Where a window (in OS units) falls on the frame captured from `monitor` (in the same units), in
/// frame pixels and clipped to the frame — None when the window isn't on that monitor at all.
pub fn window_on_frame(window: &Rect, monitor: &Rect, frame_width: u32, frame_height: u32) -> Option<Rect> {
    let visible = window.intersect(monitor)?;
    let (sx, sy) = frame_scale(monitor, frame_width, frame_height);
    let x0 = ((visible.x - monitor.x) as f64 * sx).round() as i64;
    let y0 = ((visible.y - monitor.y) as f64 * sy).round() as i64;
    let x1 = ((visible.right() - monitor.x as i64) as f64 * sx).round() as i64;
    let y1 = ((visible.bottom() - monitor.y as i64) as f64 * sy).round() as i64;
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    Rect::new(x0 as i32, y0 as i32, (x1 - x0) as u32, (y1 - y0) as u32).clamp_to(frame_width, frame_height)
}

/// Whether the point (in the same units as `r`) is inside it.
pub fn contains(r: &Rect, x: f64, y: f64) -> bool {
    x >= r.x as f64 && y >= r.y as f64 && x < r.right() as f64 && y < r.bottom() as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intersect_overlapping_and_disjoint() {
        let a = Rect::new(0, 0, 100, 100);
        assert_eq!(a.intersect(&Rect::new(50, 60, 100, 100)), Some(Rect::new(50, 60, 50, 40)));
        assert_eq!(a.intersect(&Rect::new(100, 0, 10, 10)), None, "touching edges don't overlap");
        assert_eq!(a.intersect(&Rect::new(-20, -20, 30, 30)), Some(Rect::new(0, 0, 10, 10)));
    }

    #[test]
    fn bounding_rounds_outwards() {
        let r = Rect::bounding(&[(10.4, 20.6), (30.2, 5.0), (12.0, 40.01)]).unwrap();
        assert_eq!(r, Rect::new(10, 5, 21, 36));
        assert_eq!(Rect::bounding(&[]), None);
        assert_eq!(Rect::bounding(&[(3.0, 3.0)]), None, "a single point has no area");
    }

    #[test]
    fn window_on_physical_monitor_maps_one_to_one() {
        // Windows/X11: the second monitor sits right of a 1920-wide primary.
        let monitor = Rect::new(1920, 0, 2560, 1440);
        let window = Rect::new(2000, 100, 800, 600);
        assert_eq!(window_on_frame(&window, &monitor, 2560, 1440), Some(Rect::new(80, 100, 800, 600)));
    }

    #[test]
    fn window_on_retina_monitor_scales_points_to_pixels() {
        // macOS: monitor and window in points, frame in pixels at 2×.
        let monitor = Rect::new(0, 0, 1512, 982);
        let window = Rect::new(100, 50, 400, 300);
        assert_eq!(window_on_frame(&window, &monitor, 3024, 1964), Some(Rect::new(200, 100, 800, 600)));
    }

    #[test]
    fn window_hanging_off_the_monitor_is_clipped() {
        let monitor = Rect::new(0, 0, 1920, 1080);
        let window = Rect::new(1800, -50, 400, 300);
        assert_eq!(window_on_frame(&window, &monitor, 1920, 1080), Some(Rect::new(1800, 0, 120, 250)));
        assert_eq!(window_on_frame(&Rect::new(5000, 0, 10, 10), &monitor, 1920, 1080), None);
    }

    #[test]
    fn contains_is_half_open() {
        let r = Rect::new(-1440, -200, 1440, 2560);
        assert!(contains(&r, -1440.0, -200.0));
        assert!(contains(&r, -0.5, 2359.0));
        assert!(!contains(&r, 0.0, 0.0), "the right edge belongs to the next monitor");
    }
}
