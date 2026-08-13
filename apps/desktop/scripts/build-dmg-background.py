"""Generate the macOS .dmg install-window background.

Run on a Mac (uses system fonts + `tiffutil`); the output is committed so CI
never has to render it:

    python3 apps/desktop/scripts/build-dmg-background.py

Emits `src-tauri/dmg/background.tiff` — a two-representation TIFF (1x + 2x) so
Finder draws it crisply on Retina. `tauri.conf.json` points `bundle.macOS.dmg`
at it.

Geometry is load-bearing. Finder positions icons by their *centre* in the
window's content area, and `tauri.conf.json` pins the app to (180, 170) and the
Applications alias to (480, 170) at the default 128px icon size. So the two
128px boxes plus their labels occupy roughly x 116-244 and x 416-544, y 106-260
— this artwork leaves both bands empty and puts the arrow in the gap between
them. Anything below y=370 may be clipped: the window bounds Finder receives
include the title bar, so the visible content area is shorter than 400px. Keep
real content above that line.
"""

from pathlib import Path
import subprocess

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "src-tauri/dmg"

WIDTH, HEIGHT = 660, 400
SS = 4  # supersample factor — draw big, downscale for antialiasing

# Sampled straight out of src-tauri/icons/128x128@2x.png so the installer
# window and the app icon read as the same object.
BLUE = (1, 145, 232)
CYAN = (1, 195, 249)
TEAL = (3, 185, 161)
INK_TOP = (17, 21, 24)
INK_BOTTOM = (9, 12, 13)
TEXT = (230, 237, 243)
MUTED = (110, 122, 133)

# Icon centres, mirrored from tauri.conf.json's appPosition /
# applicationFolderPosition. The arrow lives in the gap between the two boxes.
ARROW_Y = 170
ARROW_X0, ARROW_X1 = 272, 396

CJK_FONT = "/System/Library/Fonts/Hiragino Sans GB.ttc"
LATIN_FONT = "/System/Library/Fonts/SFNS.ttf"


def gradient(size, top, bottom):
    """Vertical linear gradient as an RGB image."""
    width, height = size
    band = Image.new("RGB", (1, height))
    px = band.load()
    for y in range(height):
        t = y / max(height - 1, 1)
        px[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return band.resize(size, Image.Resampling.BILINEAR)


def horizontal_gradient(size, left, right):
    width, height = size
    band = Image.new("RGB", (width, 1))
    px = band.load()
    for x in range(width):
        t = x / max(width - 1, 1)
        px[x, 0] = tuple(round(left[i] + (right[i] - left[i]) * t) for i in range(3))
    return band.resize(size, Image.Resampling.BILINEAR)


def radial_glow(size, centre, radius, colour, peak_alpha):
    """Soft circular glow, drawn as concentric rings into an alpha mask."""
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    steps = 96
    for i in range(steps, 0, -1):
        t = i / steps
        r = radius * t
        # quadratic falloff reads softer than linear at these sizes
        alpha = round(peak_alpha * (1 - t) ** 2)
        draw.ellipse(
            [centre[0] - r, centre[1] - r, centre[0] + r, centre[1] + r], fill=alpha
        )
    layer = Image.new("RGB", size, colour)
    return layer, mask


def arrow_mask(size):
    """Filled arrow pointing right, as an alpha mask at supersampled scale."""
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    y = ARROW_Y * SS
    x0, x1 = ARROW_X0 * SS, ARROW_X1 * SS
    shaft = 7 * SS  # shaft thickness
    head_w = 26 * SS
    head_h = 34 * SS
    shaft_end = x1 - head_w
    draw.rounded_rectangle(
        [x0, y - shaft // 2, shaft_end, y + shaft // 2], radius=shaft // 2, fill=255
    )
    draw.polygon(
        [(shaft_end - 2 * SS, y - head_h // 2), (shaft_end - 2 * SS, y + head_h // 2), (x1, y)],
        fill=255,
    )
    return mask


def text_centred(draw, y, content, font, fill):
    left, top, right, bottom = draw.textbbox((0, 0), content, font=font)
    draw.text(
        ((WIDTH * SS - (right - left)) / 2 - left, y * SS - (bottom - top) / 2 - top),
        content,
        font=font,
        fill=fill,
    )


def build():
    big = (WIDTH * SS, HEIGHT * SS)

    canvas = gradient(big, INK_TOP, INK_BOTTOM)

    # Two overlapping glows behind where the icons sit — blue under the app,
    # teal under the Applications alias, echoing the icon's two C's.
    for centre, colour in (((180, 176), BLUE), ((480, 176), TEAL)):
        layer, mask = radial_glow(
            big, (centre[0] * SS, centre[1] * SS), 190 * SS, colour, 46
        )
        canvas = Image.composite(layer, canvas, mask)

    # Span the gradient across the arrow only — stretched over the full canvas
    # the visible slice is all mid-tone and the arrow reads as flat teal.
    arrow_span = Image.new("RGB", big, INK_BOTTOM)
    arrow_span.paste(
        horizontal_gradient(((ARROW_X1 - ARROW_X0) * SS, big[1]), CYAN, TEAL),
        (ARROW_X0 * SS, 0),
    )
    canvas.paste(arrow_span, (0, 0), arrow_mask(big))

    draw = ImageDraw.Draw(canvas)
    wordmark = ImageFont.truetype(LATIN_FONT, 23 * SS)
    hint_cjk = ImageFont.truetype(CJK_FONT, 12 * SS)
    hint_latin = ImageFont.truetype(LATIN_FONT, 11 * SS)

    text_centred(draw, 52, "wechat-cc", wordmark, TEXT)
    # The bundle is ad-hoc signed, not notarised, so every first launch hits
    # Gatekeeper. Saying so here is cheaper than a support thread.
    # Hiragino Sans GB has no U+203A, so the CJK line uses → (verified present)
    # while the Latin line keeps the tighter ›.
    text_centred(draw, 322, "首次打开：系统设置 → 隐私与安全性 → 仍要打开", hint_cjk, MUTED)
    text_centred(
        draw,
        348,
        "First launch: System Settings › Privacy & Security › Open Anyway",
        hint_latin,
        MUTED,
    )

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    at2x = canvas.resize((WIDTH * 2, HEIGHT * 2), Image.Resampling.LANCZOS)
    at1x = canvas.resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS)

    png1x = OUT_DIR / "background-1x.png"
    png2x = OUT_DIR / "background-2x.png"
    at1x.save(png1x)
    at2x.save(png2x)

    # tiffutil bakes both scales into one file; Finder picks per display.
    tiff = OUT_DIR / "background.tiff"
    subprocess.run(
        ["tiffutil", "-cathidpicheck", str(png1x), str(png2x), "-out", str(tiff)],
        check=True,
        capture_output=True,
    )
    png1x.unlink()
    png2x.unlink()
    print(f"wrote {tiff.relative_to(ROOT)} ({tiff.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    build()
