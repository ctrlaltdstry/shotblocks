"""Shotblocks drawing canvas mixin.

The non-audio drawing subordinates of `DrawMsg` — the left-rail painter,
the shot-block bitmap and procedural renderers, the dashed-border /
diagonal-hatch primitives, and the lazy bitmap caches that back them
(`_block_bitmaps`, `_glyph_bitmaps`, `_rail_buttons`). Pulled out of
`sb_canvas.py` for code-locality alongside the audio mixin.

`ShotblocksTimelineCanvas` inherits `DrawingCanvasMixin` so all the
methods here see the same `self` as the rest of the canvas: shot-model
helpers, frame-to-x math, hover-fade state, the GeUserArea Draw* API,
etc. all stay one attribute lookup away. The split exists for code-
locality, not for any runtime independence.

`DrawMsg` itself remains on the canvas — GeUserArea's framework calls
`canvas.DrawMsg(...)` directly and the orchestrator is the entry point
for every redraw. It calls the mixin's helpers via `self.*` (resolving
through MRO).

Visual-language tokens (colors, layout constants) stay at module top
of `sb_canvas.py`; they're shared across drawing, hit-testing, hover
state, and `DrawMsg`. Drawing methods that need them lazy-import inside
the method body (same approach the audio mixin uses for shared
constants).
"""

import os

import c4d

from sb_toolbar import load_bitmap, tinted_copy, blend_two_bitmaps, HOVER_LIGHTEN, PRESS_DARKEN


# ---------------------------------------------------------------------------
# Drawing canvas mixin — bitmap caches + all the non-audio drawing
# subordinates called by `ShotblocksTimelineCanvas.DrawMsg`.
# ---------------------------------------------------------------------------

class DrawingCanvasMixin(object):
    """Drawing-cluster methods + per-instance bitmap caches for the
    timeline canvas.

    `ShotblocksTimelineCanvas` inherits this. The mixin assumes `self`
    is a canvas instance with the rest of the canvas's helpers
    available (`_frame_to_x`, `_track_y_top`, `_hover_t_for`,
    `_resolve_cam_name`, `_is_orphan`, the GeUserArea Draw* API, etc.).
    """

    # ------------------------------------------------------------------
    # Per-instance state — call from the canvas's __init__.
    # ------------------------------------------------------------------

    def _drawing_init_state(self):
        """Initialize all per-instance drawing state. Call from the
        canvas's `__init__` so a fresh canvas has empty bitmap caches
        ready for first-DrawMsg lazy loads.
        """
        # Bitmap caches are loaded lazily on first read (typically the
        # first DrawMsg). Doing the file I/O + BaseBitmap work in
        # __init__ during a docked-dialog RestoreLayout — which fires
        # very early in C4D startup — could fail silently and leave
        # C4D showing "plugin not found" in the saved layout slot.
        # Deferring keeps construction trivial and runs the loads only
        # after the doc + resources are ready.
        self._block_bitmaps_cache = None
        self._glyph_bitmaps_cache = None
        self._rail_buttons_cache  = None

    # ------------------------------------------------------------------
    # Lazy bitmap caches — see `_drawing_init_state` for why these defer.
    # ------------------------------------------------------------------

    @property
    def _block_bitmaps(self):
        if self._block_bitmaps_cache is None:
            try:
                self._block_bitmaps_cache = self._load_block_bitmaps()
            except Exception as e:
                print("[Shotblocks] block bitmaps load failed: {}".format(e))
                self._block_bitmaps_cache = {}
        return self._block_bitmaps_cache

    @property
    def _glyph_bitmaps(self):
        if self._glyph_bitmaps_cache is None:
            try:
                self._glyph_bitmaps_cache = self._load_glyph_bitmaps()
            except Exception as e:
                print("[Shotblocks] glyph bitmaps load failed: {}".format(e))
                self._glyph_bitmaps_cache = {}
        return self._glyph_bitmaps_cache

    @property
    def _rail_buttons(self):
        # Retry on every draw if the cache is empty — bitmap loading
        # can transiently fail in C4D (e.g. an off-main-thread
        # interaction during plugin init or a SpecialEventAdd-driven
        # redraw before BaseBitmap is ready). A permanent empty
        # cache would silently kill the rail buttons; the retry at
        # most costs one extra `_build_rail_buttons` per draw while
        # the failure persists.
        cache = self._rail_buttons_cache
        if cache is None or not cache:
            try:
                self._rail_buttons_cache = self._build_rail_buttons()
            except Exception as e:
                print("[Shotblocks] rail buttons load failed: {}".format(e))
                self._rail_buttons_cache = []
        return self._rail_buttons_cache

    # ------------------------------------------------------------------
    # Bitmap loaders
    # ------------------------------------------------------------------

    def _build_rail_buttons(self):
        """Load bitmaps for each rail toggle button and bake hover/press
        tinted copies. Returns a list of dicts with 'name', 'state_attr'
        (the canvas attribute name holding bool state), bitmaps, and an
        x/y rect computed at draw/hit-test time from the button index."""
        here = os.path.dirname(os.path.abspath(__file__))
        icons = os.path.join(here, "res", "icons")

        def make(name, state_attr, click_action=None):
            off = load_bitmap(os.path.join(icons, name + "-off.png"))
            on  = load_bitmap(os.path.join(icons, name + "-on.png"))
            entry = {
                "name":        name,
                "state_attr":  state_attr,
                "off":         off,
                "on":          on,
                "off_hover":   tinted_copy(off, (255, 255, 255), HOVER_LIGHTEN) if off else None,
                "on_hover":    tinted_copy(on,  (255, 255, 255), HOVER_LIGHTEN) if on  else None,
                "off_press":   tinted_copy(off, (0,   0,   0),   PRESS_DARKEN)  if off else None,
                "on_press":    tinted_copy(on,  (0,   0,   0),   PRESS_DARKEN)  if on  else None,
            }
            # Optional custom click handler. When unset, the rail
            # commit code does the default `setattr(self, state_attr,
            # not current)`. When set, it calls the named method.
            if click_action:
                entry["click_action"] = click_action
            return entry

        # The analyse button is a toggle whose bitmap follows
        # `audio_track.analysis_visible`, but its click handler is
        # custom (`_on_analyse_click`) so the first click on a
        # never-analysed track *runs* analysis instead of toggling
        # an empty visibility state. The state_attr_path lets
        # `_draw_rail` follow a dotted path into a child object,
        # rather than the simple `getattr(self, attr)` of the
        # toggle buttons.
        return [
            make("snap",  "_snap_enabled"),
            make("slip",  "_slip_enabled"),
            make("pen",   "_pen_enabled"),
            make("razor", "_razor_enabled"),
            make("loop",  "_loop_enabled"),
            make("analyse", "_audio_track.analysis_visible",
                 click_action="_on_analyse_click"),
            make("waveform", "_audio_track.waveform_visible",
                 click_action="_on_waveform_click"),
        ]

    def _load_block_bitmaps(self):
        """Load all shot/audio block PNGs into an in-memory dict. The
        build script (`scripts/build-icons.py`) writes them under
        src/res/icons/shots/. Missing files are tolerated — _draw_shot_block
        falls back to the procedural rect path when a state's bitmap set
        isn't available.

        Per state we load five bitmaps:
          left, mid, right                — body 3-slice with edge
                                            decoration baked in
          left_hover, right_hover         — same bitmaps darkened 50% by
                                            the build script for hover

        The build script does the body+edge composition and edge mirror
        at build time, so the plugin only does straight DrawBitmap
        calls."""
        here = os.path.dirname(os.path.abspath(__file__))
        icons = os.path.join(here, "res", "icons", "shots")
        result = {}
        plan = [
            ("shot",  ["normal", "selected", "orphan", "orphan-selected"]),
            ("audio", ["normal", "selected"]),
        ]
        for kind, states in plan:
            for state in states:
                key  = (kind, state)
                base = "{}-{}".format(kind, state)
                left        = load_bitmap(os.path.join(icons, base + "-left.png"))
                mid         = load_bitmap(os.path.join(icons, base + "-mid.png"))
                right       = load_bitmap(os.path.join(icons, base + "-right.png"))
                left_hover  = load_bitmap(os.path.join(icons, base + "-left-hover.png"))
                right_hover = load_bitmap(os.path.join(icons, base + "-right-hover.png"))
                if left is None or mid is None or right is None:
                    continue
                # Pre-bake N intermediate fade frames per side, blending
                # between the normal edge and the full-hover edge. Frame
                # 0 == normal, frame N-1 == full hover. Draw time picks
                # the frame matching the current animation t. Avoids
                # any per-frame compositing in the draw path.
                left_frames  = self._bake_fade_frames(left,  left_hover  or left)
                right_frames = self._bake_fade_frames(right, right_hover or right)
                result[key] = {
                    "left":         left,
                    "mid":          mid,
                    "right":        right,
                    "left_hover":   left_hover  or left,
                    "right_hover":  right_hover or right,
                    "left_frames":  left_frames,
                    "right_frames": right_frames,
                }
        return result

    def _bake_fade_frames(self, normal_bmp, hover_bmp):
        """Return a list of HOVER_FADE_LEVELS bitmaps blending from
        normal (frame 0) to hover (frame N-1). When normal == hover
        (no authored hover variant), returns N copies of normal."""
        from sb_canvas import HOVER_FADE_LEVELS
        if normal_bmp is None:
            return []
        if hover_bmp is None or hover_bmp is normal_bmp:
            return [normal_bmp] * HOVER_FADE_LEVELS
        frames = [normal_bmp]
        for i in range(1, HOVER_FADE_LEVELS - 1):
            t = i / float(HOVER_FADE_LEVELS - 1)
            blended = blend_two_bitmaps(normal_bmp, hover_bmp, t)
            frames.append(blended if blended is not None else normal_bmp)
        frames.append(hover_bmp)
        return frames

    def _load_glyph_bitmaps(self):
        """Load the procedural-overlay glyphs (camera icon and any
        future siblings). Returns a dict keyed by glyph name. Missing
        files are tolerated — caller just skips drawing that glyph."""
        here = os.path.dirname(os.path.abspath(__file__))
        glyph_dir = os.path.join(here, "res", "icons", "shots", "glyphs")
        names = ["camera", "camera-selected", "camera-orphan", "camera-orphan-selected"]
        result = {}
        for n in names:
            bmp = load_bitmap(os.path.join(glyph_dir, n + ".png"))
            if bmp is not None:
                result[n] = bmp
        return result

    # ------------------------------------------------------------------
    # Rail button geometry / hit-test
    # ------------------------------------------------------------------

    def _rail_button_rect(self, idx):
        """Return (x1, y1, x2, y2) — bbox of the button at index `idx`
        in canvas-local coords. Buttons stack vertically along the
        LEFT edge of the rail (Premiere convention) so the right
        portion of the rail is reserved for per-track row controls."""
        from sb_canvas import (
            RAIL_BTN_SIZE, RAIL_BTN_TOP, RAIL_BTN_GAP, RAIL_ROW_PAD_X,
        )
        x1 = RAIL_ROW_PAD_X
        y1 = RAIL_BTN_TOP + idx * (RAIL_BTN_SIZE + RAIL_BTN_GAP)
        return x1, y1, x1 + RAIL_BTN_SIZE, y1 + RAIL_BTN_SIZE

    def _resolve_attr_path(self, path):
        """Read a dotted attribute path off `self`. Returns False on
        any missing segment so a partially-initialized canvas (e.g.
        before AudioTrack exists) can't crash the rail draw."""
        if not path:
            return False
        obj = self
        for seg in path.split("."):
            obj = getattr(obj, seg, None)
            if obj is None:
                return False
        return obj

    def _rail_button_at(self, x, y):
        """Return the button dict (and its index) under (x, y), or
        (None, None) if the cursor isn't over a rail button."""
        from sb_canvas import LEFT_RAIL_WIDTH
        if x >= LEFT_RAIL_WIDTH:
            return None, None
        for i, btn in enumerate(self._rail_buttons):
            bx1, by1, bx2, by2 = self._rail_button_rect(i)
            if bx1 <= x < bx2 and by1 <= y < by2:
                return btn, i
        return None, None

    def _track_row_at(self, x, y):
        """Hit-test the per-track row controls. Returns
        (kind, idx, control) where control ∈ {'lock','chip','eye','mute','solo'},
        or (None, None, None) if the cursor isn't on a row control.
        Cursor must be inside the rail (x < LEFT_RAIL_WIDTH); a hit
        inside a row's Y range but not on any specific control still
        returns (None, None, None) so the rail's empty space stays
        non-interactive."""
        from sb_canvas import LEFT_RAIL_WIDTH, SHOT_HEIGHT
        if x >= LEFT_RAIL_WIDTH:
            return None, None, None
        # Video rows.
        from sb_shot_model import _displayed_lane_count
        try:
            import c4d
            doc = c4d.documents.GetActiveDocument()
            from sb_persistence import _read_shots
            shots, _ = _read_shots(doc) if doc is not None else ([], 0)
        except Exception:
            shots = []
        lane_count = max(1, _displayed_lane_count(shots))
        for track in range(lane_count):
            yt = self._track_y_top(track)
            if not (yt <= y < yt + SHOT_HEIGHT):
                continue
            rects = self._track_row_rects(yt, SHOT_HEIGHT, "video")
            for name, (rx1, ry1, rx2, ry2) in rects.items():
                if rx1 <= x < rx2 and ry1 <= y < ry2:
                    return "video", track, name
            return None, None, None
        # Audio row.
        if getattr(self, "_audio_tracks", None):
            from sb_canvas_audio import AUDIO_HEIGHT
            for lane in self._audio_lanes_in_use():
                ay1, ay2 = self._audio_lane_y_bounds(lane)
                if not (ay1 <= y < ay2):
                    continue
                rects = self._track_row_rects(ay1, AUDIO_HEIGHT, "audio")
                for name, (rx1, ry1, rx2, ry2) in rects.items():
                    if rx1 <= x < rx2 and ry1 <= y < ry2:
                        return "audio", lane, name
                return None, None, None
        return None, None, None

    # ------------------------------------------------------------------
    # Drawing — left rail
    # ------------------------------------------------------------------

    def _draw_rail(self, w, h, lane_count):
        """Paint the left rail: background, divider, toggle buttons,
        and per-track row controls (Railcut-style: lock, target chip
        with label, name, eye for video / M+S for audio)."""
        from sb_canvas import (
            COL_BG_RAIL, COL_RAIL_BORDER,
            COL_ACCENT, COL_BORDER_EMPH,
            LEFT_RAIL_WIDTH, SHOT_HEIGHT,
        )
        # Background and right-edge divider
        self.DrawSetPen(COL_BG_RAIL)
        self.DrawRectangle(0, 0, LEFT_RAIL_WIDTH, h)
        self.DrawSetPen(COL_RAIL_BORDER)
        self.DrawLine(LEFT_RAIL_WIDTH - 1, 0, LEFT_RAIL_WIDTH - 1, h)

        # Rail buttons. The `state_attr` is a dotted path (typically
        # a single segment like "_snap_enabled" but the analyse
        # button uses "_audio_track.analysis_visible" so the bitmap
        # tracks state on a child object). Bool-evaluates True/False
        # to pick the on/off bitmap; press/hover variants tint that.
        for i, btn in enumerate(self._rail_buttons):
            bx1, by1, bx2, by2 = self._rail_button_rect(i)
            attr = btn.get("state_attr")
            state = bool(self._resolve_attr_path(attr)) if attr else False
            if self._rail_pressed == btn["name"]:
                bmp = btn.get("on_press") if state else btn.get("off_press")
            elif self._rail_hover == btn["name"]:
                bmp = btn.get("on_hover") if state else btn.get("off_hover")
            else:
                bmp = btn.get("on") if state else btn.get("off")
            if bmp is None:
                # Bitmap missing — fall back to a colored rect so the
                # button is still clickable / debuggable.
                self.DrawSetPen(COL_ACCENT if state else COL_BORDER_EMPH)
                self.DrawRectangle(bx1, by1, bx2, by2)
                continue
            try:
                bw = bmp.GetBw()
                bh = bmp.GetBh()
                self.DrawBitmap(bmp, bx1, by1, bx2 - bx1, by2 - by1,
                                0, 0, bw, bh,
                                c4d.BMP_NORMALSCALED | c4d.BMP_ALLOWALPHA)
            except Exception as e:
                print("[Shotblocks] rail bitmap draw failed: {}".format(e))

        # Per-track row controls. Each video track plus the audio block
        # (when present) gets a row of controls inline with its body.
        for track in range(lane_count):
            yt = self._track_y_top(track)
            self._draw_track_row("video", track, yt, SHOT_HEIGHT,
                                 label="V{}".format(track + 1))
        # Audio rows — one per occupied lane. Lane index is the
        # AudioTrack `.track` field, NOT the list index; two clips
        # sharing a lane (after a razor split) collapse to one row.
        if getattr(self, "_audio_tracks", None):
            from sb_canvas_audio import AUDIO_HEIGHT
            for lane in self._audio_lanes_in_use():
                ay1, _ay2 = self._audio_lane_y_bounds(lane)
                self._draw_track_row("audio", lane, ay1, AUDIO_HEIGHT,
                                     label="A{}".format(lane + 1))

    def _track_row_rects(self, row_top, row_h, kind):
        """Geometry for the per-track row controls. Returns a dict
        keyed by control name ('lock', 'chip', 'eye', 'mute', 'solo')
        whose values are (x1, y1, x2, y2) tuples — used by both the
        drawer and the hit-test. `kind` is 'video' or 'audio'; the
        video row gets an eye, the audio row gets M + S."""
        from sb_canvas import (
            LEFT_RAIL_WIDTH, RAIL_BTN_SIZE, RAIL_LOCK_SIZE,
            RAIL_CHIP_W, RAIL_CHIP_H, RAIL_EYE_SIZE,
            RAIL_MS_W, RAIL_MS_H, RAIL_MS_GAP, RAIL_ROW_PAD_X,
        )
        # Rail buttons own the left column; per-track controls start
        # after them so the chip doesn't compete with Snap/Slip etc.
        left_col_end = RAIL_BTN_SIZE + RAIL_ROW_PAD_X * 2
        # Vertical centerline of the row.
        cy = row_top + row_h // 2

        # Lock — leftmost, right after the rail buttons column.
        lock_x1 = left_col_end
        lock_y1 = cy - RAIL_LOCK_SIZE // 2
        lock = (lock_x1, lock_y1,
                lock_x1 + RAIL_LOCK_SIZE, lock_y1 + RAIL_LOCK_SIZE)

        # Target chip — to the right of the lock.
        chip_x1 = lock[2] + RAIL_ROW_PAD_X
        chip_y1 = cy - RAIL_CHIP_H // 2
        chip = (chip_x1, chip_y1,
                chip_x1 + RAIL_CHIP_W, chip_y1 + RAIL_CHIP_H)

        rects = {"lock": lock, "chip": chip}

        # Right cluster — eye (video) or M+S (audio), right-aligned
        # inside the rail.
        right_edge = LEFT_RAIL_WIDTH - RAIL_ROW_PAD_X
        if kind == "video":
            eye_x2 = right_edge
            eye_x1 = eye_x2 - RAIL_EYE_SIZE
            eye_y1 = cy - RAIL_EYE_SIZE // 2
            rects["eye"] = (eye_x1, eye_y1,
                            eye_x2, eye_y1 + RAIL_EYE_SIZE)
        else:
            s_x2 = right_edge
            s_x1 = s_x2 - RAIL_MS_W
            m_x2 = s_x1 - RAIL_MS_GAP
            m_x1 = m_x2 - RAIL_MS_W
            ms_y1 = cy - RAIL_MS_H // 2
            ms_y2 = ms_y1 + RAIL_MS_H
            rects["mute"] = (m_x1, ms_y1, m_x2, ms_y2)
            rects["solo"] = (s_x1, ms_y1, s_x2, ms_y2)
        return rects

    def _draw_track_row(self, kind, idx, row_top, row_h, label):
        """Paint one per-track row of controls. `kind` is 'video' or
        'audio'; `idx` is the track index; `label` is the short tag
        that goes inside the target chip ('V1', 'A1', ...)."""
        from sb_canvas import (
            COL_BG_RAIL,
            COL_RAIL_CHIP_OFF, COL_RAIL_CHIP_ON,
            COL_RAIL_CHIP_LABEL, COL_RAIL_CHIP_LABEL_ON,
            COL_RAIL_ICON_OFF, COL_RAIL_ICON_ON, COL_RAIL_ICON_HOVER,
            COL_RAIL_SOLO_ON, COL_RAIL_MUTE_ON,
            _TEXT_BG_TRANS,
        )
        attrs = self._track_attrs(kind, idx)
        rects = self._track_row_rects(row_top, row_h, kind)
        hover   = self._track_ctrl_hover
        pressed = self._track_ctrl_pressed

        def _ctrl_color(name, on_color, off_color=COL_RAIL_ICON_OFF):
            """Pick a pen color for control `name` based on its
            on/off state plus hover/press chrome."""
            key = (kind, idx, name)
            base = on_color if name == "chip_state_marker" else \
                   (on_color if attrs.get(name, False) else off_color)
            if pressed == key:
                return on_color
            if hover == key and not attrs.get(name, False):
                return COL_RAIL_ICON_HOVER
            return base

        # Target chip — colored block with the label inside. Cyan when
        # targeted, grey when not. Chip is the dominant rail affordance
        # so it gets the largest hit-target.
        cx1, cy1, cx2, cy2 = rects["chip"]
        chip_on = attrs["targeted"]
        chip_bg = COL_RAIL_CHIP_ON if chip_on else COL_RAIL_CHIP_OFF
        # Press feedback — darken/lighten by repainting with the
        # alternate state so the user sees the click registered before
        # release.
        if pressed == (kind, idx, "chip"):
            chip_bg = COL_RAIL_CHIP_OFF if chip_on else COL_RAIL_CHIP_ON
        self.DrawSetPen(chip_bg)
        self.DrawRectangle(cx1, cy1, cx2, cy2)
        # Label inside the chip — white on the cyan ON state, light
        # grey on the OFF state.
        chip_text_col = COL_RAIL_CHIP_LABEL_ON if chip_on else COL_RAIL_CHIP_LABEL
        self.DrawSetTextCol(chip_text_col, _TEXT_BG_TRANS or chip_bg)
        # Approximate centering: glyphs are ~6 px wide × 12 px tall in
        # C4D's default font. Two-char labels (V1, A1) center on a 30 px
        # chip with a 9 px left offset.
        text_x = cx1 + max(2, (cx2 - cx1 - 6 * max(1, len(label))) // 2)
        text_y = cy1 + (cy2 - cy1 - 12) // 2
        self.DrawText(label, text_x, text_y)

        # Lock — small padlock-style glyph. C4D 2026 GeUserArea has no
        # native glyph; we draw a simple rectangle + bow procedurally
        # so we don't need to ship icons yet. The body is a 2-tone
        # box; the bow is a thin half-circle approximation (two short
        # lines).
        lx1, ly1, lx2, ly2 = rects["lock"]
        locked = attrs["locked"]
        lock_col = COL_RAIL_ICON_ON if locked else COL_RAIL_ICON_OFF
        if hover == (kind, idx, "lock") and not locked:
            lock_col = COL_RAIL_ICON_HOVER
        if pressed == (kind, idx, "lock"):
            lock_col = COL_RAIL_ICON_ON if not locked else COL_RAIL_ICON_OFF
        self.DrawSetPen(lock_col)
        body_top = ly1 + (ly2 - ly1) // 2
        self.DrawRectangle(lx1 + 2, body_top, lx2 - 2, ly2 - 1)
        # Bow (shackle) — vertical sides + top. Open when unlocked
        # (right side detached), closed when locked.
        bow_top = ly1 + 1
        bow_left = lx1 + 3
        bow_right = lx2 - 3
        self.DrawLine(bow_left,  bow_top, bow_left,  body_top - 1)
        if locked:
            self.DrawLine(bow_right, bow_top, bow_right, body_top - 1)
        else:
            self.DrawLine(bow_right, bow_top + 2, bow_right, body_top - 1)
        self.DrawLine(bow_left + 1,  bow_top, bow_right - 1, bow_top)

        # Right-side cluster — eye for video, M+S for audio.
        if kind == "video":
            ex1, ey1, ex2, ey2 = rects["eye"]
            visible = attrs["visible"]
            eye_col = COL_RAIL_ICON_ON if visible else COL_RAIL_ICON_OFF
            if hover == (kind, idx, "eye") and visible:
                eye_col = COL_RAIL_ICON_HOVER
            if pressed == (kind, idx, "eye"):
                eye_col = COL_RAIL_ICON_OFF if visible else COL_RAIL_ICON_ON
            self.DrawSetPen(eye_col)
            # Open-eye glyph approximation: top arc (2 lines) + center
            # pupil dot, OR a single horizontal line + cross when hidden.
            ecx = (ex1 + ex2) // 2
            ecy = (ey1 + ey2) // 2
            if visible:
                self.DrawLine(ex1, ecy, ex2, ecy)
                # eye top + bottom lashes
                self.DrawLine(ex1 + 2, ecy - 2, ex2 - 2, ecy - 2)
                self.DrawLine(ex1 + 2, ecy + 2, ex2 - 2, ecy + 2)
                self.DrawRectangle(ecx - 1, ecy - 1, ecx + 1, ecy + 1)
            else:
                # Closed eye / hidden — a flat dash and a slash through.
                self.DrawLine(ex1, ecy, ex2, ecy)
                self.DrawLine(ex1, ey1, ex2, ey2)
        else:
            # Mute / Solo — two small lozenges, colored when active.
            mx1, my1, mx2, my2 = rects["mute"]
            muted = attrs["muted"]
            m_col = COL_RAIL_MUTE_ON if muted else COL_RAIL_ICON_OFF
            if hover == (kind, idx, "mute") and not muted:
                m_col = COL_RAIL_ICON_HOVER
            self.DrawSetPen(m_col)
            self.DrawRectangle(mx1, my1, mx2, my2)
            self.DrawSetTextCol(COL_BG_RAIL if muted else COL_RAIL_ICON_OFF,
                                _TEXT_BG_TRANS or m_col)
            self.DrawText("M", mx1 + 3, my1 + (my2 - my1 - 12) // 2)

            sx1, sy1, sx2, sy2 = rects["solo"]
            soloed = attrs["solo"]
            s_col = COL_RAIL_SOLO_ON if soloed else COL_RAIL_ICON_OFF
            if hover == (kind, idx, "solo") and not soloed:
                s_col = COL_RAIL_ICON_HOVER
            self.DrawSetPen(s_col)
            self.DrawRectangle(sx1, sy1, sx2, sy2)
            self.DrawSetTextCol(COL_BG_RAIL if soloed else COL_RAIL_ICON_OFF,
                                _TEXT_BG_TRANS or s_col)
            self.DrawText("S", sx1 + 3, sy1 + (sy2 - sy1 - 12) // 2)

    # ------------------------------------------------------------------
    # Drawing — primitives (used by DrawMsg and shot-block fallback)
    # ------------------------------------------------------------------

    def _draw_diagonal_hatch(self, x1, y1, x2, y2, stride, thickness=1):
        """Fill the rect [x1, y1, x2, y2] with a 45° diagonal hatch
        pattern, drawing one diagonal line every `stride` pixels.
        `thickness` controls line thickness — C4D's DrawLine is
        1-pixel wide, so each "thick" line is implemented as N
        parallel 1-pixel lines offset by 1 px horizontally.

        Used as a translucent-dim approximation when real alpha
        blending isn't available — the eye reads the gap-between-
        lines coverage as a darkening overlay rather than a solid
        block, so the timeline content underneath stays partly
        visible.

        Caller sets the pen color via DrawSetPen before calling.
        Each line is clipped to the rect's [x1, x2] range so lines
        don't extend past the rect's horizontal bounds into
        adjacent UI areas.
        """
        if x2 <= x1 or y2 <= y1 or stride < 1:
            return
        rect_h = y2 - y1
        # Quantize x_top to the stride grid so the hatch is stationary
        # across pans/zooms regardless of rect position.
        x_top_start = ((x1 - rect_h) // stride) * stride
        x_top = x_top_start
        while x_top <= x2:
            # Each thick line = N adjacent 1-px diagonals offset by
            # 1 px in x. Visually merges into a thicker stroke.
            for off in range(thickness):
                ax, ay = x_top + off,          y1
                bx, by = x_top + off + rect_h, y2
                if ax < x1:
                    ay = y1 + (x1 - ax)
                    ax = x1
                if bx > x2:
                    by = y2 - (bx - x2)
                    bx = x2
                if ax <= bx:
                    self.DrawLine(ax, ay, bx, by)
            x_top += stride

    def _draw_dashed_hline(self, x1, x2, y, on_px, off_px):
        """Horizontal dashed line via short DrawRectangle segments. C4D
        2026 Python's draw API has no native dash support; this is the
        simple approximation. Used for the orphan border."""
        if x2 <= x1:
            return
        cursor = x1
        on = True
        while cursor <= x2:
            seg = on_px if on else off_px
            end = min(x2, cursor + seg - 1)
            if on:
                self.DrawRectangle(cursor, y, end, y)
            cursor = end + 1
            on = not on

    def _draw_dashed_vline(self, x, y1, y2, on_px, off_px):
        if y2 <= y1:
            return
        cursor = y1
        on = True
        while cursor <= y2:
            seg = on_px if on else off_px
            end = min(y2, cursor + seg - 1)
            if on:
                self.DrawRectangle(x, cursor, x, end)
            cursor = end + 1
            on = not on

    # ------------------------------------------------------------------
    # Drawing — shot blocks (bitmap + procedural fallback)
    # ------------------------------------------------------------------

    def _draw_shot_block(self, shot, w, y_top, selected):
        from sb_canvas import (
            DEFAULT_SHOT_FRAMES, SHOT_HEIGHT, EDGE_BAND_PX,
            COL_SHOT_LABEL, COL_SHOT_LABEL_SELECTED, COL_SHOT_LABEL_ORPHAN,
            _TEXT_BG_TRANS,
        )
        in_f  = shot.get("in_frame", 0)
        out_f = shot.get("out_frame", DEFAULT_SHOT_FRAMES)
        # Resolve the camera's current name through the live ref cache —
        # in-session renames in the Object Manager reflect on the next
        # redraw without needing the user to restage the shot.
        doc   = c4d.documents.GetActiveDocument()
        name  = self._resolve_cam_name(shot, doc)
        orphan = self._is_orphan(shot, doc)
        if not name:
            name = shot.get("cam_name", "?")

        sx1, sx2 = self._shot_x_bounds(in_f, out_f, w)
        sy1 = y_top
        sy2 = y_top + SHOT_HEIGHT - 1

        # Body state (drives mid + the non-hovered edges):
        #   orphan > selected > normal
        # Hover does NOT change the body state — it only swaps the
        # specific edge slice the cursor is over. The user discovers
        # which edge is grabbable; the body stays informative about
        # selection / orphan.
        shot_id = shot.get("id")
        # Hover animation t (0..1) per side. The animation system
        # (driven by _set_hover_target / _anim_tick) decouples the raw
        # hover-band signal from the rendered fade.
        left_t  = self._hover_t_for(shot_id, "left")
        right_t = self._hover_t_for(shot_id, "right")
        if orphan and selected:
            base_state = "orphan-selected"
        elif orphan:
            base_state = "orphan"
        elif selected:
            base_state = "selected"
        else:
            base_state = "normal"

        rendered_via_bitmap = self._draw_block_bitmap(
            "shot", base_state,
            left_t, right_t,
            sx1, sy1, sx2, sy2)

        # Procedural fallback — the old rect/border path. Triggered when
        # a state's bitmaps failed to load (build script not run, or
        # missing PNGs). Keeps the timeline functional even when assets
        # are out of sync with the code.
        if not rendered_via_bitmap:
            self._draw_shot_block_procedural(
                shot_id, sx1, sy1, sx2, sy2, selected, orphan)

        # Orphan dashed border is now baked into the bitmap (the body's
        # mid slice is wide enough to capture one full dash cycle and
        # the plugin tiles it). Procedural dash drawing only kicks in
        # when bitmaps fail to load, via the procedural fallback path.

        # Camera glyph — bottom-left of the body, just inside the left
        # handle. Drawn procedurally because the SVG glyph falls outside
        # the slice boundaries (and would only render in the body's
        # 1-px-wide middle anyway). Orphan state uses a separate red
        # glyph variant if available; otherwise the regular glyph is
        # drawn anyway (the dashed border + label prefix still signal
        # the orphan state).
        if rendered_via_bitmap and not self._block_too_narrow_for_glyph(sx1, sx2):
            # Glyph picks its own state: orphan-selected > orphan >
            # selected > normal. Each variant falls back to the next-most-
            # specific glyph if absent (orphan-selected falls back to
            # orphan, etc.) so missing-asset states still render.
            if orphan and selected and "camera-orphan-selected" in self._glyph_bitmaps:
                glyph_name = "camera-orphan-selected"
            elif orphan and "camera-orphan" in self._glyph_bitmaps:
                glyph_name = "camera-orphan"
            elif selected and "camera-selected" in self._glyph_bitmaps:
                glyph_name = "camera-selected"
            else:
                glyph_name = "camera"
            glyph = self._glyph_bitmaps.get(glyph_name)
            if glyph is not None:
                gw = glyph.GetBw()
                gh = glyph.GetBh()
                # Glyph aligns left with the camera-name label and sits
                # near the bottom of the body (~7 px above the bottom).
                # The label x is computed below as `sx1 + band_w + 4`;
                # match that exactly so the two left edges line up.
                clip_w_g = sx2 - sx1
                band_w_g = max(1, min(EDGE_BAND_PX, clip_w_g // 3))
                gx = sx1 + band_w_g + 4
                gy = sy2 - 10 - gh + 1
                if gx + gw <= sx2 - EDGE_BAND_PX - 4:
                    try:
                        self.DrawBitmap(glyph, gx, gy, gw, gh,
                                        0, 0, gw, gh,
                                        c4d.BMP_NORMALSCALED | c4d.BMP_ALLOWALPHA)
                    except Exception as e:
                        print("[Shotblocks] glyph DrawBitmap failed: {}".format(e))

        # Procedural label. Bitmaps don't carry text; the label changes
        # when the user renames a camera in the Object Manager, so it
        # has to be drawn fresh each frame from the live name.
        clip_w = sx2 - sx1
        band_w = max(1, min(EDGE_BAND_PX, clip_w // 3))
        label_x_start = sx1 + band_w + 4
        label_x_end   = sx2 - band_w - 4
        inner_w       = label_x_end - label_x_start
        if inner_w > 0:
            if selected:
                label_color = COL_SHOT_LABEL_SELECTED
            elif orphan:
                label_color = COL_SHOT_LABEL_ORPHAN
            else:
                label_color = COL_SHOT_LABEL
            # Pass a transparent bg to DrawSetTextCol so it doesn't paint
            # a solid rect behind glyphs. The rect would overwrite the
            # bitmap's anti-aliased rounded-corner pixels with sharp
            # opaque #1C1C1C, producing a visible halo at the corners.
            # When COLOR_TRANS isn't available we fall back to fg=bg —
            # the glyph alpha makes the bg invisible.
            text_bg = _TEXT_BG_TRANS if _TEXT_BG_TRANS is not None else label_color
            self.DrawSetTextCol(label_color, text_bg)
            label = "(missing) " + name if orphan else name
            if self.DrawGetTextWidth(label) > inner_w:
                while len(label) > 1 and self.DrawGetTextWidth(label + "…") > inner_w:
                    label = label[:-1]
                label = label + "…"
            self.DrawText(label, label_x_start, sy1 + 4)

    def _draw_block_bitmap(self, kind, base_state,
                           left_t, right_t,
                           sx1, sy1, sx2, sy2):
        """Render a block at `base_state`. `left_t` and `right_t` are
        animation progress 0..1 between normal and hover for each edge.
        Picks the closest pre-baked fade frame for each side from the
        per-state frame list; mid stays at base_state.

        Returns True on success, False if any required body bitmap is
        missing (caller falls back to procedural)."""
        base = self._block_bitmaps.get((kind, base_state))
        if base is None:
            return False
        frames_l = base.get("left_frames")  or [base["left"]]
        frames_r = base.get("right_frames") or [base["right"]]
        n_l = max(1, len(frames_l))
        n_r = max(1, len(frames_r))
        idx_l = int(round(max(0.0, min(1.0, left_t))  * (n_l - 1)))
        idx_r = int(round(max(0.0, min(1.0, right_t)) * (n_r - 1)))
        left_bmp  = frames_l[idx_l]
        right_bmp = frames_r[idx_r]
        mid_bmp   = base["mid"]
        if left_bmp is None or mid_bmp is None or right_bmp is None:
            return False

        clip_w = sx2 - sx1
        edge_w = left_bmp.GetBw()
        if clip_w < 2 * edge_w:
            edge_w = max(1, clip_w // 2)
        edge_h = left_bmp.GetBh()
        body_h = sy2 - sy1 + 1

        right_x = sx2 - edge_w + 1
        mid_x   = sx1 + edge_w
        mid_w   = right_x - mid_x

        try:
            self.DrawBitmap(left_bmp, sx1, sy1, edge_w, body_h,
                            0, 0, left_bmp.GetBw(), edge_h,
                            c4d.BMP_NORMALSCALED | c4d.BMP_ALLOWALPHA)
            self.DrawBitmap(right_bmp, right_x, sy1, edge_w, body_h,
                            0, 0, right_bmp.GetBw(), edge_h,
                            c4d.BMP_NORMALSCALED | c4d.BMP_ALLOWALPHA)
            if mid_w > 0:
                src_w = mid_bmp.GetBw()
                if src_w <= 1:
                    # 1-px source: stretch to fill the gap (cheap; uniform
                    # color sources look identical to a tile here).
                    self.DrawBitmap(mid_bmp, mid_x, sy1, mid_w, body_h,
                                    0, 0, src_w, mid_bmp.GetBh(),
                                    c4d.BMP_NORMALSCALED | c4d.BMP_ALLOWALPHA)
                else:
                    # Multi-px source: tile across the gap so a horizontal
                    # pattern (e.g. orphan's dashed border) repeats at its
                    # designed cycle width instead of being stretched.
                    src_h = mid_bmp.GetBh()
                    cursor = mid_x
                    while cursor < right_x:
                        seg_w = min(src_w, right_x - cursor)
                        self.DrawBitmap(mid_bmp, cursor, sy1, seg_w, body_h,
                                        0, 0, seg_w, src_h,
                                        c4d.BMP_NORMALSCALED | c4d.BMP_ALLOWALPHA)
                        cursor += seg_w
        except Exception as e:
            print("[Shotblocks] block DrawBitmap failed: {}".format(e))
            return False
        return True

    def _block_too_narrow_for_glyph(self, sx1, sx2):
        """True when there isn't enough horizontal room for the camera
        glyph between the left and right handles (avoids the glyph
        crashing into the right handle on very short shots)."""
        from sb_canvas import EDGE_BAND_PX
        return (sx2 - sx1) < (2 * EDGE_BAND_PX + 28)

    def _label_bg_for_state(self, state, selected, orphan):
        """Background color for label antialiasing. Matches the SVG
        body fill exactly — `#1C1C1C` for all current shot states (the
        body color stays constant; only the handles change)."""
        from sb_canvas import COL_SHOT_BODY_FILL
        return COL_SHOT_BODY_FILL

    def _draw_shot_block_procedural(self, shot_id, sx1, sy1, sx2, sy2,
                                    selected, orphan):
        """Fallback draw path — used when bitmaps aren't available.
        Mirrors the pre-bitmap draw code so the timeline keeps working
        with SVG-pipeline assets missing."""
        from sb_canvas import (
            EDGE_BAND_PX, DASH_ORPHAN_ON, DASH_ORPHAN_OFF,
            COL_SHOT_FILL, COL_SHOT_FILL_SELECTED,
            COL_SHOT_FILL_ORPHAN, COL_SHOT_FILL_ORPHAN_SEL,
            COL_SHOT_BORDER, COL_SHOT_BORDER_ORPHAN,
            COL_SHOT_EDGE_BAND, COL_SHOT_EDGE_BAND_HOVER,
        )
        if selected and orphan:
            body_color = COL_SHOT_FILL_ORPHAN_SEL
        elif selected:
            body_color = COL_SHOT_FILL_SELECTED
        elif orphan:
            body_color = COL_SHOT_FILL_ORPHAN
        else:
            body_color = COL_SHOT_FILL
        self.DrawSetPen(body_color)
        self.DrawRectangle(sx1, sy1, sx2, sy2)

        clip_w = sx2 - sx1
        band_w = max(1, min(EDGE_BAND_PX, clip_w // 3))
        if clip_w >= 4:
            hover = self._hover_band
            left_hovered  = (hover == (shot_id, "left"))
            right_hovered = (hover == (shot_id, "right"))
            self.DrawSetPen(COL_SHOT_EDGE_BAND_HOVER if left_hovered  else COL_SHOT_EDGE_BAND)
            self.DrawRectangle(sx1, sy1, sx1 + band_w, sy2)
            self.DrawSetPen(COL_SHOT_EDGE_BAND_HOVER if right_hovered else COL_SHOT_EDGE_BAND)
            self.DrawRectangle(sx2 - band_w, sy1, sx2, sy2)

        if orphan:
            self.DrawSetPen(COL_SHOT_BORDER_ORPHAN)
            self._draw_dashed_hline(sx1, sx2, sy1, DASH_ORPHAN_ON, DASH_ORPHAN_OFF)
            self._draw_dashed_hline(sx1, sx2, sy2, DASH_ORPHAN_ON, DASH_ORPHAN_OFF)
            self._draw_dashed_vline(sx1, sy1, sy2, DASH_ORPHAN_ON, DASH_ORPHAN_OFF)
            self._draw_dashed_vline(sx2, sy1, sy2, DASH_ORPHAN_ON, DASH_ORPHAN_OFF)
        else:
            self.DrawSetPen(COL_SHOT_BORDER)
            self.DrawLine(sx1, sy1, sx2, sy1)
            self.DrawLine(sx1, sy2, sx2, sy2)
            self.DrawLine(sx1, sy1, sx1, sy2)
            self.DrawLine(sx2, sy1, sx2, sy2)
