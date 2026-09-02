#!/usr/bin/env python3
"""Renders the extension icons without any image library.

Draws a rounded blue->cyan tile with a bold check mark and a small row of
"code boxes", supersampled 4x and box-filtered down to each required size.
"""
import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "extension" / "assets" / "icons"
SIZES = [16, 32, 48, 128]
SS = 4  # supersampling factor


def rounded_box_sdf(px, py, cx, cy, hw, hh, r):
    """Signed distance to a rounded rectangle (negative = inside)."""
    qx = abs(px - cx) - (hw - r)
    qy = abs(py - cy) - (hh - r)
    return math.hypot(max(qx, 0.0), max(qy, 0.0)) + min(max(qx, qy), 0.0) - r


def seg_distance(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    denom = vx * vx + vy * vy
    t = 0.0 if denom == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / denom))
    return math.hypot(px - (ax + t * vx), py - (ay + t * vy))


def render(size):
    n = size * SS
    buf = bytearray(n * n * 4)

    tile_r = n * 0.24
    # check mark geometry, in unit coordinates
    check = [(0.30, 0.53), (0.44, 0.67), (0.72, 0.35)]
    check_w = n * 0.085

    boxes = [(0.26, 0.80), (0.42, 0.80), (0.58, 0.80), (0.74, 0.80)]
    box_w, box_h, box_r = n * 0.055, n * 0.045, n * 0.018

    for y in range(n):
        for x in range(n):
            px, py = x + 0.5, y + 0.5
            idx = (y * n + x) * 4

            d_tile = rounded_box_sdf(px, py, n / 2, n / 2, n / 2, n / 2, tile_r)
            if d_tile > 0.9:
                continue
            tile_a = min(1.0, max(0.0, 0.5 - d_tile))

            # diagonal gradient #1d4ed8 -> #06b6d4
            t = (px / n * 0.65) + (py / n * 0.35)
            r = int(0x1D + (0x06 - 0x1D) * t)
            g = int(0x4E + (0xB6 - 0x4E) * t)
            b = int(0xD8 + (0xD4 - 0xD8) * t)

            # check mark
            d_check = min(
                seg_distance(px, py, check[0][0] * n, check[0][1] * n, check[1][0] * n, check[1][1] * n),
                seg_distance(px, py, check[1][0] * n, check[1][1] * n, check[2][0] * n, check[2][1] * n),
            ) - check_w
            ink = min(1.0, max(0.0, 0.5 - d_check))

            for bx, by in boxes:
                d_box = rounded_box_sdf(px, py, bx * n, by * n, box_w, box_h, box_r)
                ink = max(ink, min(1.0, max(0.0, 0.5 - d_box)) * 0.92)

            r = int(r + (255 - r) * ink)
            g = int(g + (255 - g) * ink)
            b = int(b + (255 - b) * ink)

            buf[idx] = r
            buf[idx + 1] = g
            buf[idx + 2] = b
            buf[idx + 3] = int(255 * tile_a)

    # box-filter down to the target size
    out = bytearray(size * size * 4)
    for y in range(size):
        for x in range(size):
            acc = [0, 0, 0, 0]
            for dy in range(SS):
                for dx in range(SS):
                    i = ((y * SS + dy) * n + (x * SS + dx)) * 4
                    a = buf[i + 3]
                    acc[0] += buf[i] * a
                    acc[1] += buf[i + 1] * a
                    acc[2] += buf[i + 2] * a
                    acc[3] += a
            o = (y * size + x) * 4
            if acc[3]:
                out[o] = min(255, acc[0] // acc[3])
                out[o + 1] = min(255, acc[1] // acc[3])
                out[o + 2] = min(255, acc[2] // acc[3])
            out[o + 3] = acc[3] // (SS * SS)
    return bytes(out)


def write_png(path, size, rgba):
    raw = b"".join(b"\x00" + rgba[y * size * 4:(y + 1) * size * 4] for y in range(size))

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    path.write_bytes(png)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        path = OUT / f"icon-{size}.png"
        write_png(path, size, render(size))
        print(f"  {path.name}  {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
