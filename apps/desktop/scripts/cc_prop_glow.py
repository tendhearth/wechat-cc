"""HDR prop bloom with finite support measured from the rendered surface."""
import math
import numpy as np


def glow_alpha(hdr, body, radius=28):
    if type(radius) is not int or not 1 <= radius <= 64:
        raise ValueError('Glow radius must be an integer in 1..64')
    if body.ndim != 2 or hdr.shape != (*body.shape, 3) or min(body.shape) < 25:
        raise ValueError('Glow/body dimensions do not match')
    if not np.all(np.isfinite(hdr)) or not np.all(np.isfinite(body)) or np.any(body < 0) or np.any(body > 1):
        raise ValueError('Glow inputs must be finite; coverage must be in 0..1')
    if not np.any(body > 0): raise ValueError('Rendered star coverage is empty')
    height, width = body.shape
    distance = np.where(body > 0, 0., float(radius)).astype(np.float32)
    # Eight-neighbor metric follows the actual star contours. Constant padding
    # prevents the opposite canvas edge from becoming a spurious light source.
    for _ in range(radius):
        padded = np.pad(distance, 1, constant_values=radius)
        candidates = [distance]
        for dx, dy in [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)]:
            candidates.append(padded[1+dy:1+dy+height, 1+dx:1+dx+width]+math.hypot(dx, dy))
        distance = np.minimum.reduce(candidates)
    support = np.clip(1-distance/radius, 0, 1)
    support = support*support*(3-2*support)
    yy, xx = np.indices(body.shape)
    margin = np.minimum.reduce([xx, yy, width-1-xx, height-1-yy])
    border = np.clip((margin-12)/18, 0, 1); border = border*border*(3-2*border)
    energy = np.maximum(hdr, 0).mean(axis=2)
    return np.minimum(.48, 1-np.exp(-energy*24))*support*border


def composite_glow(pixels, hdr, radius=28):
    if pixels.ndim != 3 or pixels.shape[2] != 4 or not np.all(np.isfinite(pixels)):
        raise ValueError('Rendered prop must be finite RGBA')
    body = pixels[:, :, 3]
    halo = glow_alpha(hdr, body, radius)
    alpha = body+halo*(1-body)
    result = pixels.copy()
    result[:, :, :3] = (pixels[:, :, :3]*body[:, :, None]+np.array([1, .68, .22])*((1-body)*halo)[:, :, None])/np.maximum(alpha[:, :, None], 1e-8)
    result[:, :, 3] = alpha
    result[alpha == 0] = 0
    return result
