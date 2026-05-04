"""Shotblocks timeline canvas.

The `ShotblocksTimelineCanvas` GeUserArea — drawing, hit-testing, drag
handlers (move / resize / marquee / pan / zoom / range-bar / playhead),
right-click context menu, keyboard shortcuts.

Imports the pure-function shot model from `sb_shot_model` and the helper-
null persistence from `sb_persistence`. Does NOT import anything from
`shotblocks.pyp` (the entry-point).
"""

import math

import c4d

from sb_shot_model import (
    MAX_TRACKS, MIN_SHOT_FRAMES,
    _make_shot, _shot_track, _displayed_lane_count,
    _resolve_position, _resolve_resize,
)
from sb_persistence import (
    _read_shots, _write_shots,
    _read_range, _write_range,
    _get_or_create_helper,
)


# ---------------------------------------------------------------------------
# Visual-language tokens (from .agent/design/visual-language.md)
# ---------------------------------------------------------------------------

def _rgb(hex6):
    return c4d.Vector(
        int(hex6[0:2], 16) / 255.0,
        int(hex6[2:4], 16) / 255.0,
        int(hex6[4:6], 16) / 255.0,
    )

COL_BG_TIMELINE   = _rgb("1a1a1a")
COL_BG_TRACK      = _rgb("222222")
COL_BG_TRACK_ALT  = _rgb("1e1e1e")
COL_BG_RULER      = _rgb("2a2a2a")
COL_BORDER_SUB    = _rgb("333333")
COL_RULER_TEXT    = _rgb("888888")
COL_CURSOR        = _rgb("ff6b6b")

# Untagged passthrough — every v3 shot still draws as untagged.
COL_SHOT_FILL     = _rgb("5a5a5a")
COL_SHOT_BORDER   = _rgb("7a7a7a")
COL_SHOT_LABEL    = _rgb("dddddd")

# Selection overlay (warm yellow, 2px) — sits on top of the state border.
COL_SELECTION     = _rgb("ffd966")

# Drop hint
COL_DROP_HINT     = _rgb("aaaaaa")

# Play-range bar
COL_RANGE_BAR     = _rgb("3a3a3a")
COL_RANGE_ACTIVE  = _rgb("5a5a4a")
COL_RANGE_HANDLE  = _rgb("aaaa8a")


# ---------------------------------------------------------------------------
# Layout constants
# ---------------------------------------------------------------------------

RANGE_HEIGHT        = 16          # play-range bar at the very top
RANGE_HANDLE_PX     = 6           # in/out handle hit-zone width
RULER_HEIGHT        = 24
RULER_Y_TOP         = RANGE_HEIGHT
SHOT_Y_TOP          = RANGE_HEIGHT + RULER_HEIGHT + 4
SHOT_HEIGHT         = 32
LANE_GAP            = 2
DEFAULT_SHOT_FRAMES = 48          # 2 s at 24 fps — good starting length
EDGE_HIT_PX         = 6           # leading/trailing edge-drag zone width
SNAP_PIXEL_RADIUS   = 8           # how close (in pixels) before magnetic snap pulls


# ---------------------------------------------------------------------------
# Right-click context menu item IDs (plugin-internal; any unused int works).
# ---------------------------------------------------------------------------

MENU_DELETE         = 3000
MENU_DUPLICATE      = 3001
MENU_SET_RANGE_THIS = 3002
MENU_SET_RANGE_SEL  = 3003
MENU_RANGE_TO_ALL   = 3004


# ---------------------------------------------------------------------------
# Input qualifier and key constants — verified empirically in C4D 2026.
# ---------------------------------------------------------------------------

# Qualifier bits: QSHIFT=1, QCTRL=2, QALT=4 (verified vs c4d.QSHIFT/QCTRL/QALT).
_QSHIFT = getattr(c4d, "QSHIFT", 0x1)
_QCTRL  = getattr(c4d, "QCTRL",  0x2)
_QALT   = getattr(c4d, "QALT",   0x4)

# MouseDragStart flag — may or may not exist in 2026 Python.
_MOUSE_DRAG_FLAG = getattr(c4d, "MOUSE_DRAG_NOMOVE_MSG_ON_MOUSEUP", 0)
_KEY_MLEFT   = getattr(c4d, "KEY_MLEFT",   61440)
_KEY_MRIGHT  = getattr(c4d, "KEY_MRIGHT",  61441)
_KEY_MMIDDLE = getattr(c4d, "KEY_MMIDDLE", 61442)

# Keyboard keys we care about — KEY_DELETE=61823, KEY_BACKSPACE=61704 in 2026.
_KEY_DELETE    = getattr(c4d, "KEY_DELETE",    None)
_KEY_BACKSPACE = getattr(c4d, "KEY_BACKSPACE", None)
_KEY_D         = getattr(c4d, "KEY_D",         None)


# ---------------------------------------------------------------------------
# Camera-detection helper (used by drag-receive)
# ---------------------------------------------------------------------------

def _is_camera_like(obj):
    try:
        if obj.CheckType(c4d.Ocamera):
            return True
    except Exception:
        pass
    try:
        if isinstance(obj, c4d.CameraObject):
            return True
    except Exception:
        pass
    try:
        if "camera" in obj.GetTypeName().lower():
            return True
    except Exception:
        pass
    return False


def _qualifier_mode(qualifier, snap_enabled=False):
    """Map a BFM_INPUT_QUALIFIER bitmask to overlap-policy mode string.

    - Default (no modifier, snap off): replace.
    - Shift held: ripple (overrides snap toggle).
    - Snap toggle on (no Shift): snap-to-edge.
    - Alt is reserved for zoom (C4D timeline convention) and does NOT bind to
      a policy mode — Alt-drags go to the zoom path before this is consulted.
    """
    if qualifier & _QSHIFT:
        return "ripple"
    if snap_enabled:
        return "snap"
    return "replace"


# ---------------------------------------------------------------------------
# GeUserArea canvas
# ---------------------------------------------------------------------------

class ShotblocksTimelineCanvas(c4d.gui.GeUserArea):
    _NICE_STEPS = (1, 2, 5, 10, 12, 24, 30, 60, 120, 240, 480, 1200, 2400)

    # Class-level once-flags / shared state for diagnostics.
    _drag_shape_logged = False
    _constants_dumped  = False
    _channel_logged    = set()
    _popup_api_logged  = False

    def __init__(self):
        super().__init__()
        # One-time constants dump (helps identify the actual values in C4D 2026)
        if not ShotblocksTimelineCanvas._constants_dumped:
            ShotblocksTimelineCanvas._constants_dumped = True
            for name in ("QSHIFT", "QCTRL", "QALT",
                         "BFM_INPUT_MOUSE", "BFM_INPUT_KEYBOARD",
                         "BFM_INPUT_MOUSELEFT", "BFM_INPUT_MOUSERIGHT",
                         "BFM_INPUT_MOUSEMIDDLE", "BFM_INPUT_MOUSEWHEEL",
                         "BFM_INPUT_QUALIFIER", "BFM_INPUT_VALUE",
                         "KEY_MLEFT", "KEY_MMIDDLE", "KEY_MRIGHT",
                         "KEY_DELETE", "KEY_BACKSPACE", "KEY_D"):
                v = getattr(c4d, name, "MISSING")
                print("[Shotblocks] c4d.{} = {!r}".format(name, v))

        self.visible_first  = 0
        self.visible_last   = 240
        self.playhead_frame = 60

        # Drag-receive (Object Manager → canvas) state
        self._drag_over   = False
        self._drag_frame  = -1
        self._drag_track  = 0

        # Selection — a set of shot ids. Empty = nothing selected.
        self._selected_ids = set()

        # Marquee drag state — non-None during a marquee, holds (x0, y0, x1, y1).
        self._marquee_rect = None

        # Drag preview overrides — if non-None, DrawMsg uses these instead of doc
        self._preview_shots = None
        self._preview_range = None  # (in_frame, out_frame) or None

        # Snap-to-edge toggle (UI checkbox in toolbar). When on, no-modifier
        # drops/moves use snap-to-edge instead of replace.
        self._snap_enabled = False

        # Once-per-type drag-debug log
        self._logged_obj_types = set()

    # ------------------------------------------------------------------
    # Coordinate helpers
    # ------------------------------------------------------------------

    def _frame_to_x(self, frame, w):
        span = max(1, self.visible_last - self.visible_first)
        return int((frame - self.visible_first) / span * w)

    def _x_to_frame(self, x, w):
        span = max(1, self.visible_last - self.visible_first)
        return self.visible_first + int(x / max(1, w) * span)

    def _frames_per_pixel(self, w):
        span = max(1, self.visible_last - self.visible_first)
        return span / max(1, w)

    def _snap_frames(self):
        """Convert SNAP_PIXEL_RADIUS to a frame count at the current zoom."""
        w = self.GetWidth()
        if w <= 0:
            return 0
        return max(1, int(round(SNAP_PIXEL_RADIUS * self._frames_per_pixel(w))))

    def _get_preview_range_or_doc(self):
        if self._preview_range is not None:
            return self._preview_range
        return _read_range(c4d.documents.GetActiveDocument())

    def _pick_tick_step(self, w, target_px=80):
        span = max(1, self.visible_last - self.visible_first)
        if w <= 0:
            return self._NICE_STEPS[-1]
        target_frames = target_px * span / w
        for s in self._NICE_STEPS:
            if s >= target_frames:
                return s
        return self._NICE_STEPS[-1]

    # Track-lane Y geometry — track 0 sits at the BOTTOM (NLE convention).
    def _track_y_top(self, track, lane_count):
        flipped = (lane_count - 1) - track
        return SHOT_Y_TOP + flipped * (SHOT_HEIGHT + LANE_GAP)

    def _y_to_track(self, y, lane_count):
        if y < SHOT_Y_TOP:
            return lane_count - 1
        flipped = (y - SHOT_Y_TOP) // (SHOT_HEIGHT + LANE_GAP)
        flipped = max(0, min(lane_count - 1, int(flipped)))
        return (lane_count - 1) - flipped

    # ------------------------------------------------------------------
    # Hit testing
    # ------------------------------------------------------------------

    def _hit_test_range(self, x, y, w):
        """Range-bar hit test. Returns 'in', 'out', 'body', or None.
        Body hit is the active span between handles."""
        if y < 0 or y >= RANGE_HEIGHT:
            return None
        range_in, range_out = self._get_preview_range_or_doc()
        rin_x  = self._frame_to_x(range_in,  w)
        rout_x = self._frame_to_x(range_out, w)
        d_in  = abs(x - rin_x)
        d_out = abs(x - rout_x)
        # Handles win over body. Closer handle wins when zones overlap.
        if d_in <= RANGE_HANDLE_PX and d_in <= d_out:
            return "in"
        if d_out <= RANGE_HANDLE_PX:
            return "out"
        if rin_x < x < rout_x:
            return "body"
        return None

    def _hit_test(self, x, y, shots, w):
        """Return (shot_id, region) where region is 'body' / 'left' / 'right',
        or (None, None) if no hit."""
        lane_count = _displayed_lane_count(shots)
        for shot in shots:
            track = _shot_track(shot)
            sy_top = self._track_y_top(track, lane_count)
            sy_bot = sy_top + SHOT_HEIGHT - 1
            if y < sy_top or y > sy_bot:
                continue
            sx1 = self._frame_to_x(shot["in_frame"], w)
            sx2 = self._frame_to_x(shot["out_frame"], w)
            if sx2 < sx1 + 2:
                sx2 = sx1 + 2
            if x < sx1 or x > sx2:
                continue
            edge_zone = min(EDGE_HIT_PX, max(1, (sx2 - sx1) // 3))
            if x <= sx1 + edge_zone:
                return shot["id"], "left"
            if x >= sx2 - edge_zone:
                return shot["id"], "right"
            return shot["id"], "body"
        return None, None

    # ------------------------------------------------------------------
    # Drawing
    # ------------------------------------------------------------------

    def DrawMsg(self, x1, y1, x2, y2, msg):
        self.OffScreenOn()
        w = self.GetWidth()
        h = self.GetHeight()

        # Background
        self.DrawSetPen(COL_BG_TIMELINE)
        self.DrawRectangle(0, 0, w, h)

        # Play-range bar at the very top
        range_in, range_out = self._get_preview_range_or_doc()
        self.DrawSetPen(COL_RANGE_BAR)
        self.DrawRectangle(0, 0, w, RANGE_HEIGHT)
        rin_x  = self._frame_to_x(range_in,  w)
        rout_x = self._frame_to_x(range_out, w)
        if rout_x < rin_x:
            rin_x, rout_x = rout_x, rin_x
        self.DrawSetPen(COL_RANGE_ACTIVE)
        self.DrawRectangle(rin_x, 0, rout_x, RANGE_HEIGHT)
        # Handles flanking the active region
        self.DrawSetPen(COL_RANGE_HANDLE)
        self.DrawRectangle(max(0, rin_x  - 2), 0, rin_x  + 1, RANGE_HEIGHT)
        self.DrawRectangle(rout_x - 1, 0, min(w, rout_x + 2), RANGE_HEIGHT)
        # Bottom border separating range bar from ruler
        self.DrawSetPen(COL_BORDER_SUB)
        self.DrawLine(0, RANGE_HEIGHT, w, RANGE_HEIGHT)

        # Ruler band (now starts below the range bar)
        ruler_top = RULER_Y_TOP
        ruler_bot = RULER_Y_TOP + RULER_HEIGHT
        self.DrawSetPen(COL_BG_RULER)
        self.DrawRectangle(0, ruler_top, w, ruler_bot)
        self.DrawSetPen(COL_BORDER_SUB)
        self.DrawLine(0, ruler_bot, w, ruler_bot)

        # Frame ticks and labels
        self.DrawSetTextCol(COL_RULER_TEXT, COL_BG_RULER)
        step = self._pick_tick_step(w)
        first_tick = ((self.visible_first + step - 1) // step) * step
        for frame in range(first_tick, self.visible_last + 1, step):
            tx = self._frame_to_x(frame, w)
            self.DrawLine(tx, ruler_bot - 6, tx, ruler_bot - 1)
            label = str(frame)
            text_w = self.DrawGetTextWidth(label)
            label_x = tx + 3
            if label_x + text_w > w:
                label_x = tx - text_w - 3
            self.DrawText(label, label_x, ruler_top + 4)

        # Shots + lane backgrounds (use preview override during active drag)
        if self._preview_shots is not None:
            shots = self._preview_shots
        else:
            doc = c4d.documents.GetActiveDocument()
            shots, _ = _read_shots(doc)
        lane_count = _displayed_lane_count(shots)

        # Lane backgrounds (alternating) and separators
        for track in range(lane_count):
            yt = self._track_y_top(track, lane_count)
            yb = yt + SHOT_HEIGHT
            bg = COL_BG_TRACK if (track % 2 == 0) else COL_BG_TRACK_ALT
            self.DrawSetPen(bg)
            self.DrawRectangle(0, yt, w, yb)
            self.DrawSetPen(COL_BORDER_SUB)
            self.DrawLine(0, yb, w, yb)

        # Shots
        for shot in shots:
            track  = _shot_track(shot)
            yt     = self._track_y_top(track, lane_count)
            self._draw_shot_block(shot, w, yt, shot["id"] in self._selected_ids)

        # Marquee selection rectangle (1px warm-yellow outline)
        if self._marquee_rect is not None:
            mx0, my0, mx1, my1 = self._marquee_rect
            rx1, ry1 = min(mx0, mx1), min(my0, my1)
            rx2, ry2 = max(mx0, mx1), max(my0, my1)
            self.DrawSetPen(COL_SELECTION)
            self.DrawLine(rx1, ry1, rx2, ry1)
            self.DrawLine(rx1, ry2, rx2, ry2)
            self.DrawLine(rx1, ry1, rx1, ry2)
            self.DrawLine(rx2, ry1, rx2, ry2)

        # Drop hint: vertical line at drag frame position, in the dragged track
        if self._drag_over and self._drag_frame >= 0:
            dx = self._frame_to_x(self._drag_frame, w)
            self.DrawSetPen(COL_DROP_HINT)
            self.DrawLine(dx, RULER_Y_TOP + RULER_HEIGHT, dx, h)
            # Highlight target lane
            yt = self._track_y_top(self._drag_track, lane_count)
            self.DrawLine(0, yt, w, yt)
            self.DrawLine(0, yt + SHOT_HEIGHT, w, yt + SHOT_HEIGHT)

        # Playhead (always on top)
        self.DrawSetPen(COL_CURSOR)
        px = self._frame_to_x(self.playhead_frame, w)
        self.DrawLine(px, 0, px, h)

    def _draw_shot_block(self, shot, w, y_top, selected):
        in_f  = shot.get("in_frame", 0)
        out_f = shot.get("out_frame", DEFAULT_SHOT_FRAMES)
        name  = shot.get("cam_name", "?")

        sx1 = self._frame_to_x(in_f, w)
        sx2 = self._frame_to_x(out_f, w)
        if sx2 < sx1 + 2:
            sx2 = sx1 + 2
        sy1 = y_top
        sy2 = y_top + SHOT_HEIGHT - 1

        # Fill
        self.DrawSetPen(COL_SHOT_FILL)
        self.DrawRectangle(sx1, sy1, sx2, sy2)

        # State border
        self.DrawSetPen(COL_SHOT_BORDER)
        self.DrawLine(sx1, sy1, sx2, sy1)
        self.DrawLine(sx1, sy2, sx2, sy2)
        self.DrawLine(sx1, sy1, sx1, sy2)
        self.DrawLine(sx2, sy1, sx2, sy2)

        # Selection overlay (warm yellow, 2px) — sits on top of the state border
        if selected:
            self.DrawSetPen(COL_SELECTION)
            for off in (0, 1):
                self.DrawLine(sx1 - off, sy1 - off, sx2 + off, sy1 - off)
                self.DrawLine(sx1 - off, sy2 + off, sx2 + off, sy2 + off)
                self.DrawLine(sx1 - off, sy1 - off, sx1 - off, sy2 + off)
                self.DrawLine(sx2 + off, sy1 - off, sx2 + off, sy2 + off)

        # Label (truncate with ellipsis when too wide)
        inner_w = sx2 - sx1 - 12
        if inner_w > 0:
            self.DrawSetTextCol(COL_SHOT_LABEL, COL_SHOT_FILL)
            label = name
            if self.DrawGetTextWidth(label) > inner_w:
                while len(label) > 1 and self.DrawGetTextWidth(label + "…") > inner_w:
                    label = label[:-1]
                label = label + "…"
            self.DrawText(label, sx1 + 6, sy1 + 4)

    # ------------------------------------------------------------------
    # Drag-receive (Object Manager → canvas)
    # ------------------------------------------------------------------

    def Message(self, msg, result):
        try:
            msg_id = msg.GetId()
        except Exception:
            return super().Message(msg, result)

        if msg_id == c4d.BFM_DRAGRECEIVE:
            try:
                return self._on_drag_receive(msg, result)
            except Exception as e:
                print("[Shotblocks] drag-receive error: {}".format(e))
                return False

        return super().Message(msg, result)

    def _on_drag_receive(self, msg, result):
        if msg.GetInt32(c4d.BFM_DRAG_LOST) or msg.GetInt32(c4d.BFM_DRAG_ESC):
            self._clear_drag()
            return True

        cameras = self._drag_cameras(msg)
        if not cameras:
            self._clear_drag()
            return False

        local_xy = self._get_drag_local_xy(msg)
        if local_xy is not None:
            x, y = local_xy
            doc = c4d.documents.GetActiveDocument()
            shots, _ = _read_shots(doc)
            lane_count = _displayed_lane_count(shots)
            self._drag_over  = True
            self._drag_frame = self._x_to_frame(x, self.GetWidth())
            self._drag_track = self._y_to_track(y, lane_count)

        finished = bool(msg.GetInt32(c4d.BFM_DRAG_FINISHED))
        if not finished:
            try:
                self.SetDragDestination(c4d.MOUSE_POINT_HAND)
            except Exception:
                pass
            self.Redraw()
            return True

        drop_frame = self._drag_frame if self._drag_frame >= 0 else self.visible_first
        drop_track = self._drag_track
        self._clear_drag()
        return self._create_shots_at(drop_frame, drop_track, cameras)

    def _drag_cameras(self, msg):
        try:
            drag_info = self.GetDragObject(msg)
        except Exception as e:
            print("[Shotblocks] GetDragObject error: {}".format(e))
            return []

        if isinstance(drag_info, dict):
            drag_type = drag_info.get("type", drag_info.get("dragtype"))
            drag_obj  = drag_info.get("object", drag_info.get("dragobject"))
        elif isinstance(drag_info, (list, tuple)) and len(drag_info) >= 2:
            drag_type, drag_obj = drag_info[0], drag_info[1]
        else:
            return []

        if drag_type != c4d.DRAGTYPE_ATOMARRAY:
            return []

        if not isinstance(drag_obj, (list, tuple)):
            drag_obj = [drag_obj] if drag_obj is not None else []

        cameras = []
        for o in drag_obj:
            if not isinstance(o, c4d.BaseObject):
                continue
            try:
                t = o.GetType()
                if t not in self._logged_obj_types:
                    self._logged_obj_types.add(t)
                    print("[Shotblocks] dragged object type={} name='{}' typename='{}'".format(
                        t, o.GetName(), o.GetTypeName()))
            except Exception:
                pass
            if _is_camera_like(o):
                cameras.append(o)
        return cameras

    def _get_drag_local_xy(self, msg):
        try:
            info = self.GetDragPosition(msg)
            if isinstance(info, dict):
                return info.get("x"), info.get("y")
            if isinstance(info, (list, tuple)) and len(info) >= 2:
                return info[0], info[1]
        except Exception:
            pass
        try:
            sx = msg.GetInt32(c4d.BFM_DRAG_SCREENX)
            sy = msg.GetInt32(c4d.BFM_DRAG_SCREENY)
            origin = self.Local2Global()
            if isinstance(origin, dict):
                return sx - origin.get("x", 0), sy - origin.get("y", 0)
        except Exception:
            pass
        return None

    def _create_shots_at(self, drop_frame, drop_track, cameras):
        doc  = c4d.documents.GetActiveDocument()
        shots, next_id = _read_shots(doc)

        doc.StartUndo()
        # Ensure helper exists; first-create is silent (no undo entry).
        _ = _get_or_create_helper(doc)

        for cam in cameras:
            new_shot = _make_shot(
                shot_id=next_id,
                in_frame=drop_frame,
                out_frame=drop_frame + DEFAULT_SHOT_FRAMES,
                cam_name=cam.GetName(),
                track=max(0, min(MAX_TRACKS - 1, drop_track)),
            )
            shots.append(new_shot)
            drop_mode  = "snap" if self._snap_enabled else "replace"
            snap_frames = self._snap_frames() if drop_mode == "snap" else 0
            shots = _resolve_position(shots, new_shot["id"],
                                      new_shot["in_frame"],
                                      new_shot["track"], drop_mode, snap_frames)
            print("[Shotblocks] created shot id={} cam='{}' frames={}-{} track={}".format(
                next_id, cam.GetName(), drop_frame, drop_frame + DEFAULT_SHOT_FRAMES,
                new_shot["track"]))
            next_id += 1

        _write_shots(doc, shots, next_id, with_undo=True)
        doc.EndUndo()
        c4d.EventAdd()
        self.Redraw()
        return True

    def _clear_drag(self):
        if self._drag_over or self._drag_frame >= 0:
            self._drag_over  = False
            self._drag_frame = -1
            self.Redraw()

    # ------------------------------------------------------------------
    # Input — mouse and keyboard
    # ------------------------------------------------------------------

    def InputEvent(self, msg):
        try:
            device = msg.GetInt32(c4d.BFM_INPUT_DEVICE)
        except Exception:
            return False

        if device == c4d.BFM_INPUT_MOUSE:
            return self._on_mouse(msg)
        if device == c4d.BFM_INPUT_KEYBOARD:
            return self._on_keyboard(msg)
        return False

    def _on_mouse(self, msg):
        try:
            channel   = msg.GetInt32(c4d.BFM_INPUT_CHANNEL)
            x         = msg.GetInt32(c4d.BFM_INPUT_X)
            y         = msg.GetInt32(c4d.BFM_INPUT_Y)
            qualifier = msg.GetInt32(c4d.BFM_INPUT_QUALIFIER)
        except Exception as e:
            print("[Shotblocks] mouse event read failed: {}".format(e))
            return False

        # x,y from BFM_INPUT_X/Y in C4D 2026 are global; convert to local.
        try:
            origin = self.Local2Global()
            if isinstance(origin, dict):
                x -= origin.get("x", 0)
                y -= origin.get("y", 0)
        except Exception:
            pass

        # Mouse wheel — scroll value in BFM_INPUT_VALUE.
        if channel == c4d.BFM_INPUT_MOUSEWHEEL:
            try:
                delta = msg.GetFloat(c4d.BFM_INPUT_VALUE)
            except Exception:
                delta = 0
            print("[Shotblocks] wheel delta={} qual={:#x}".format(delta, qualifier))
            alt_held = bool(qualifier & _QALT)
            if alt_held:
                self._zoom_around_cursor(x, delta)
            else:
                # Plain wheel = horizontal pan. delta>0 = scroll up = pan left
                # (earlier frames into view) — matches DAW/NLE wheel-pan feel.
                self._pan_by_wheel(delta)
            return True

        if channel == c4d.BFM_INPUT_MOUSELEFT:
            return self._on_left_press(x, y, qualifier)

        if channel == c4d.BFM_INPUT_MOUSERIGHT:
            return self._on_right_press(x, y, qualifier)

        # MMB drag is intercepted by C4D's framework before reaching GeUserArea's
        # drag system (verified empirically: MouseDrag returns state=2 immediately
        # for MMB regardless of Alt). Pan is on the wheel and Alt+LMB instead.

        if channel not in ShotblocksTimelineCanvas._channel_logged:
            ShotblocksTimelineCanvas._channel_logged.add(channel)
            print("[Shotblocks] unhandled mouse channel={} qual={:#x} at ({},{})".format(
                channel, qualifier, x, y))
        return False

    def _on_right_press(self, x, y, qualifier):
        # Alt+RMB drag = zoom (C4D viewport/timeline convention) — pivots around click.
        if qualifier & _QALT:
            print("[Shotblocks] Alt+RMB at ({},{}) → zoom drag".format(x, y))
            self._drag_zoom(x, y)
            return True
        # Plain RMB → context menu.
        return self._open_context_menu(x, y)

    def _open_context_menu(self, x, y):
        """Right-click context menu. v4b items: Set Range to This / Selection /
        All, Delete, Duplicate (Set-Range-to-All is the only entry on empty
        canvas)."""
        w = self.GetWidth()
        doc = c4d.documents.GetActiveDocument()
        shots, _ = _read_shots(doc)
        shot_id, _region = self._hit_test(x, y, shots, w)
        print("[Shotblocks] RMB press at ({},{}) hit={}".format(x, y, shot_id))

        bc = c4d.BaseContainer()

        if shot_id is None:
            # Empty-canvas menu: just "Range to All" for v4b.
            bc.SetString(MENU_RANGE_TO_ALL, "Range to All")
        else:
            # If clicked shot isn't in selection, replace selection with just it.
            if shot_id not in self._selected_ids:
                self._selected_ids = {shot_id}
                self.Redraw()

            n = len(self._selected_ids)
            suffix = " ({})".format(n) if n > 1 else ""
            if n > 1:
                bc.SetString(MENU_SET_RANGE_SEL,  "Set Range to Selection" + suffix)
            else:
                bc.SetString(MENU_SET_RANGE_THIS, "Set Range to This")
            bc.SetString(MENU_DELETE,    "Delete"    + suffix)
            bc.SetString(MENU_DUPLICATE, "Duplicate" + suffix)

        result = self._show_popup(bc, x, y)
        self._dispatch_menu_result(result, doc, shots)
        return True

    def _show_popup(self, bc, x, y):
        """Convert canvas-local coords to monitor screen via Local2Screen and
        invoke ShowPopupDialog. Returns the selected menu id, or 0 on dismiss."""
        sx, sy = x, y
        try:
            scr = self.Local2Screen()
            if isinstance(scr, dict):
                sx = x + scr.get("x", 0)
                sy = y + scr.get("y", 0)
            elif isinstance(scr, (list, tuple)) and len(scr) >= 2:
                sx = x + int(scr[0])
                sy = y + int(scr[1])
        except Exception as e:
            print("[Shotblocks] Local2Screen err: {}".format(e))

        try:
            return c4d.gui.ShowPopupDialog(cd=None, bc=bc, x=sx, y=sy)
        except Exception as e:
            print("[Shotblocks] ShowPopupDialog raised: {}".format(e))
            return 0

    def _dispatch_menu_result(self, result, doc, shots):
        if result in (None, 0):
            return
        if result == MENU_DELETE:
            self._delete_selected()
        elif result == MENU_DUPLICATE:
            self._duplicate_selected()
        elif result == MENU_SET_RANGE_THIS:
            sel = [s for s in shots if s["id"] in self._selected_ids]
            if sel:
                s = sel[0]
                self._set_range(doc, s["in_frame"], s["out_frame"])
        elif result == MENU_SET_RANGE_SEL:
            sel = [s for s in shots if s["id"] in self._selected_ids]
            if sel:
                in_f  = min(s["in_frame"]  for s in sel)
                out_f = max(s["out_frame"] for s in sel)
                self._set_range(doc, in_f, out_f)
        elif result == MENU_RANGE_TO_ALL:
            if shots:
                in_f  = min(s["in_frame"]  for s in shots)
                out_f = max(s["out_frame"] for s in shots)
                self._set_range(doc, in_f, out_f)

    def _set_range(self, doc, in_f, out_f):
        """One-shot range write with undo. Used by menu items and I/O hotkeys."""
        in_f  = max(0, int(in_f))
        out_f = max(in_f + 1, int(out_f))
        cur_in, cur_out = _read_range(doc)
        if (cur_in, cur_out) == (in_f, out_f):
            return
        doc.StartUndo()
        _write_range(doc, in_f, out_f, with_undo=True)
        doc.EndUndo()
        c4d.EventAdd()
        self.Redraw()
        print("[Shotblocks] range set to [{}, {}]".format(in_f, out_f))

    def _on_keyboard(self, msg):
        try:
            channel   = msg.GetInt32(c4d.BFM_INPUT_CHANNEL)
            qualifier = msg.GetInt32(c4d.BFM_INPUT_QUALIFIER)
        except Exception:
            return False

        # Delete / Backspace → delete selected. Verified empirically in C4D 2026:
        # KEY_DELETE = 61823, KEY_BACKSPACE = 61704.
        if channel in (_KEY_DELETE, _KEY_BACKSPACE):
            self._delete_selected()
            return True

        # Ctrl+D → duplicate selected. KEY_D constant doesn't exist in 2026,
        # but the channel is the ASCII code for 'D' (68 = 0x44).
        if (qualifier & _QCTRL) and channel == ord('D'):
            self._duplicate_selected(qualifier=qualifier)
            return True

        # I / O → set in/out at the current playhead frame (no qualifier required).
        # Constitution principle 5: optional accelerators, never the only path.
        if not (qualifier & (_QCTRL | _QALT)):
            doc = c4d.documents.GetActiveDocument()
            cur_in, cur_out = _read_range(doc)
            if channel == ord('I'):
                new_in = max(0, min(self.playhead_frame, cur_out - 1))
                self._set_range(doc, new_in, cur_out)
                return True
            if channel == ord('O'):
                new_out = max(cur_in + 1, self.playhead_frame)
                self._set_range(doc, cur_in, new_out)
                return True

        return False

    # ------------------------------------------------------------------
    # Click / drag — left button
    # ------------------------------------------------------------------

    def _on_left_press(self, x, y, qualifier):
        # Alt+LMB drag = pan, overrides hit-test (unifies with Alt+RMB zoom
        # and Alt+wheel zoom — Alt is the canvas navigation modifier).
        if qualifier & _QALT:
            print("[Shotblocks] Alt+LMB at ({},{}) → pan drag".format(x, y))
            self._drag_pan(x, y)
            return True

        w = self.GetWidth()

        # Range-bar interactions take priority when y is in the range band.
        if y < RANGE_HEIGHT:
            region = self._hit_test_range(x, y, w)
            print("[Shotblocks] LMB on range bar at ({},{}) hit={}".format(x, y, region))
            if region == "in":
                self._drag_range_handle("in", x, y)
            elif region == "out":
                self._drag_range_handle("out", x, y)
            elif region == "body":
                self._drag_range_body(x, y)
            return True

        # Ruler band → scrub the playhead (click + drag).
        if RULER_Y_TOP <= y < RULER_Y_TOP + RULER_HEIGHT:
            self._drag_playhead(x, y)
            return True

        doc = c4d.documents.GetActiveDocument()
        shots, _ = _read_shots(doc)
        shot_id, region = self._hit_test(x, y, shots, w)
        shift_held = bool(qualifier & _QSHIFT)
        print("[Shotblocks] LMB press at ({},{}) hit={}/{} shift={}".format(
            x, y, shot_id, region, shift_held))

        if shot_id is None:
            # Plain LMB on empty canvas → marquee drag (Shift adds to selection).
            self._drag_marquee(x, y, additive=shift_held)
            return True

        # Hit a shot. Selection update depends on Shift.
        if shift_held:
            # Toggle this shot in/out of selection
            if shot_id in self._selected_ids:
                self._selected_ids.discard(shot_id)
            else:
                self._selected_ids.add(shot_id)
            self.Redraw()
            # Don't drag-move on shift-click — it's a selection gesture only.
            return True

        # Plain click → single-select if not already in selection.
        if shot_id not in self._selected_ids:
            self._selected_ids = {shot_id}
            self.Redraw()
        # If already in a multi-selection, leave selection alone — the user is
        # about to drag a member; drag-move still operates on this single shot.

        if region == "body":
            self._drag_move(shot_id, x, y)
        elif region in ("left", "right"):
            self._drag_resize(shot_id, region, x, y)
        return True

    # ------------------------------------------------------------------
    # Drag loops — uses MouseDragStart / MouseDrag / MouseDragEnd
    # ------------------------------------------------------------------

    def _drag_loop(self, button_key, mx, my, on_tick):
        """Generic drag-poll loop. Calls on_tick(accum_dx, accum_dy, qualifier)
        per motion update. Returns (final_dx, final_dy, final_qualifier) or None
        on failure."""
        try:
            self.MouseDragStart(button_key, mx, my, _MOUSE_DRAG_FLAG)
        except Exception as e:
            print("[Shotblocks] MouseDragStart EXC: {}: {}".format(type(e).__name__, e))
            return None

        accum_dx = 0
        accum_dy = 0
        last_qualifier = 0
        ticks = 0
        while True:
            try:
                state = self.MouseDrag()
            except Exception as e:
                print("[Shotblocks] MouseDrag EXC tick={}: {}: {}".format(
                    ticks, type(e).__name__, e))
                break

            if not ShotblocksTimelineCanvas._drag_shape_logged:
                ShotblocksTimelineCanvas._drag_shape_logged = True
                print("[Shotblocks] MouseDrag returned: {!r} (type={})".format(
                    state, type(state).__name__))
                if isinstance(state, (list, tuple)):
                    print("[Shotblocks]   tuple len={}, contents=[{}]".format(
                        len(state),
                        ", ".join("{}={!r}".format(i, v) for i, v in enumerate(state))))
                consts = {n: getattr(c4d, n) for n in dir(c4d)
                          if n.startswith("MOUSE_DRAG_")}
                print("[Shotblocks]   c4d.MOUSE_DRAG_* = {}".format(consts))

            drag_state, dx, dy, channels = self._parse_drag_state(state)

            if self._is_drag_terminal(drag_state):
                ticks += 1
                last_qualifier = channels or last_qualifier
                break

            accum_dx += int(dx or 0)
            accum_dy += int(dy or 0)
            if channels:
                last_qualifier = channels
            ticks += 1
            on_tick(accum_dx, accum_dy, last_qualifier)

        try:
            self.MouseDragEnd()
        except Exception as e:
            print("[Shotblocks] MouseDragEnd EXC: {}".format(e))

        return accum_dx, accum_dy, last_qualifier

    @staticmethod
    def _parse_drag_state(state):
        """Returns (drag_state, dx, dy, qualifier_int).
        C4D 2026 convention (verified empirically):
        - state is a 4-tuple (int_state, float_dx, float_dy, BaseContainer)
        - dx/dy are sign-inverted relative to screen direction — negate them so
          callers can use natural "positive = right/down" semantics
        - qualifier lives inside the BaseContainer at BFM_INPUT_QUALIFIER
        """
        drag_state, dx, dy, channels = 0, 0, 0, 0
        if isinstance(state, (list, tuple)):
            if len(state) >= 1: drag_state = state[0]
            if len(state) >= 2: dx = state[1]
            if len(state) >= 3: dy = state[2]
            if len(state) >= 4: channels = state[3]
        elif isinstance(state, dict):
            drag_state = state.get("state", state.get("result", 0))
            dx = state.get("dx", 0)
            dy = state.get("dy", 0)
            channels = state.get("channels", state.get("qualifier", 0))
        else:
            drag_state = state

        qualifier = 0
        if isinstance(channels, c4d.BaseContainer):
            try:
                qualifier = channels.GetInt32(c4d.BFM_INPUT_QUALIFIER)
            except Exception:
                qualifier = 0
        elif isinstance(channels, int):
            qualifier = channels

        return drag_state, -dx, -dy, qualifier

    @staticmethod
    def _is_drag_terminal(drag_state):
        try:
            if drag_state == c4d.MOUSE_DRAG_FINISHED:
                return True
        except Exception:
            pass
        try:
            if drag_state == c4d.MOUSE_DRAG_ESC:
                return True
        except Exception:
            pass
        if drag_state in (0, 2):
            return True
        return False

    def _drag_move(self, shot_id, mx, my):
        w = self.GetWidth()
        doc = c4d.documents.GetActiveDocument()
        shots, _ = _read_shots(doc)
        target = next((s for s in shots if s["id"] == shot_id), None)
        if target is None:
            return

        orig_in    = target["in_frame"]
        orig_out   = target["out_frame"]
        orig_track = _shot_track(target)
        duration   = orig_out - orig_in
        fpp = self._frames_per_pixel(w)

        def on_tick(adx, ady, qual):
            new_in = max(0, orig_in + int(round(adx * fpp)))
            lane_count = _displayed_lane_count(shots)
            preview_y = self._track_y_top(orig_track, lane_count) + ady
            new_track = max(0, min(MAX_TRACKS - 1,
                                   self._y_to_track(preview_y, lane_count)))
            mode = _qualifier_mode(qual, self._snap_enabled)
            if mode in ("snap", "ripple"):
                snap_frames = self._snap_frames() if mode == "snap" else 0
                shots_preview = _resolve_position(shots, shot_id, new_in,
                                                  new_track, mode, snap_frames)
            else:
                shots_preview = [dict(s) for s in shots]
                t = next(s for s in shots_preview if s["id"] == shot_id)
                t["in_frame"]  = new_in
                t["out_frame"] = new_in + duration
                t["track"]     = new_track
            self._render_preview_shots(shots_preview)

        result = self._drag_loop(_KEY_MLEFT, mx, my, on_tick)
        self._render_preview_shots(None)
        if result is None:
            return
        accum_dx, accum_dy, qualifier = result

        new_in = max(0, orig_in + int(round(accum_dx * fpp)))
        lane_count = _displayed_lane_count(shots)
        preview_y = self._track_y_top(orig_track, lane_count) + accum_dy
        new_track = max(0, min(MAX_TRACKS - 1,
                               self._y_to_track(preview_y, lane_count)))

        if new_in == orig_in and new_track == orig_track:
            return

        mode = _qualifier_mode(qualifier, self._snap_enabled)
        snap_frames = self._snap_frames() if mode == "snap" else 0
        doc.StartUndo()
        new_shots = _resolve_position(shots, shot_id, new_in, new_track, mode, snap_frames)
        _write_shots(doc, new_shots, _read_shots(doc)[1], with_undo=True)
        doc.EndUndo()
        c4d.EventAdd()

    def _drag_resize(self, shot_id, edge, mx, my):
        w = self.GetWidth()
        doc = c4d.documents.GetActiveDocument()
        shots, _ = _read_shots(doc)
        target = next((s for s in shots if s["id"] == shot_id), None)
        if target is None:
            return

        orig_in  = target["in_frame"]
        orig_out = target["out_frame"]
        fpp = self._frames_per_pixel(w)

        def on_tick(adx, _ady, qual):
            delta_frames = int(round(adx * fpp))
            if edge == "left":
                want = max(0, min(orig_out - MIN_SHOT_FRAMES, orig_in + delta_frames))
            else:
                want = max(orig_in + MIN_SHOT_FRAMES, orig_out + delta_frames)

            mode = _qualifier_mode(qual, self._snap_enabled)
            if mode in ("snap", "ripple"):
                snap_frames = self._snap_frames() if mode == "snap" else 0
                shots_preview = _resolve_resize(shots, shot_id, edge, want, mode, snap_frames)
            else:
                shots_preview = [dict(s) for s in shots]
                t = next(s for s in shots_preview if s["id"] == shot_id)
                if edge == "left":
                    t["in_frame"] = want
                else:
                    t["out_frame"] = want
            self._render_preview_shots(shots_preview)

        result = self._drag_loop(_KEY_MLEFT, mx, my, on_tick)
        self._render_preview_shots(None)
        if result is None:
            return
        accum_dx, _accum_dy, qualifier = result

        delta_frames = int(round(accum_dx * fpp))
        want = orig_in + delta_frames if edge == "left" else orig_out + delta_frames
        if (edge == "left" and want == orig_in) or (edge == "right" and want == orig_out):
            return

        mode = _qualifier_mode(qualifier, self._snap_enabled)
        snap_frames = self._snap_frames() if mode == "snap" else 0
        doc.StartUndo()
        new_shots = _resolve_resize(shots, shot_id, edge, want, mode, snap_frames)
        _write_shots(doc, new_shots, _read_shots(doc)[1], with_undo=True)
        doc.EndUndo()
        c4d.EventAdd()

    # ------------------------------------------------------------------
    # Selection operations (delete, duplicate)
    # ------------------------------------------------------------------

    def _delete_selected(self):
        if not self._selected_ids:
            return
        doc = c4d.documents.GetActiveDocument()
        shots, next_id = _read_shots(doc)
        target_ids = set(self._selected_ids)
        new_shots = [s for s in shots if s["id"] not in target_ids]
        if len(new_shots) == len(shots):
            return
        doc.StartUndo()
        _write_shots(doc, new_shots, next_id, with_undo=True)
        doc.EndUndo()
        self._selected_ids = set()
        c4d.EventAdd()
        self.Redraw()
        print("[Shotblocks] deleted {} shot(s)".format(len(target_ids)))

    def _duplicate_selected(self, qualifier=0):
        """Duplicate every selected shot. Each copy lands on track+1 (auto-grow
        up to MAX_TRACKS); at the cap, it falls back to same-track immediately
        after the source. Active overlap policy applies. The new shots become
        the selection."""
        if not self._selected_ids:
            return
        doc = c4d.documents.GetActiveDocument()
        shots, next_id = _read_shots(doc)
        srcs = [s for s in shots if s["id"] in self._selected_ids]
        if not srcs:
            return

        new_ids = set()
        mode = _qualifier_mode(qualifier, self._snap_enabled)
        snap_frames = self._snap_frames() if mode == "snap" else 0

        doc.StartUndo()
        for src in srcs:
            dup_id    = next_id
            next_id  += 1
            src_track = _shot_track(src)
            duration  = src["out_frame"] - src["in_frame"]
            if src_track + 1 < MAX_TRACKS:
                copy = _make_shot(dup_id, src["in_frame"], src["out_frame"],
                                  src["cam_name"], src_track + 1)
                shots.append(copy)
                shots = _resolve_position(shots, dup_id, copy["in_frame"],
                                          copy["track"], mode, snap_frames)
            else:
                new_in = src["out_frame"] + 1
                copy = _make_shot(dup_id, new_in, new_in + duration,
                                  src["cam_name"], src_track)
                shots.append(copy)
                shots = _resolve_position(shots, dup_id, copy["in_frame"],
                                          copy["track"], mode, snap_frames)
            new_ids.add(dup_id)
        _write_shots(doc, shots, next_id, with_undo=True)
        doc.EndUndo()
        self._selected_ids = new_ids
        c4d.EventAdd()
        self.Redraw()
        print("[Shotblocks] duplicated {} shot(s) → {}".format(len(srcs), new_ids))

    def _drag_marquee(self, mx, my, additive):
        """Plain LMB-drag-on-empty-canvas marquee. Selects shots whose body
        bbox intersects the rectangle. Additive = Shift held."""
        w = self.GetWidth()
        doc = c4d.documents.GetActiveDocument()
        shots, _ = _read_shots(doc)

        base_selection = set(self._selected_ids) if additive else set()
        self._selected_ids = set(base_selection)
        self._marquee_rect = None
        self.Redraw()

        def on_tick(adx, ady, _qual):
            x1 = mx + adx
            y1 = my + ady
            self._marquee_rect = (mx, my, x1, y1)
            rx1, ry1, rx2, ry2 = (min(mx, x1), min(my, y1),
                                  max(mx, x1), max(my, y1))
            hits = self._shots_in_rect(shots, rx1, ry1, rx2, ry2, w)
            self._selected_ids = base_selection | hits
            self.Redraw()

        self._drag_loop(_KEY_MLEFT, mx, my, on_tick)
        self._marquee_rect = None
        self.Redraw()

    def _shots_in_rect(self, shots, rx1, ry1, rx2, ry2, w):
        """Return the set of shot ids whose body bbox intersects the rect."""
        lane_count = _displayed_lane_count(shots)
        hit = set()
        for s in shots:
            track = _shot_track(s)
            sy_top = self._track_y_top(track, lane_count)
            sy_bot = sy_top + SHOT_HEIGHT - 1
            sx1 = self._frame_to_x(s["in_frame"], w)
            sx2 = self._frame_to_x(s["out_frame"], w)
            if sx2 < sx1 + 2:
                sx2 = sx1 + 2
            if sx2 < rx1 or sx1 > rx2:
                continue
            if sy_bot < ry1 or sy_top > ry2:
                continue
            hit.add(s["id"])
        return hit

    # ------------------------------------------------------------------
    # Range-bar drag handlers
    # ------------------------------------------------------------------

    def _drag_range_handle(self, edge, mx, my):
        """Drag the in or out handle. The opposite edge stays fixed."""
        w = self.GetWidth()
        fpp = self._frames_per_pixel(w)
        doc = c4d.documents.GetActiveDocument()
        orig_in, orig_out = _read_range(doc)

        def on_tick(adx, _ady, _qual):
            delta = int(round(adx * fpp))
            if edge == "in":
                new_in = max(0, min(orig_in + delta, orig_out - 1))
                self._preview_range = (new_in, orig_out)
            else:
                new_out = max(orig_in + 1, orig_out + delta)
                self._preview_range = (orig_in, new_out)
            self.Redraw()

        self._drag_loop(_KEY_MLEFT, mx, my, on_tick)
        self._commit_range_drag(doc, orig_in, orig_out)

    def _drag_range_body(self, mx, my):
        """Drag the active span between handles to slide both together."""
        w = self.GetWidth()
        fpp = self._frames_per_pixel(w)
        doc = c4d.documents.GetActiveDocument()
        orig_in, orig_out = _read_range(doc)
        length = orig_out - orig_in

        def on_tick(adx, _ady, _qual):
            delta = int(round(adx * fpp))
            new_in = max(0, orig_in + delta)
            self._preview_range = (new_in, new_in + length)
            self.Redraw()

        self._drag_loop(_KEY_MLEFT, mx, my, on_tick)
        self._commit_range_drag(doc, orig_in, orig_out)

    def _drag_playhead(self, mx, my):
        """Click + drag in the ruler band scrubs the playhead. View state —
        no doc write, no undo."""
        w = self.GetWidth()
        self.playhead_frame = max(0, self._x_to_frame(mx, w))
        self.Redraw()

        def on_tick(adx, _ady, _qual):
            cur_x = mx + adx
            self.playhead_frame = max(0, self._x_to_frame(cur_x, w))
            self.Redraw()

        self._drag_loop(_KEY_MLEFT, mx, my, on_tick)

    def _commit_range_drag(self, doc, orig_in, orig_out):
        """Shared commit logic for range-bar drag handlers."""
        if self._preview_range is not None:
            new_in, new_out = self._preview_range
            if (new_in, new_out) != (orig_in, orig_out):
                doc.StartUndo()
                _write_range(doc, new_in, new_out, with_undo=True)
                doc.EndUndo()
                c4d.EventAdd()
        self._preview_range = None
        self.Redraw()

    def _drag_pan(self, mx, my):
        """Alt+LMB drag-pan. Held LMB so MouseDrag actually delivers motion
        (MMB is intercepted by C4D's framework regardless of qualifier)."""
        orig_first = self.visible_first
        orig_last  = self.visible_last
        w = self.GetWidth()
        fpp = self._frames_per_pixel(w)

        def on_tick(adx, _ady, _qual):
            shift_frames = int(round(-adx * fpp))
            self.visible_first = orig_first + shift_frames
            self.visible_last  = orig_last  + shift_frames
            self.Redraw()

        self._drag_loop(_KEY_MLEFT, mx, my, on_tick)

    def _drag_zoom(self, mx, my):
        """Alt+RMB zoom-drag — horizontal motion changes zoom around the press
        frame (C4D viewport/timeline convention). Drag right = zoom in."""
        w = self.GetWidth()
        if w <= 0:
            return
        anchor_frame = self._x_to_frame(mx, w)
        orig_first = self.visible_first
        orig_last  = self.visible_last
        orig_span  = max(8, orig_last - orig_first)

        def on_tick(adx, _ady, _qual):
            factor = math.exp(-adx / 200.0)
            new_span = max(8, int(round(orig_span * factor)))
            ratio = (anchor_frame - orig_first) / float(orig_span)
            new_first = anchor_frame - int(round(ratio * new_span))
            new_first = max(0, new_first)
            self.visible_first = new_first
            self.visible_last  = new_first + new_span
            self.Redraw()

        self._drag_loop(_KEY_MRIGHT, mx, my, on_tick)

    def _pan_by_wheel(self, delta):
        """Plain scroll wheel = horizontal pan. One wheel notch = ~10% of the
        current visible span."""
        span = max(1, self.visible_last - self.visible_first)
        notches = delta / 120.0
        shift = int(round(-notches * span * 0.1))
        new_first = max(0, self.visible_first + shift)
        self.visible_first = new_first
        self.visible_last  = new_first + span
        self.Redraw()

    def _zoom_around_cursor(self, cursor_x, delta):
        w = self.GetWidth()
        if w <= 0 or delta == 0:
            return
        anchor_frame = self._x_to_frame(cursor_x, w)
        factor = 1.0 / 1.2 if delta > 0 else 1.2
        span_old = self.visible_last - self.visible_first
        span_new = max(8, int(round(span_old * factor)))
        ratio = (anchor_frame - self.visible_first) / max(1, span_old)
        new_first = anchor_frame - int(round(ratio * span_new))
        new_first = max(0, new_first)
        self.visible_first = new_first
        self.visible_last  = new_first + span_new
        self.Redraw()

    # ------------------------------------------------------------------
    # Render preview during drag without committing to the document
    # ------------------------------------------------------------------

    def _render_preview_shots(self, shots_or_none):
        """Cache an override list for the next paint. Pass None to clear."""
        self._preview_shots = shots_or_none
        self.Redraw()
