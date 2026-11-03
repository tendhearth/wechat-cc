"""Transient world-space rig math. Never edits the frozen mesh or accumulates poses."""
import math


def crest_point(point, pivot, tilt):
    """Rigid local-Y curl motion around its embedded anatomical root."""
    if (len(point) != 3 or len(pivot) != 3 or type(tilt) not in (int, float)
            or not all(math.isfinite(v) for v in [*point, *pivot, tilt])):
        raise ValueError('Crest placement must be finite')
    if abs(tilt) > .42:
        raise ValueError('Crest placement exceeds the rooted envelope')
    if tilt == 0:
        return tuple(point)
    x, y, z = (point[i] - pivot[i] for i in range(3))
    sine, cosine = math.sin(tilt), math.cos(tilt)
    return (pivot[0] + x*cosine + z*sine, pivot[1] + y,
            pivot[2] - x*sine + z*cosine)


def eye_surface_point(location, gaze, gaze_up=0):
    """Move an existing eye over the face; neutral never changes its saved point."""
    if len(location) != 3 or not all(math.isfinite(v) for v in [*location, gaze, gaze_up]):
        raise ValueError('Eye placement must be finite')
    if abs(gaze) > .07 or not -.04 <= gaze_up <= .14:
        raise ValueError('Eye placement exceeds the face envelope')
    if gaze == 0 and gaze_up == 0:
        return tuple(location)
    x, z = location[0] + gaze, location[2] + gaze_up
    inside = 1 - (x / 1.12) ** 2 - ((z - .742) / .93) ** 2
    if inside <= 0:
        raise ValueError('Eye placement leaves the face surface')
    return (x, -.94 * math.sqrt(inside) - .013, z)


def body_point(point, controls):
    x, y, z = point
    squash = controls['squash']
    width = 1 / math.sqrt(squash)
    x, y, z = x * width, y * width, (z - .15) * squash
    sine, cosine = math.sin(controls['lean']), math.cos(controls['lean'])
    return (x * cosine + z * sine + controls['shift'], y,
            -x * sine + z * cosine + .15 + controls['rise'])


def foot_point(point, pivot, controls):
    x, y, z = (point[i] - pivot[i] for i in range(3))
    sine, cosine = math.sin(controls['roll']), math.cos(controls['roll'])
    # Lift the rolling ellipsoid enough that its lowest world-space point never
    # crosses the ground. A planted foot has the exact identity transform.
    clearance = math.sqrt((.21*sine)**2 + (.15*cosine)**2) - .15*cosine
    stride = controls['stride'] / math.sqrt(109)
    return (pivot[0] + x*cosine + z*sine + 10*stride,
            pivot[1] + y - 3*stride,
            pivot[2] - x*sine + z*cosine + controls['lift'] + clearance)
