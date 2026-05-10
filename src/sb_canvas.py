"""Shotblocks timeline canvas.

The `ShotblocksTimelineCanvas` GeUserArea — drawing, hit-testing, drag
handlers (move / resize / marquee / pan / zoom / range-bar / playhead),
right-click context menu, keyboard shortcuts.

Imports the pure-function shot model from `sb_shot_model` and the helper-
null persistence from `sb_persistence`. Does NOT import anything from
`shotblocks.pyp` (the entry-point).
"""

import math
import os
from time import monotonic as _monotonic

import c4d

from sb_shot_model import (
    MAX_TRACKS, MIN_SHOT_FRAMES,
    _make_shot, _shot_track, _displayed_lane_count,
    _resolve_position, _resolve_resize, _resolve_group_move,
    _magnetic_snap_edge,
    _active_shot_at,
)
from sb_persistence import (
    _read_shots, _write_shots,
    _read_range, _write_range,
    _get_or_create_helper,
    _set_shot_cam_link, _get_shot_cam, _clear_shot_cam_link,
)
from sb_toolbar import load_bitmap, tinted_copy, blend_two_bitmaps, HOVER_LIGHTEN, PRESS_DARKEN
from sb_audio_decode import is_audio_path
from sb_audio_track  import AudioTrack, AudioTrackError
from sb_audio_render import draw_waveform
from sb_audio_playback import AudioPlayback


# ---------------------------------------------------------------------------
# Visual-language tokens (from .agent/design/visual-language.md)
# ---------------------------------------------------------------------------

def _rgb(hex6):
    return c4d.Vector(
        int(hex6[0:2], 16) / 255.0,
        int(hex6[2:4], 16) / 255.0,
        int(hex6[4:6], 16) / 255.0,
    )

# Canvas bg matches the bitmap shot-body fill (#1C1C1C) so the
# transparent rounded-corner cutouts in the body bitmaps blend
# seamlessly with the surrounding canvas. Without this match, you'd
# see a sharp rectangle of body color against a slightly different
# canvas bg through every corner cutout.
COL_BG_TIMELINE   = _rgb("1C1C1C")
COL_BG_RAIL       = _rgb("141414")  # rail still distinguishably darker than timeline
COL_RAIL_BORDER   = _rgb("2a2a2a")  # vertical divider between rail and timeline
COL_RAIL_LABEL    = _rgb("888888")
# Lane backgrounds. Both colors match the bitmap shot-body fill (#1C1C1C
# in src/res/svg/shot-*.svg) so the bitmap's rounded-corner cutouts blend
# seamlessly with the lane behind them — without this, the lane bg would
# show through the partially-transparent corner pixels as a square halo.
# Track separation is carried by the COL_BORDER_SUB lines between lanes.
COL_BG_TRACK      = _rgb("1C1C1C")
COL_BG_TRACK_ALT  = _rgb("1C1C1C")
COL_BG_RULER      = _rgb("2a2a2a")
COL_BORDER_SUB    = _rgb("333333")
COL_BORDER_EMPH   = _rgb("444444")
COL_RULER_TEXT    = _rgb("888888")
COL_CURSOR        = _rgb("ff6b6b")
COL_PLAYHEAD_HEAD = _rgb("4a90d9")  # Blue head — visual grab handle at top of playhead

# Design-system accent (Maxon blue) — the single accent that does all
# interactive work in the timeline: selection, hover-on-grab-zones, range
# handles, marquee outline. Per `.agent/design/design-system.md`.
COL_ACCENT        = _rgb("2C7CD3")
COL_ACCENT_HOVER  = _rgb("3B8CE8")
COL_ON_ACCENT     = _rgb("FFFFFF")  # text/label color on accent backgrounds

# Body fill of the bitmap shot block — must match the SVG <rect fill="#1C1C1C"/>
# in src/res/svg/shot-*.svg. Used as the label-text antialiasing bg so glyphs
# don't paint over gray. If the SVG body fill ever changes, update both.
COL_SHOT_BODY_FILL         = _rgb("1C1C1C")

# Untagged passthrough — every v3 shot still draws as untagged.
COL_SHOT_FILL              = _rgb("5a5a5a")
COL_SHOT_FILL_SELECTED     = COL_ACCENT     # selected body uses Maxon blue
COL_SHOT_BORDER            = _rgb("7a7a7a")
COL_SHOT_LABEL             = _rgb("dddddd")
COL_SHOT_LABEL_SELECTED    = COL_ON_ACCENT  # white label on accent body
COL_SHOT_EDGE_BAND         = _rgb("4a4a4a")  # darker grip zone at each edge
COL_SHOT_EDGE_BAND_HOVER   = COL_ACCENT_HOVER  # brighter blue when cursor is
                                                # over the resize zone — primary
                                                # "you can drag here" affordance.

# Orphaned state — shot whose source camera has been deleted. Muted dark-red
# palette per visual-language.md "Worked example" section. The dashed border
# is the secondary signal; the body-fill desaturation is the primary one.
COL_SHOT_FILL_ORPHAN       = _rgb("3a2a2a")
COL_SHOT_BORDER_ORPHAN     = _rgb("7a4a4a")
COL_SHOT_LABEL_ORPHAN      = _rgb("a08080")
# Selected-orphan fill — a saturated muted red. This is a documented
# divergence from the universal "selection = Maxon blue" rule: when a shot
# is orphaned the orphan signal must survive selection (the muted dark-red
# body and dashed border would both be lost under accent-blue), so we
# substitute a brighter red instead. Deliberately distinct from the
# playhead cursor `#ff6b6b` — cursor red stays exclusive to the playhead.
COL_SHOT_FILL_ORPHAN_SEL   = _rgb("8a3030")
DASH_ORPHAN_ON             = 12  # dashed border on-pixels — matches the
                                  # rhythm baked into shot-orphan-body.png
DASH_ORPHAN_OFF            = 8   # dashed border off-pixels — matches design

# Marquee selection rectangle — accent outline (transient interactive state).
COL_SELECTION     = COL_ACCENT

# Drop hint
COL_DROP_HINT     = _rgb("aaaaaa")

# Snap indicator — vertical yellow line drawn at each snap target while
# a drag is currently magnetized to it. Yellow chosen to stand out
# against both the dark canvas and any state's body color, and to
# avoid clashing with our blue/orange/red state palette.
COL_SNAP_INDICATOR = _rgb("ffd60a")

# Audio block — body fill is a deep teal so the waveform reads cleanly
# against it and the block is unmistakably distinct from a video shot.
COL_AUDIO_BODY          = _rgb("1d3a44")  # deep teal, mid-saturation
COL_AUDIO_BODY_SELECTED = _rgb("2a5666")  # lighter teal when selected
COL_AUDIO_BORDER        = _rgb("3a6a78")
COL_AUDIO_WAVEFORM      = _rgb("9be0f0")  # light cyan; pops on the teal body
COL_AUDIO_CENTERLINE    = _rgb("3a6a78")  # same as border — subtle reference
COL_AUDIO_LABEL         = _rgb("c0e8f0")

# Play-range bar
COL_RANGE_BAR           = _rgb("3a3a3a")
COL_RANGE_ACTIVE        = _rgb("4A4A4A")    # surface-4 — neutral lift between
                                             # handles; the accent-blue handles
                                             # mark the boundaries.
COL_RANGE_HANDLE        = COL_ACCENT
COL_RANGE_HANDLE_HOVER  = COL_ACCENT_HOVER


# ---------------------------------------------------------------------------
# Layout constants
# ---------------------------------------------------------------------------

RANGE_HEIGHT        = 16          # play-range bar at the very top
RANGE_HANDLE_PX     = 6           # in/out handle hit-zone width
RULER_HEIGHT        = 24
RULER_Y_TOP         = RANGE_HEIGHT
SHOT_Y_TOP          = RANGE_HEIGHT + RULER_HEIGHT + 4
SHOT_HEIGHT         = 48
AUDIO_HEIGHT        = 96   # audio tracks render at 2x shot height per design;
                           # not yet wired into track-Y math (waits for the
                           # audio subsystem in v7+).
LANE_GAP            = 2
# Horizontal interior padding. The visible frame range maps to
# [LEFT_RAIL_WIDTH + TIMELINE_PAD_X, w - TIMELINE_PAD_X] so the playhead,
# range handles, and tick marks at the doc's first/last frame stay
# visibly inside the timeline column (right of the rail) instead of
# touching the very edge.
TIMELINE_PAD_X      = 8

# Left rail. A fixed-width column on the left side of the canvas hosts
# the global tools (Snap, Loop) and per-track labels ("Track 0", etc.).
# The frame-to-x mapping starts AFTER this column. NLE convention —
# Premiere/Resolve put track headers on the left.
LEFT_RAIL_WIDTH     = 80
RAIL_BTN_SIZE       = 24
RAIL_BTN_GAP        = 4
RAIL_BTN_TOP        = 6   # vertical inset of the first button row
DEFAULT_SHOT_FRAMES = 48          # 2 s at 24 fps — good starting length
EDGE_BAND_PX        = 24          # visible darker grip-band at each shot edge
                                  # (matches the edge PNG width in design space)
EDGE_HIT_PX         = 24          # click edge-drag zone — matches the band
CURSOR_EDGE_PX      = 24          # cursor affordance — matches the band
# Hard corners on shot blocks. The design system asks for 3-4 px corner
# radius, but every rendering path we tried in C4D 2026 Python failed at
# this small scale: stairstep DrawRectangle approximations were visibly
# stepped, BaseBitmap with BMP_ALLOWALPHA / BMP_TRANSPARENTALPHA quantized
# alpha to a binary threshold (so AA gradients collapsed to hard masks),
# and per-pixel software AA produced bumpy results because 4 px is too
# few transitional pixels for the eye to perceive a smooth curve.
# Documented divergence — revisit if shot blocks ever render at >=48 px
# height (where 8 px radius would have enough pixels to read smoothly),
# or if C4D ships an anti-aliased shape primitive in its Python API.
SNAP_PIXEL_RADIUS   = 8           # how close (in pixels) before magnetic snap pulls
PLAYHEAD_HEAD_W     = 12          # blue triangle head — full width at top
PLAYHEAD_HEAD_H     = 10          # blue triangle head — height (apex at line)

# Hover fade — N pre-baked intermediate frames blended between
# normal and hover at construction time. At draw time we look up the
# frame matching the current animation t. 5 levels = 4 transitions
# spread over HOVER_FADE_MS — perceptually smooth.
HOVER_FADE_LEVELS = 5
HOVER_FADE_MS     = 200  # full normal → hover transition duration


# Sentinel passed to DrawSetTextCol(fg, bg) to suppress the solid bg-rect
# behind glyphs. Without this, the bg color paints a square block that
# overwrites the bitmap's anti-aliased rounded corners with a sharp
# rectangle (visible as a halo where the label sits near the corner).
# `c4d.COLOR_TRANS` exists in 2026; resolved with getattr so the module
# still loads on builds where the constant is named differently.
_TEXT_BG_TRANS = getattr(c4d, "COLOR_TRANS", None)


# ---------------------------------------------------------------------------
# Right-click context menu item IDs (plugin-internal; any unused int works).
# ---------------------------------------------------------------------------

MENU_DELETE         = 3000
MENU_DUPLICATE      = 3001
MENU_SET_RANGE_THIS = 3002
MENU_SET_RANGE_SEL  = 3003
MENU_RANGE_TO_ALL   = 3004
MENU_DELETE_AUDIO   = 3005


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

# Spacebar channel — verified empirically in C4D 2026: channel 61728 (0xf120),
# matching c4d.KEY_SPACE. ASCII 32 is included as a fallback for older builds.
_SPACE_CHANNELS = tuple(c for c in (
    ord(' '),
    getattr(c4d, "KEY_SPACE", None),
) if c is not None)

# Auto-repeat debounce for spacebar play/pause. C4D fires keyboard events
# repeatedly while a key is held; without a debounce, a single physical
# press toggles playback many times. 0.25 s is well above the typical
# repeat cadence and well below a deliberate second press.
_PLAY_TOGGLE_DEBOUNCE_S = 0.25

# Loop mode is a Shotblocks-owned toggle. C4D 2026 exposes no Python API
# for the native transport's "cycle" button — we verified empirically by
# scanning every c4d.* constant containing LOOP/CYCLE/PLAYMODE/PINGPONG.
# The toolbar checkbox controls it; the value persists with the play range.


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
    _kb_channel_logged = set()
    _scrub_logged      = False
    _block_draw_logged = False

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

        # Hover state for the visual highlights — these replace the
        # Windows cursor change as the primary "you can drag here"
        # affordance (the cursor flickers unreliably in C4D 2026 GeUserArea
        # Python).
        # _hover_band: (shot_id, "left"|"right") for shot-clip edges.
        # _hover_range: "in" | "out" for play-range handles.
        self._hover_band  = None
        self._hover_range = None

        # Per-shot camera reference cache. Maps shot_id -> BaseObject so we
        # can read the current camera name on every draw — that way an
        # in-session rename in the Object Manager reflects immediately in
        # the timeline. The cache is populated lazily by walking the doc
        # if a shot has no live ref (e.g., right after the document
        # finishes loading). Persistence still stores the name as a
        # fallback for the orphan case.
        self._cam_refs = {}

        # Orphan-transition tracking. Compared each redraw; on increase we
        # log once to the console (we have no status-line widget yet — that
        # arrives with the post-v5 visual-polish pass).
        self._last_orphan_count = 0

        # v6 playback state. _playback_owner_dialog is set by the dialog
        # right after AttachUserArea — the canvas asks the dialog to
        # start/stop its Timer rather than owning timer mechanics itself.
        # _loop_enabled is the Shotblocks-owned cycle toggle (the toolbar
        # checkbox); on by default so playback feels alive on first launch.
        self._playing                 = False
        self._playback_owner_dialog   = None
        self._last_play_toggle_t      = 0.0
        self._loop_enabled            = True

        # Per-shot hover-fade animation state.
        # Map shot_id -> {"left_t":  current animation 0..1,
        #                 "left_target": target 0..1,
        #                 "right_t": ...,
        #                 "right_target": ...}.
        # Cursor entering an edge sets that side's target to 1.0;
        # leaving sets it to 0.0. The timer tick advances `*_t` toward
        # `*_target` by dt / HOVER_FADE_MS each frame. Entries are
        # culled when both t and target are 0.0 (back at rest).
        self._shot_hover_anim         = {}
        self._last_anim_tick_t        = _monotonic()

        # Frames the in-flight drag's snap is currently aligned with.
        # A tuple of frame integers; empty when no snap is active.
        # Drawn in DrawMsg as vertical yellow lines so the user sees
        # exactly where the magnetic snap pulled the shot.
        self._snap_indicator_frames   = ()

        # v7 audio. One track per document. `_audio_doc_id` is the
        # `id(doc)` we last sync'd against — when it changes (the user
        # opened a different document), we reload from the helper null.
        self._audio_track    = AudioTrack()
        self._audio_playback = AudioPlayback()
        self._audio_doc_id   = None
        # Selection / hover for the audio block. Keys parallel to the
        # shot-block conventions: 'audio' is the singleton id (we have
        # one audio block per document in v7).
        self._audio_selected = False
        self._audio_drag_logged_types = set()

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
        # Name of the rail button under the cursor (or None) — set by
        # _on_cursor_info, drives the hover tint in _draw_rail.
        self._rail_hover = None
        # Name of the rail button held down with LMB (or None) — drives
        # the press tint while the user holds before release.
        self._rail_pressed = None


    # ------------------------------------------------------------------
    # Lazy bitmap caches — see __init__ for why these defer.
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
        if self._rail_buttons_cache is None:
            try:
                self._rail_buttons_cache = self._build_rail_buttons()
            except Exception as e:
                print("[Shotblocks] rail buttons load failed: {}".format(e))
                self._rail_buttons_cache = []
        return self._rail_buttons_cache

    # ------------------------------------------------------------------
    # Camera-reference cache (live name resolution)
    # ------------------------------------------------------------------

    def _resolve_cam_name(self, shot, doc):
        """Return the current display name for this shot's camera, or the
        last-known stored name if the camera is gone (orphan).

        Resolution order:
        1. Persistent BaseLink stored in the helper null. Survives save/load
           and follows the camera through OM renames — this is the path
           that lets a rename after reopening a project show up.
        2. In-memory BaseObject cache (populated on drop or first
           successful resolution). Avoids re-resolving the BaseLink every
           draw within a session.
        3. Fallback: the persisted `cam_name` string. Used when the camera
           is gone (orphan). NOTE: we deliberately do NOT walk the doc
           by-name here. Re-binding to a same-named survivor would silently
           heal an orphan and erase the user's signal that a delete
           happened — the orphan visual is the point.
        """
        sid = shot.get("id")
        if doc is not None and sid is not None:
            cam = _get_shot_cam(doc, sid)
            if cam is not None:
                self._cam_refs[sid] = cam
                try:
                    return cam.GetName()
                except Exception:
                    pass
            else:
                # BaseLink resolved to None → camera is gone. Drop any
                # stale in-memory ref so the orphan state is consistent.
                self._cam_refs.pop(sid, None)
        cam = self._cam_refs.get(sid)
        if cam is not None:
            try:
                return cam.GetName()
            except Exception:
                self._cam_refs.pop(sid, None)
        return shot.get("cam_name", "")

    def _is_orphan(self, shot, doc):
        """True when this shot's camera has been deleted from the document.
        Resolution order matches `_resolve_cam_name` — if the BaseLink is
        dead AND the in-memory cache is empty, the shot is orphaned."""
        sid = shot.get("id")
        if doc is None or sid is None:
            return False
        if _get_shot_cam(doc, sid) is not None:
            return False
        cam = self._cam_refs.get(sid)
        if cam is None:
            return True
        # In-memory ref might still point to a freed object; calling
        # GetName() on a deleted BaseObject raises in C4D Python.
        try:
            cam.GetName()
            return False
        except Exception:
            self._cam_refs.pop(sid, None)
            return True

    def _remember_cam(self, shot_id, cam_obj):
        """Cache the BaseObject reference for a freshly-created shot AND
        persist a BaseLink so the connection survives save/load."""
        if cam_obj is None:
            return
        self._cam_refs[shot_id] = cam_obj
        doc = c4d.documents.GetActiveDocument()
        if doc is not None:
            _set_shot_cam_link(doc, shot_id, cam_obj)

    # ------------------------------------------------------------------
    # Coordinate helpers
    # ------------------------------------------------------------------

    def _timeline_x0(self):
        """Left edge of the timeline content area (right of the rail,
        accounting for interior padding)."""
        return LEFT_RAIL_WIDTH + TIMELINE_PAD_X

    def _timeline_x1(self, w):
        """Right edge of the timeline content area (interior of the right
        padding)."""
        return w - TIMELINE_PAD_X

    def _frame_to_x(self, frame, w):
        span = max(1, self.visible_last - self.visible_first)
        inner_w = max(1, self._timeline_x1(w) - self._timeline_x0())
        return self._timeline_x0() + int((frame - self.visible_first) / span * inner_w)

    def _shot_x_bounds(self, in_f, out_f, w):
        """Return (sx1, sx2) — the inclusive pixel range of a shot whose
        frame range is [in_f, out_f]. The right edge maps to the pixel
        just before frame (out_f + 1) so adjacent shots' pixel ranges
        abut perfectly: if shot A ends at out=N and shot B starts at
        in=N+1, A's sx2 == B's sx1 - 1 and the visible gap is zero."""
        sx1 = self._frame_to_x(in_f, w)
        sx2 = self._frame_to_x(out_f + 1, w) - 1
        if sx2 < sx1 + 2:
            sx2 = sx1 + 2
        return sx1, sx2

    def _x_to_frame(self, x, w):
        span = max(1, self.visible_last - self.visible_first)
        inner_w = max(1, self._timeline_x1(w) - self._timeline_x0())
        return self.visible_first + int((x - self._timeline_x0()) / inner_w * span)

    def _frames_per_pixel(self, w):
        span = max(1, self.visible_last - self.visible_first)
        return span / max(1, self._timeline_x1(w) - self._timeline_x0())

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

    def _pick_minor_substeps(self, major_step):
        """Return (minor_step, sub_step) — the un-numbered subdivisions
        between major numbered ticks. Picks divisors that make the major
        step land on a clean grid: 5 sub-divisions for steps that are
        multiples of 5 or 10 (the common case at most zooms), 4 for
        24-frame second-multiples, 2 as a fallback. sub_step further
        subdivides minor and is suppressed (returned as 0) when it would
        produce sub-pixel ticks at the current zoom."""
        if major_step <= 1:
            return 0, 0
        if major_step % 10 == 0:
            return major_step // 10, major_step // 10  # 10 minor / 0 sub
        if major_step % 5 == 0:
            return major_step // 5, 0
        if major_step % 4 == 0:
            return major_step // 4, 0
        if major_step % 3 == 0:
            return major_step // 3, 0
        if major_step % 2 == 0:
            return major_step // 2, 0
        return 0, 0

    # Track-lane Y geometry — track 0 is vertically centered in the timeline
    # content area (NLE convention: Premiere/FCP/Resolve anchor V1/A1 at the
    # divider, video grows up, audio grows down). The area below track 0 is
    # reserved for audio tracks (added in a later version).
    #
    # Sizing rules in priority order:
    #   1. Track 0 is centered when the canvas is tall enough.
    #   2. The top of the highest displayed track must not go above
    #      SHOT_Y_TOP (the bottom of the ruler). When the canvas shrinks,
    #      we slide track 0 *down* so the upper tracks dock against the
    #      ruler rather than disappearing under it.
    #   3. Track 0's top never falls below SHOT_Y_TOP (no negative case).
    def _track_0_top(self):
        h = self.GetHeight()
        # Determine how many lanes we'll be drawing — the top one sets the
        # ceiling. _displayed_lane_count needs the current shots; we read
        # them from the doc once per draw, but for the Y math here we just
        # use the cached top track count via a helper.
        top_track = max(0, self._displayed_top_track())
        natural_center = (SHOT_Y_TOP + h) // 2
        natural_top = natural_center - SHOT_HEIGHT // 2
        # Lowest allowed t0_top so top_track's top stays >= SHOT_Y_TOP.
        min_t0_top = SHOT_Y_TOP + top_track * (SHOT_HEIGHT + LANE_GAP)
        return max(SHOT_Y_TOP, max(natural_top, min_t0_top))

    def _displayed_top_track(self):
        """Index of the highest track currently being displayed (0-based).
        Reads the doc; returns 0 when there are no shots or the doc is
        unavailable. Used by the Y-geometry helpers to dock the stack
        against the ruler when the canvas is short."""
        try:
            doc = c4d.documents.GetActiveDocument()
            shots = self._preview_shots
            if shots is None:
                shots, _ = _read_shots(doc)
            return _displayed_lane_count(shots) - 1
        except Exception:
            return 0

    def _track_y_top(self, track):
        return self._track_0_top() - track * (SHOT_HEIGHT + LANE_GAP)

    # v7: audio renders below track 0, separated by LANE_GAP. Returns
    # the (top, bottom) Y bounds of the audio block in canvas pixels.
    # Used by both the draw path and audio-block hit-test.
    def _audio_y_bounds(self):
        t0_bot   = self._track_0_top() + SHOT_HEIGHT
        audio_top = t0_bot + LANE_GAP
        audio_bot = audio_top + AUDIO_HEIGHT
        return audio_top, audio_bot

    def _y_to_track(self, y, lane_count):
        t0_top = self._track_0_top()
        if y >= t0_top + SHOT_HEIGHT:
            return 0
        diff = (t0_top + SHOT_HEIGHT - 1 - y) // (SHOT_HEIGHT + LANE_GAP)
        return max(0, min(lane_count - 1, int(diff)))

    # ------------------------------------------------------------------
    # Left rail — tools and per-track labels (Premiere-style layout)
    # ------------------------------------------------------------------

    def _build_rail_buttons(self):
        """Load bitmaps for each rail toggle button and bake hover/press
        tinted copies. Returns a list of dicts with 'name', 'state_attr'
        (the canvas attribute name holding bool state), bitmaps, and an
        x/y rect computed at draw/hit-test time from the button index."""
        here = os.path.dirname(os.path.abspath(__file__))
        icons = os.path.join(here, "res", "icons")

        def make(name, state_attr):
            off = load_bitmap(os.path.join(icons, name + "-off.png"))
            on  = load_bitmap(os.path.join(icons, name + "-on.png"))
            return {
                "name":        name,
                "state_attr":  state_attr,
                "off":         off,
                "on":          on,
                "off_hover":   tinted_copy(off, (255, 255, 255), HOVER_LIGHTEN),
                "on_hover":    tinted_copy(on,  (255, 255, 255), HOVER_LIGHTEN),
                "off_press":   tinted_copy(off, (0,   0,   0),   PRESS_DARKEN),
                "on_press":    tinted_copy(on,  (0,   0,   0),   PRESS_DARKEN),
            }

        return [
            make("snap", "_snap_enabled"),
            make("loop", "_loop_enabled"),
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

    def _rail_button_rect(self, idx):
        """Return (x1, y1, x2, y2) — bbox of the button at index `idx`
        in canvas-local coords. Buttons are stacked vertically along
        the top of the rail, then wrap if the rail ever needs more
        than one column (not yet)."""
        # Single-column layout for now: one button per row.
        x1 = (LEFT_RAIL_WIDTH - RAIL_BTN_SIZE) // 2  # centered horizontally
        y1 = RAIL_BTN_TOP + idx * (RAIL_BTN_SIZE + RAIL_BTN_GAP)
        return x1, y1, x1 + RAIL_BTN_SIZE, y1 + RAIL_BTN_SIZE

    def _rail_button_at(self, x, y):
        """Return the button dict (and its index) under (x, y), or
        (None, None) if the cursor isn't over a rail button."""
        if x >= LEFT_RAIL_WIDTH:
            return None, None
        for i, btn in enumerate(self._rail_buttons):
            bx1, by1, bx2, by2 = self._rail_button_rect(i)
            if bx1 <= x < bx2 and by1 <= y < by2:
                return btn, i
        return None, None

    def _handle_rail_click(self, x, y):
        """Process a click in the rail area. Hit-tests against the rail
        buttons; on release, commits the toggle ONLY if the cursor is
        still over the same button. Dragging off cancels: the press tint
        is removed and the button doesn't toggle. Standard "click vs.
        cancel" gesture."""
        btn, idx = self._rail_button_at(x, y)
        if btn is None:
            return  # rail empty space — nothing to do
        bx1, by1, bx2, by2 = self._rail_button_rect(idx)
        self._rail_pressed = btn["name"]
        self.Redraw()
        # MouseDrag returns per-tick deltas (not absolute from press), so
        # we accumulate them — same convention as _drag_loop. Track
        # accumulated cursor position; if it crosses the button rect,
        # clear the press tint so the user sees that release will cancel.
        accum_dx = 0
        accum_dy = 0
        inside = True
        try:
            self.MouseDragStart(_KEY_MLEFT, x, y, _MOUSE_DRAG_FLAG)
            while True:
                state = self.MouseDrag()
                drag_state, dx, dy, _q = self._parse_drag_state(state)
                if self._is_drag_terminal(drag_state):
                    break
                accum_dx += int(dx or 0)
                accum_dy += int(dy or 0)
                cur_x = x + accum_dx
                cur_y = y + accum_dy
                still_inside = (bx1 <= cur_x < bx2 and by1 <= cur_y < by2)
                if still_inside != inside:
                    inside = still_inside
                    self._rail_pressed = btn["name"] if inside else None
                    self.Redraw()
            self.MouseDragEnd()
        except Exception as e:
            print("[Shotblocks] rail drag loop raised: {}".format(e))
        # Final commit decision: only if release was inside the button.
        committed = inside
        self._rail_pressed = None
        if committed:
            attr = btn["state_attr"]
            new_val = not bool(getattr(self, attr, False))
            setattr(self, attr, new_val)
            print("[Shotblocks] {} = {}".format(attr.lstrip("_"), new_val))
        self.Redraw()

    # ------------------------------------------------------------------
    # Hit testing
    # ------------------------------------------------------------------

    def _hit_test_playhead_head(self, x, y, w):
        """True if (x, y) is inside the playhead triangle handle's bbox.
        Hit zone matches the rendered triangle (centered on playhead x,
        full height = PLAYHEAD_HEAD_H, full width = PLAYHEAD_HEAD_W)."""
        if y < 0 or y >= PLAYHEAD_HEAD_H:
            return False
        px = self._frame_to_x(self.playhead_frame, w)
        return abs(x - px) <= PLAYHEAD_HEAD_W // 2

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
            sy_top = self._track_y_top(track)
            sy_bot = sy_top + SHOT_HEIGHT - 1
            if y < sy_top or y > sy_bot:
                continue
            sx1, sx2 = self._shot_x_bounds(shot["in_frame"], shot["out_frame"], w)
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

        # Background — the timeline area only. The rail paints itself
        # at the end so its content lands on top of any chrome.
        self.DrawSetPen(COL_BG_TIMELINE)
        self.DrawRectangle(LEFT_RAIL_WIDTH, 0, w, h)

        # Play-range bar at the very top (starts after the rail)
        range_in, range_out = self._get_preview_range_or_doc()
        self.DrawSetPen(COL_RANGE_BAR)
        self.DrawRectangle(LEFT_RAIL_WIDTH, 0, w, RANGE_HEIGHT)
        rin_x  = self._frame_to_x(range_in,  w)
        rout_x = self._frame_to_x(range_out, w)
        if rout_x < rin_x:
            rin_x, rout_x = rout_x, rin_x
        self.DrawSetPen(COL_RANGE_ACTIVE)
        self.DrawRectangle(rin_x, 0, rout_x, RANGE_HEIGHT)
        # Handles flanking the active region — hover highlight when the
        # cursor is over a handle.
        in_handle_color  = (COL_RANGE_HANDLE_HOVER if self._hover_range == "in"
                            else COL_RANGE_HANDLE)
        out_handle_color = (COL_RANGE_HANDLE_HOVER if self._hover_range == "out"
                            else COL_RANGE_HANDLE)
        self.DrawSetPen(in_handle_color)
        self.DrawRectangle(max(LEFT_RAIL_WIDTH, rin_x - 2), 0, rin_x + 1, RANGE_HEIGHT)
        self.DrawSetPen(out_handle_color)
        self.DrawRectangle(rout_x - 1, 0, min(w, rout_x + 2), RANGE_HEIGHT)
        # Bottom border separating range bar from ruler
        self.DrawSetPen(COL_BORDER_SUB)
        self.DrawLine(LEFT_RAIL_WIDTH, RANGE_HEIGHT, w, RANGE_HEIGHT)

        # Ruler band (now starts below the range bar)
        ruler_top = RULER_Y_TOP
        ruler_bot = RULER_Y_TOP + RULER_HEIGHT
        self.DrawSetPen(COL_BG_RULER)
        self.DrawRectangle(LEFT_RAIL_WIDTH, ruler_top, w, ruler_bot)
        self.DrawSetPen(COL_BORDER_SUB)
        self.DrawLine(LEFT_RAIL_WIDTH, ruler_bot, w, ruler_bot)

        # Frame ticks: three tiers — major (numbered, tall), minor
        # (un-numbered, medium), and sub (un-numbered, short, only when
        # the spacing stays >= ~3 px so they don't visually merge into
        # a smear). Mirrors the C4D native timeline's tick density.
        major_step = self._pick_tick_step(w)
        minor_step, sub_step = self._pick_minor_substeps(major_step)
        fpp = self._frames_per_pixel(w) or 1.0
        # Draw sub-ticks first (lightest), then minor, then major + labels —
        # so longer ticks paint over shorter ones at coincident positions.
        if sub_step > 0 and sub_step < minor_step and (sub_step / fpp) >= 3.0:
            self.DrawSetPen(COL_BORDER_SUB)
            first_sub = ((self.visible_first + sub_step - 1) // sub_step) * sub_step
            for frame in range(first_sub, self.visible_last + 1, sub_step):
                if minor_step and frame % minor_step == 0:
                    continue
                if frame % major_step == 0:
                    continue
                tx = self._frame_to_x(frame, w)
                self.DrawLine(tx, ruler_bot - 2, tx, ruler_bot - 1)
        if minor_step > 0 and (minor_step / fpp) >= 4.0:
            self.DrawSetPen(COL_RULER_TEXT)
            first_min = ((self.visible_first + minor_step - 1) // minor_step) * minor_step
            for frame in range(first_min, self.visible_last + 1, minor_step):
                if frame % major_step == 0:
                    continue
                tx = self._frame_to_x(frame, w)
                self.DrawLine(tx, ruler_bot - 4, tx, ruler_bot - 1)
        # Major ticks + labels. Always draw a tick at visible_last so the
        # right edge of the ruler shows the actual project end frame even
        # when it's not a multiple of major_step.
        self.DrawSetPen(COL_RULER_TEXT)
        self.DrawSetTextCol(COL_RULER_TEXT, COL_BG_RULER)
        first_maj = ((self.visible_first + major_step - 1) // major_step) * major_step
        major_frames = list(range(first_maj, self.visible_last + 1, major_step))
        if not major_frames or major_frames[-1] != self.visible_last:
            major_frames.append(self.visible_last)
        for frame in major_frames:
            tx = self._frame_to_x(frame, w)
            self.DrawLine(tx, ruler_bot - 7, tx, ruler_bot - 1)
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

        # Lane backgrounds (alternating) and separators. Tracks grow upward
        # from a vertically centered track 0 anchor.
        for track in range(lane_count):
            yt = self._track_y_top(track)
            yb = yt + SHOT_HEIGHT
            bg = COL_BG_TRACK if (track % 2 == 0) else COL_BG_TRACK_ALT
            self.DrawSetPen(bg)
            self.DrawRectangle(LEFT_RAIL_WIDTH, yt, w, yb)
            self.DrawSetPen(COL_BORDER_SUB)
            self.DrawLine(LEFT_RAIL_WIDTH, yb, w, yb)

        # Video/audio divider — emphasized line directly under track 0 marking
        # where audio tracks will appear.
        t0_bot = self._track_0_top() + SHOT_HEIGHT
        self.DrawSetPen(COL_BORDER_EMPH)
        self.DrawLine(LEFT_RAIL_WIDTH, t0_bot, w, t0_bot)

        # Orphan-count transition log. Cheap predicate per shot — just a
        # BaseLink dereference. Logging happens *only* on increase so the
        # user gets a single console message per camera deletion.
        doc_for_orphans = c4d.documents.GetActiveDocument()
        orphan_count = sum(1 for s in shots if self._is_orphan(s, doc_for_orphans))
        if orphan_count > self._last_orphan_count:
            print("[Shotblocks] camera deleted; {} shot(s) now orphaned. "
                  "Cmd+Z to restore.".format(orphan_count))
        self._last_orphan_count = orphan_count

        # Shots
        for shot in shots:
            track  = _shot_track(shot)
            yt     = self._track_y_top(track)
            self._draw_shot_block(shot, w, yt, shot["id"] in self._selected_ids)

        # Audio block (v7) — re-syncs from the doc on first draw or on
        # doc switch, then renders below track 0.
        self._sync_audio_for_active_doc()
        if self._audio_track.decoded is not None:
            self._draw_audio_block(w)

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
            yt = self._track_y_top(self._drag_track)
            self.DrawLine(LEFT_RAIL_WIDTH, yt, w, yt)
            self.DrawLine(LEFT_RAIL_WIDTH, yt + SHOT_HEIGHT, w, yt + SHOT_HEIGHT)

        # Playhead (always on top, but only over the timeline area —
        # the rail paints later and covers any stem that strays left).
        px = self._frame_to_x(self.playhead_frame, w)
        self.DrawSetPen(COL_CURSOR)
        self.DrawLine(px, 0, px, h)
        self._draw_playhead_head(px)

        # Snap indicator — yellow vertical lines at each frame the
        # in-flight drag is currently magnetized to. Drawn after the
        # playhead so a snap-to-playhead overrides the playhead line
        # visually with the snap signal. Cleared when the drag commits.
        if self._snap_indicator_frames:
            self.DrawSetPen(COL_SNAP_INDICATOR)
            for frame in self._snap_indicator_frames:
                ix = self._frame_to_x(frame, w)
                self.DrawLine(ix, 0, ix, h)

        # Left rail — drawn last so its background covers any chrome that
        # extends to x=0 (e.g. range-bar leftover, ruler leftover, lane
        # tail). The rail owns columns x ∈ [0, LEFT_RAIL_WIDTH).
        self._draw_rail(w, h, lane_count)

    def _draw_rail(self, w, h, lane_count):
        """Paint the left rail: background, divider, toggle buttons,
        and per-track labels aligned with each track row."""
        # Background and right-edge divider
        self.DrawSetPen(COL_BG_RAIL)
        self.DrawRectangle(0, 0, LEFT_RAIL_WIDTH, h)
        self.DrawSetPen(COL_RAIL_BORDER)
        self.DrawLine(LEFT_RAIL_WIDTH - 1, 0, LEFT_RAIL_WIDTH - 1, h)

        # Toggle buttons
        for i, btn in enumerate(self._rail_buttons):
            bx1, by1, bx2, by2 = self._rail_button_rect(i)
            state = bool(getattr(self, btn["state_attr"], False))
            if self._rail_pressed == btn["name"]:
                bmp = btn["on_press"] if state else btn["off_press"]
            elif self._rail_hover == btn["name"]:
                bmp = btn["on_hover"] if state else btn["off_hover"]
            else:
                bmp = btn["on"] if state else btn["off"]
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

        # Per-track labels — "Track N" left-aligned in the rail, vertically
        # centered with each track row. Only labels for tracks that are
        # currently displayed (lane_count comes from the active shot list).
        self.DrawSetTextCol(COL_RAIL_LABEL, COL_BG_RAIL)
        for track in range(lane_count):
            yt = self._track_y_top(track)
            label = "Track {}".format(track)
            label_y = yt + (SHOT_HEIGHT - 12) // 2
            self.DrawText(label, 8, label_y)

    def _draw_playhead_head(self, px):
        # Filled downward triangle. DrawRectangle with y1==y2 is degenerate in
        # C4D 2026 (renders zero pixels), so each row is an explicit 1-pixel-
        # tall rect spanning [r, r+1].
        half = PLAYHEAD_HEAD_W // 2
        self.DrawSetPen(COL_PLAYHEAD_HEAD)
        for r in range(PLAYHEAD_HEAD_H):
            ratio = r / float(max(1, PLAYHEAD_HEAD_H - 1))
            ww = max(0, int(round(half * (1.0 - ratio))))
            self.DrawRectangle(px - ww, r, px + ww, r + 1)

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

    def _draw_shot_block(self, shot, w, y_top, selected):
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
        return (sx2 - sx1) < (2 * EDGE_BAND_PX + 28)

    def _label_bg_for_state(self, state, selected, orphan):
        """Background color for label antialiasing. Matches the SVG
        body fill exactly — `#1C1C1C` for all current shot states (the
        body color stays constant; only the handles change)."""
        return COL_SHOT_BODY_FILL

    def _draw_shot_block_procedural(self, shot_id, sx1, sy1, sx2, sy2,
                                    selected, orphan):
        """Fallback draw path — used when bitmaps aren't available.
        Mirrors the pre-bitmap draw code so the timeline keeps working
        with SVG-pipeline assets missing."""
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

        cursor_info_id = getattr(c4d, "BFM_GETCURSORINFO", None)
        if cursor_info_id is not None and msg_id == cursor_info_id:
            try:
                return self._on_cursor_info(msg, result)
            except Exception as e:
                print("[Shotblocks] cursor-info error: {}".format(e))
                return False

        return super().Message(msg, result)

    def _on_drag_receive(self, msg, result):
        if msg.GetInt32(c4d.BFM_DRAG_LOST) or msg.GetInt32(c4d.BFM_DRAG_ESC):
            self._clear_drag()
            return True

        cameras  = self._drag_cameras(msg)
        audio_path = None if cameras else self._drag_audio_path(msg)
        if not cameras and audio_path is None:
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

        if audio_path is not None:
            self._clear_drag()
            return self._import_audio_file(audio_path, drop_frame)

        # Drop-on-existing-shot → relink that shot's camera. Works on
        # orphans (the architecture's primary use case) AND healthy shots
        # (one-gesture re-camera). If the drop is on empty canvas space,
        # fall through to the create path.
        target_shot_id = None
        if local_xy is not None:
            x, y = local_xy
            doc = c4d.documents.GetActiveDocument()
            shots, _ = _read_shots(doc)
            target_shot_id, _region = self._hit_test(x, y, shots, self.GetWidth())

        self._clear_drag()
        if target_shot_id is not None and cameras:
            return self._relink_shot(target_shot_id, cameras[0])
        return self._create_shots_at(drop_frame, drop_track, cameras)

    def _drag_audio_path(self, msg):
        """Pull a supported audio file path (`.wav` or `.mp3`) out of a
        drag message, if the drag type is one of the file-drop types.
        Returns None on miss. Tolerates the several shapes
        GetDragObject returns for file drops in different C4D builds
        (string, list of strings, dict)."""
        try:
            drag_info = self.GetDragObject(msg)
        except Exception:
            return None

        if isinstance(drag_info, dict):
            drag_type = drag_info.get("type", drag_info.get("dragtype"))
            drag_obj  = drag_info.get("object", drag_info.get("dragobject"))
        elif isinstance(drag_info, (list, tuple)) and len(drag_info) >= 2:
            drag_type, drag_obj = drag_info[0], drag_info[1]
        else:
            return None

        # Log unknown drag types once to help diagnose v7 file-drop
        # behavior on the user's actual machine. Removed once we
        # confirm DRAGTYPE_FILES is what fires for OS file explorer drops.
        if drag_type not in self._audio_drag_logged_types:
            self._audio_drag_logged_types.add(drag_type)
            print("[Shotblocks] drag-receive type={} obj-type={}".format(
                drag_type, type(drag_obj).__name__))

        if drag_type not in (c4d.DRAGTYPE_FILES,
                             c4d.DRAGTYPE_FILENAME_OTHER,
                             getattr(c4d, "DRAGTYPE_BROWSER_SOUND", -1)):
            return None

        # Normalize to a list of path strings.
        if isinstance(drag_obj, str):
            paths = [drag_obj]
        elif isinstance(drag_obj, (list, tuple)):
            paths = [p for p in drag_obj if isinstance(p, str)]
        else:
            paths = []

        for p in paths:
            if is_audio_path(p):
                return p
        return None

    def _import_audio_file(self, audio_path, drop_frame):
        """Bring a WAV or MP3 file in as the document's audio track.
        Replaces any existing track. Wraps the persistence write in
        undo so the user can Cmd+Z back to no-audio."""
        doc = c4d.documents.GetActiveDocument()
        try:
            doc.StartUndo()
            _get_or_create_helper(doc)
            self._audio_track.import_file(audio_path, doc, drop_in_frame=drop_frame)
            doc.EndUndo()
        except AudioTrackError as e:
            print("[Shotblocks] audio import failed: {}".format(e))
            try:
                doc.EndUndo()
            except Exception:
                pass
            return False
        except Exception as e:
            print("[Shotblocks] audio import unexpected error: {}".format(e))
            try:
                doc.EndUndo()
            except Exception:
                pass
            return False
        # Hand the new audio data to the playback engine immediately so
        # the next spacebar press kicks off correctly without waiting
        # for a full reload cycle.
        self._audio_playback.set_audio(self._audio_track.decoded)
        # Update the loaded-signature so the next draw's sync is a
        # no-op rather than re-decoding what we just loaded.
        self._refresh_audio_loaded_sig(doc)
        c4d.EventAdd()
        self.Redraw()
        print("[Shotblocks] audio imported: {} ({:.2f}s)".format(
            os.path.basename(audio_path),
            self._audio_track.decoded.duration_s))
        return True

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
            self._remember_cam(new_shot["id"], cam)
            drop_mode  = "snap" if self._snap_enabled else "replace"
            snap_frames = self._snap_frames() if drop_mode == "snap" else 0
            shots, _snap_targets = _resolve_position(
                shots, new_shot["id"],
                new_shot["in_frame"],
                new_shot["track"], drop_mode, snap_frames,
                extra_points=(self.playhead_frame,))
            print("[Shotblocks] created shot id={} cam='{}' frames={}-{} track={}".format(
                next_id, cam.GetName(), drop_frame, drop_frame + DEFAULT_SHOT_FRAMES,
                new_shot["track"]))
            next_id += 1

        _write_shots(doc, shots, next_id, with_undo=True)
        doc.EndUndo()
        c4d.EventAdd()
        self.Redraw()
        return True

    def _relink_shot(self, shot_id, cam):
        """Swap a shot's camera reference for `cam`. In/out range, track,
        and id are preserved. Used both for healing orphans (drag a
        replacement camera onto the broken block) and for one-gesture
        re-cameraing of a healthy shot. Wrapped in undo.

        Undo correctness note: a single `AddUndo(helper)` must precede ALL
        helper-container writes inside the StartUndo/EndUndo block. Both
        the shot-list JSON (`cam_name`) AND the BaseLink live on the
        helper's BaseContainer — registering undo only around the JSON
        write would snapshot the helper *after* the BaseLink was already
        rewritten, leaving Cmd+Z unable to restore the previous link.
        """
        doc = c4d.documents.GetActiveDocument()
        shots, next_id = _read_shots(doc)
        target = next((s for s in shots if s["id"] == shot_id), None)
        if target is None or cam is None:
            return False

        prev_name = target.get("cam_name", "")
        new_name  = cam.GetName()
        was_orphan = self._is_orphan(target, doc)

        doc.StartUndo()
        # Snapshot the helper BEFORE any container write so undo restores
        # both the JSON shot list and the per-shot BaseLink.
        helper = _get_or_create_helper(doc)
        doc.AddUndo(c4d.UNDOTYPE_CHANGE_SMALL, helper)
        target["cam_name"] = new_name
        self._remember_cam(shot_id, cam)
        _write_shots(doc, shots, next_id, with_undo=False)
        doc.EndUndo()
        # Recount orphans on next draw — relinking an orphan should
        # reduce the count without re-triggering the upward-transition log.
        # We pre-decrement here so DrawMsg doesn't see a phantom decrease.
        if was_orphan and self._last_orphan_count > 0:
            self._last_orphan_count -= 1
        c4d.EventAdd()
        self.Redraw()
        print("[Shotblocks] relinked shot id={} '{}' → '{}'{}".format(
            shot_id, prev_name, new_name,
            " (was orphan)" if was_orphan else ""))
        return True

    def _clear_drag(self):
        if self._drag_over or self._drag_frame >= 0:
            self._drag_over  = False
            self._drag_frame = -1
            self.Redraw()

    # ------------------------------------------------------------------
    # Cursor info (BFM_GETCURSORINFO) — drives the hover highlights.
    # ------------------------------------------------------------------
    #
    # We don't change the OS cursor here. Tried multiple approaches
    # (RESULT_CURSOR via the message result container, c4d.gui.SetMousePointer,
    # GetInputState-based modifier polling) — none reliably change the
    # cursor over our GeUserArea in C4D 2026. The visual hover overlay
    # on edges and range-handles serves as the primary "you can drag here"
    # affordance instead. Pan-on-Alt remains undocumented in the UI; if
    # we want to surface it later, a tooltip or status-bar hint is more
    # likely to work than a cursor change.

    def _on_cursor_info(self, msg, result):
        x, y = self._cursor_local_xy(msg)
        if x is None:
            return False
        w, h = self.GetWidth(), self.GetHeight()
        if not (0 <= x < w and 0 <= y < h):
            return False
        # Rail hover — set the hovered button name (or None) based on the
        # cursor position. Cursor outside the rail clears rail hover.
        if x < LEFT_RAIL_WIDTH:
            btn, _idx = self._rail_button_at(x, y)
            new_rail_hover = btn["name"] if btn is not None else None
        else:
            new_rail_hover = None
        if new_rail_hover != self._rail_hover:
            self._rail_hover = new_rail_hover
            self.Redraw()
        new_band  = self._compute_hover_band(x, y)
        new_range = self._compute_hover_range(x, y)
        if new_band != self._hover_band or new_range != self._hover_range:
            # Hover-band change: drive the animation targets so the
            # previously-hovered edge fades out and the newly-hovered
            # edge fades in. Both transitions can run concurrently.
            old_band = self._hover_band
            if old_band is not None:
                self._set_hover_target(old_band[0], old_band[1], False)
            if new_band is not None:
                self._set_hover_target(new_band[0], new_band[1], True)
            self._hover_band  = new_band
            self._hover_range = new_range
            self.Redraw()

        return False

    def _cursor_local_xy(self, msg):
        """Return (x, y) of the cursor in canvas-local coords, or (None, None).
        BFM_GETCURSORINFO carries position in BFM_DRAG_SCREENX/Y (screen
        coordinates) — convert via Local2Screen origin."""
        try:
            sx = msg.GetInt32(c4d.BFM_DRAG_SCREENX)
            sy = msg.GetInt32(c4d.BFM_DRAG_SCREENY)
        except Exception:
            return None, None
        origin = self.Local2Screen()
        if isinstance(origin, dict):
            return sx - origin.get("x", 0), sy - origin.get("y", 0)
        if isinstance(origin, (list, tuple)) and len(origin) >= 2:
            return sx - int(origin[0]), sy - int(origin[1])
        return sx, sy

    def _compute_hover_range(self, x, y):
        """Return 'in' | 'out' if the cursor is over a play-range handle,
        else None. Mirrors the visual range-handle width (CURSOR_EDGE_PX)."""
        if y < 0 or y >= RANGE_HEIGHT:
            return None
        w = self.GetWidth()
        if w <= 0:
            return None
        range_in, range_out = self._get_preview_range_or_doc()
        rin_x  = self._frame_to_x(range_in,  w)
        rout_x = self._frame_to_x(range_out, w)
        d_in  = abs(x - rin_x)
        d_out = abs(x - rout_x)
        # Closest handle wins when zones overlap; outside both → no hover.
        if d_in <= CURSOR_EDGE_PX and d_in <= d_out:
            return "in"
        if d_out <= CURSOR_EDGE_PX:
            return "out"
        return None

    def _compute_hover_band(self, x, y):
        """Return (id, 'left'|'right') if the cursor is over an edge
        band, else None. `id` is a shot id (int) for shot blocks or the
        sentinel string "audio" for the audio block. DrawMsg uses this
        to highlight only the hovered side."""
        w = self.GetWidth()
        if w <= 0:
            return None
        Y_BUFFER = 2
        doc = c4d.documents.GetActiveDocument()

        if self._audio_track.decoded is not None:
            ay1, ay2 = self._audio_y_bounds()
            if ay1 - Y_BUFFER <= y <= ay2 + Y_BUFFER:
                ax1, ax2 = self._audio_x_bounds(w)
                if ax1 <= x <= ax2:
                    edge_zone = min(CURSOR_EDGE_PX, max(1, (ax2 - ax1) // 3))
                    if (x - ax1) <= edge_zone:
                        return ("audio", "left")
                    if (ax2 - x) <= edge_zone:
                        return ("audio", "right")

        shots, _ = _read_shots(doc)
        for shot in shots:
            track  = _shot_track(shot)
            sy_top = self._track_y_top(track)
            sy_bot = sy_top + SHOT_HEIGHT - 1
            if y < sy_top - Y_BUFFER or y > sy_bot + Y_BUFFER:
                continue
            sx1, sx2 = self._shot_x_bounds(shot["in_frame"], shot["out_frame"], w)
            if x < sx1 or x > sx2:
                continue
            edge_zone = min(CURSOR_EDGE_PX, max(1, (sx2 - sx1) // 3))
            if (x - sx1) <= edge_zone:
                return (shot["id"], "left")
            if (sx2 - x) <= edge_zone:
                return (shot["id"], "right")
        return None

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
        """Right-click context menu. Entries depend on hit kind: shot →
        Set Range / Delete / Duplicate; audio block → Delete; empty
        canvas → Range to All."""
        w = self.GetWidth()
        doc = c4d.documents.GetActiveDocument()
        shots, _ = _read_shots(doc)
        shot_id, _region = self._hit_test(x, y, shots, w)

        # If the click missed every shot, see if it landed on the audio
        # block instead — RMB on the waveform should offer Delete.
        audio_hit = None
        if shot_id is None:
            audio_hit = self._hit_test_audio(x, y, w)
        print("[Shotblocks] RMB press at ({},{}) hit={} audio_hit={}".format(
            x, y, shot_id, bool(audio_hit)))

        bc = c4d.BaseContainer()

        if audio_hit is not None:
            # Make the audio block the active selection so Delete (and any
            # later audio menu items) are unambiguous about what they target.
            self._audio_selected = True
            self._selected_ids.clear()
            self.Redraw()
            bc.SetString(MENU_DELETE_AUDIO, "Delete Audio Track")
            result = self._show_popup(bc, x, y)
            self._dispatch_menu_result(result, doc, shots)
            return True

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
            # "Remove" verb on orphans matches architecture wording — the
            # user is clearing a broken reference, not deleting a working
            # shot. Falls back to "Delete" for healthy shots and any mixed
            # selection (any healthy shot in selection wins).
            sel_shots = [s for s in shots if s["id"] in self._selected_ids]
            all_orphans = bool(sel_shots) and all(
                self._is_orphan(s, doc) for s in sel_shots)
            del_label = "Remove" if all_orphans else "Delete"
            bc.SetString(MENU_DELETE,    del_label   + suffix)
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
        elif result == MENU_DELETE_AUDIO:
            self._delete_selected_audio()
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

        # Once-per-channel log so we can capture the actual code C4D 2026
        # reports for keys we haven't pinned down yet (e.g. spacebar).
        # Also log BFM_INPUT_VALUE the first few times — on some platforms
        # it distinguishes press from auto-repeat.
        if channel not in ShotblocksTimelineCanvas._kb_channel_logged:
            ShotblocksTimelineCanvas._kb_channel_logged.add(channel)
            try:
                val = msg.GetInt32(c4d.BFM_INPUT_VALUE)
            except Exception:
                val = "?"
            print("[Shotblocks] kb channel={} (0x{:x}) qual={:#x} value={}".format(
                channel, channel, qualifier, val))

        # Spacebar → play/pause toggle (v6). C4D 2026 reports space as
        # channel 61728 (= c4d.KEY_SPACE). Auto-repeat fires this handler
        # many times per real keystroke, so debounce on wall-clock time —
        # ignore toggles that arrive within _PLAY_TOGGLE_DEBOUNCE_S of the
        # previous one. 0.25 s is well above key-repeat cadence and well
        # below the user's reaction time for a deliberate second press.
        if channel in _SPACE_CHANNELS and not (qualifier & (_QSHIFT | _QCTRL | _QALT)):
            now = _monotonic()
            if now - self._last_play_toggle_t >= _PLAY_TOGGLE_DEBOUNCE_S:
                self._last_play_toggle_t = now
                self._toggle_playback()
            return True

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

        # C4D delivers '=' / '-' as channels 0x3D / 0x2D regardless of
        # Shift state, so Ctrl++ (Shift+=) and Ctrl+_ (Shift+-) reach
        # the same handler — no separate Shift branch needed.
        if (qualifier & _QCTRL) and channel in (ord('='), ord('-')):
            w = self.GetWidth()
            anchor_x = self._frame_to_x(self.playhead_frame, w)
            self._zoom_around_cursor(anchor_x, +1 if channel == ord('=') else -1)
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
    # Doc sync — visible window auto-fits to the doc's total frame range
    # ------------------------------------------------------------------

    def _fit_visible_to_doc(self, force=False):
        """Snap visible_first/last to the doc's [Min, Max] frame range so
        the timeline mirrors the project length set in C4D's project
        settings.

        Called on dialog open (force=True) and on EVMSG_CHANGE — but on
        EVMSG_CHANGE we only refit if the doc's length actually changed
        since last sync, so the user's pan/zoom isn't clobbered by every
        unrelated scene mutation."""
        doc = c4d.documents.GetActiveDocument()
        if doc is None:
            return False
        fps = self._doc_fps(doc)
        try:
            doc_first = int(doc.GetMinTime().GetFrame(fps))
            doc_last  = int(doc.GetMaxTime().GetFrame(fps))
        except Exception:
            return False
        if doc_last <= doc_first:
            return False
        last_known = getattr(self, "_last_doc_range", None)
        if not force and last_known == (doc_first, doc_last):
            return False
        self._last_doc_range = (doc_first, doc_last)
        if (doc_first, doc_last) == (self.visible_first, self.visible_last):
            return False
        self.visible_first = doc_first
        self.visible_last  = doc_last
        return True

    # ------------------------------------------------------------------
    # Playback (v6) — spacebar drives a doc-FPS Timer on the dialog
    # ------------------------------------------------------------------

    def _doc_fps(self, doc):
        try:
            fps = int(doc.GetFps())
        except Exception:
            fps = 0
        return fps if fps > 0 else 24

    def _toggle_playback(self):
        dlg = self._playback_owner_dialog
        if self._playing:
            self._playing = False
            if dlg is not None:
                dlg.stop_playback_timer()
            self._audio_playback.pause()
            print("[Shotblocks] playback paused at frame {}".format(self.playhead_frame))
            return

        doc = c4d.documents.GetActiveDocument()
        range_in, range_out = _read_range(doc)
        if self.playhead_frame < range_in or self.playhead_frame >= range_out:
            self.playhead_frame = range_in
        fps = self._doc_fps(doc)
        self._playing = True
        # Wall-clock anchor — used by _playback_tick to compute
        # playhead_frame from elapsed time. This gives a video clock
        # accurate to wall time within ±1 frame and prevents the
        # accumulating drift of the previous "advance by 1 each tick"
        # approach, which silently absorbed timer jitter and made
        # video drift slower than audio over a long clip.
        self._playback_anchor_t       = _monotonic()
        self._playback_anchor_frame   = self.playhead_frame
        if dlg is not None:
            dlg.start_playback_timer(fps)
        # Audio: kick off async playback starting at the audio frame
        # corresponding to the current timeline frame. If the playhead is
        # outside the audio block, doc_frame_to_audio_frame returns -1
        # and we don't start audio at all (silence until the user moves
        # the playhead inside the clip — same as a video-only timeline).
        # We deliberately do NOT call set_audio() here: that would tear
        # down the in-flight DecodedAudio reference and re-bind it to the
        # same data, just to re-issue the temp-file write. The data was
        # bound on import; spacebar should be near-instant.
        start_af = self._audio_track.doc_frame_to_audio_frame(
            self.playhead_frame, fps)
        if self._audio_track.decoded is not None and start_af >= 0:
            self._audio_playback.play(start_af)
        print("[Shotblocks] playback started at frame {} ({} fps)".format(
            self.playhead_frame, fps))

    def _route_camera_for_frame(self, doc, frame):
        """Resolve the active shot at `frame` and route its source camera
        to the active BaseDraw. On gap or orphan: leave the current camera
        alone — hold last good. The dashed-red orphan block on the timeline
        is the signal."""
        shots, _ = _read_shots(doc)
        active = _active_shot_at(shots, frame)
        if active is None:
            return
        cam = _get_shot_cam(doc, active.get("id"))
        if cam is None:
            return
        try:
            bd = doc.GetActiveBaseDraw()
            if bd is not None:
                bd[c4d.BASEDRAW_DATA_CAMERA] = cam
        except Exception as e:
            print("[Shotblocks] BaseDraw camera set failed: {}".format(e))

    def _anim_tick(self):
        """Advance each in-flight hover animation toward its target.
        Called from the dialog Timer at ~60 fps. Cleans up entries
        once both sides are at rest. Triggers a Redraw whenever any
        animation actually changed value."""
        anim = self._shot_hover_anim
        if not anim:
            return
        now  = _monotonic()
        dt   = max(0.0, now - self._last_anim_tick_t)
        self._last_anim_tick_t = now
        # Convert wall time to fade progress per side.
        step = dt / (HOVER_FADE_MS / 1000.0)
        any_changed = False
        to_remove = []
        for sid, st in anim.items():
            for side in ("left", "right"):
                t_key      = side + "_t"
                target_key = side + "_target"
                cur    = st[t_key]
                target = st[target_key]
                if cur == target:
                    continue
                if cur < target:
                    new = min(target, cur + step)
                else:
                    new = max(target, cur - step)
                st[t_key] = new
                any_changed = True
            # Cull when fully at rest with target=0.
            if (st["left_t"]   == 0.0 and st["left_target"]   == 0.0
                and st["right_t"]  == 0.0 and st["right_target"]  == 0.0):
                to_remove.append(sid)
        for sid in to_remove:
            del anim[sid]
        if any_changed:
            self.Redraw()

    def _set_hover_target(self, shot_id, side, on):
        """Set the animation target for a side ('left' or 'right') to
        1.0 (hovered) or 0.0 (not hovered). Creates the per-shot anim
        entry on first set. Wakes the dialog timer if needed."""
        if shot_id is None:
            return
        anim = self._shot_hover_anim
        was_empty = not anim  # was the animation system idle?
        st = anim.get(shot_id)
        if st is None:
            st = {"left_t":  0.0, "left_target":  0.0,
                  "right_t": 0.0, "right_target": 0.0}
            anim[shot_id] = st
        target_key = side + "_target"
        new_target = 1.0 if on else 0.0
        if st[target_key] != new_target:
            st[target_key] = new_target
            # Reset the tick clock when the animation system was idle
            # before this call. Without this, the first tick after the
            # timer wakes up sees a huge dt (time since the last anim
            # ended, which can be many seconds), and the first frame
            # snaps almost all the way to target instead of fading.
            if was_empty:
                self._last_anim_tick_t = _monotonic()
            dlg = self._playback_owner_dialog
            if dlg is not None and hasattr(dlg, "request_anim_tick"):
                dlg.request_anim_tick()
            # Pre-emptive redraw so the first visible frame paints now
            # instead of waiting for the timer's first tick (which on
            # some C4D builds waits the full interval before firing).
            # On enter, this paints frame 0 (still the normal bitmap).
            # Subsequent frames advance via the tick.
            self.Redraw()

    def _hover_t_for(self, shot_id, side):
        """Current animation t for a side (0..1). 0 means no hover."""
        st = self._shot_hover_anim.get(shot_id)
        if st is None:
            return 0.0
        return st[side + "_t"]

    def _playback_tick(self):
        """Called by the dialog's Timer (~60 Hz). Computes the current
        video frame from wall-clock elapsed time since spacebar press,
        which keeps the video clock locked to monotonic() the same way
        Windows audio is. The two clocks share one time source so they
        cannot drift relative to each other."""
        if not self._playing:
            return
        doc = c4d.documents.GetActiveDocument()
        if doc is None:
            self._playing = False
            dlg = self._playback_owner_dialog
            if dlg is not None:
                dlg.stop_playback_timer()
            return

        fps = self._doc_fps(doc)
        anchor_t      = getattr(self, "_playback_anchor_t",     _monotonic())
        anchor_frame  = getattr(self, "_playback_anchor_frame", self.playhead_frame)
        now           = _monotonic()
        target_frame  = anchor_frame + int((now - anchor_t) * fps)

        # Skip the per-tick work when the wall-clock target hasn't
        # moved past the previous frame — equivalent to the old
        # rate-limit, but anchored to a fixed start time so jitter
        # doesn't accumulate.
        if target_frame == self.playhead_frame:
            return

        range_in, range_out = _read_range(doc)
        if target_frame >= range_out:
            if self._loop_enabled:
                # Wrap. Re-anchor so the next frame computation starts
                # from range_in at a wall time corresponding to the
                # frame the wrap happened on (preserves audio sync
                # across the wrap).
                wrap_overflow_frames = target_frame - range_out
                wrap_overflow_t      = wrap_overflow_frames / float(fps)
                self.playhead_frame  = range_in
                self._playback_anchor_t     = now - wrap_overflow_t
                self._playback_anchor_frame = range_in
                # Audio: tell playback to re-issue from the new audio
                # frame (sync() detects the backward jump and reissues
                # PlaySound). Forward-only sync below would miss the wrap.
                if self._audio_track.decoded is not None and self._audio_playback.is_playing():
                    target_af = self._audio_track.doc_frame_to_audio_frame(
                        self.playhead_frame, fps)
                    if target_af < 0:
                        target_af = 0
                    self._audio_playback.sync(target_af)
            else:
                # Stop at out.
                self.playhead_frame = range_out
                self._playing = False
                dlg = self._playback_owner_dialog
                if dlg is not None:
                    dlg.stop_playback_timer()
                self._audio_playback.pause()
        else:
            self.playhead_frame = target_frame

        # Order matters: set camera FIRST, then time, then post the redraw.
        # If we set time before camera, C4D can render the next frame with
        # the new time but the previous camera (the redraw races our
        # camera write). Setting camera first guarantees the very next
        # render reflects both changes together.
        self._route_camera_for_frame(doc, self.playhead_frame)
        try:
            doc.SetTime(c4d.BaseTime(self.playhead_frame, fps))
        except Exception as e:
            print("[Shotblocks] SetTime failed: {}".format(e))
        c4d.EventAdd()
        self.Redraw()

    # ------------------------------------------------------------------
    # Audio block (v7) — sync, draw, hit-test, drag handlers
    # ------------------------------------------------------------------

    def _sync_audio_for_active_doc(self):
        """Load the audio track from the helper null if our in-memory
        state doesn't match what's persisted. Idempotent — called on
        every draw, but only re-decodes when the persisted-vs-loaded
        signature changes (path / in / out / trim). C4D 2026 returns
        a fresh Python wrapper for `GetActiveDocument()` on each call
        so id()-based caching is unreliable; comparing the persisted
        dict against the in-memory state is the safe signal."""
        try:
            doc = c4d.documents.GetActiveDocument()
        except Exception:
            doc = None
        if doc is None:
            return

        from sb_persistence import _read_audio
        persisted = _read_audio(doc)
        track     = self._audio_track

        if persisted is None:
            # Doc has no audio. If we currently hold one, drop it.
            if track.decoded is not None:
                self._audio_playback.stop()
                track._reset()
                print("[Shotblocks] audio cleared (doc has no audio)")
            return

        # Build a cheap signature from the persisted dict and compare.
        # Path resolution differs between persisted (project-relative
        # string) and in-memory (absolute) so we can't compare path
        # strings directly. Compare the placement keys instead — they
        # uniquely identify the audio state for our purposes.
        sig_persisted = (
            bool(persisted.get("path_is_relative", False)),
            persisted.get("path", ""),
            int(persisted.get("in_frame",  0)),
            int(persisted.get("out_frame", 0)),
            int(persisted.get("trim_start_audio_frames", 0)),
        )
        sig_loaded = getattr(self, "_audio_loaded_sig", None)
        if sig_persisted == sig_loaded:
            return

        try:
            loaded = track.load_from_doc(doc)
        except Exception as e:
            print("[Shotblocks] audio load_from_doc raised: {}".format(e))
            return
        self._audio_loaded_sig = sig_persisted
        self._audio_playback.set_audio(track.decoded if loaded else None)
        if loaded:
            print("[Shotblocks] audio loaded for doc: {} ({:.2f}s, {} Hz)".format(
                track.path,
                track.decoded.duration_s,
                track.decoded.sample_rate))

    def _audio_x_bounds(self, w):
        """Pixel bounds of the audio block on screen. Mirrors
        `_shot_x_bounds` for shots."""
        return self._shot_x_bounds(self._audio_track.in_frame,
                                   self._audio_track.out_frame, w)

    def _draw_audio_block(self, w):
        track = self._audio_track
        ax1, ax2 = self._audio_x_bounds(w)
        ay1, ay2 = self._audio_y_bounds()

        body_color = COL_AUDIO_BODY_SELECTED if self._audio_selected else COL_AUDIO_BODY
        state = "selected" if self._audio_selected else "normal"
        left_t  = self._hover_t_for("audio", "left")
        right_t = self._hover_t_for("audio", "right")
        rendered_via_bitmap = self._draw_block_bitmap(
            "audio", state,
            left_t=left_t, right_t=right_t,
            sx1=ax1, sy1=ay1, sx2=ax2, sy2=ay2)

        if not rendered_via_bitmap:
            self.DrawSetPen(body_color)
            self.DrawRectangle(ax1, ay1, ax2, ay2)
            self.DrawSetPen(COL_AUDIO_BORDER)
            self.DrawLine(ax1, ay1, ax2, ay1)
            self.DrawLine(ax1, ay2, ax2, ay2)
            self.DrawLine(ax1, ay1, ax1, ay2)
            self.DrawLine(ax2, ay1, ax2, ay2)

        # Waveform inset — keep it inside the body's mid slice so the
        # left/right edge handles (and their dot grips) stay visible.
        # Mirrors the shot-label band-clamp so a very narrow block
        # gracefully shrinks the inset.
        clip_w = ax2 - ax1
        band_w = max(1, min(EDGE_BAND_PX, clip_w // 3))
        wf_x1 = ax1 + band_w
        wf_x2 = ax2 - band_w
        wf_y1 = ay1 + 4
        wf_y2 = ay2 - 4
        if wf_x2 <= wf_x1 or wf_y2 <= wf_y1 or track.peaks is None:
            return

        # Compute the audio-frame range that actually maps to the
        # currently-visible block, then slice the peak cache. The cache
        # is built once at import time at a fixed high resolution
        # (samples_per_column=256 — see AudioTrack.import_file). We
        # never rebuild during draw — that put a multi-hundred-ms
        # full-file scan into every zoom-drag tick, freezing the UI.
        # Instead the renderer downsamples the cache slice to
        # `block_pixels` via nearest-neighbor below.
        doc      = c4d.documents.GetActiveDocument()
        fps      = self._doc_fps(doc)
        af0, af1 = track.audio_frames_for_visible_window(fps)
        block_pixels = max(1, wf_x2 - wf_x1)

        from sb_audio_peaks import slice_peaks
        peaks_slice, _col_offset = slice_peaks(track.peaks, af0, af1)
        if not peaks_slice:
            return

        # Downsample/upsample the slice to exactly block_pixels columns
        # so 1 list entry = 1 pixel column. Cheap nearest-neighbor pick.
        n = len(peaks_slice)
        if n != block_pixels:
            scaled = [None] * block_pixels
            for x in range(block_pixels):
                scaled[x] = peaks_slice[(x * n) // block_pixels]
            peaks_slice = scaled

        draw_waveform(self,
                      peaks_slice,
                      (wf_x1, wf_y1, wf_x2, wf_y2),
                      fg_rgb=COL_AUDIO_WAVEFORM,
                      mid_rgb=COL_AUDIO_CENTERLINE,
                      x_offset=0)

        # Label — file basename, top-left of the block.
        try:
            base = os.path.basename(track.path) or "audio"
        except Exception:
            base = "audio"
        self.DrawSetTextCol(COL_AUDIO_LABEL, _TEXT_BG_TRANS or body_color)
        self.DrawText(base, ax1 + 6, ay1 + 4)

    def _hit_test_audio(self, x, y, w):
        """Return None, ('audio', 'left'|'right'|'body') for clicks on
        the audio block. Used by left-press to dispatch to the right
        drag handler."""
        if self._audio_track.decoded is None:
            return None
        ay1, ay2 = self._audio_y_bounds()
        if y < ay1 or y > ay2:
            return None
        ax1, ax2 = self._audio_x_bounds(w)
        if x < ax1 or x > ax2:
            return None
        if x < ax1 + EDGE_HIT_PX:
            return ("audio", "left")
        if x > ax2 - EDGE_HIT_PX:
            return ("audio", "right")
        return ("audio", "body")

    def _drag_audio_move(self, mx, my):
        """Drag the entire audio block horizontally. Preserves duration
        and trim. Persists once at drag-end."""
        track = self._audio_track
        if track.decoded is None:
            return
        doc = c4d.documents.GetActiveDocument()
        orig_in = track.in_frame
        w = self.GetWidth()
        start_frame = self._x_to_frame(mx, w)

        def on_tick(adx, _ady, _qual):
            cur_frame = self._x_to_frame(mx + adx, w)
            new_in = orig_in + (cur_frame - start_frame)
            if new_in < 0:
                new_in = 0
            track.set_in_frame(new_in, doc, persist=False)
            self.Redraw()

        self._drag_loop(_KEY_MLEFT, mx, my, on_tick)
        # Persist once at end with undo.
        try:
            doc.StartUndo()
            _get_or_create_helper(doc)
            track._persist_current(doc)
            doc.EndUndo()
        except Exception as e:
            print("[Shotblocks] audio move persist failed: {}".format(e))
        self._refresh_audio_loaded_sig(doc)
        c4d.EventAdd()

    def _drag_audio_resize(self, edge, mx, my):
        """Edge-drag the audio block. `edge` is 'left' or 'right'."""
        track = self._audio_track
        if track.decoded is None:
            return
        doc = c4d.documents.GetActiveDocument()
        w = self.GetWidth()
        start_frame = self._x_to_frame(mx, w)
        orig_in   = track.in_frame
        orig_out  = track.out_frame
        orig_trim = track.trim_start_audio_frames

        def on_tick(adx, _ady, _qual):
            cur_frame = self._x_to_frame(mx + adx, w)
            delta = cur_frame - start_frame
            if edge == "left":
                # Reset to original each tick so the trim math is
                # absolute against the drag's start point, not cumulative.
                track.in_frame                = orig_in
                track.trim_start_audio_frames = orig_trim
                track.resize_left_edge(orig_in + delta, doc, persist=False)
            else:
                track.resize_right_edge(orig_out + delta, doc, persist=False)
            self.Redraw()

        self._drag_loop(_KEY_MLEFT, mx, my, on_tick)
        try:
            doc.StartUndo()
            _get_or_create_helper(doc)
            track._persist_current(doc)
            doc.EndUndo()
        except Exception as e:
            print("[Shotblocks] audio resize persist failed: {}".format(e))
        self._refresh_audio_loaded_sig(doc)
        c4d.EventAdd()

    def _refresh_audio_loaded_sig(self, doc):
        """Update the persistence-signature cache after an in-place
        mutation (drag move/resize). Without this, the next draw's
        sync would see the persisted-vs-loaded mismatch and trigger
        an expensive re-decode of the same file.
        Mirrors how `_sync_audio_for_active_doc` builds its signature
        from the persisted dict — read it back rather than assemble
        from in-memory state, so we're guaranteed to match."""
        try:
            from sb_persistence import _read_audio
            persisted = _read_audio(doc)
        except Exception:
            persisted = None
        if persisted is None:
            self._audio_loaded_sig = None
            return
        self._audio_loaded_sig = (
            bool(persisted.get("path_is_relative", False)),
            persisted.get("path", ""),
            int(persisted.get("in_frame",  0)),
            int(persisted.get("out_frame", 0)),
            int(persisted.get("trim_start_audio_frames", 0)),
        )

    # ------------------------------------------------------------------
    # Click / drag — left button
    # ------------------------------------------------------------------

    def _on_left_press(self, x, y, qualifier):
        # Rail click — handled before any timeline gesture. The rail
        # owns x in [0, LEFT_RAIL_WIDTH); modifiers don't change rail
        # behavior (no Alt+drag-pan inside the rail).
        if x < LEFT_RAIL_WIDTH:
            self._handle_rail_click(x, y)
            return True

        # Alt+LMB drag = pan, overrides hit-test (unifies with Alt+RMB zoom
        # and Alt+wheel zoom — Alt is the canvas navigation modifier).
        if qualifier & _QALT:
            print("[Shotblocks] Alt+LMB at ({},{}) → pan drag".format(x, y))
            self._drag_pan(x, y)
            return True

        w = self.GetWidth()

        # Playhead handle wins over range-bar (the triangle visually sits on
        # top of the range bar, so it must hit-test first).
        if self._hit_test_playhead_head(x, y, w):
            print("[Shotblocks] LMB on playhead head at ({},{})".format(x, y))
            self._drag_playhead(x, y, snap_on_click=False)
            return True

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

        # Audio block (v7) — hit-test before shots since the audio block
        # lives in its own Y band below track 0; hit_test_audio returns
        # None unless y is inside that band, so this never misroutes a
        # shot click.
        audio_hit = self._hit_test_audio(x, y, w)
        if audio_hit is not None:
            _kind, region = audio_hit
            self._audio_selected = True
            # Clear shot selection so only the audio block reads selected.
            self._selected_ids.clear()
            self.Redraw()
            if region == "left":
                self._drag_audio_resize("left", x, y)
            elif region == "right":
                self._drag_audio_resize("right", x, y)
            else:
                self._drag_audio_move(x, y)
            return True

        # Click anywhere else clears audio selection.
        if self._audio_selected:
            self._audio_selected = False
            self.Redraw()

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
        # If clicked shot is already in a multi-selection, leave selection
        # intact and let _drag_move move the whole selection as a group.

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
        """Body-drag move. If the clicked shot is part of a multi-selection,
        the entire selection moves rigidly; otherwise just shot_id moves."""
        w = self.GetWidth()
        doc = c4d.documents.GetActiveDocument()
        shots, _ = _read_shots(doc)
        target = next((s for s in shots if s["id"] == shot_id), None)
        if target is None:
            return

        is_group = (shot_id in self._selected_ids and len(self._selected_ids) > 1)
        target_ids = set(self._selected_ids) if is_group else {shot_id}

        orig_in    = target["in_frame"]
        orig_out   = target["out_frame"]
        orig_track = _shot_track(target)
        duration   = orig_out - orig_in
        fpp = self._frames_per_pixel(w)

        # Group bounds — used to clamp the rigid shift so no member goes
        # below frame 0 or off the track range.
        if is_group:
            sel_orig = [s for s in shots if s["id"] in target_ids]
            grp_min_in  = min(s["in_frame"] for s in sel_orig)
            grp_min_trk = min(_shot_track(s) for s in sel_orig)
            grp_max_trk = max(_shot_track(s) for s in sel_orig)
        else:
            grp_min_in  = orig_in
            grp_min_trk = orig_track
            grp_max_trk = orig_track

        def compute_delta(adx, ady):
            df = int(round(adx * fpp))
            lane_count = _displayed_lane_count(shots)
            preview_y = self._track_y_top(orig_track) + ady
            raw_track = self._y_to_track(preview_y, lane_count)
            dt = raw_track - orig_track
            # Clamp to keep every group member in valid range
            if grp_min_in  + df < 0: df = -grp_min_in
            if grp_min_trk + dt < 0: dt = -grp_min_trk
            if grp_max_trk + dt > MAX_TRACKS - 1:
                dt = MAX_TRACKS - 1 - grp_max_trk
            return df, dt

        def shift_preview(df, dt):
            """Raw shift of the selection, no collision resolution. Used
            for replace-mode preview to match single-shot behavior."""
            out = [dict(s) for s in shots]
            for s in out:
                if s["id"] in target_ids:
                    s["in_frame"]  += df
                    s["out_frame"] += df
                    s["track"]     += dt
            return out

        def on_tick(adx, ady, qual):
            df, dt = compute_delta(adx, ady)
            mode = _qualifier_mode(qual, self._snap_enabled)
            snap_frames = self._snap_frames() if mode == "snap" else 0
            extra = (self.playhead_frame,)
            snap_targets = ()
            if is_group:
                if mode in ("snap", "ripple"):
                    shots_preview, snap_targets = _resolve_group_move(
                        shots, target_ids, shot_id, df, dt, mode, snap_frames,
                        extra_points=extra)
                else:
                    shots_preview = shift_preview(df, dt)
            elif mode in ("snap", "ripple"):
                new_in = orig_in + df
                new_track = orig_track + dt
                shots_preview, snap_targets = _resolve_position(
                    shots, shot_id, new_in, new_track, mode, snap_frames,
                    extra_points=extra)
            else:
                shots_preview = shift_preview(df, dt)
            self._snap_indicator_frames = snap_targets
            self._render_preview_shots(shots_preview)

        result = self._drag_loop(_KEY_MLEFT, mx, my, on_tick)
        self._render_preview_shots(None)
        if result is None:
            return
        accum_dx, accum_dy, qualifier = result

        df, dt = compute_delta(accum_dx, accum_dy)
        if df == 0 and dt == 0:
            return

        mode = _qualifier_mode(qualifier, self._snap_enabled)
        snap_frames = self._snap_frames() if mode == "snap" else 0
        extra = (self.playhead_frame,)
        doc.StartUndo()
        if is_group:
            new_shots, _ = _resolve_group_move(shots, target_ids, shot_id,
                                               df, dt, mode, snap_frames,
                                               extra_points=extra)
        else:
            new_shots, _ = _resolve_position(shots, shot_id, orig_in + df,
                                             orig_track + dt, mode, snap_frames,
                                             extra_points=extra)
        _write_shots(doc, new_shots, _read_shots(doc)[1], with_undo=True)
        doc.EndUndo()
        # Clear the snap indicator now that the drag is committed.
        self._snap_indicator_frames = ()
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
            snap_targets = ()
            if mode in ("snap", "ripple"):
                snap_frames = self._snap_frames() if mode == "snap" else 0
                shots_preview, snap_targets = _resolve_resize(
                    shots, shot_id, edge, want, mode, snap_frames,
                    extra_points=(self.playhead_frame,))
            else:
                shots_preview = [dict(s) for s in shots]
                t = next(s for s in shots_preview if s["id"] == shot_id)
                if edge == "left":
                    t["in_frame"] = want
                else:
                    t["out_frame"] = want
            self._snap_indicator_frames = snap_targets
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
        new_shots, _ = _resolve_resize(
            shots, shot_id, edge, want, mode, snap_frames,
            extra_points=(self.playhead_frame,))
        _write_shots(doc, new_shots, _read_shots(doc)[1], with_undo=True)
        doc.EndUndo()
        self._snap_indicator_frames = ()
        c4d.EventAdd()

    # ------------------------------------------------------------------
    # Selection operations (delete, duplicate)
    # ------------------------------------------------------------------

    def _delete_selected(self):
        if self._audio_selected:
            self._delete_selected_audio()
            return
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
        # Clean up per-shot caches and persisted BaseLinks for the removed shots.
        for sid in target_ids:
            self._cam_refs.pop(sid, None)
            _clear_shot_cam_link(doc, sid)
        self._selected_ids = set()
        c4d.EventAdd()
        self.Redraw()
        print("[Shotblocks] deleted {} shot(s)".format(len(target_ids)))

    def _delete_selected_audio(self):
        """Delete the selected audio track. Mirrors _delete_selected's
        undo bracketing so Cmd+Z restores the import."""
        doc = c4d.documents.GetActiveDocument()
        if self._audio_track.decoded is None:
            self._audio_selected = False
            return
        try:
            doc.StartUndo()
            self._audio_track.clear(doc)
            doc.EndUndo()
        except Exception as e:
            print("[Shotblocks] audio delete failed: {}".format(e))
            try:
                doc.EndUndo()
            except Exception:
                pass
            return
        # Stop any in-progress playback and drop the buffer reference.
        self._audio_playback.set_audio(None)
        self._refresh_audio_loaded_sig(doc)
        self._audio_selected = False
        c4d.EventAdd()
        self.Redraw()
        print("[Shotblocks] audio track deleted")

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
                shots, _ = _resolve_position(shots, dup_id, copy["in_frame"],
                                             copy["track"], mode, snap_frames,
                                             extra_points=(self.playhead_frame,))
            else:
                new_in = src["out_frame"] + 1
                copy = _make_shot(dup_id, new_in, new_in + duration,
                                  src["cam_name"], src_track)
                shots.append(copy)
                shots, _ = _resolve_position(shots, dup_id, copy["in_frame"],
                                             copy["track"], mode, snap_frames,
                                             extra_points=(self.playhead_frame,))
            new_ids.add(dup_id)
            # Carry the source shot's camera link forward so the duplicate's
            # name stays in sync with the source camera through future renames.
            src_cam = self._cam_refs.get(src["id"]) or _get_shot_cam(doc, src["id"])
            if src_cam is not None:
                self._remember_cam(dup_id, src_cam)
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
        hit = set()
        for s in shots:
            track = _shot_track(s)
            sy_top = self._track_y_top(track)
            sy_bot = sy_top + SHOT_HEIGHT - 1
            sx1, sx2 = self._shot_x_bounds(s["in_frame"], s["out_frame"], w)
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
        """Drag the in or out handle. The opposite edge stays fixed.
        Both edges clamp to the doc's [Min, Max] frame bounds — the play
        range can't extend past project length in either direction."""
        w = self.GetWidth()
        fpp = self._frames_per_pixel(w)
        doc = c4d.documents.GetActiveDocument()
        doc_first, doc_last = self._doc_bounds()
        orig_in, orig_out = _read_range(doc)

        def on_tick(adx, _ady, _qual):
            delta = int(round(adx * fpp))
            if edge == "in":
                new_in = max(doc_first, min(orig_in + delta, orig_out - 1))
                self._preview_range = (new_in, orig_out)
            else:
                new_out = min(doc_last, max(orig_in + 1, orig_out + delta))
                self._preview_range = (orig_in, new_out)
            self.Redraw()

        self._drag_loop(_KEY_MLEFT, mx, my, on_tick)
        self._commit_range_drag(doc, orig_in, orig_out)

    def _drag_range_body(self, mx, my):
        """Drag the active span between handles to slide both together.
        The whole span clamps inside the doc's [Min, Max] frame bounds."""
        w = self.GetWidth()
        fpp = self._frames_per_pixel(w)
        doc = c4d.documents.GetActiveDocument()
        doc_first, doc_last = self._doc_bounds()
        orig_in, orig_out = _read_range(doc)
        length = orig_out - orig_in

        def on_tick(adx, _ady, _qual):
            delta = int(round(adx * fpp))
            new_in = max(doc_first, min(orig_in + delta, doc_last - length))
            self._preview_range = (new_in, new_in + length)
            self.Redraw()

        self._drag_loop(_KEY_MLEFT, mx, my, on_tick)
        self._commit_range_drag(doc, orig_in, orig_out)

    def _drag_playhead(self, mx, my, snap_on_click=True):
        """Click + drag scrubs the playhead. View state — no doc write, no
        undo. snap_on_click=True (ruler band) snaps the playhead to the click
        x; snap_on_click=False (triangle handle) preserves the playhead's
        current frame and only follows the drag delta — clicking off-center
        on the handle won't yank the playhead to the click point.

        When snap is enabled (toolbar toggle), the playhead is magnetically
        pulled to nearby edit points (shot ins/outs and audio in/out) within
        the same SNAP_PIXEL_RADIUS the body-drag uses. Holding Shift during
        the drag suppresses snap (matches the body-drag inversion).

        Each scrub step also pushes doc time and routes the active shot's
        camera to the active BaseDraw, so the viewport switches cameras
        live during scrubbing — not just during spacebar playback."""
        w = self.GetWidth()
        fpp = self._frames_per_pixel(w)
        doc = c4d.documents.GetActiveDocument()
        fps = self._doc_fps(doc) if doc is not None else 24
        doc_first, doc_last = self._doc_bounds()

        shots, _ = _read_shots(doc) if doc is not None else ([], 0)
        audio_extras = ()
        if self._audio_track.decoded is not None:
            audio_extras = (int(self._audio_track.in_frame),
                            int(self._audio_track.out_frame) + 1)

        def snap_frame(f, qual):
            mode = _qualifier_mode(qual, self._snap_enabled)
            if mode != "snap":
                self._snap_indicator_frames = ()
                return f
            snapped, targets = _magnetic_snap_edge(
                shots, target_id=None, edge_frame=f,
                snap_frames=self._snap_frames(),
                extra_points=audio_extras)
            self._snap_indicator_frames = targets
            return snapped

        def push_to_doc(frame):
            if doc is None:
                return
            try:
                doc.SetTime(c4d.BaseTime(frame, fps))
            except Exception:
                pass
            # Notify the time-change BEFORE redrawing so the camera switch
            # we just made on the BaseDraw, plus the new doc time, are
            # picked up by the editor view's render pass.
            try:
                c4d.GeSyncMessage(c4d.EVMSG_TIMECHANGED)
            except Exception:
                pass
            self._route_camera_for_frame(doc, frame)
            # Force a synchronous editor-view redraw inside the drag loop.
            # DRAWFLAGS_NO_THREAD makes the call block until the redraw is
            # actually painted; INDRAG hints that we're mid-drag (lets C4D
            # skip expensive passes); FORCEFULLREDRAW makes it ignore the
            # cached view state. ONLY_ACTIVE_VIEW skips inactive panels.
            flags = (c4d.DRAWFLAGS_NO_THREAD
                     | c4d.DRAWFLAGS_INDRAG
                     | c4d.DRAWFLAGS_FORCEFULLREDRAW
                     | c4d.DRAWFLAGS_ONLY_ACTIVE_VIEW)
            try:
                c4d.DrawViews(flags)
            except Exception as e:
                if not ShotblocksTimelineCanvas._scrub_logged:
                    ShotblocksTimelineCanvas._scrub_logged = True
                    print("[Shotblocks] scrub DrawViews err: {}".format(e))
                c4d.EventAdd()

        if snap_on_click:
            raw = self._x_to_frame(mx, w)
            snapped = snap_frame(raw, 0)
            self.playhead_frame = max(doc_first, min(doc_last, snapped))
            push_to_doc(self.playhead_frame)
            self.Redraw()
        orig_frame = self.playhead_frame

        def on_tick(adx, _ady, qual):
            raw = orig_frame + int(round(adx * fpp))
            snapped = snap_frame(raw, qual)
            new_frame = max(doc_first, min(doc_last, snapped))
            if new_frame != self.playhead_frame:
                self.playhead_frame = new_frame
                push_to_doc(new_frame)
                self.Redraw()

        self._drag_loop(_KEY_MLEFT, mx, my, on_tick)
        if self._snap_indicator_frames:
            self._snap_indicator_frames = ()
            self.Redraw()

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

    def _doc_bounds(self):
        """Return (doc_first, doc_last) in frames — the project's [Min, Max]
        time. Falls back to (0, visible_last) if no doc is available."""
        doc = c4d.documents.GetActiveDocument()
        if doc is None:
            return 0, max(1, self.visible_last)
        fps = self._doc_fps(doc)
        try:
            first = int(doc.GetMinTime().GetFrame(fps))
            last  = int(doc.GetMaxTime().GetFrame(fps))
        except Exception:
            return 0, max(1, self.visible_last)
        if last <= first:
            return 0, max(1, self.visible_last)
        return first, last

    def _clamp_visible(self, new_first, new_last):
        """Clamp [new_first, new_last] to the doc's [Min, Max] range.
        Visible window can't extend past project bounds in either direction;
        if the requested span is wider than the doc, we fit-to-doc."""
        doc_first, doc_last = self._doc_bounds()
        span = max(8, new_last - new_first)
        doc_span = doc_last - doc_first
        if span >= doc_span:
            return doc_first, doc_last
        if new_first < doc_first:
            new_first = doc_first
            new_last  = new_first + span
        if new_last > doc_last:
            new_last  = doc_last
            new_first = new_last - span
        return int(new_first), int(new_last)

    def _drag_pan(self, mx, my):
        """Alt+LMB drag-pan. Held LMB so MouseDrag actually delivers motion
        (MMB is intercepted by C4D's framework regardless of qualifier)."""
        orig_first = self.visible_first
        orig_last  = self.visible_last
        w = self.GetWidth()
        fpp = self._frames_per_pixel(w)

        def on_tick(adx, _ady, _qual):
            shift_frames = int(round(-adx * fpp))
            self.visible_first, self.visible_last = self._clamp_visible(
                orig_first + shift_frames, orig_last + shift_frames)
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
            self.visible_first, self.visible_last = self._clamp_visible(
                new_first, new_first + new_span)
            self.Redraw()

        self._drag_loop(_KEY_MRIGHT, mx, my, on_tick)

    def _pan_by_wheel(self, delta):
        """Plain scroll wheel = horizontal pan. One wheel notch = ~10% of the
        current visible span."""
        span = max(1, self.visible_last - self.visible_first)
        notches = delta / 120.0
        shift = int(round(-notches * span * 0.1))
        new_first = self.visible_first + shift
        self.visible_first, self.visible_last = self._clamp_visible(
            new_first, new_first + span)
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
        self.visible_first, self.visible_last = self._clamp_visible(
            new_first, new_first + span_new)
        self.Redraw()

    # ------------------------------------------------------------------
    # Render preview during drag without committing to the document
    # ------------------------------------------------------------------

    def _render_preview_shots(self, shots_or_none):
        """Cache an override list for the next paint. Pass None to clear."""
        self._preview_shots = shots_or_none
        self.Redraw()
