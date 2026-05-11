"""Build script: PNG sources → C4D-ready bitmap assets.

Reads the 2x-resolution PNGs the user exports from Figma in
`src/res/png-source/`, downsamples them to 1x with Lanczos, and writes
the C4D-loadable assets into `src/res/icons/shots/` (and
`src/res/icons/shots/glyphs/` for camera glyphs).

Three asset kinds are recognized by filename suffix:

  *-body.png   → body of the shot/audio block (sliced into left/mid/right)
  *-edge.png   → left-edge handle decoration (used as-is; plugin mirrors
                 horizontally for the right edge)
  camera*.png  → procedural-overlay glyphs (no slicing, just downsample)

Naming convention (lowercase, hyphenated):
  shot-{normal,selected,orphan}-{body,edge}.png
  audio-{normal,selected}-{body,edge}.png
  camera{,-selected,-orphan}.png

Usage:
  python scripts/build-icons.py

Dependencies (pip):
  Pillow

The previous svglib + reportlab pipeline has been retired. SVGs in
`src/res/svg/` are kept as design archives but no longer build inputs.
"""

import os
import sys

from PIL import Image


# ---------------------------------------------------------------------------
# Geometry — must match the plugin constants in sb_canvas.py
# ---------------------------------------------------------------------------

# Source PNGs are exported from Figma at 4x design resolution. We
# downsample to 1x for C4D rendering. 4x supersampling lands cleanly
# on the 1x pixel grid via Lanczos and produces sharper edges than 2x.
SUPERSAMPLE     = 4
SHOT_HEIGHT     = 48     # 1x design height of a shot block
AUDIO_HEIGHT    = 96     # 1x design height of an audio block
SHOT_EDGE_PX    = 24     # 1x edge slice width (handle area)
MID_W           = 1      # 1x middle-slice width — default; states with
                         # horizontal patterns override below
# Per-base mid-slice width override. States whose body has a horizontal
# pattern (e.g. orphan's dashed border) need a wider mid to capture one
# full pattern cycle. The plugin tiles wider mids horizontally rather
# than stretching them.
MID_W_BY_BASE = {
    "shot-orphan": 20,  # one full dash cycle (12 on + 8 off) at 1x
}

# Map filename prefix → expected 1x body height. The build script
# validates each source PNG matches its expected dimensions after
# downsampling.
BODY_HEIGHT_BY_PREFIX = {
    "audio-": AUDIO_HEIGHT,
    "shot-":  SHOT_HEIGHT,
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _here():
    return os.path.dirname(os.path.abspath(__file__))


def _repo_root():
    return os.path.dirname(_here())


def expected_body_height_for(basename):
    """Return the expected 1x body height for a source PNG basename, or
    None if the prefix isn't recognized."""
    for prefix, h in BODY_HEIGHT_BY_PREFIX.items():
        if basename.startswith(prefix):
            return h
    return None


def downsample(img, factor):
    """Downsample a Pillow image by an integer factor with Lanczos."""
    if factor == 1:
        return img
    w, h = img.size
    return img.resize((w // factor, h // factor), resample=Image.LANCZOS)


# ---------------------------------------------------------------------------
# Body slicing
# ---------------------------------------------------------------------------

def slice_body(img, base_name, out_dir, expected_h):
    """Slice a body PNG into left/mid/right and write three files.

    `base_name` is e.g. `shot-normal-body`; output files drop the
    `-body` suffix and become `shot-normal-{left,mid,right}.png`.
    `expected_h` is the 1x body height — the source must downsample to
    exactly this many pixels tall."""
    w, h = img.size
    if h != expected_h:
        raise ValueError(
            "{}: downsampled height {} != expected {}. Author this PNG at "
            "{}px tall (in design space; export at 2x).".format(
                base_name, h, expected_h, expected_h))
    if w < 2 * SHOT_EDGE_PX + MID_W:
        raise ValueError(
            "{}: downsampled width {} too narrow (need at least {})".format(
                base_name, w, 2 * SHOT_EDGE_PX + MID_W))

    # Strip the trailing `-body` from base_name so the slice files match
    # the existing plugin loader convention (`shot-normal-left.png`).
    if base_name.endswith("-body"):
        out_base = base_name[:-len("-body")]
    else:
        out_base = base_name

    left  = img.crop((0, 0, SHOT_EDGE_PX, h))
    right = img.crop((w - SHOT_EDGE_PX, 0, w, h))
    mid_x = w // 2
    mid   = img.crop((mid_x, 0, mid_x + MID_W, h))

    os.makedirs(out_dir, exist_ok=True)
    paths = []
    for suffix, slice_img in (("-left", left), ("-mid", mid), ("-right", right)):
        p = os.path.join(out_dir, out_base + suffix + ".png")
        slice_img.save(p)
        paths.append(out_base + suffix + ".png")
    return paths


# ---------------------------------------------------------------------------
# Edge — copy through, no slicing
# ---------------------------------------------------------------------------

def emit_edge(img, base_name, out_dir):
    """Write the (already-downsampled) edge PNG to the output dir.
    Plugin mirrors it horizontally at draw time for the right side, so
    we only need the left edge here."""
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, base_name + ".png")
    img.save(out_path)
    return [base_name + ".png"]


# ---------------------------------------------------------------------------
# Glyph — copy through, no slicing
# ---------------------------------------------------------------------------

def emit_glyph(img, base_name, out_dir):
    """Write the (already-downsampled) glyph PNG to the glyph dir."""
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, base_name + ".png")
    img.save(out_path)
    return [base_name + ".png"]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def classify(basename):
    """Return ('body' | 'edge' | 'glyph' | 'hover' | 'chrome' | None, base_for_output).

    'hover' covers files named `hover-shot.png` / `hover-audio.png` —
    a single hover edge applied to every state of that kind. The base
    name returned is the kind ('shot' or 'audio') for downstream lookup.

    'chrome' covers standalone UI icons that just need downsampling
    (no slicing, no per-state body composition). The playhead
    triangle, peak-marker triangle, and waveform toggle source PNGs
    fall in this bucket — recognized via the CHROME_SOURCES map
    below. Output filename is the map's value.
    """
    chrome_target = CHROME_SOURCES.get(basename)
    if chrome_target is not None:
        return "chrome", chrome_target
    if basename.startswith("hover-"):
        kind = basename[len("hover-"):]
        return "hover", kind
    if basename.endswith("-body"):
        return "body", basename
    if basename.endswith("-edge"):
        return "edge", basename
    if basename == "camera" or basename.startswith("camera-"):
        return "glyph", basename
    return None, basename


# Standalone chrome icons. Source filenames in src/res/png-source/
# (without .png) map to output filenames in src/res/icons/. Inputs
# are authored at any reasonable supersample; the build script just
# downsamples by SUPERSAMPLE and writes the result. No flattening
# applied — these icons sit over varying backgrounds at runtime so
# the transparent / partial-alpha source is what the plugin wants.
CHROME_SOURCES = {
    "Playhead triangle":        "playhead-triangle",
    "peak detection normal":    "peak-marker",
    "peak detection selected":  "peak-marker-selected",
    "range handle":             "range-handle",
    "range handle hover":       "range-handle-hover",
    "Dim BG tile":              "dim-bg-tile",
    "Waveform toggle":          "waveform-source",  # processed further
                                                    # below to produce
                                                    # on/off variants
}


CANVAS_BG_HEX = "#1C1C1C"  # must match COL_BG_TIMELINE in sb_canvas.py

# Per-glyph background color for flattening. The glyph PNGs from
# Figma have AA pixels around the camera silhouette; flattening them
# against the body color the glyph will sit on at runtime turns those
# AA pixels into proper visual blends instead of sharp opaque squares.
# Keys are glyph base names (no extension); values are the body color
# of the state where each glyph is shown.
GLYPH_BG_BY_NAME = {
    "camera":                  "#1C1C1C",  # shot-normal body (dark)
    "camera-selected":         "#007AFF",  # shot-selected body (iOS blue)
    "camera-orphan":           "#1C1C1C",  # shot-orphan body (dark — only handles are red)
    "camera-orphan-selected":  "#FF3B30",  # shot-orphan-selected body (saturated red)
}


def _flatten_to_canvas_bg(img, bg_hex=CANVAS_BG_HEX):
    """Composite `img` against the canvas bg color and return a fully
    opaque RGBA image. Partial-alpha pixels (the AA gradient at corner
    curves) get blended in software here, so the runtime DrawBitmap
    never has to handle partial alpha — every pixel comes out alpha=255
    with the corner-curve color smoothly fading from body color to the
    canvas bg color.

    This sidesteps two C4D 2026 DrawBitmap pitfalls at once:
      - partial-alpha pixels render as fully-opaque source RGB
      - alpha=0 pixels reveal lane-bg differences as sharp rectangles
    Both go away when every bitmap pixel is opaque."""
    bg_hex = bg_hex.lstrip("#")
    br = int(bg_hex[0:2], 16)
    bg = int(bg_hex[2:4], 16)
    bb = int(bg_hex[4:6], 16)
    bg_layer = Image.new("RGBA", img.size, (br, bg, bb, 255))
    out = Image.alpha_composite(bg_layer, img)
    return out  # fully opaque RGBA


def composite_edge_onto_body(body_left_or_right, edge_pil, mirrored=False):
    """Composite the edge PNG over a body slice (both RGBA), then
    flatten the result onto the canvas bg color so no partial alpha
    survives.

    `mirrored=True` flips the edge horizontally first (used for the
    right side, since we author only a left edge)."""
    if mirrored:
        edge_pil = edge_pil.transpose(Image.FLIP_LEFT_RIGHT)
    composited = Image.alpha_composite(body_left_or_right, edge_pil)
    return _flatten_to_canvas_bg(composited)


def _apply_hover_overlay(body_slice, edge_pil, hover_pil, mirrored=False):
    """Build a hover-state edge slice. Order: body -> normal edge ->
    hover overlay. The hover overlay is typically a translucent black
    rectangle from `hover-shot.png` / `hover-audio.png`; its alpha
    determines how much the underlying decoration darkens. The dot
    grips on the normal edge stay visible (just darkened)."""
    if mirrored:
        edge_pil  = edge_pil.transpose(Image.FLIP_LEFT_RIGHT)
        hover_pil = hover_pil.transpose(Image.FLIP_LEFT_RIGHT)
    step1 = Image.alpha_composite(body_slice, edge_pil)
    step2 = Image.alpha_composite(step1, hover_pil)
    return _flatten_to_canvas_bg(step2)


def darken_bitmap(img, factor=0.5):
    """Return a copy of `img` with RGB channels multiplied toward black
    by `factor`. Alpha is preserved. Used to bake the hover-darken
    variant of each edge composite at build time."""
    out = img.copy()
    pixels = out.load()
    w, h = out.size
    keep = 1.0 - factor
    for y in range(h):
        for x in range(w):
            r, g, b, a = pixels[x, y]
            pixels[x, y] = (int(r * keep), int(g * keep), int(b * keep), a)
    return out


def main():
    repo = _repo_root()
    src_dir    = os.path.join(repo, "src", "res", "png-source")
    out_blocks = os.path.join(repo, "src", "res", "icons", "shots")
    out_glyphs = os.path.join(repo, "src", "res", "icons", "shots", "glyphs")

    if not os.path.isdir(src_dir):
        print("png-source directory not found: {}".format(src_dir))
        return 1

    sources = [f for f in sorted(os.listdir(src_dir))
               if f.lower().endswith(".png")]
    if not sources:
        print("no .png sources in {}".format(src_dir))
        return 1

    # First pass: load + downsample everything, classify by kind.
    bodies = {}  # base ("shot-normal") -> small Pillow image
    edges  = {}  # base ("shot-normal") -> small Pillow image
    glyphs = {}  # base ("camera-orphan") -> small Pillow image
    hover_edges = {}  # kind ("shot", "audio") -> small Pillow image
    chrome = {}  # target filename ("playhead-triangle") -> small Pillow image
    for src in sources:
        base = os.path.splitext(src)[0]
        path = os.path.join(src_dir, src)
        kind, out_base = classify(base)
        if kind is None:
            print("[skip] {}: unrecognized name".format(src))
            continue
        try:
            big = Image.open(path).convert("RGBA")
            # Chrome icons (playhead, peak marker, waveform toggle)
            # are authored at their final 1× render size — except
            # the waveform toggle which goes into a 24×24 rail
            # button slot, so its source is authored at SUPERSAMPLE×
            # and downsampled here like the rest. Block
            # bodies/edges/glyphs always downsample.
            if kind == "chrome":
                if out_base == "waveform-source":
                    small = downsample(big, SUPERSAMPLE)
                else:
                    small = big
            else:
                small = downsample(big, SUPERSAMPLE)
        except Exception as e:
            print("[FAIL] {}: load/downsample: {}".format(src, e))
            continue
        # Strip kind suffix to align body and edge under the same base
        # ("shot-normal-body" and "shot-normal-edge" both key as
        # "shot-normal").
        if kind == "body":
            bodies[out_base[:-len("-body")]] = small
        elif kind == "edge":
            edges[out_base[:-len("-edge")]] = small
        elif kind == "hover":
            # out_base for hover is the kind ("shot" or "audio").
            hover_edges[out_base] = small
        elif kind == "chrome":
            chrome[out_base] = small
        else:
            glyphs[out_base] = small

    # Glyphs: flatten each against the body color it'll sit on at
    # runtime so the silhouette's AA pixels blend correctly. Without
    # this, partial-alpha pixels around the camera shape render as
    # opaque source-RGB (a light-gray fringe).
    os.makedirs(out_glyphs, exist_ok=True)
    for name, img in glyphs.items():
        bg = GLYPH_BG_BY_NAME.get(name, CANVAS_BG_HEX)
        flat = _flatten_to_canvas_bg(img, bg)
        flat.save(os.path.join(out_glyphs, name + ".png"))
        print("[ok]   glyph {}.png (flattened against {})".format(name, bg))

    # Bodies: slice each into left/mid/right. Composite the edge PNG
    # (if available for this base) onto the left and right slices and
    # flatten partial alpha — produces left/right bitmaps with binary
    # alpha that C4D renders correctly.
    os.makedirs(out_blocks, exist_ok=True)
    written_count = 0
    for base, body_img in sorted(bodies.items()):
        expected_h = expected_body_height_for(base)
        if expected_h is None:
            print("[skip] body {}: no recognized prefix".format(base))
            continue
        w, h = body_img.size
        if h != expected_h:
            print("[FAIL] body {}: height {} != expected {}".format(
                base, h, expected_h))
            continue
        if w < 2 * SHOT_EDGE_PX + MID_W:
            print("[FAIL] body {}: width {} too narrow".format(base, w))
            continue

        left_slice  = body_img.crop((0, 0, SHOT_EDGE_PX, h))
        right_slice = body_img.crop((w - SHOT_EDGE_PX, 0, w, h))
        # Mid slice — width depends on the base. Default 1 px (uniform
        # color states). For states with horizontal patterns (e.g.
        # orphan's dashed border) we sample one full pattern cycle and
        # the plugin tiles it. Sample from x=SHOT_EDGE_PX so the pattern
        # phase starts at the body's left edge.
        mid_w = MID_W_BY_BASE.get(base, MID_W)
        if mid_w == 1:
            mid_slice = body_img.crop((w // 2, 0, w // 2 + 1, h))
        else:
            mid_slice = body_img.crop((SHOT_EDGE_PX, 0, SHOT_EDGE_PX + mid_w, h))

        edge_img = edges.get(base)
        # Edge fallback: a "*-selected" body without its own edge falls
        # back to the corresponding non-selected edge. Currently used by
        # shot-orphan-selected which reuses shot-orphan-edge.
        if edge_img is None and base.endswith("-selected"):
            base_without_selected = base[:-len("-selected")]
            edge_img = edges.get(base_without_selected)
        # Hover edge: per-kind override (hover-shot.png / hover-audio.png).
        # When an authored hover PNG is missing, fall back to auto-darken.
        kind_prefix = base.split("-", 1)[0]  # "shot" or "audio"
        hover_edge_img = hover_edges.get(kind_prefix)

        if edge_img is not None:
            left_final  = composite_edge_onto_body(left_slice,  edge_img, mirrored=False)
            right_final = composite_edge_onto_body(right_slice, edge_img, mirrored=True)
            if hover_edge_img is not None:
                # Authored hover is a translucent overlay applied ON TOP
                # of the already-composited edge (which carries the dot
                # grips). Order: body -> normal edge -> hover overlay.
                # This keeps the dots visible on hover and just darkens
                # them per the hover PNG's alpha.
                left_hover  = _apply_hover_overlay(left_slice, edge_img, hover_edge_img, mirrored=False)
                right_hover = _apply_hover_overlay(right_slice, edge_img, hover_edge_img, mirrored=True)
            else:
                # No authored hover for this kind — auto-darken.
                left_hover  = darken_bitmap(left_final,  0.5)
                right_hover = darken_bitmap(right_final, 0.5)
        else:
            # No edge layer for this state — flatten body alpha so C4D
            # renders corners cleanly.
            left_final  = _flatten_to_canvas_bg(left_slice)
            right_final = _flatten_to_canvas_bg(right_slice)
            left_hover  = darken_bitmap(left_final,  0.5)
            right_hover = darken_bitmap(right_final, 0.5)

        # Mid slice — flatten partial alpha too. The mid is sampled from
        # the horizontal center of the body, where the body fill is
        # solid; partial alpha would only appear if the design has a
        # vertical translucent band there, which it doesn't. Still safe
        # to binarize.
        mid_final = _binarize_alpha(mid_slice)

        for suffix, img in (("-left",        left_final),
                            ("-mid",         mid_final),
                            ("-right",       right_final),
                            ("-left-hover",  left_hover),
                            ("-right-hover", right_hover)):
            p = os.path.join(out_blocks, base + suffix + ".png")
            img.save(p)
            written_count += 1
        print("[ok]   body {} -> 5 slices (incl. hover variants)".format(base))

    # Chrome (standalone) icons: playhead triangle, peak marker, and
    # the waveform toggle. The waveform source is composited onto
    # the standard rail-button bg in two opacity variants (on/off)
    # so it reads the same way as the existing snap/loop/analyse
    # buttons. Other chrome icons are pass-through — the user
    # authors them with the bg they want already baked in
    # (transparent for icons like the playhead that sit over
    # neutral chrome, or solid for icons like the peak marker
    # that sit over a colored audio block).
    out_icons = os.path.join(repo, "src", "res", "icons")
    os.makedirs(out_icons, exist_ok=True)
    chrome_written = 0
    for name, img in chrome.items():
        if name == "waveform-source":
            _emit_waveform_toggle(img, out_icons)
            chrome_written += 2  # on + off
            continue
        if name in ("range-handle", "range-handle-hover"):
            # Emit two variants. The authored source is a `]`-shape
            # (stem on the right, caps protruding left top + bottom)
            # — that's the OUT (right) handle, opening leftward
            # toward the play range. The IN (left) handle is the
            # horizontal flip: `[` (stem on the left, caps right).
            # The pair visually brackets the play range like
            # `[ ... ]`. Done for both base and hover bitmaps so the
            # canvas can pick in/out × normal/hover at draw time.
            # Flatten against the range-bar bg first — C4D 2026's
            # DrawBitmap with BMP_ALLOWALPHA renders partial-alpha
            # pixels as opaque source-RGB, which produces visible
            # boxes around the bracket's AA edges. Flattening bakes
            # the AA blend against the actual bg color.
            suffix = "-hover" if name.endswith("-hover") else ""
            flat = _flatten_to_canvas_bg(img, "#3a3a3a")
            out_img = flat
            in_img  = flat.transpose(Image.FLIP_LEFT_RIGHT)
            out_img.save(os.path.join(out_icons,
                                       "range-handle-out" + suffix + ".png"))
            in_img.save(os.path.join(out_icons,
                                      "range-handle-in" + suffix + ".png"))
            print("[ok]   chrome range-handle-in{0} / range-handle-out{0}.png ({1}x{2})"
                  .format(suffix, img.size[0], img.size[1]))
            chrome_written += 2
            continue
        # Chrome icons authored at the final render size. Several
        # need their transparent corners flattened against the
        # specific bg they sit over at runtime — otherwise C4D
        # 2026's DrawBitmap with BMP_ALLOWALPHA renders the
        # bitmap's transparent / partial-alpha corners as opaque
        # source-RGB and produces a visible square fringe.
        FLATTEN_BG = {
            "playhead-triangle":     "#3a3a3a",  # range-bar bg
            "peak-marker":           "#406349",  # audio body unselected
            "peak-marker-selected":  "#328647",  # audio body selected
        }
        flatten_bg = FLATTEN_BG.get(name)
        if flatten_bg is not None:
            out_img = _flatten_to_canvas_bg(img, flatten_bg)
        else:
            out_img = img
        out_path = os.path.join(out_icons, name + ".png")
        out_img.save(out_path)
        print("[ok]   chrome {}.png ({}x{})".format(name, img.size[0], img.size[1]))
        chrome_written += 1

    print("done. {} files written.".format(
        written_count + len(glyphs) + chrome_written))
    return 0


# Rail-button background colors — must match snap/loop/analyse so the
# new waveform button reads as part of the same toolbar family.
RAIL_BTN_BG_OFF = (60, 60, 60, 255)
RAIL_BTN_BG_ON  = (44, 124, 211, 255)
WAVEFORM_OFF_OPACITY = 0.30


def _emit_waveform_toggle(src_img, out_dir):
    """Render the waveform-toggle source PNG into two rail-button
    icons: `waveform-off.png` (30% white waveform on a gray
    background) and `waveform-on.png` (full white waveform on the
    active blue background). Matches the snap/loop/analyse on/off
    visual convention so the new button blends into the toolbar.
    """
    w, h = src_img.size
    src = src_img.convert("RGBA")

    def _render(bg_color, opacity):
        out = Image.new("RGBA", (w, h), bg_color)
        # Pre-multiply the source's alpha by `opacity` so the
        # waveform fades vs. the bg uniformly. Source is white
        # silhouette + transparent background; reducing alpha lets
        # more of the bg show through.
        if opacity != 1.0:
            scaled_alpha = Image.eval(src.getchannel("A"),
                                      lambda a: int(a * opacity))
            faded = src.copy()
            faded.putalpha(scaled_alpha)
            return Image.alpha_composite(out, faded)
        return Image.alpha_composite(out, src)

    off = _render(RAIL_BTN_BG_OFF, WAVEFORM_OFF_OPACITY)
    on  = _render(RAIL_BTN_BG_ON,  1.0)
    off.save(os.path.join(out_dir, "waveform-off.png"))
    on.save(os.path.join(out_dir, "waveform-on.png"))
    print("[ok]   chrome waveform-off.png / waveform-on.png ({}x{})".format(w, h))


def _binarize_alpha(img):
    """Backwards-compatible name kept; now flattens against the canvas
    bg so output is fully opaque with proper AA preserved."""
    return _flatten_to_canvas_bg(img)


if __name__ == "__main__":
    sys.exit(main())
