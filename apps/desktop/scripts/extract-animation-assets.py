"""Extract animation-ready fish cutouts from the flattened companion artwork.

The source illustration has a transparent outer canvas but the aquarium
contents are flattened.  Tight crops plus border-colour matting preserve the
original painted pixels without redrawing the characters.
"""

from collections import deque
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src/assets/moment-cc-companion.png"
PLANT_SOURCE = ROOT / "src/assets/moment-cc-companion-lab.png"
OUTPUT = ROOT / "src/assets/animation"

# Pixel boxes measured from the 988 x 660 source artwork.
FISH = {
    "fish-yellow-left": (392, 270, 470, 329),
    "fish-yellow-right": (572, 286, 646, 344),
    "fish-blue": (476, 329, 558, 389),
    "fish-orange": (641, 339, 721, 400),
    "fish-pink": (558, 377, 642, 436),
}

# Hand-tuned silhouettes for the two puppet layers.  The points follow the
# painted contours and intentionally overlap the torso slightly so movement
# never opens a visible seam.
PUPPET_PARTS = {
    "bear-head": {
        "box": (92, 244, 365, 452),
        "polygon": [
            (45, 82), (53, 61), (70, 49), (99, 23), (132, 17),
            (157, 13), (188, 29), (219, 54), (239, 91), (246, 124),
            (237, 153), (218, 178), (187, 198), (144, 204), (102, 196),
            (70, 178), (51, 151), (42, 119),
        ],
    },
    "bear-arm": {
        "box": (280, 337, 407, 463),
        "polygon": [
            (0, 58), (20, 44), (39, 42), (54, 28), (63, 17),
            (76, 16), (95, 0), (111, 8), (124, 24), (122, 42),
            (106, 56), (88, 63), (77, 74), (70, 99), (54, 114),
            (34, 108), (15, 92), (0, 85),
        ],
    },
}

# Separate clusters from the AI-cleaned fishless plate (1529 x 1028).  Their
# runtime positions are stored beside the sprite list in animation-lab.js.
PLANTS = {
    # Each crop is one independently animated aquarium plant group.  The
    # source is the cleaned fishless plate; the mask below removes water and
    # sand so the sprites can sway without carrying a rectangular backdrop.
    "plant-left": {
        "box": (575, 500, 710, 820),
        "polygon": [(35, 0), (88, 0), (108, 40), (125, 80), (116, 120), (125, 170), (116, 220), (105, 270), (90, 305), (12, 305), (0, 270), (0, 220), (10, 170), (0, 120), (10, 75), (24, 40)],
    },
    "plant-lotus": {
        "box": (690, 620, 845, 820),
        "polygon": [(8, 0), (145, 0), (150, 50), (140, 110), (130, 150), (115, 175), (40, 175), (20, 155), (8, 120), (0, 70)],
    },
    "plant-center-small": {
        "box": (995, 625, 1120, 820),
        "polygon": [(0, 0), (102, 0), (110, 30), (104, 80), (98, 115), (80, 145), (45, 145), (15, 130), (0, 100)],
    },
    "plant-right-round": {
        "box": (1070, 445, 1245, 820),
        "polygon": [(25, 0), (145, 0), (150, 80), (140, 160), (140, 250), (130, 330), (30, 330), (10, 290), (5, 220), (10, 140), (15, 70)],
    },
    "plant-right-grass": {
        "box": (1200, 445, 1405, 820),
        "polygon": [(24, 0), (188, 0), (190, 80), (200, 150), (185, 250), (185, 350), (30, 350), (15, 300), (10, 220), (10, 130)],
    },
}

FULL_BEAR_BOX = (80, 240, 420, 600)


def colour_distance(a, b):
    return sum((int(a[i]) - int(b[i])) ** 2 for i in range(3)) ** 0.5


def connected_components(mask, width, height):
    seen = bytearray(width * height)
    components = []
    for start in range(width * height):
        if seen[start] or not mask[start]:
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
                    if not seen[neighbour] and mask[neighbour]:
                        seen[neighbour] = 1
                        queue.append(neighbour)
        components.append(component)
    return components


def fill_holes(mask, width, height):
    outside = bytearray(width * height)
    queue = deque()
    for x in range(width):
        for y in (0, height - 1):
            index = y * width + x
            if not mask[index] and not outside[index]:
                outside[index] = 1
                queue.append(index)
    for y in range(height):
        for x in (0, width - 1):
            index = y * width + x
            if not mask[index] and not outside[index]:
                outside[index] = 1
                queue.append(index)
    while queue:
        index = queue.popleft()
        x, y = index % width, index // width
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < width and 0 <= ny < height:
                neighbour = ny * width + nx
                if not mask[neighbour] and not outside[neighbour]:
                    outside[neighbour] = 1
                    queue.append(neighbour)
    for index in range(width * height):
        if not outside[index]:
            mask[index] = 1


def extract_fish(source, box, destination):
    crop = source.crop(box).convert("RGBA")
    width, height = crop.size
    pixels = list(crop.getdata())
    border = []
    for x in range(width):
        border.extend((pixels[x][:3], pixels[(height - 1) * width + x][:3]))
    for y in range(height):
        border.extend((pixels[y * width][:3], pixels[y * width + width - 1][:3]))
    # Reduce the border palette while retaining the watercolour variation.
    samples = border[:: max(1, len(border) // 48)]
    foreground = bytearray(width * height)
    for index, pixel in enumerate(pixels):
        rgb = pixel[:3]
        distance = min(colour_distance(rgb, sample) for sample in samples)
        saturation = max(rgb) - min(rgb)
        brightness = sum(rgb) / 3
        if distance > 30 or saturation > 54 or brightness < 142:
            foreground[index] = 1

    components = connected_components(foreground, width, height)
    centre = (height // 2) * width + width // 2
    candidates = [part for part in components if centre in part]
    component = candidates[0] if candidates else max(components, key=len)
    mask = bytearray(width * height)
    for index in component:
        mask[index] = 1
    fill_holes(mask, width, height)

    alpha = Image.new("L", (width, height))
    alpha.putdata([255 if value else 0 for value in mask])
    alpha = alpha.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(.65))
    crop.putalpha(alpha)
    visible = alpha.getbbox()
    if visible:
        padding = 3
        left = max(0, visible[0] - padding)
        top = max(0, visible[1] - padding)
        right = min(width, visible[2] + padding)
        bottom = min(height, visible[3] + padding)
        crop = crop.crop((left, top, right, bottom))
    crop.save(destination)


def extract_polygon(source, specification, destination, name):
    box = specification["box"]
    crop = source.crop(box).convert("RGBA")
    width, height = crop.size
    polygon_mask = Image.new("L", crop.size, 0)
    draw = ImageDraw.Draw(polygon_mask)
    draw.polygon(specification["polygon"], fill=255)
    polygon_data = list(polygon_mask.getdata())
    pixels = list(crop.getdata())
    candidates = bytearray(width * height)
    for index, (red, green, blue, _) in enumerate(pixels):
        if not polygon_data[index]:
            continue
        bear_fur = red > 188 and green > 160 and blue > 126 and red + 4 >= green
        blush = red > 188 and 112 < green < 202 and 100 < blue < 190
        held_fish = name == "bear-arm" and red > 174 and green > 112 and blue < 152
        if bear_fur or blush or held_fish:
            candidates[index] = 1

    components = sorted(connected_components(candidates, width, height), key=len, reverse=True)
    kept = bytearray(width * height)
    # Head is one continuous fur field; arm and held fish may be two fields.
    keep_count = 2 if name == "bear-arm" else 1
    for component in components[:keep_count]:
        if len(component) < 20:
            continue
        for index in component:
            kept[index] = 1
    mask = Image.new("L", crop.size)
    mask.putdata([255 if value else 0 for value in kept])
    # Expand over the painted brown contour, then fill facial/texture islands.
    mask = mask.filter(ImageFilter.MaxFilter(7))
    binary = bytearray(1 if value > 20 else 0 for value in mask.getdata())
    fill_holes(binary, width, height)
    mask.putdata([255 if value else 0 for value in binary])
    mask = Image.composite(mask, Image.new("L", crop.size, 0), polygon_mask)
    mask = mask.filter(ImageFilter.GaussianBlur(.65))
    original_alpha = crop.getchannel("A")
    mask = Image.composite(mask, Image.new("L", crop.size, 0), original_alpha)
    crop.putalpha(mask)
    crop.save(destination)


def extract_plant(source, box, polygon, destination, name):
    crop = source.crop(box).convert("RGBA")
    width, height = crop.size
    pixels = list(crop.getdata())
    seed = Image.new("L", crop.size, 0)
    seed_data = []
    for red, green, blue, _ in pixels:
        olive = (
            72 < green < 210 and blue < 152 and red < 216
            and max(red, green, blue) - min(red, green, blue) > 42
            and green > blue * 1.15 and green >= red * .88
        )
        orange = name == "plant-lotus" and red > 164 and 72 < green < 188 and blue < 132 and red > green * 1.08
        seed_data.append(255 if olive or orange else 0)
    seed.putdata(seed_data)
    if polygon:
        polygon_mask = Image.new("L", crop.size, 0)
        ImageDraw.Draw(polygon_mask).polygon(polygon, fill=255)
        seed = ImageChops.multiply(seed, polygon_mask)
    # Pull in the hand-painted outline and anti-aliased edge around the colour
    # core, without filling the open water between individual leaves.
    expanded = seed.filter(ImageFilter.MaxFilter(5))
    expanded_data = list(expanded.getdata())
    alpha = []
    for index, (red, green, blue, _) in enumerate(pixels):
        # Only expand into dark, saturated painted contour pixels. Pale water
        # and sand are deliberately excluded so the moving sprite has no
        # rectangular backdrop.
        saturation = max(red, green, blue) - min(red, green, blue)
        outline = expanded_data[index] and saturation > 28 and (red + green + blue) / 3 < 165
        alpha.append(255 if seed_data[index] or outline else 0)
    mask = Image.new("L", crop.size)
    mask.putdata(alpha)
    # Keep only sizeable connected painted regions.  Tiny isolated grains in
    # the sand and water sparkle are not part of a plant and would otherwise
    # make the crop look like an opaque rectangle.
    binary = bytearray(1 if value > 18 else 0 for value in mask.getdata())
    components = connected_components(binary, width, height)
    kept = bytearray(width * height)
    for component in components:
        if len(component) < 24:
            continue
        xs = [index % width for index in component]
        ys = [index // width for index in component]
        component_width = max(xs) - min(xs) + 1
        component_height = max(ys) - min(ys) + 1
        # Ignore the aquarium's straight glass edge, which can otherwise be
        # mistaken for a tall blade of grass in the right-hand crop.
        if component_width < 10 and component_height > 70:
            continue
        # The left crop touches the bear's held fish. Keep only the plant
        # material that reaches the lower root area.
        if name == "plant-left" and max(ys) < height * .62:
            continue
        for index in component:
            kept[index] = 1
    fill_holes(kept, width, height)
    mask.putdata([255 if value else 0 for value in kept])
    mask = mask.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(.7))
    crop.putalpha(mask)
    visible = mask.getbbox()
    if visible:
        padding = 5
        left = max(0, visible[0] - padding)
        top = max(0, visible[1] - padding)
        right = min(width, visible[2] + padding)
        bottom = min(height, visible[3] + padding)
        crop = crop.crop((left, top, right, bottom))
    crop.save(destination)


def extract_complete_bear(source, destination):
    crop = source.crop(FULL_BEAR_BOX).convert("RGBA")
    width, height = crop.size
    pixels = list(crop.getdata())

    fur_candidates = bytearray(width * height)
    fish_candidates = bytearray(width * height)
    for index, (red, green, blue, _) in enumerate(pixels):
        fur = red > 184 and green > 154 and blue > 118 and red + 5 >= green
        blush = red > 184 and 108 < green < 205 and 92 < blue < 194
        held_fish = red > 170 and 105 < green < 202 and blue < 150 and red > green * 1.04
        if fur or blush:
            fur_candidates[index] = 1
        if held_fish:
            fish_candidates[index] = 1

    fur_components = sorted(connected_components(fur_candidates, width, height), key=len, reverse=True)
    fish_components = sorted(connected_components(fish_candidates, width, height), key=len, reverse=True)
    mask_data = bytearray(width * height)
    if fur_components:
        for index in fur_components[0]:
            mask_data[index] = 1
    # The held fish has several painted colour islands; retain sizeable ones in
    # its upper-right hand area while excluding ground and flower fragments.
    for component in fish_components:
        if len(component) < 18:
            continue
        centre_x = sum(index % width for index in component) / len(component)
        centre_y = sum(index // width for index in component) / len(component)
        if centre_x > 205 and centre_y < 185:
            for index in component:
                mask_data[index] = 1

    mask = Image.new("L", crop.size)
    mask.putdata([255 if value else 0 for value in mask_data])
    mask = mask.filter(ImageFilter.MaxFilter(9))
    binary = bytearray(1 if value > 16 else 0 for value in mask.getdata())
    # Filling holes restores the eyes, mouth and internal watercolour texture.
    fill_holes(binary, width, height)
    mask.putdata([255 if value else 0 for value in binary])
    mask = mask.filter(ImageFilter.GaussianBlur(.7))
    mask = ImageChops.multiply(mask, crop.getchannel("A"))
    crop.putalpha(mask)
    crop.save(destination)
    return crop


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    source = Image.open(SOURCE)
    for name, box in FISH.items():
        extract_fish(source, box, OUTPUT / f"{name}.png")
    for name, specification in PUPPET_PARTS.items():
        extract_polygon(source, specification, OUTPUT / f"{name}.png", name)
    complete_bear = extract_complete_bear(source, OUTPUT / "bear-complete.png")
    body_alpha = complete_bear.getchannel("A")
    for name, specification in PUPPET_PARTS.items():
        part = Image.open(OUTPUT / f"{name}.png")
        offset = (
            specification["box"][0] - FULL_BEAR_BOX[0],
            specification["box"][1] - FULL_BEAR_BOX[1],
        )
        subtraction = Image.new("L", complete_bear.size, 0)
        subtraction.paste(part.getchannel("A").filter(ImageFilter.MaxFilter(5)), offset)
        body_alpha = ImageChops.subtract(body_alpha, subtraction)
    bear_body = complete_bear.copy()
    bear_body.putalpha(body_alpha)
    bear_body.save(OUTPUT / "bear-body.png")
    plant_source = Image.open(PLANT_SOURCE)
    for name, specification in PLANTS.items():
        extract_plant(
            plant_source,
            specification["box"],
            specification.get("polygon"),
            OUTPUT / f"{name}.png",
            name,
        )


if __name__ == "__main__":
    main()
