"""Draws the tray and window icons in this folder: python generate.py (needs Pillow).

Each size is drawn on its own grid rather than shrunk from one big picture: a tray icon is 16-48 pixels,
and a downscaled one turns its strokes to grey mush. The app picks the size matching the display's
scaling (16 px at 100%, 28 px at 175%...).

- glyph-light-N.png / glyph-dark-N.png (Windows): viewfinder corners in the taskbar's own ink, dark on
  a light taskbar and white on a dark one, with the coral arrow of the app icon. The way Windows 11's
  own tray icons are drawn.
  The windows (Settings, the editor) wear the same glyph on Windows, in their title bar and taskbar
  button; the 56 and 64 are for the taskbar's bigger icon at high scaling.
- tile-N.png (Linux): the same glyph on the app icon's dark tile, which holds up on light and dark
  panels alike — there is no reliable way there to ask which a panel is.
- template.png (macOS): the glyph in black on transparent; the menu bar recolours it.
"""
import math
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
S = 8  # supersampling
CORAL = (255, 107, 74, 255)
INK = (32, 36, 48, 255)
WHITE = (255, 255, 255, 255)
TILE = (40, 46, 64, 255)


def snap(v):
    return round(v / S) * S


def stroke(px):
    return max(S * 1.5, snap(max(2, round(px / 9)) * S) / 1.0)


def corners(d, size, inset, length, w, color):
    a = snap(inset)
    b = size - a
    L = snap(length)
    for (x, y, dx, dy) in [(a, a, 1, 1), (b, a, -1, 1), (a, b, 1, -1), (b, b, -1, -1)]:
        x0, x1 = sorted([x, x + dx * L])
        y0, y1 = sorted([y, y + dy * L])
        hy0 = y if dy > 0 else y - w
        d.rectangle([x0, hy0, x1 - 1, hy0 + w - 1], fill=color)
        vx0 = x if dx > 0 else x - w
        d.rectangle([vx0, y0, vx0 + w - 1, y1 - 1], fill=color)


def arrow(d, c0, tip, w, head, color):
    ux, uy = tip[0] - c0[0], tip[1] - c0[1]
    n = math.hypot(ux, uy)
    ux, uy = ux / n, uy / n
    px, py = -uy, ux
    base = (tip[0] - ux * head, tip[1] - uy * head)
    d.line([c0, (base[0] + ux * w * 0.3, base[1] + uy * w * 0.3)], fill=color, width=int(w))
    r = w / 2
    d.ellipse([c0[0] - r, c0[1] - r, c0[0] + r, c0[1] + r], fill=color)
    hw = head * 0.78
    d.polygon([tip, (base[0] + px * hw, base[1] + py * hw), (base[0] - px * hw, base[1] - py * hw)], fill=color)


def glyph(px, ink, arrow_color=CORAL, tile=None):
    size = px * S
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    w = stroke(px)
    if tile:
        pad = snap(size * 0.03)
        d.rounded_rectangle([pad, pad, size - pad - 1, size - pad - 1], radius=size * 0.24, fill=tile)
        corners(d, size, size * 0.2, size * 0.2, int(w * 0.85), ink)
        arrow(d, (size * 0.37, size * 0.63), (size * 0.66, size * 0.34), w, size * 0.2, arrow_color)
    else:
        corners(d, size, size * 0.08, size * 0.26, int(w), ink)
        arrow(d, (size * 0.3, size * 0.7), (size * 0.72, size * 0.28), w * 1.15, size * 0.26, arrow_color)
    return img.resize((px, px), Image.LANCZOS)


for px in (16, 20, 24, 28, 32, 40, 48, 56, 64):
    glyph(px, INK).save(os.path.join(HERE, f"glyph-light-{px}.png"))
    glyph(px, WHITE).save(os.path.join(HERE, f"glyph-dark-{px}.png"))
for px in (24, 32, 48):
    glyph(px, WHITE, tile=TILE).save(os.path.join(HERE, f"tile-{px}.png"))
glyph(44, (0, 0, 0, 255), arrow_color=(0, 0, 0, 255)).save(os.path.join(HERE, "template.png"))
print("ok")
