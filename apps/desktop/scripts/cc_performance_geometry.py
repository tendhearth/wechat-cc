"""Transient world-space rig math. Never edits the frozen mesh or accumulates poses."""
import math


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
