"""Bitmap helpers for canvas-rendered toolbar buttons.

Originally this module hosted a `ToolbarToggleButton` GeUserArea class
used in the dialog's top toolbar. With the move to a Premiere-style
left rail, the canvas itself now draws the toggle buttons (so the rail
and the timeline share one coordinate space). What remains here is the
pixel-level utilities: loading PNGs and producing pre-tinted hover/press
copies so we don't need a third PNG per state on disk.

Two PNGs per logical button (off + on); hover and press are baked from
those at construction time by mixing pixels toward white/black.
"""

import os

import c4d


HOVER_LIGHTEN = 0.18
PRESS_DARKEN  = 0.20


def load_bitmap(path):
    """Load a PNG into a c4d.bitmaps.BaseBitmap. Returns None on failure."""
    if not os.path.exists(path):
        print("[Shotblocks] toolbar icon missing: {}".format(path))
        return None
    bmp = c4d.bitmaps.BaseBitmap()
    res = bmp.InitWith(path)
    if isinstance(res, tuple):
        ok = (res[0] == c4d.IMAGERESULT_OK)
    else:
        ok = (res == c4d.IMAGERESULT_OK)
    if not ok:
        print("[Shotblocks] toolbar icon failed to load: {} ({})".format(path, res))
        return None
    return bmp


def blend_two_bitmaps(a_bmp, b_bmp, t):
    """Return a new BaseBitmap that is `(1-t) * a + t * b` per pixel.
    Both inputs must be the same dimensions. Alpha channels are blended
    the same way. Used to pre-bake hover-fade intermediate frames at
    canvas construction time, so draw-time stays a simple lookup."""
    if a_bmp is None or b_bmp is None:
        return None
    w = a_bmp.GetBw()
    h = a_bmp.GetBh()
    if b_bmp.GetBw() != w or b_bmp.GetBh() != h:
        return None
    dst = c4d.bitmaps.BaseBitmap()
    if dst.Init(w, h, 32) != c4d.IMAGERESULT_OK:
        return None
    src_alpha_a = None
    src_alpha_b = None
    dst_alpha = None
    try:
        src_alpha_a = a_bmp.GetInternalChannel()
        src_alpha_b = b_bmp.GetInternalChannel()
    except Exception:
        pass
    if src_alpha_a is not None or src_alpha_b is not None:
        try:
            dst_alpha = dst.AddChannel(True, False)
        except Exception:
            dst_alpha = None

    inv = 1.0 - t
    for y in range(h):
        for x in range(w):
            try:
                ar, ag, ab_ = a_bmp.GetPixel(x, y)[:3]
                br, bg, bb_ = b_bmp.GetPixel(x, y)[:3]
            except Exception:
                continue
            dst.SetPixel(x, y,
                         int(ar * inv + br * t),
                         int(ag * inv + bg * t),
                         int(ab_ * inv + bb_ * t))
            if dst_alpha is not None:
                try:
                    aa = a_bmp.GetAlphaPixel(src_alpha_a, x, y) if src_alpha_a else 255
                    ba = b_bmp.GetAlphaPixel(src_alpha_b, x, y) if src_alpha_b else 255
                    dst.SetAlphaPixel(dst_alpha, x, y,
                                      int(aa * inv + ba * t))
                except Exception:
                    pass
    return dst


def tinted_copy(src_bmp, toward_rgb, t):
    """Return a new BaseBitmap with every pixel mixed toward `toward_rgb`
    (0..255 tuple) by amount t (0..1). Preserves alpha. Used to bake a
    hover/press version once at construction time."""
    if src_bmp is None:
        return None
    w = src_bmp.GetBw()
    h = src_bmp.GetBh()
    dst = c4d.bitmaps.BaseBitmap()
    if dst.Init(w, h, 32) != c4d.IMAGERESULT_OK:
        return None

    src_alpha = None
    dst_alpha = None
    try:
        src_alpha = src_bmp.GetInternalChannel()
    except Exception:
        src_alpha = None
    if src_alpha is not None:
        try:
            dst_alpha = dst.AddChannel(True, False)
        except Exception:
            dst_alpha = None

    tr, tg, tb = toward_rgb
    for y in range(h):
        for x in range(w):
            try:
                pix = src_bmp.GetPixel(x, y)
            except Exception:
                continue
            r = int(pix[0] + (tr - pix[0]) * t)
            g = int(pix[1] + (tg - pix[1]) * t)
            b = int(pix[2] + (tb - pix[2]) * t)
            dst.SetPixel(x, y, r, g, b)
            if src_alpha is not None and dst_alpha is not None:
                try:
                    a = src_bmp.GetAlphaPixel(src_alpha, x, y)
                    dst.SetAlphaPixel(dst_alpha, x, y, a)
                except Exception:
                    pass
    return dst
