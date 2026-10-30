"""Pure eye deformation math, kept separate so topology can be tested without Blender."""
import math

def morph_eye(x, z, amount):
    # Rotate a bent capsule in its own local frame. Unlike blending opposite-
    # orientation meshes, this has Jacobian determinant width > 0 at every point.
    angle = amount * math.pi / 2
    sine, cosine = math.sin(angle), math.cos(angle)
    width = 1 - .65 * amount
    bow = .045 * (1 - (z / .136) ** 2) * amount
    across = x * width - bow
    return across * cosine + z * sine, -across * sine + z * cosine


def eye_width(scale):
    t = min(1, max(0, (scale - .12) / .18))
    ease = t * t * (3 - 2 * t)
    return 1.18 - .18 * ease
