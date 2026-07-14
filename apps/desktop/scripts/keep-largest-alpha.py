"""Remove isolated chroma-key leftovers from a transparent sprite."""

from collections import deque
from pathlib import Path
import sys

from PIL import Image


path = Path(sys.argv[1])
image = Image.open(path).convert("RGBA")
alpha = image.getchannel("A")
width, height = image.size
data = bytearray(1 if value > 10 else 0 for value in alpha.getdata())
seen = bytearray(width * height)
components = []
for start in range(width * height):
    if seen[start] or not data[start]:
        continue
    seen[start] = 1
    queue = deque([start])
    component = []
    while queue:
        index = queue.popleft()
        component.append(index)
        x, y = index % width, index // width
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < width and 0 <= ny < height:
                neighbour = ny * width + nx
                if data[neighbour] and not seen[neighbour]:
                    seen[neighbour] = 1
                    queue.append(neighbour)
    components.append(component)

keep = max(components, key=len) if components else []
kept = bytearray(width * height)
for index in keep:
    kept[index] = 255
new_alpha = Image.new("L", (width, height))
new_alpha.putdata(kept)
image.putalpha(new_alpha)
image.save(path)
