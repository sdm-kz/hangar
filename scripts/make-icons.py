"""Builds every Hangar icon from one logo: the browser tab, the installed web app, the header and the
server's exe. Needs Pillow (pip install pillow).

    python scripts/make-icons.py [path/to/logo.png]

With a path, that picture (the logo on a transparent background) becomes the new master,
assets/hangar-logo.png; without one, the icons are rebuilt from the master already there. The
tray app (tray/) draws its own icons (tray/src-tauri/icons) and is not touched.
"""

import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
MASTER = ROOT / "assets" / "hangar-logo.png"

# The installed web app's tile. Opaque: a phone puts a transparent icon on a colour of its own choosing.
TILE = (255, 255, 255, 255)


def clean(src: Image.Image) -> Image.Image:
    """The logo cut to its own edges, with the faint specks an image generator leaves around it dropped."""
    img = src.convert("RGBA")
    alpha = img.getchannel("A").point(lambda a: 0 if a < 24 else a)
    img.putalpha(alpha)
    return img.crop(alpha.getbbox())


def fit(logo: Image.Image, size: int, share: float, background=(0, 0, 0, 0)) -> Image.Image:
    """The logo centred on a size x size square, its longer side taking `share` of it."""
    scale = size * share / max(logo.size)
    w, h = max(1, round(logo.width * scale)), max(1, round(logo.height * scale))
    canvas = Image.new("RGBA", (size, size), background)
    part = logo.resize((w, h), Image.LANCZOS)
    canvas.alpha_composite(part, ((size - w) // 2, (size - h) // 2))
    return canvas


def ico(img_for_size, path: Path, sizes=(16, 20, 24, 32, 40, 48, 64, 128, 256)) -> None:
    frames = [img_for_size(s) for s in sizes]
    path.parent.mkdir(parents=True, exist_ok=True)
    frames[-1].save(path, format="ICO", sizes=[(s, s) for s in sizes], append_images=frames[:-1])


def main() -> None:
    if len(sys.argv) > 1:
        MASTER.parent.mkdir(parents=True, exist_ok=True)
        clean(Image.open(sys.argv[1])).save(MASTER, optimize=True)
    logo = Image.open(MASTER).convert("RGBA")

    web = ROOT / "web"
    # Header, sign-in page, empty state: shown at 28-56 CSS px, so 2x of the largest.
    (web / "src" / "assets").mkdir(parents=True, exist_ok=True)
    fit(logo, 128, 1.0).save(web / "src" / "assets" / "hangar-logo.png", optimize=True)
    # Browser tab: inlined into the favicon SVG (which draws the status dot over it) and served
    # as the plain icon index.html names before the app has started.
    fit(logo, 64, 1.0).save(web / "src" / "assets" / "hangar-favicon.png", optimize=True)
    fit(logo, 64, 1.0).save(web / "public" / "icons" / "favicon.png", optimize=True)
    # Installed web app. "maskable": a launcher may cut the tile to a circle 80% across, so the logo's
    # corners stay inside it (its half-diagonal is ~0.65 of its width, hence 0.6).
    for size in (192, 512):
        fit(logo, size, 0.6, TILE).save(web / "public" / "icons" / f"icon-{size}.png", optimize=True)
    # iOS rounds the corners itself and masks nothing else.
    fit(logo, 180, 0.72, TILE).save(web / "public" / "icons" / "apple-touch-icon.png", optimize=True)
    # A notification's small badge (Android): drawn from the alpha alone, so a white silhouette.
    shape = fit(logo, 96, 0.92)
    badge = Image.new("RGBA", shape.size, (255, 255, 255, 0))
    badge.putalpha(shape.getchannel("A"))
    badge.save(web / "public" / "icons" / "badge-96.png", optimize=True)

    # The exe: as large as the square allows -- at 16 px every pixel counts.
    ico(lambda s: fit(logo, s, 0.98), ROOT / "assets" / "hangar.ico")
    print("ok")


if __name__ == "__main__":
    main()
