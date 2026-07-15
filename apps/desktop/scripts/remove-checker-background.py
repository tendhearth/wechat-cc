"""Convert the light checkerboard outside an AI edit into transparency."""

from collections import deque
from pathlib import Path
import sys

from PIL import Image


source = Path(sys.argv[1])
destination = Path(sys.argv[2])
image = Image.open(source).convert("RGBA")
width, height = image.size
pixels = image.load()
seen = bytearray(width * height)
queue = deque()


def is_checker(red, green, blue):
    return max(red, green, blue) - min(red, green, blue) <= 7 and (red + green + blue) / 3 >= 224


for x in range(width):
    queue.extend(((x, 0), (x, height - 1)))
for y in range(height):
    queue.extend(((0, y), (width - 1, y)))

while queue:
    x, y = queue.popleft()
    index = y * width + x
    if seen[index]:
        continue
    seen[index] = 1
    red, green, blue, alpha = pixels[x, y]
    if not is_checker(red, green, blue):
        continue
    pixels[x, y] = (red, green, blue, 0)
    for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
        if 0 <= nx < width and 0 <= ny < height and not seen[ny * width + nx]:
            queue.append((nx, ny))

image.save(destination)
