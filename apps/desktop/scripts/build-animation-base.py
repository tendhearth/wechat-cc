"""Bake the clean aquarium interior into the bear-free companion background."""

from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
background = Image.open(ROOT / "src/assets/moment-cc-companion-bearless.png").convert("RGBA")
empty_tank = Image.open(ROOT / "src/assets/moment-cc-companion-empty-tank.png").convert("RGBA")
empty_tank = empty_tank.resize(background.size, Image.Resampling.LANCZOS)

width, height = background.size
mask = Image.new("L", background.size, 0)
draw = ImageDraw.Draw(mask)
points = [
    (round(width * .34), round(height * .346)),
    (round(width * .902), round(height * .346)),
    (round(width * .902), round(height * .805)),
]

# Match the shallow curved bottom edge used by the canvas version.
start = (.902, .805)
control = (.67, .825)
end = (.34, .805)
for step in range(1, 19):
    t = step / 18
    inverse = 1 - t
    x = inverse * inverse * start[0] + 2 * inverse * t * control[0] + t * t * end[0]
    y = inverse * inverse * start[1] + 2 * inverse * t * control[1] + t * t * end[1]
    points.append((round(width * x), round(height * y)))
points.append((round(width * .34), round(height * .346)))
draw.polygon(points, fill=255)

background.alpha_composite(Image.composite(empty_tank, Image.new("RGBA", background.size), mask))
background.save(ROOT / "src/assets/moment-cc-companion-animation-base.png")
