"""Shotblocks plugin entry point.

v0: registers the TagData, CommandData, and GeDialog plumbing.
v1: adds a GeUserArea (ShotblocksTimelineCanvas) that draws the timeline backdrop.
v2: drag-a-camera-to-create-a-shot, shot block rendering.
v3: hidden-null persistence (replaces SceneHookData fallback), multi-track timeline
    (auto-grow up to 4 lanes), click-to-select, body-drag move, edge-drag resize,
    same-track overlap policy (snap-to-edge default, Shift ripple, Alt replace),
    Ctrl+scroll zoom and middle-drag pan.
"""

import json
import math
import os

import c4d


PLUGIN_ID_TAG     = 1000001
PLUGIN_ID_DIALOG  = 1000002
PLUGIN_ID_COMMAND = 1000003
# PLUGIN_ID_SCENE_HOOK retired — SceneHookData isn't exposed in C4D 2026 Python.

SHOTBLOCKS_ENABLED = 1000
SHOTBLOCKS_DAMPING = 1001

ID_CANVAS      = 2000
ID_SNAP_TOGGLE = 2001

# Right-click context menu item IDs (plugin-internal; any unused int works).
MENU_DELETE    = 3000
MENU_DUPLICATE = 3001

# BaseContainer keys on the helper null
BCKEY_HELPER_MARKER = 1010   # str: identifies a null as our data carrier
BCKEY_SHOTS_JSON    = 1011   # str: the JSON-serialized shot list + counters
HELPER_MARKER_VALUE = "shotblocks_v1"
HELPER_NULL_NAME    = "Shotblocks Data (do not delete)"


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


# ---------------------------------------------------------------------------
# Layout constants
# ---------------------------------------------------------------------------

RULER_HEIGHT        = 24
SHOT_Y_TOP          = RULER_HEIGHT + 4
SHOT_HEIGHT         = 32
LANE_GAP            = 2
DEFAULT_SHOT_FRAMES = 48          # 2 s at 24 fps — good starting length
MAX_TRACKS          = 4           # hard cap
EDGE_HIT_PX         = 6           # leading/trailing edge-drag zone width
MIN_SHOT_FRAMES     = 1           # smallest legal shot duration
SNAP_PIXEL_RADIUS   = 8           # how close (in pixels) before magnetic snap pulls


# ---------------------------------------------------------------------------
# Persistence — hidden helper null carries shot data in its BaseContainer.
# ---------------------------------------------------------------------------

def _find_helper(doc):
    """Return the existing helper null in this document, or None."""
    if doc is None:
        return None
    obj = doc.GetFirstObject()
    while obj is not None:
        bc = obj.GetDataInstance()
        try:
            if bc is not None and bc.GetString(BCKEY_HELPER_MARKER) == HELPER_MARKER_VALUE:
                return obj
        except Exception:
            pass
        obj = obj.GetNext()
    return None


def _create_helper(doc):
    """Create the helper null, mark it, hide it, insert at root, and return it.

    Created OUTSIDE the undo system intentionally — once introduced, the helper
    sticks around forever (it's invisible anyway). Subsequent data changes ARE
    undoable; only the very first shot in a fresh document is "non-undoable
    relative to the helper's presence," which is fine.
    """
    null = c4d.BaseObject(c4d.Onull)
    null.SetName(HELPER_NULL_NAME)
    bc = null.GetDataInstance()
    if bc is not None:
        bc.SetString(BCKEY_HELPER_MARKER, HELPER_MARKER_VALUE)
    # Display: NONE so even if visible somewhere, it draws nothing.
    try:
        null[c4d.NULLOBJECT_DISPLAY] = c4d.NULLOBJECT_DISPLAY_NONE
    except Exception:
        pass
    # Hide from editor / Object Manager.
    try:
        null.ChangeNBit(c4d.NBIT_OHIDE, c4d.NBITCONTROL_SET)
    except Exception:
        pass
    doc.InsertObject(null)
    print("[Shotblocks] created helper null")
    return null


def _get_or_create_helper(doc):
    helper = _find_helper(doc)
    if helper is None:
        helper = _create_helper(doc)
    return helper


def _read_shots(doc):
    """Return (shots, next_id) for the active document."""
    helper = _find_helper(doc)
    if helper is None:
        return [], 1
    bc = helper.GetDataInstance()
    if bc is None:
        return [], 1
    raw = bc.GetString(BCKEY_SHOTS_JSON)
    if not raw:
        return [], 1
    try:
        data = json.loads(raw)
        return data.get("shots", []), data.get("next_id", 1)
    except (ValueError, TypeError):
        return [], 1


def _write_shots(doc, shots, next_id, with_undo=True):
    """Persist shots + next_id on the helper null. Wraps in undo by default."""
    helper = _get_or_create_helper(doc)
    bc = helper.GetDataInstance()
    if bc is None:
        print("[Shotblocks] _write_shots: GetDataInstance returned None")
        return
    if with_undo:
        doc.AddUndo(c4d.UNDOTYPE_CHANGE_SMALL, helper)
    bc.SetString(BCKEY_SHOTS_JSON, json.dumps({"shots": shots, "next_id": next_id}))


# ---------------------------------------------------------------------------
# Shot model helpers
# ---------------------------------------------------------------------------

def _make_shot(shot_id, in_frame, out_frame, cam_name, track):
    return {
        "id":        shot_id,
        "in_frame":  in_frame,
        "out_frame": out_frame,
        "cam_name":  cam_name,
        "track":     track,
    }


def _shot_track(shot):
    return shot.get("track", 0)


def _shots_on_track(shots, track):
    return [s for s in shots if _shot_track(s) == track]


def _max_used_track(shots):
    if not shots:
        return -1
    return max(_shot_track(s) for s in shots)


def _displayed_lane_count(shots):
    """Lanes to draw: used + 1 preview, capped at MAX_TRACKS, min 1."""
    used = _max_used_track(shots) + 1
    return max(1, min(MAX_TRACKS, used + 1))


def _active_shot_at(shots, frame):
    """Highest-track shot covering `frame`, or None.
    Documents the resolver semantics; not yet wired to camera output (v5+)."""
    candidates = [s for s in shots
                  if s["in_frame"] <= frame <= s["out_frame"]]
    if not candidates:
        return None
    candidates.sort(key=lambda s: (_shot_track(s), s["id"]), reverse=True)
    return candidates[0]


# ---------------------------------------------------------------------------
# Same-track overlap resolution.
# Returns the modified shot list. Operates on copies so callers can preview.
# Modes: "snap" (default), "ripple" (Shift), "replace" (Alt).
# ---------------------------------------------------------------------------

def _collect_edit_points(shots, exclude_id=None):
    """All cross-track edit points: every shot's in_frame and (out_frame + 1).
    For hard cuts, those are the same set of values where one clip yields to
    the next. Excludes the dragged shot to avoid self-snapping."""
    pts = set()
    for s in shots:
        if s["id"] == exclude_id:
            continue
        pts.add(s["in_frame"])
        pts.add(s["out_frame"] + 1)
    return pts


def _magnetic_snap_position(shots, target_id, want_in, want_out, snap_frames):
    """Magnetically pull (want_in, want_out) toward the nearest edit point
    if either edge is within `snap_frames` of one. Edit points come from ALL
    tracks (Resolve/Premiere convention). Returns (snapped_in, snapped_out)
    with the shot's duration preserved. Outside the threshold, returns the
    inputs unchanged — the drag continues freely."""
    if snap_frames <= 0:
        return want_in, want_out
    edit_points = _collect_edit_points(shots, exclude_id=target_id)
    if not edit_points:
        return want_in, want_out

    best_offset = 0
    best_dist   = snap_frames + 1
    for ep in edit_points:
        # Align dragged shot's IN to this edit point
        d = ep - want_in
        if abs(d) < best_dist:
            best_dist, best_offset = abs(d), d
        # Align dragged shot's "cut after" (out + 1) to this edit point
        d = ep - (want_out + 1)
        if abs(d) < best_dist:
            best_dist, best_offset = abs(d), d

    if best_dist <= snap_frames:
        return want_in + best_offset, want_out + best_offset
    return want_in, want_out


def _magnetic_snap_edge(shots, target_id, edge_frame, snap_frames):
    """Pull a single resize edge to the nearest cross-track edit point within
    `snap_frames`. `edge_frame` is the frame the moved edge would land on
    (treat both 'left in_frame' and 'right (out_frame + 1)' as edit-point
    candidates — the caller passes whichever one to align). Returns the
    snapped edge frame."""
    if snap_frames <= 0:
        return edge_frame
    edit_points = _collect_edit_points(shots, exclude_id=target_id)
    if not edit_points:
        return edge_frame
    best = edge_frame
    best_dist = snap_frames + 1
    for ep in edit_points:
        d = abs(ep - edge_frame)
        if d <= snap_frames and d < best_dist:
            best_dist, best = d, ep
    return best


def _resolve_position(shots, target_id, want_in, want_track, mode, snap_frames=0):
    """Resolve a body-drag move. Returns the new shot list."""
    shots = [dict(s) for s in shots]
    target = next((s for s in shots if s["id"] == target_id), None)
    if target is None:
        return shots

    duration = target["out_frame"] - target["in_frame"]
    target["track"] = max(0, min(MAX_TRACKS - 1, want_track))
    target["in_frame"]  = max(0, want_in)
    target["out_frame"] = target["in_frame"] + duration

    if mode == "snap":
        # Cross-track magnetic snap; falls through to replace if same-track
        # overlap remains after snapping (i.e., user dragged past the snap zone).
        new_in, new_out = _magnetic_snap_position(
            shots, target_id, target["in_frame"], target["out_frame"], snap_frames)
        target["in_frame"]  = new_in
        target["out_frame"] = new_out
        shots = _replace_overlap(shots, target)
    elif mode == "ripple":
        shots = _ripple_around(shots, target)
    elif mode == "replace":
        shots = _replace_overlap(shots, target)

    return shots


def _resolve_resize(shots, target_id, edge, want_frame, mode, snap_frames=0):
    """Resolve an edge-drag resize. `edge` is "left" or "right";
    `want_frame` is the desired new edge frame."""
    shots = [dict(s) for s in shots]
    target = next((s for s in shots if s["id"] == target_id), None)
    if target is None:
        return shots

    if edge == "left":
        target["in_frame"] = max(0, min(want_frame, target["out_frame"] - MIN_SHOT_FRAMES))
    else:
        target["out_frame"] = max(want_frame, target["in_frame"] + MIN_SHOT_FRAMES)

    if mode == "snap":
        if edge == "left":
            snapped = _magnetic_snap_edge(shots, target_id,
                                          target["in_frame"], snap_frames)
            target["in_frame"] = max(0, min(snapped, target["out_frame"] - MIN_SHOT_FRAMES))
        else:
            # The "cut after" is out_frame + 1 — snap that to an edit point,
            # then convert back to out_frame.
            snapped = _magnetic_snap_edge(shots, target_id,
                                          target["out_frame"] + 1, snap_frames)
            target["out_frame"] = max(target["in_frame"] + MIN_SHOT_FRAMES, snapped - 1)
        shots = _replace_overlap(shots, target)
    elif mode == "ripple":
        shots = _ripple_around(shots, target)
    elif mode == "replace":
        shots = _replace_overlap(shots, target)

    return shots


def _ripple_around(shots, target):
    """Push same-track shots later/earlier so target's range is clear.
    Preserves each pushed shot's duration."""
    out = [s for s in shots if s["id"] == target["id"] or _shot_track(s) != _shot_track(target)]
    # Sort same-track shots (excluding target) by in_frame
    same = sorted(
        [s for s in shots if s["id"] != target["id"] and _shot_track(s) == _shot_track(target)],
        key=lambda s: s["in_frame"])

    cursor = target["out_frame"] + 1
    pushed_right = False
    for s in same:
        if s["in_frame"] >= target["in_frame"]:
            # Ensure this shot starts no earlier than cursor
            if s["in_frame"] < cursor:
                dur = s["out_frame"] - s["in_frame"]
                s = dict(s)
                s["in_frame"]  = cursor
                s["out_frame"] = cursor + dur
                pushed_right = True
            cursor = s["out_frame"] + 1
        out.append(s)

    if not pushed_right:
        # Try pushing earlier shots leftward instead
        cursor = target["in_frame"] - 1
        out = [s for s in shots if s["id"] == target["id"] or _shot_track(s) != _shot_track(target)]
        for s in sorted(same, key=lambda x: -x["in_frame"]):
            if s["out_frame"] <= target["out_frame"]:
                if s["out_frame"] > cursor:
                    dur = s["out_frame"] - s["in_frame"]
                    s = dict(s)
                    s["out_frame"] = max(MIN_SHOT_FRAMES - 1, cursor)
                    s["in_frame"]  = max(0, s["out_frame"] - dur)
                    cursor = s["in_frame"] - 1
                else:
                    cursor = s["in_frame"] - 1
            out.append(s)

    return out


def _replace_overlap(shots, target):
    """Trim or remove same-track shots whose range intersects target's range."""
    out = []
    for s in shots:
        if s["id"] == target["id"] or _shot_track(s) != _shot_track(target):
            out.append(s)
            continue
        # s is on same track, not the target itself
        if s["out_frame"] < target["in_frame"] or s["in_frame"] > target["out_frame"]:
            out.append(s)
            continue
        # Overlaps target — trim or drop
        if s["in_frame"] >= target["in_frame"] and s["out_frame"] <= target["out_frame"]:
            # Fully covered — drop
            continue
        s = dict(s)
        if s["in_frame"] < target["in_frame"] and s["out_frame"] <= target["out_frame"]:
            # Trim trailing edge
            s["out_frame"] = target["in_frame"] - 1
        elif s["in_frame"] >= target["in_frame"] and s["out_frame"] > target["out_frame"]:
            # Trim leading edge
            s["in_frame"] = target["out_frame"] + 1
        else:
            # Target sits inside s — split or trim trailing (simpler: trim trailing)
            s["out_frame"] = target["in_frame"] - 1
        if s["out_frame"] - s["in_frame"] >= MIN_SHOT_FRAMES:
            out.append(s)
    return out


# ---------------------------------------------------------------------------
# Camera-detection helper (shared by drag-receive)
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


# Qualifier bits — verified empirically against c4d.QSHIFT/QCTRL/QALT in 2026:
# QSHIFT=1, QCTRL=2, QALT=4.
_QSHIFT = getattr(c4d, "QSHIFT", 0x1)
_QCTRL  = getattr(c4d, "QCTRL",  0x2)
_QALT   = getattr(c4d, "QALT",   0x4)

# MouseDragStart flag — may or may not exist in 2026 Python.
_MOUSE_DRAG_FLAG = getattr(c4d, "MOUSE_DRAG_NOMOVE_MSG_ON_MOUSEUP", 0)
_MOUSE_DRAG_CONTINUE = getattr(c4d, "MOUSE_DRAG_CONTINUE", 1)
_MOUSE_DRAG_FINISHED_S = getattr(c4d, "MOUSE_DRAG_FINISHED", 0)
_MOUSE_DRAG_ESCAPE   = getattr(c4d, "MOUSE_DRAG_ESC", 2)
_KEY_MLEFT   = getattr(c4d, "KEY_MLEFT",   61440)
_KEY_MRIGHT  = getattr(c4d, "KEY_MRIGHT",  61441)
_KEY_MMIDDLE = getattr(c4d, "KEY_MMIDDLE", 61442)

# Keyboard keys we care about — values dumped at canvas init for verification.
_KEY_DELETE    = getattr(c4d, "KEY_DELETE",    None)
_KEY_BACKSPACE = getattr(c4d, "KEY_BACKSPACE", None)
_KEY_D         = getattr(c4d, "KEY_D",         None)


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

        # Drag preview override — if non-None, DrawMsg uses this list instead of doc
        self._preview_shots = None

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

        # Ruler band
        self.DrawSetPen(COL_BG_RULER)
        self.DrawRectangle(0, 0, w, RULER_HEIGHT)
        self.DrawSetPen(COL_BORDER_SUB)
        self.DrawLine(0, RULER_HEIGHT, w, RULER_HEIGHT)

        # Frame ticks and labels
        self.DrawSetTextCol(COL_RULER_TEXT, COL_BG_RULER)
        step = self._pick_tick_step(w)
        first_tick = ((self.visible_first + step - 1) // step) * step
        for frame in range(first_tick, self.visible_last + 1, step):
            tx = self._frame_to_x(frame, w)
            self.DrawLine(tx, RULER_HEIGHT - 6, tx, RULER_HEIGHT - 1)
            label = str(frame)
            text_w = self.DrawGetTextWidth(label)
            label_x = tx + 3
            if label_x + text_w > w:
                label_x = tx - text_w - 3
            self.DrawText(label, label_x, 4)

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
            self.DrawLine(dx, RULER_HEIGHT, dx, h)
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
        # for MMB regardless of Alt). Pan is on the wheel and Shift+LMB-on-empty
        # instead.

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
        """Right-click context menu. v4a items: Delete, Duplicate."""
        # One-time API probe — dump every popup-related and coord-related attr
        # so we can see what's actually available in this C4D 2026 build.
        if not ShotblocksTimelineCanvas._popup_api_logged:
            ShotblocksTimelineCanvas._popup_api_logged = True
            popup_attrs = [n for n in dir(c4d.gui)
                           if ("popup" in n.lower() or "menu" in n.lower())]
            pos_attrs = [n for n in dir(c4d.gui)
                         if any(s in n.lower() for s in
                                ("mouse", "cursor", "screen", "pointer"))]
            ua_attrs = [n for n in dir(self)
                        if any(s in n.lower() for s in
                               ("local2", "global2", "screen", "screen2",
                                "cursor"))]
            print("[Shotblocks] popup attrs: {}".format(popup_attrs))
            print("[Shotblocks] c4d.gui pos attrs: {}".format(pos_attrs))
            print("[Shotblocks] GeUserArea coord attrs: {}".format(ua_attrs))

        w = self.GetWidth()
        doc = c4d.documents.GetActiveDocument()
        shots, _ = _read_shots(doc)
        shot_id, _region = self._hit_test(x, y, shots, w)
        print("[Shotblocks] RMB press at ({},{}) hit={}".format(x, y, shot_id))

        # Right-click on empty canvas: no menu in v4a.
        if shot_id is None:
            return True

        # If clicked shot isn't in selection, replace selection with just it.
        if shot_id not in self._selected_ids:
            self._selected_ids = {shot_id}
            self.Redraw()

        # Build menu — counts reflect selection size when >1.
        n = len(self._selected_ids)
        suffix = " ({})".format(n) if n > 1 else ""
        bc = c4d.BaseContainer()
        bc.SetString(MENU_DELETE,    "Delete"    + suffix)
        bc.SetString(MENU_DUPLICATE, "Duplicate" + suffix)

        # Convert canvas-local coords to monitor screen coords. Verified in
        # C4D 2026: GeUserArea.Local2Screen() returns {"x": ..., "y": ...} —
        # the screen position of the canvas's (0,0). Local2Global only gives
        # offset within the parent dialog, which is why the menu landed at
        # top-left of the monitor before the fix.
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

        result = None
        try:
            result = c4d.gui.ShowPopupDialog(cd=None, bc=bc, x=sx, y=sy)
        except Exception as e:
            print("[Shotblocks] ShowPopupDialog raised: {}".format(e))
        if result not in (None, 0):
            print("[Shotblocks] popup → {}".format(
                "DELETE" if result == MENU_DELETE else
                "DUPLICATE" if result == MENU_DUPLICATE else result))

        if result == MENU_DELETE:
            self._delete_selected()
        elif result == MENU_DUPLICATE:
            self._duplicate_selected()
        return True

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

    # Class-level once-flag so we only dump the MouseDrag shape on the first iter
    _drag_shape_logged = False
    _constants_dumped  = False
    _channel_logged    = set()
    _popup_api_logged  = False

    def _drag_loop(self, button_key, mx, my, on_tick):
        """Generic drag-poll loop. Calls on_tick(accum_dx, accum_dy, qualifier)
        per motion update. Returns (final_dx, final_dy, final_qualifier) or None
        on failure. Logs MouseDrag's actual return shape on the first iteration
        ever — that diagnostic is what we need to nail the API.
        """
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
                # Dump available MOUSE_DRAG_* constants once for reference
                consts = {n: getattr(c4d, n) for n in dir(c4d)
                          if n.startswith("MOUSE_DRAG_")}
                print("[Shotblocks]   c4d.MOUSE_DRAG_* = {}".format(consts))

            # Parse return shape
            drag_state, dx, dy, channels = self._parse_drag_state(state)

            # Treat anything that is plausibly "finished" or "esc" as exit;
            # otherwise treat as continue.
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

        # Drain MouseDragEnd
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

        # Extract qualifier from BaseContainer if present, else trust the int
        qualifier = 0
        if isinstance(channels, c4d.BaseContainer):
            try:
                qualifier = channels.GetInt32(c4d.BFM_INPUT_QUALIFIER)
            except Exception:
                qualifier = 0
        elif isinstance(channels, int):
            qualifier = channels

        # Negate to natural screen convention
        return drag_state, -dx, -dy, qualifier

    @staticmethod
    def _is_drag_terminal(drag_state):
        # Names vary; treat the FINISHED/ESC family as terminal, anything else continues.
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
        # If exposed only via numbered values, fall back: 0 commonly = finished, 2 = esc
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
                # Live resolution — snap-to-edge feels magnetic; ripple shows
                # neighbors push live as the drag crosses them.
                snap_frames = self._snap_frames() if mode == "snap" else 0
                shots_preview = _resolve_position(shots, shot_id, new_in,
                                                  new_track, mode, snap_frames)
            else:
                # Replace: preview overlays neighbors freely; trim happens on commit.
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
            return  # nothing actually removed
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
                # Track above, same in/out range
                copy = _make_shot(dup_id, src["in_frame"], src["out_frame"],
                                  src["cam_name"], src_track + 1)
                shots.append(copy)
                shots = _resolve_position(shots, dup_id, copy["in_frame"],
                                          copy["track"], mode, snap_frames)
            else:
                # At the track cap → place adjacent on the same track
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
        bbox intersects the rectangle. Additive = Shift held = preserve the
        existing selection and union with the marquee's hits."""
        w = self.GetWidth()
        doc = c4d.documents.GetActiveDocument()
        shots, _ = _read_shots(doc)

        base_selection = set(self._selected_ids) if additive else set()
        # Apply baseline immediately so a click-without-drag deselects
        # visually before MouseDrag returns terminal on first poll.
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
            # Exponential — 200px of drag = ~e factor (~2.7x zoom). Tweak by feel.
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
        # delta is typically ±120 per notch on Windows; normalize.
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
        # delta > 0 → zoom in; <0 → zoom out. Step factor 1.2 per notch.
        factor = 1.0 / 1.2 if delta > 0 else 1.2
        span_old = self.visible_last - self.visible_first
        span_new = max(8, int(round(span_old * factor)))
        # Anchor: keep anchor_frame at same x ratio
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

    # Override DrawMsg to honor preview when present (small extension)
    # Done by re-routing: see _read_shots_for_draw.


# ---------------------------------------------------------------------------
# Tag
# ---------------------------------------------------------------------------

class ShotblocksTag(c4d.plugins.TagData):
    def Init(self, node):
        node[SHOTBLOCKS_ENABLED] = True
        node[SHOTBLOCKS_DAMPING] = 0.5
        return True

    def Execute(self, tag, doc, op, bt, priority, flags):
        return c4d.EXECUTIONRESULT_OK


# ---------------------------------------------------------------------------
# Dialog
# ---------------------------------------------------------------------------

class ShotblocksTimelineDialog(c4d.gui.GeDialog):
    def __init__(self):
        super().__init__()
        self.canvas = ShotblocksTimelineCanvas()

    def CreateLayout(self):
        self.SetTitle("Shotblocks")
        # Toolbar row
        if self.GroupBegin(id=0, flags=c4d.BFH_SCALEFIT, cols=8, rows=1):
            self.GroupBorderSpace(4, 4, 4, 4)
            self.AddCheckbox(id=ID_SNAP_TOGGLE,
                             flags=c4d.BFH_LEFT,
                             initw=0, inith=0,
                             name="Snap")
            self.SetBool(ID_SNAP_TOGGLE, self.canvas._snap_enabled)
        self.GroupEnd()
        # Canvas row
        self.AddUserArea(
            id=ID_CANVAS,
            flags=c4d.BFH_SCALEFIT | c4d.BFV_SCALEFIT,
            initw=600,
            inith=200,
        )
        self.AttachUserArea(self.canvas, ID_CANVAS)
        return True

    def Command(self, id, msg):
        if id == ID_SNAP_TOGGLE:
            self.canvas._snap_enabled = self.GetBool(ID_SNAP_TOGGLE)
            print("[Shotblocks] snap toggle = {}".format(self.canvas._snap_enabled))
            return True
        return c4d.gui.GeDialog.Command(self, id, msg)


# ---------------------------------------------------------------------------
# Command (opens the dialog)
# ---------------------------------------------------------------------------

class OpenShotblocksTimelineCommand(c4d.plugins.CommandData):
    dialog = None

    def Execute(self, doc):
        if self.dialog is None:
            self.dialog = ShotblocksTimelineDialog()
        return self.dialog.Open(
            dlgtype=c4d.DLG_TYPE_ASYNC,
            pluginid=PLUGIN_ID_DIALOG,
            defaultw=600,
            defaulth=240,
        )

    def RestoreLayout(self, sec_ref):
        if self.dialog is None:
            self.dialog = ShotblocksTimelineDialog()
        return self.dialog.Restore(pluginid=PLUGIN_ID_DIALOG, secret=sec_ref)


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

def _load_icon():
    plugin_dir = os.path.dirname(os.path.abspath(__file__))
    icon_path  = os.path.join(plugin_dir, "res", "icons", "tshotblocks.tif")
    bmp = c4d.bitmaps.BaseBitmap()
    bmp.InitWith(icon_path)
    return bmp


if __name__ == "__main__":
    icon = _load_icon()

    c4d.plugins.RegisterTagPlugin(
        id=PLUGIN_ID_TAG,
        str="Shotblocks",
        info=c4d.TAG_VISIBLE | c4d.TAG_EXPRESSION,
        g=ShotblocksTag,
        description="tshotblocks",
        icon=icon,
    )

    c4d.plugins.RegisterCommandPlugin(
        id=PLUGIN_ID_COMMAND,
        str="Open Shotblocks Timeline",
        info=0,
        help="Open the Shotblocks timeline window",
        dat=OpenShotblocksTimelineCommand(),
        icon=icon,
    )

    print("[Shotblocks] loaded (tag={}, command={}, dialog={})".format(
        PLUGIN_ID_TAG, PLUGIN_ID_COMMAND, PLUGIN_ID_DIALOG))
