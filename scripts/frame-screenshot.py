"""Puts a screenshot in a device frame for the README and docs: a macOS window around a desktop shot,
an iPhone around a phone shot. The result is a PNG on a transparent background, with a soft shadow, so
it sits on GitHub's light and dark pages alike. Needs Pillow (pip install pillow).

    python scripts/frame-screenshot.py mac    <in.png> <out.png> [--dpr 1.75] [--title Hangar] [--width 2000]
    python scripts/frame-screenshot.py iphone <in.png> <out.png> [--width 800]

mac: the shot is the window's content, taken at `--dpr` device pixels per CSS pixel; the title bar
takes the colour of the shot's top edge, as an installed web app's does.

iphone: the shot is an iPhone 15 Pro's screen less its status bar and home indicator, the area an
installed web app lays out in: 393x759 CSS px (852 less the insets of 59 and 34), at any scale. The
frame adds the status bar (9:41, signal, Wi-Fi, battery) above it and the home indicator below it,
in the colours of the shot's edges.

Light or dark comes from the shot itself (its top edge), so a light and a dark shot each get a
matching frame.
"""

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

# Drawn this many times larger, then scaled down, so curves and small glyphs come out smooth.
SS = 4

FONTS = [
    "seguisb.ttf",                      # Windows: Segoe UI Semibold
    "/System/Library/Fonts/SFNS.ttf",   # macOS: San Francisco
    "DejaVuSans-Bold.ttf",              # Linux
    "arialbd.ttf",
]


def font(size: float) -> ImageFont.FreeTypeFont:
    for name in FONTS:
        try:
            return ImageFont.truetype(name, round(size))
        except OSError:
            continue
    return ImageFont.load_default(round(size))


def is_dark(rgb) -> bool:
    r, g, b = rgb[:3]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128


def edge_colour(img: Image.Image, y: int):
    """The most common colour along row y: the bar's background, not the odd icon on it."""
    row = img.convert("RGB").crop((0, y, img.width, y + 1))
    return max(row.getcolors(img.width), key=lambda c: c[0])[1]


def rounded_mask(size, radius: float) -> Image.Image:
    """An antialiased rounded rectangle, as an alpha mask of `size`."""
    w, h = size
    big = Image.new("L", (w * SS, h * SS), 0)
    ImageDraw.Draw(big).rounded_rectangle((0, 0, w * SS - 1, h * SS - 1), radius * SS, fill=255)
    return big.resize(size, Image.LANCZOS)


def shadow(size, radius: float, box, blur: float, alpha: int, dy: float) -> Image.Image:
    """A blurred dark rounded rectangle under `box` (left, top, right, bottom), on a canvas of `size`."""
    layer = Image.new("L", size, 0)
    l, t, r, b = box
    ImageDraw.Draw(layer).rounded_rectangle((l, t + dy, r, b + dy), radius, fill=alpha)
    layer = layer.filter(ImageFilter.GaussianBlur(blur))
    out = Image.new("RGBA", size, (0, 0, 0, 0))
    out.putalpha(layer)
    return out


def with_shadows(body: Image.Image, pt: float, radius: float, margin, shadows) -> Image.Image:
    """`body` (corner `radius` pt) on a transparent canvas with room around it, and its shadows (blur,
    alpha, dy in pt)."""
    ml, mt, mr, mb = (round(m * pt) for m in margin)
    size = (body.width + ml + mr, body.height + mt + mb)
    canvas = Image.new("RGBA", size, (0, 0, 0, 0))
    box = (ml, mt, ml + body.width, mt + body.height)
    for blur, alpha, dy in shadows:
        canvas = Image.alpha_composite(canvas, shadow(size, radius * pt, box, blur * pt, alpha, dy * pt))
    canvas.alpha_composite(body, (ml, mt))
    return canvas


def finish(img: Image.Image, width: int | None, out: Path):
    if width and img.width != width:
        img = img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)
    img.save(out, optimize=True)
    print(f"{out}: {img.width}x{img.height}, {out.stat().st_size // 1024} KB")


def mac(shot: Image.Image, dpr: float, title: str) -> Image.Image:
    """A macOS window: title bar with the traffic lights and a centred title, rounded corners, a hairline."""
    pt = dpr
    bar_h = round(28 * pt)
    bg = edge_colour(shot, 0)
    dark = is_dark(bg)
    w, h = shot.width, shot.height + bar_h

    big = Image.new("RGBA", (w * SS, h * SS), bg + (255,))
    d = ImageDraw.Draw(big)
    # The bar's lower edge, the same hairline the app's own header has.
    line = (255, 255, 255, 28) if dark else (0, 0, 0, 30)
    d.rectangle((0, bar_h * SS - SS, w * SS, bar_h * SS), fill=line)
    cy = bar_h * SS / 2
    for i, (fill, rim) in enumerate([((255, 95, 87), (224, 68, 62)),
                                     ((254, 188, 46), (222, 161, 35)),
                                     ((40, 200, 64), (26, 171, 41))]):
        cx = (20 + 20 * i) * pt * SS
        r = 6 * pt * SS
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=fill, outline=rim, width=round(0.5 * pt * SS))
    if title:
        f = font(13 * pt * SS)
        d.text((w * SS / 2, cy), title, font=f, anchor="mm",
               fill=(223, 223, 223) if dark else (77, 77, 77))
    window = big.resize((w, h), Image.LANCZOS)
    window.paste(shot.convert("RGBA"), (0, bar_h))

    radius = 10 * pt
    window.putalpha(rounded_mask(window.size, radius))
    # The edge macOS draws around a window: dark outside, and a faint light rim inside on a dark one.
    rim = Image.new("RGBA", (w * SS, h * SS), (0, 0, 0, 0))
    rd = ImageDraw.Draw(rim)
    rd.rounded_rectangle((0, 0, w * SS - 1, h * SS - 1), radius * SS,
                         outline=(0, 0, 0, 110 if dark else 60), width=round(1 * pt * SS))
    if dark:
        inset = round(1 * pt * SS)
        rd.rounded_rectangle((inset, inset, w * SS - 1 - inset, h * SS - 1 - inset), radius * SS - inset,
                             outline=(255, 255, 255, 40), width=round(0.75 * pt * SS))
    window.alpha_composite(rim.resize((w, h), Image.LANCZOS))

    return with_shadows(window, pt, 10, margin=(56, 40, 56, 80),
                        shadows=[(30, 120 if dark else 95, 18), (2, 70 if dark else 40, 1)])


# iPhone 15 Pro, in points.
SCREEN_W, SCREEN_H = 393, 852
INSET_TOP, INSET_BOTTOM = 59, 34
SCREEN_RADIUS = 55
BEZEL = 13        # black glass border around the screen
FRAME = 3.5       # the titanium band around that


def status_bar(d: ImageDraw.ImageDraw, k: float, ink):
    """9:41, then signal, Wi-Fi and battery, drawn at k device pixels per point."""
    cy = 31 * k
    d.text((61 * k, cy), "9:41", font=font(17 * k), anchor="mm", fill=ink)

    # Signal: four bars, rising.
    x = 300 * k
    for i, bh in enumerate((4, 6.3, 8.6, 11)):
        l = x + i * 4.5 * k
        d.rounded_rectangle((l, cy + 5.5 * k - bh * k, l + 3 * k, cy + 5.5 * k), 0.9 * k, fill=ink)

    # Wi-Fi: a wedge and two arcs, from one point under them.
    ox, oy = 331.5 * k, cy + 5.8 * k
    for r, wdt in ((3.4, None), (7.4, 2.3), (11.4, 2.3)):
        box = (ox - r * k, oy - r * k, ox + r * k, oy + r * k)
        if wdt is None:
            d.pieslice(box, 225, 315, fill=ink)
        else:
            d.arc(box, 225, 315, fill=ink, width=round(wdt * k))

    # Battery: an outline, the charge inside it, and the cap.
    l, t = 348 * k, cy - 6.25 * k
    faint = ink[:3] + (100,)
    d.rounded_rectangle((l, t, l + 25 * k, t + 12.5 * k), 4 * k, outline=faint, width=round(1 * k))
    d.rounded_rectangle((l + 2 * k, t + 2 * k, l + 23 * k, t + 10.5 * k), 2.5 * k, fill=ink)
    d.rounded_rectangle((l + 26.2 * k, t + 4.2 * k, l + 27.7 * k, t + 8.3 * k), 0.8 * k, fill=faint)


def iphone(shot: Image.Image) -> Image.Image:
    """An iPhone 15 Pro around a web app's area: status bar, Dynamic Island, home indicator, bezel."""
    pt = shot.width / SCREEN_W
    expect = round((SCREEN_H - INSET_TOP - INSET_BOTTOM) * pt)
    if abs(shot.height - expect) > 2:
        raise SystemExit(f"expected a {SCREEN_W}x{SCREEN_H - INSET_TOP - INSET_BOTTOM} pt shot "
                         f"({shot.width}x{expect} px at this width), got {shot.width}x{shot.height}")

    top, bottom = edge_colour(shot, 0), edge_colour(shot, shot.height - 1)
    dark = is_dark(top)
    ink = (255, 255, 255, 255) if dark else (0, 0, 0, 255)

    # The screen: status bar, the shot, home indicator.
    sw, sh = round(SCREEN_W * pt), round(SCREEN_H * pt)
    k = pt * SS
    big = Image.new("RGBA", (sw * SS, sh * SS), top + (255,))
    d = ImageDraw.Draw(big)
    d.rectangle((0, (SCREEN_H - INSET_BOTTOM) * k, sw * SS, sh * SS), fill=bottom + (255,))
    status_bar(d, k, ink)
    # Dynamic Island.
    d.rounded_rectangle(((SCREEN_W - 126) / 2 * k, 11 * k, (SCREEN_W + 126) / 2 * k, 48.3 * k),
                        18.7 * k, fill=(0, 0, 0, 255))
    # Home indicator.
    hb = (255, 255, 255, 255) if is_dark(bottom) else (0, 0, 0, 255)
    d.rounded_rectangle(((SCREEN_W - 134) / 2 * k, (SCREEN_H - 13) * k,
                         (SCREEN_W + 134) / 2 * k, (SCREEN_H - 8) * k), 2.5 * k, fill=hb)
    screen = big.resize((sw, sh), Image.LANCZOS)
    screen.paste(shot.convert("RGBA"), (0, round(INSET_TOP * pt)))
    screen.putalpha(rounded_mask(screen.size, SCREEN_RADIUS * pt))

    # The body: titanium band, black bezel, then the screen; buttons stand out of the band's sides.
    edge = BEZEL + FRAME
    btn = 2.2
    bw, bh = round((SCREEN_W + 2 * edge + 2 * btn) * pt), round((SCREEN_H + 2 * edge) * pt)
    big = Image.new("RGBA", (bw * SS, bh * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    titanium = (78, 78, 82, 255) if dark else (160, 160, 166, 255)
    shade = (56, 56, 60, 255) if dark else (128, 128, 134, 255)
    left, right = btn * k, (SCREEN_W + 2 * edge + btn) * k
    # Action button and the volume pair on the left, the side button on the right.
    for (y0, y1) in ((120, 152), (178, 238), (256, 316)):
        d.rounded_rectangle((0, y0 * k, left + 2 * k, y1 * k), 1.2 * k, fill=shade)
    d.rounded_rectangle((right - 2 * k, 210 * k, bw * SS, 312 * k), 1.2 * k, fill=shade)
    body_r = (SCREEN_RADIUS + edge) * k
    d.rounded_rectangle((left, 0, right, bh * SS - 1), body_r, fill=titanium)
    d.rounded_rectangle((left + 0.8 * k, 0.8 * k, right - 0.8 * k, bh * SS - 1 - 0.8 * k),
                        body_r - 0.8 * k, outline=(255, 255, 255, 60), width=round(0.6 * k))
    d.rounded_rectangle((left + FRAME * k, FRAME * k, right - FRAME * k, bh * SS - FRAME * k),
                        (SCREEN_RADIUS + BEZEL) * k, fill=(8, 8, 10, 255))
    body = big.resize((bw, bh), Image.LANCZOS)
    body.alpha_composite(screen, (round((btn + edge) * pt), round(edge * pt)))

    return with_shadows(body, pt, SCREEN_RADIUS + BEZEL + FRAME, margin=(36, 28, 36, 56),
                        shadows=[(24, 110 if dark else 90, 14), (2, 60, 1)])


def main():
    ap = argparse.ArgumentParser(description="Frame a screenshot as a macOS window or an iPhone.")
    ap.add_argument("device", choices=["mac", "iphone"])
    ap.add_argument("input", type=Path)
    ap.add_argument("output", type=Path)
    ap.add_argument("--dpr", type=float, default=2.0, help="mac: device pixels per CSS pixel of the shot")
    ap.add_argument("--title", default="Hangar", help="mac: the window's title ('' for none)")
    ap.add_argument("--width", type=int, help="scale the framed result to this width in pixels")
    a = ap.parse_args()

    shot = Image.open(a.input).convert("RGB")
    framed = mac(shot, a.dpr, a.title) if a.device == "mac" else iphone(shot)
    finish(framed, a.width, a.output)


if __name__ == "__main__":
    main()
