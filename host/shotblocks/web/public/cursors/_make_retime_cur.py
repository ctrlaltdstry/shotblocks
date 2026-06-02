"""Generate retime.cur — the Alt-edge-drag retime cursor.

Source artwork: ../../../../Cursors/Retime tool.png (Mike's design — a
horizontal double-chevron stretch glyph flanking a small clock, reading
as "stretch time"). White fill + dark outline so it reads on the dark
timeline. Already authored in the right palette, so we pack it verbatim
(no recolor) — just resample to the three cursor resolutions.

Packs 32/48/64 px 32bpp BGRA images into one multi-resolution .cur,
matching the existing cursors (roll/slip/zoom). Hotspot is the centre.
Run from this folder; writes retime.cur next to it. Reproducible.
"""
import os
import struct
from PIL import Image

SIZES = [32, 48, 64]
# Source PNG, resolved relative to this script. This file lives at
# <repo>/host/shotblocks/web/public/cursors/, so the repo root is five
# levels up; the artwork is at <repo>/Cursors/.
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", "..", "..", "..", ".."))
SRC = os.path.join(REPO, "Cursors", "Retime tool.png")


def load_glyph(size: int) -> Image.Image:
    """Source artwork resampled to `size`x`size`, RGBA, transparent bg."""
    src = Image.open(SRC).convert("RGBA")
    if src.size != (size, size):
        src = src.resize((size, size), Image.LANCZOS)
    return src


def cur_bytes() -> bytes:
    imgs = [load_glyph(s) for s in SIZES]
    # ICONDIR
    out = struct.pack("<HHH", 0, 2, len(imgs))  # reserved, type=2(CUR), count
    # Build each image's DIB (BITMAPINFOHEADER + BGRA + AND mask).
    dibs = []
    for im in imgs:
        w, h = im.size
        # BITMAPINFOHEADER: biHeight is doubled (XOR + AND mask).
        bih = struct.pack("<IiiHHIIiiII",
                          40, w, h * 2, 1, 32, 0, 0, 0, 0, 0, 0)
        # Pixel rows bottom-up, BGRA.
        rows = []
        px = im.load()
        for y in range(h - 1, -1, -1):
            row = bytearray()
            for x in range(w):
                r, g, b, a = px[x, y]
                row += bytes((b, g, r, a))
            rows.append(bytes(row))
        xor = b"".join(rows)
        # AND mask: 1bpp, rows padded to 32 bits, all-zero (alpha drives it).
        and_stride = ((w + 31) // 32) * 4
        andmask = b"\x00" * (and_stride * h)
        dibs.append(bih + xor + andmask)

    # ICONDIRENTRY table — offsets follow the 6-byte header + 16*count table.
    offset = 6 + 16 * len(imgs)
    entries = b""
    for im, dib in zip(imgs, dibs):
        w, h = im.size
        bw = 0 if w >= 256 else w
        bh = 0 if h >= 256 else h
        hx, hy = w // 2, h // 2  # hotspot at centre (CUR: planes/bpp = hotspot)
        entries += struct.pack("<BBBBHHII",
                               bw, bh, 0, 0, hx, hy, len(dib), offset)
        offset += len(dib)
    return out + entries + b"".join(dibs)


if __name__ == "__main__":
    data = cur_bytes()
    with open(os.path.join(HERE, "retime.cur"), "wb") as f:
        f.write(data)
    print("wrote retime.cur", len(data), "bytes from", SRC)
