//! Cutting a capture out of a frame: a rectangle, or a freeform shape whose outside goes transparent.

use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder, RgbaImage};

use crate::geometry::Rect;

/// The part of `frame` under `rect`, clipped to the frame. None when nothing of it is on the frame.
pub fn crop(frame: &RgbaImage, rect: &Rect) -> Option<RgbaImage> {
    let r = rect.clamp_to(frame.width(), frame.height())?;
    Some(image::imageops::crop_imm(frame, r.x as u32, r.y as u32, r.width, r.height).to_image())
}

/// The freeform shape traced by `points` (frame pixels), cut out of `frame`: the shape's bounding box,
/// with everything outside the shape transparent. Edges are antialiased — four sample lines per pixel
/// row, and exact horizontal coverage along each — so a lasso doesn't come out with stair-stepped
/// sides. The shape closes itself (last point back to the first), and crossing strokes follow the
/// even-odd rule, as a lasso drawn over itself would be expected to.
pub fn freeform(frame: &RgbaImage, points: &[(f64, f64)]) -> Option<RgbaImage> {
    if points.len() < 3 {
        return None;
    }
    let bounds = Rect::bounding(points)?.clamp_to(frame.width(), frame.height())?;
    let mut out = crop(frame, &bounds)?;
    let (ox, oy) = (bounds.x as f64, bounds.y as f64);
    let local: Vec<(f64, f64)> = points.iter().map(|&(x, y)| (x - ox, y - oy)).collect();
    let width = out.width() as usize;

    const SUBROWS: usize = 4;
    let mut coverage = vec![0f32; width];
    let mut crossings: Vec<f64> = Vec::with_capacity(64);
    for row in 0..out.height() {
        coverage.iter_mut().for_each(|c| *c = 0.0);
        for sub in 0..SUBROWS {
            let sy = row as f64 + (sub as f64 + 0.5) / SUBROWS as f64;
            crossings.clear();
            for i in 0..local.len() {
                let (x0, y0) = local[i];
                let (x1, y1) = local[(i + 1) % local.len()];
                if (y0 <= sy) != (y1 <= sy) {
                    crossings.push(x0 + (sy - y0) * (x1 - x0) / (y1 - y0));
                }
            }
            crossings.sort_by(f64::total_cmp);
            for &[a, b] in crossings.as_chunks::<2>().0 {
                add_span(&mut coverage, a, b, 1.0 / SUBROWS as f32);
            }
        }
        for (x, c) in coverage.iter().enumerate() {
            let pixel = out.get_pixel_mut(x as u32, row);
            pixel.0[3] = (pixel.0[3] as f32 * c.min(1.0)).round() as u8;
        }
    }
    Some(out)
}

/// Add `weight` to every pixel of `coverage` that `[a, b)` covers, in proportion to how much of it.
fn add_span(coverage: &mut [f32], a: f64, b: f64, weight: f32) {
    let a = a.max(0.0);
    let b = b.min(coverage.len() as f64);
    if b <= a {
        return;
    }
    let (first, last) = (a.floor() as usize, (b.ceil() as usize).min(coverage.len()));
    for (px, c) in coverage.iter_mut().enumerate().take(last).skip(first) {
        let covered = (b.min(px as f64 + 1.0) - a.max(px as f64)).max(0.0);
        *c += covered as f32 * weight;
    }
}

/// PNG-encode for handing an image to a webview in-process: speed over size, since it never leaves
/// the machine — a 4K frame encodes in tens of milliseconds this way, and the overlay waits on it.
pub fn encode_png_fast(image: &RgbaImage) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(image.as_raw().len() / 4);
    PngEncoder::new_with_quality(&mut bytes, CompressionType::Fast, FilterType::Sub)
        .write_image(image.as_raw(), image.width(), image.height(), ExtendedColorType::Rgba8)
        .expect("encoding an in-memory RGBA image cannot fail");
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn gradient(w: u32, h: u32) -> RgbaImage {
        RgbaImage::from_fn(w, h, |x, y| Rgba([x as u8, y as u8, 7, 255]))
    }

    #[test]
    fn crop_takes_the_region_and_clips_to_the_frame() {
        let frame = gradient(100, 80);
        let c = crop(&frame, &Rect::new(10, 20, 30, 40)).unwrap();
        assert_eq!((c.width(), c.height()), (30, 40));
        assert_eq!(c.get_pixel(0, 0).0, [10, 20, 7, 255]);
        let clipped = crop(&frame, &Rect::new(90, 70, 50, 50)).unwrap();
        assert_eq!((clipped.width(), clipped.height()), (10, 10));
        assert!(crop(&frame, &Rect::new(200, 200, 5, 5)).is_none());
    }

    #[test]
    fn freeform_square_is_opaque_inside_and_clear_outside() {
        let frame = gradient(100, 100);
        // A diamond inside a 40×40 box at (20, 20).
        let pts = [(40.0, 20.0), (60.0, 40.0), (40.0, 60.0), (20.0, 40.0)];
        let out = freeform(&frame, &pts).unwrap();
        assert_eq!((out.width(), out.height()), (40, 40));
        assert_eq!(out.get_pixel(20, 20).0, [40, 40, 7, 255], "centre keeps its colour and alpha");
        assert_eq!(out.get_pixel(1, 1).0[3], 0, "corner of the box is outside the diamond");
        assert_eq!(out.get_pixel(38, 38).0[3], 0);
        // The edge x + y = 20 cuts pixel (9, 10) in half, corner to corner.
        let edge = out.get_pixel(9, 10).0[3];
        assert!((96..=160).contains(&edge), "edge pixel is half covered, got {edge}");
    }

    #[test]
    fn freeform_axis_aligned_rectangle_has_crisp_full_pixels() {
        let frame = gradient(50, 50);
        let out = freeform(&frame, &[(10.0, 10.0), (30.0, 10.0), (30.0, 20.0), (10.0, 20.0)]).unwrap();
        assert_eq!((out.width(), out.height()), (20, 10));
        assert!(out.pixels().all(|p| p.0[3] == 255));
    }

    #[test]
    fn freeform_needs_an_area() {
        let frame = gradient(10, 10);
        assert!(freeform(&frame, &[(1.0, 1.0), (5.0, 5.0)]).is_none());
        assert!(freeform(&frame, &[(100.0, 100.0), (120.0, 100.0), (110.0, 120.0)]).is_none(), "off the frame");
    }

    #[test]
    fn png_round_trips() {
        let frame = gradient(64, 32);
        let decoded = image::load_from_memory(&encode_png_fast(&frame)).unwrap().to_rgba8();
        assert_eq!(decoded, frame);
    }
}
