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
    MAX_TRACKS, MIN_SHOT_FRAMES, CLIP_GAP_FRAMES,
    _make_shot, _shot_track, _displayed_lane_count,
    _resolve_position, _resolve_resize, _resolve_group_move,
    _magnetic_snap_edge,
    _active_shot_at,
)
from sb_persistence import (
    _read_shots, _write_shots,
    _read_range, _write_range,
    _read_tracks, _write_tracks,
    _get_or_create_helper,
    _set_shot_cam_link, _get_shot_cam, _clear_shot_cam_link,
)
from sb_audio_track  import AudioTrack, AudioTrackError
from sb_audio_onsets import grid_is_displayable
from sb_canvas_audio import (
    AudioCanvasMixin, drag_audio_path,
    AUDIO_HEIGHT, RIGHT_METER_PANEL_W,
)
from sb_canvas_drawing  import DrawingCanvasMixin
from sb_canvas_drag     import DragCanvasMixin
from sb_canvas_playback import PlaybackCanvasMixin


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
# Per-track row controls — Railcut-style layout (chip+lock+name+eye/M/S).
COL_RAIL_CHIP_OFF    = _rgb("3a3a3a")  # untargeted target chip background
COL_RAIL_CHIP_ON     = _rgb("2C7CD3")  # targeted = Maxon blue (matches COL_ACCENT)
COL_RAIL_CHIP_LABEL  = _rgb("dddddd")
COL_RAIL_CHIP_LABEL_ON = _rgb("FFFFFF")
COL_RAIL_ICON_OFF    = _rgb("707070")  # lock/eye/M/S in resting state
COL_RAIL_ICON_ON     = _rgb("dddddd")  # lock engaged / eye on / M or S engaged
COL_RAIL_ICON_HOVER  = _rgb("aaaaaa")
COL_RAIL_SOLO_ON     = _rgb("eac84a")  # warm yellow when solo'd (Premiere convention)
COL_RAIL_MUTE_ON     = _rgb("d96b6b")  # warm red when muted
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

# Audio-only color tokens live in `sb_canvas_audio.py`.

# Play-range bar
COL_RANGE_BAR           = _rgb("3a3a3a")
COL_RANGE_ACTIVE        = _rgb("4A4A4A")    # surface-4 — neutral lift between
                                             # handles; the accent-blue handles
                                             # mark the boundaries.
COL_RANGE_HANDLE        = COL_ACCENT
# Vertical line marking each range handle's column, extending from
# the range bar's bottom edge down to the canvas bottom. Same blue
# as the handles themselves — reads as "the range continues all
# the way down through the timeline."
COL_RANGE_LINE          = COL_ACCENT
# Dim overlay drawn over the timeline area OUTSIDE the play range
# (diagonal hatch pattern — see `_draw_diagonal_hatch`). Picked as
# the canvas timeline bg (#1c1c1c) darkened by ~10 % so the hatched
# pixels read as "same color as the bg but slightly darker" rather
# than as pure black streaks. Combined with the stride gaps between
# lines, the visual reads as a subtle translucent darkening.
#
# We tried 1×1 checker / 2×2 checker / vertical stripe dithers for a
# smoother dim — visually nicer, but per-pixel DrawRectangle / DrawLine
# in the per-frame repaint stuttered playback. The BMP_TRANSPARENTALPHA
# bitmap path didn't help (binary alpha flattens to fully opaque in
# C4D 2026). The diagonal hatch costs ~N/stride lines and stays fast.
COL_RANGE_OUTSIDE_DIM   = _rgb("191919")
COL_RANGE_HANDLE_HOVER  = COL_ACCENT_HOVER


# ---------------------------------------------------------------------------
# Layout constants
# ---------------------------------------------------------------------------

RANGE_HEIGHT        = 16          # play-range bar at the very top
RANGE_HANDLE_PX     = 10          # in/out handle hit-zone radius from
                                  # the handle's anchor frame column
RULER_HEIGHT        = 24
RULER_Y_TOP         = RANGE_HEIGHT
SHOT_Y_TOP          = RANGE_HEIGHT + RULER_HEIGHT + 4
SHOT_HEIGHT         = 48
# `AUDIO_HEIGHT` is owned by `sb_canvas_audio` and re-imported above.
LANE_GAP            = 2
# Horizontal interior padding. The visible frame range maps to
# [LEFT_RAIL_WIDTH + TIMELINE_PAD_X, w - TIMELINE_PAD_X] so the playhead,
# range handles, and tick marks at the doc's first/last frame stay
# visibly inside the timeline column (right of the rail) instead of
# touching the very edge.
TIMELINE_PAD_X      = 8

# Left rail. A fixed-width column on the left side of the canvas hosts
# the global tools (Snap, Loop, Pen) at the top and per-track row
# controls (lock, target chip, name, eye-or-M+S) inline with each
# track row. NLE convention — Premiere/Resolve/Railcut put per-track
# headers on the left.
LEFT_RAIL_WIDTH     = 120
RAIL_BTN_SIZE       = 24
RAIL_BTN_GAP        = 4
RAIL_BTN_TOP        = 6   # vertical inset of the first button row

# Per-track row layout. Reading left → right inside the rail: lock
# icon, target chip (carries the track label inside it), free space,
# then eye-or-M+S on the right. Same layout for the audio row,
# substituting M+S for the eye.
RAIL_LOCK_SIZE      = 14
RAIL_CHIP_W         = 30
RAIL_CHIP_H         = 20
RAIL_EYE_SIZE       = 14
RAIL_MS_W           = 14
RAIL_MS_H           = 14
RAIL_MS_GAP         = 2
RAIL_ROW_PAD_X      = 4   # left/right padding inside the row

# Right-side audio meter sizing + meter colors + audio-block insets all
# live in `sb_canvas_audio.py`. `RIGHT_METER_PANEL_W` is re-imported
# above for `_timeline_x1`'s right-edge math.

DEFAULT_SHOT_FRAMES = 48          # 2 s at 24 fps — good starting length
EDGE_BAND_PX        = 24          # visible darker grip-band at each shot edge
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
PLAYHEAD_HEAD_W     = 12          # blue triangle head — procedural fallback only
PLAYHEAD_HEAD_H     = 10          # blue triangle head — procedural fallback only
# Target output sizes (height) for the bitmap-driven icons. Width
# scales from the source bitmap's aspect ratio so authoring at any
# reasonable size produces correctly-proportioned output. C4D's
# DrawBitmap with BMP_NORMALSCALED handles the scale.
PLAYHEAD_BITMAP_H   = 14          # fits inside the 16 px RANGE_HEIGHT bar
# `PEAK_MARKER_BITMAP_H` lives in `sb_canvas_audio.py` (audio-only).

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
MENU_CLEAR_RANGE    = 3006
# Level-keyframe interpolation menu (Pen-mode right-click on a node).
MENU_LVL_DELETE       = 3010
MENU_LVL_INTERP_LIN   = 3011
MENU_LVL_INTERP_HOLD  = 3012
MENU_LVL_INTERP_IN    = 3013
MENU_LVL_INTERP_OUT   = 3014
MENU_LVL_INTERP_INOUT = 3015


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
# Arrow keys — Up/Down for edit-point navigation (jump playhead to
# nearest cut). Verified in C4D 2026: KEY_UP=61824, KEY_DOWN=61825.
_KEY_UP        = getattr(c4d, "KEY_UP",        61824)
_KEY_DOWN      = getattr(c4d, "KEY_DOWN",      61825)
_KEY_LEFT      = getattr(c4d, "KEY_LEFT",      61826)
_KEY_RIGHT     = getattr(c4d, "KEY_RIGHT",     61827)

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

class ShotblocksTimelineCanvas(AudioCanvasMixin, DrawingCanvasMixin, DragCanvasMixin, PlaybackCanvasMixin, c4d.gui.GeUserArea):
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
        # Stashed (visible_first, visible_last) from before the last
        # `\` zoom-to-fit toggle, so a second press restores the
        # user's prior zoom. None when nothing's stashed.
        self._zoom_fit_stash = None

        # `_last_active_shot_id` (active-shot transition tracker used
        # by `_route_camera_for_frame` to reset the rig spring on hard
        # cuts) lives on `PlaybackCanvasMixin._playback_init_state`.

        # Drag-receive (Object Manager → canvas) state
        self._drag_over   = False
        self._drag_frame  = -1
        self._drag_track  = 0

        # Selection — a set of shot ids. Empty = nothing selected.
        self._selected_ids = set()

        # Drag-cluster state — `_marquee_rect`, `_preview_shots`,
        # `_preview_range`, `_snap_indicator_frames` are owned by
        # `DragCanvasMixin._drag_init_state` (called at the bottom of
        # this __init__). The drawing cluster READS them on every
        # paint; the drag cluster WRITES them while a gesture is in
        # flight.

        # Snap-to-edge toggle (UI checkbox in toolbar). When on, no-modifier
        # drops/moves use snap-to-edge instead of replace.
        self._snap_enabled = False

        # Slip-tool toggle (rail button). When on, a body-drag on the
        # audio block slides the source window underneath instead of
        # moving the block on the timeline — the clip is a window over
        # the full audio file, and slip changes which portion of the
        # source plays through that window. Edge resize stays edge
        # resize regardless of slip mode. Session-only, like Snap.
        self._slip_enabled = False

        # Pen-tool toggle (rail button). When on, clicks on the audio
        # block body add/move level keyframes instead of selecting or
        # moving the clip. Edge resize stays edge resize regardless.
        # Migrates to the left tool palette in Round 3 alongside Razor,
        # Slide, and Slip — those four become palette tools together,
        # so for v13 the rail button is the temporary home.
        self._pen_enabled = False

        # Razor-tool toggle (rail button). When on, clicks on a shot
        # or audio block split it at the click frame (or at the
        # nearest snap target within snap radius when snap is on).
        # Edge clicks still resize; only body clicks split.
        self._razor_enabled = False

        # Selection-Follows-Playhead is always on — stopping playback
        # auto-selects the shot the playhead lands on (across all
        # tracks, top track wins on overlap, same as the active-shot
        # resolver). Triggers on stop only, not on scrub or jump, so
        # the selection doesn't flicker during dragging. No toggle —
        # the constitution favours minimal hidden modes, and the
        # spacebar-stop-then-edit pattern is the dominant workflow.

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

        # Playback cluster — see `PlaybackCanvasMixin._playback_init_state`.
        # Owns `_playing`, `_playback_owner_dialog`, `_last_play_toggle_t`,
        # `_loop_enabled`, and `_last_active_shot_id`. Initialized at the
        # bottom of this __init__ along with the other mixin clusters.

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

        # `_snap_indicator_frames` (in-flight snap-target columns) is
        # owned by `DragCanvasMixin._drag_init_state`. DrawMsg reads
        # it to paint the vertical yellow snap lines.

        # Double-click detection for the range bar. Tracks the
        # wall-clock time of the last LMB press inside the range
        # bar; a second press within DOUBLE_CLICK_WINDOW_S clears
        # the range instead of starting a drag.
        self._last_range_lmb_t = 0.0

        # Name of the rail button under the cursor (or None) — set by
        # _on_cursor_info, drives the hover tint in _draw_rail. Lives on
        # the canvas (not the drawing mixin) because the cursor/click
        # handlers in the input cluster write to it.
        self._rail_hover = None
        # Name of the rail button held down with LMB (or None) — drives
        # the press tint while the user holds before release. Shared
        # between drawing and input clusters; canvas-owned.
        self._rail_pressed = None

        # Per-track state — keyed by (kind, idx) where kind is
        # "video" or "audio" and idx is the track index (audio: 0
        # for the single track until multi-clip audio ships). Defaults
        # for an unseen key are computed by `_track_attrs` (targeted
        # True, locked False, visible True, muted False, solo False).
        # Hydrated from persistence on document load; written back
        # when toggles change.
        self._track_state = {}

        # Pen-mode level keyframe hover/drag state. `_hover_idx` is
        # the index of the keyframe under the cursor (or -1); the
        # canvas drawer paints hovered/pressed nodes larger. Held
        # during a drag so the moved node stays visually emphasized.
        # Level-keyframe hover/press state — (track_idx, kf_idx) where
        # -1 means "no hit". Tracked per-clip so razor-split clips and
        # lane-2+ clips both register hover, not just tracks[0].
        self._level_kf_hover_idx   = (-1, -1)
        self._level_kf_pressed_idx = (-1, -1)
        # Track-row hover/press state for the per-track controls
        # (lock chip, target chip, eye, M, S). Stored as
        # ("kind", idx, "control") tuples so the drawer can pick a
        # hover/press tint without re-scanning hit-tests.
        self._track_ctrl_hover   = None
        self._track_ctrl_pressed = None

        # Audio cluster — see `AudioCanvasMixin._audio_init_state`.
        # Owns the AudioTrack, AudioPlayback, dB-meter buffers, busy
        # overlay state, peak-rebuild and analysis worker plumbing,
        # and the chrome-bitmap cache for peak markers.
        self._audio_init_state()

        # Drawing cluster — see `DrawingCanvasMixin._drawing_init_state`.
        # Owns the lazy bitmap caches (`_block_bitmaps_cache`,
        # `_glyph_bitmaps_cache`, `_rail_buttons_cache`) that back the
        # shot-block render and the rail buttons.
        self._drawing_init_state()

        # Drag cluster — see `DragCanvasMixin._drag_init_state`. Owns
        # the in-flight gesture state (`_marquee_rect`, `_preview_shots`,
        # `_preview_range`, `_snap_indicator_frames`) read by the
        # drawing cluster on every paint.
        self._drag_init_state()

        # Playback cluster — see `PlaybackCanvasMixin._playback_init_state`.
        # Owns the spacebar-driven playback state (`_playing`,
        # `_playback_owner_dialog`, `_last_play_toggle_t`, `_loop_enabled`,
        # `_last_active_shot_id`).
        self._playback_init_state()


    # Lazy bitmap caches (`_block_bitmaps`, `_glyph_bitmaps`,
    # `_rail_buttons`) live on `DrawingCanvasMixin` in `sb_canvas_drawing.py`.
    # `_chrome_bitmaps` (peak-marker bitmaps) lives on `AudioCanvasMixin`.

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
        padding). Shrinks by `RIGHT_METER_PANEL_W` when an audio track
        is loaded so the dB meter on the far right doesn't overlap
        the timeline content."""
        right_pad = TIMELINE_PAD_X
        if self._audio_track.decoded is not None:
            right_pad += RIGHT_METER_PANEL_W
        return w - right_pad

    # `_meter_panel_x_bounds` lives on `AudioCanvasMixin`.

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

    def _range_is_active(self, range_in, range_out, doc_first, doc_last):
        """Whether the current play range is meaningfully smaller than
        the doc — used to decide whether to draw the dim overlay +
        range lines. A range that spans the full doc is the 'cleared'
        state and should render as a clean timeline."""
        # 2-frame tolerance so a range that snaps to the doc bounds
        # but is off by rounding still reads as "full doc".
        return (range_in > doc_first + 1) or (range_out < doc_last - 1)

    def _snap_extras(self):
        """Build the tuple of extra snap-target frames passed to the
        shot model's `_resolve_*` functions. Includes:
          - playhead frame (the long-standing reference point)
          - audio block's in_frame and (out_frame + 1) when audio
            is loaded
          - prominent-peak frames from v9 onset analysis, converted
            from source-rate audio-frames to doc-frames using the
            track's current trim/in_frame

        All values are ints — the snap matcher compares to shot edge
        frames, which are integers, and the extras must match.
        """
        extras = [self.playhead_frame]
        track = self._audio_track
        if track.decoded is None:
            return tuple(extras)
        extras.append(int(track.in_frame))
        extras.append(int(track.out_frame) + 1)
        # Peaks + beat-grid lines contribute to snap targets only
        # when analysis is toggled visible — invisible markers
        # shouldn't grab clips.
        if track.analysis_visible:
            doc = c4d.documents.GetActiveDocument()
            fps = self._doc_fps(doc)
            in_f  = track.in_frame
            out_f = track.out_frame

            # Prominent peaks. Source-rate audio-frames → doc-frames
            # via the track's current trim/in_frame so the snap
            # targets follow the clip when it's moved or trimmed.
            # Widen the range check by 1 frame on each side so a peak
            # right at the clip boundary isn't lost to int rounding.
            if track.prominent_peaks:
                for af in track.prominent_peaks:
                    df = track.audio_frame_to_doc_frame(af, fps)
                    df_int = int(round(df))
                    if in_f - 1 <= df_int <= out_f + 1:
                        extras.append(df_int)

            # Beat-grid lines. Generated from (period, phase) so we
            # don't store every beat individually. Same int-rounding
            # tolerance as peaks. The visual grid spans the whole
            # canvas (incl. before/after the clip), but for snapping
            # we restrict to the clip's range — snapping to a beat
            # that doesn't have audio under it would be misleading.
            grid = track.beat_grid
            if grid_is_displayable(grid):
                period_af, phase_af, _conf = grid
                if period_af > 0:
                    # Two anchor points → derive doc-frame period.
                    df0 = track.audio_frame_to_doc_frame(phase_af, fps)
                    df1 = track.audio_frame_to_doc_frame(phase_af + period_af, fps)
                    period_df = df1 - df0
                    if period_df > 0:
                        # k_lo = first k such that (df0 + k*period_df) >= in_f.
                        k_lo = int(math.ceil((in_f - df0) / period_df))
                        k_hi = int(math.floor((out_f - df0) / period_df))
                        for k in range(k_lo, k_hi + 1):
                            extras.append(int(round(df0 + k * period_df)))
        return tuple(extras)

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

    # `_audio_y_bounds` lives on `AudioCanvasMixin`; it returns the
    # (top, bottom) Y of the audio block, used by both the draw path
    # and the canvas-side hover-band/hit-test code.

    # ------------------------------------------------------------------
    # Per-track state — targeted / locked / visible / muted / solo
    # ------------------------------------------------------------------

    _TRACK_DEFAULTS = {
        "targeted": True,   # included in playhead-driven edits
        "locked":   False,  # blocks all mutations
        "visible":  True,   # video-only — locked tracks still draw, hidden tracks don't
        "muted":    False,  # audio-only — track skipped at temp-WAV write time
        "solo":     False,  # audio-only — exclusive playback when any track soloed
    }

    def _track_attrs(self, kind, idx):
        """Return the merged attribute dict for a track. Missing keys
        fall back to `_TRACK_DEFAULTS` so a brand-new track behaves
        sensibly without an explicit entry. The returned dict is a
        copy — mutate it freely without affecting persisted state.
        """
        out = dict(self._TRACK_DEFAULTS)
        out.update(self._track_state.get((kind, int(idx)), {}))
        return out

    def _set_track_attr(self, kind, idx, attr, value):
        """Flip one attribute on a per-track entry. Writes through to
        the in-memory dict only; caller is responsible for invoking
        `_persist_tracks` (so multi-attr changes batch into a single
        helper-null write)."""
        key = (kind, int(idx))
        cur = dict(self._track_state.get(key, {}))
        cur[attr] = bool(value)
        # Drop keys that match the default — keeps persisted blob small.
        if cur[attr] == self._TRACK_DEFAULTS.get(attr):
            cur.pop(attr, None)
        if cur:
            self._track_state[key] = cur
        else:
            self._track_state.pop(key, None)

    def _track_is_locked(self, kind, idx):
        """Fast-path lock check — used by every mutation entry point."""
        return self._track_attrs(kind, idx)["locked"]

    def _any_video_track_locked(self, track_ids):
        """True iff any of the given video track indices is locked.
        Used by the multi-shot mutation entry points (group move,
        nudge, delete-selection) to gate the whole operation."""
        return any(self._track_is_locked("video", t) for t in track_ids)

    def _any_audio_solo(self):
        """True iff any audio track is soloed. While true, non-solo
        tracks are silenced (Premiere/FCP convention). Currently we
        ship a single audio track so this collapses to a per-track
        flag check, but the shape is forward-compatible."""
        for (kind, _idx), attrs in self._track_state.items():
            if kind == "audio" and attrs.get("solo"):
                return True
        return False

    def _audio_level_curve_fn(self):
        """Return a callable suitable for `AudioPlayback.play`'s
        `level_curve_fn` argument, or None when no automation exists
        (so playback can skip the per-frame walk entirely)."""
        track = self._audio_track
        if track is None or not track.level_keyframes:
            return None
        return track.evaluate_level

    def _audio_clip_end_af(self, doc):
        """Return the audio-frame index one past the clip's trimmed
        right edge — i.e. the cap to pass to `AudioPlayback.play` so
        Windows stops at the visual end of the block rather than
        continuing into source samples past `out_frame`.

        Returns None when there's no audio loaded; the playback
        engine treats that as 'play to end of decoded buffer'."""
        track = self._audio_track
        if track is None or track.decoded is None:
            return None
        fps = self._doc_fps(doc)
        # `out_frame` is inclusive; we want the frame just past it
        # in audio-frame space so the temp WAV stops at the trimmed
        # right edge. doc_frame_to_audio_frame returns -1 outside
        # the clip — when the right edge sits at a valid doc-frame
        # we step one past, otherwise fall back to decoded.n_frames
        # so a clip extended past end-of-audio still plays to EOF.
        end_af = track.doc_frame_to_audio_frame(track.out_frame, fps)
        if end_af < 0:
            return track.decoded.n_frames
        # +1 frame so the LAST doc-frame is included. Past that,
        # the timeline is empty and audio should stop.
        rate = track.decoded.sample_rate
        af_per_frame = rate / float(max(1, fps))
        return min(track.decoded.n_frames,
                   end_af + max(1, int(round(af_per_frame))))

    def _build_audio_mix(self, start_doc_frame, max_doc_frames=None):
        """Mix every audible audio track into one 16-bit PCM payload
        starting at `start_doc_frame`. Each track is trimmed to its
        in/out, gain-curved, then summed onto a common output buffer
        positioned by `track.in_frame - start_doc_frame`.

        Returns (payload_bytes, sample_rate, n_channels). When no
        audio is audible, returns (b'', 0, 0) so the caller can
        decide whether to skip playback entirely.

        The mix uses the first audible track's (sample_rate,
        n_channels) as the output format. Tracks with mismatched
        rates/channels are skipped with a one-time warning — the
        full converter (audioop.ratecv + tomono/tostereo) is
        deferred until we ship multi-format audio import.

        `max_doc_frames` caps the output length in doc-frames; when
        None, extends to the rightmost out_frame of any audible
        track. Used by callers that want to pre-cap to a range.
        """
        import audioop
        doc = c4d.documents.GetActiveDocument()
        fps = self._doc_fps(doc)

        audible = list(self._audible_tracks())
        if not audible:
            return b"", 0, 0

        # Use the first track's format as the output format. All
        # other tracks must match (we don't ship a converter yet).
        _, first_track = audible[0]
        sample_rate = first_track.decoded.sample_rate
        n_channels  = first_track.decoded.n_channels
        bytes_per_frame = 2 * n_channels  # 16-bit PCM

        # Determine output length in audio-frames.
        af_per_doc_frame = sample_rate / float(max(1, fps))
        rightmost_out = max(t.out_frame for _, t in audible)
        last_doc_frame = rightmost_out
        if max_doc_frames is not None:
            last_doc_frame = min(last_doc_frame,
                                 start_doc_frame + int(max_doc_frames) - 1)
        n_doc_frames = max(0, last_doc_frame - start_doc_frame + 1)
        if n_doc_frames <= 0:
            return b"", 0, 0
        n_audio_frames = max(1, int(round(n_doc_frames * af_per_doc_frame)))
        out_size = n_audio_frames * bytes_per_frame
        # 32-bit accumulator avoids int16 overflow when N tracks sum.
        accum = bytearray(n_audio_frames * 4 * n_channels)
        # We'll accumulate as little-endian signed 32-bit via int.from_bytes
        # only at the final step; build in audioop's signed-16 space using
        # `audioop.add(a, b, 2)` on an extended-buffer per track.
        # audioop.add returns int16-clamping bytes, so to avoid early clamp
        # we widen via `audioop.lin2lin(buf, 2, 4)` before adding, then
        # narrow at the end with optional saturation.
        # NB: lin2lin extends 16→32 cleanly. add(a, b, 4) then sums as
        # signed-32 and won't overflow until ~32k tracks (we're fine).
        zero_chunk = b"\x00" * out_size  # int16 zero
        accum32 = audioop.lin2lin(zero_chunk, 2, 4)  # 4-byte signed zero buf

        mismatched_logged = False
        for idx, track in audible:
            if track.decoded is None:
                continue
            if (track.decoded.sample_rate != sample_rate
                    or track.decoded.n_channels != n_channels):
                if not mismatched_logged:
                    mismatched_logged = True
                    print("[Shotblocks] mix: track {} format mismatch "
                          "(rate {}/{}, ch {}/{}) — skipped".format(
                              idx, track.decoded.sample_rate, sample_rate,
                              track.decoded.n_channels, n_channels))
                continue

            # Source slice: audio-frame range covering [clip in_frame,
            # min(clip out_frame, last_doc_frame)] mapped through
            # trim_start.
            clip_start_doc = max(track.in_frame, start_doc_frame)
            clip_end_doc   = min(track.out_frame, last_doc_frame)
            if clip_end_doc < clip_start_doc:
                continue
            # Audio-frame range within the source buffer.
            src_af0 = track.doc_frame_to_audio_frame(clip_start_doc, fps)
            src_af1 = track.doc_frame_to_audio_frame(clip_end_doc, fps)
            if src_af0 < 0 or src_af1 < 0:
                # Clip extends past end-of-audio; clamp.
                src_af0 = max(0, src_af0)
                src_af1 = min(track.decoded.n_frames - 1, max(src_af0, src_af1))
            if src_af1 <= src_af0:
                continue
            src_af1 += 1  # exclusive end
            src_af1 = min(src_af1, track.decoded.n_frames)
            b0 = src_af0 * bytes_per_frame
            b1 = src_af1 * bytes_per_frame
            chunk = bytes(track.decoded.samples[b0:b1])
            if not chunk:
                continue

            # Apply level curve if this track has keyframes.
            if track.level_keyframes:
                chunk = self._audio_playback._apply_level_curve(
                    chunk, track.decoded, src_af0, track.evaluate_level)

            # Position the chunk in the output buffer. Offset in
            # audio-frames against `start_doc_frame`.
            dst_af0 = int(round((clip_start_doc - start_doc_frame)
                                * af_per_doc_frame))
            dst_b0 = dst_af0 * bytes_per_frame
            # Truncate chunk to fit in the output buffer (in case
            # the source extends past out_frame for any reason).
            avail_bytes = out_size - dst_b0
            if avail_bytes <= 0:
                continue
            if len(chunk) > avail_bytes:
                chunk = chunk[:avail_bytes]
            # Widen chunk to 32-bit, pad to full output length, then
            # add into the accumulator.
            chunk32 = audioop.lin2lin(chunk, 2, 4)
            # Pad chunk32 with zeros on either side so it aligns with
            # the accumulator. Each int16 frame is 4 bytes in 32-bit
            # space, so multiply offsets by 2.
            pre  = b"\x00" * (dst_b0 * 2)
            post = b"\x00" * (len(accum32) - len(pre) - len(chunk32))
            if post and len(post) > 0:
                padded = pre + chunk32 + post
            else:
                padded = pre + chunk32
                if len(padded) < len(accum32):
                    padded = padded + b"\x00" * (len(accum32) - len(padded))
                elif len(padded) > len(accum32):
                    padded = padded[:len(accum32)]
            accum32 = audioop.add(accum32, padded, 4)

        # Narrow accumulator back to int16 with saturation. audioop.lin2lin
        # narrows by truncation (not saturation), which would wrap loud
        # sums. Pre-attenuate so a 2-track mix at 0 dBFS each can't
        # exceed int16 range. -6 dB headroom = factor 0.5.
        attenuated = audioop.mul(accum32, 4, 0.5)
        payload = audioop.lin2lin(attenuated, 4, 2)
        return payload, sample_rate, n_channels

    def _audio_is_audible(self, idx=0):
        """True when the audio track at `idx` should be heard.
        Muted always silences; with any solo active, only the
        soloed tracks play."""
        attrs = self._track_attrs("audio", idx)
        if attrs["muted"]:
            return False
        if self._any_audio_solo() and not attrs["solo"]:
            return False
        return True

    def _hydrate_tracks_from_doc(self, doc):
        """Replace the in-memory track state with what's persisted on
        the active doc. Idempotent — safe to call from every DrawMsg.
        Cheap: a single helper-null read; only updates the dict when
        the persisted blob changed since the last hydration."""
        if doc is None:
            return
        sig = getattr(self, "_tracks_loaded_sig", None)
        try:
            persisted = _read_tracks(doc)
        except Exception as e:
            print("[Shotblocks] _read_tracks failed: {}".format(e))
            return
        # Cheap order-independent signature.
        new_sig = tuple(sorted(
            (k, tuple(sorted(v.items()))) for k, v in persisted.items()))
        if new_sig == sig:
            return
        self._track_state = persisted
        self._tracks_loaded_sig = new_sig

    def _persist_tracks(self, doc):
        """Write the current in-memory track state to the helper null,
        wrapped in undo. Skips when the doc is None."""
        if doc is None:
            return
        try:
            doc.StartUndo()
            _write_tracks(doc, self._track_state, with_undo=True)
            doc.EndUndo()
        except Exception as e:
            print("[Shotblocks] _persist_tracks failed: {}".format(e))
            try:
                doc.EndUndo()
            except Exception:
                pass
            return
        # Refresh the signature so the next hydrate is a no-op.
        new_sig = tuple(sorted(
            (k, tuple(sorted(v.items()))) for k, v in self._track_state.items()))
        self._tracks_loaded_sig = new_sig
        c4d.EventAdd()

    def _y_to_track(self, y, lane_count):
        t0_top = self._track_0_top()
        if y >= t0_top + SHOT_HEIGHT:
            return 0
        diff = (t0_top + SHOT_HEIGHT - 1 - y) // (SHOT_HEIGHT + LANE_GAP)
        return max(0, min(lane_count - 1, int(diff)))

    # ------------------------------------------------------------------
    # Left rail — tools and per-track labels (Premiere-style layout)
    # ------------------------------------------------------------------

    # `_build_rail_buttons`, `_load_block_bitmaps`, `_bake_fade_frames`,
    # `_load_glyph_bitmaps`, `_rail_button_rect`, `_resolve_attr_path`,
    # and `_rail_button_at` all live on `DrawingCanvasMixin` in
    # `sb_canvas_drawing.py`. `_handle_rail_click` stays here — it's
    # the input-cluster click handler (sets `_rail_pressed`, runs the
    # MouseDrag loop, commits the toggle); the rail-button hit-test
    # helpers it calls resolve via MRO.

    def _handle_track_row_click(self, x, y):
        """Process a click on a per-track row control (chip/lock/eye/M/S).
        Mirrors the rail-button click pattern: press visual on press,
        commit only if release is over the same control, persist + redraw
        on commit. Returns True iff the click was consumed."""
        kind, idx, ctrl = self._track_row_at(x, y)
        if ctrl is None:
            return False
        key = (kind, idx, ctrl)
        self._track_ctrl_pressed = key
        self.Redraw()
        # Use the same drag-loop scaffolding as rail buttons so the
        # press tint follows the cursor in/out of the control rect.
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
                # Recompute inside on every tick — the row may have
                # moved if a sibling track was deleted mid-drag (rare,
                # but harmless to re-resolve).
                hit_kind, hit_idx, hit_ctrl = self._track_row_at(cur_x, cur_y)
                still_inside = (hit_kind == kind and hit_idx == idx
                                and hit_ctrl == ctrl)
                if still_inside != inside:
                    inside = still_inside
                    self._track_ctrl_pressed = key if inside else None
                    self.Redraw()
            self.MouseDragEnd()
        except Exception as e:
            print("[Shotblocks] track-row drag loop raised: {}".format(e))
        self._track_ctrl_pressed = None
        if not inside:
            self.Redraw()
            return True
        # Commit — flip the matching attribute and persist.
        attr_map = {
            "chip": "targeted",
            "lock": "locked",
            "eye":  "visible",
            "mute": "muted",
            "solo": "solo",
        }
        attr = attr_map.get(ctrl)
        if attr is None:
            self.Redraw()
            return True
        cur = self._track_attrs(kind, idx)[attr]
        self._set_track_attr(kind, idx, attr, not cur)
        doc = c4d.documents.GetActiveDocument()
        self._persist_tracks(doc)
        print("[Shotblocks] track {}/{} {} = {}".format(
            kind, idx, attr, not cur))
        # Mute/solo audibility changes need to take effect mid-playback.
        # Rebuild the mix from the current playhead so the change is
        # heard immediately. Same path as a scrub-resync.
        if kind == "audio" and attr in ("muted", "solo") and self._playing:
            any_audible = any(True for _ in self._audible_tracks())
            playing_now = self._audio_playback.is_playing()
            if any_audible:
                fps = self._doc_fps(doc)
                self._start_audio_mix_for_playhead(fps)
            elif playing_now:
                self._audio_playback.stop()
        self.Redraw()
        return True

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
            click_action = btn.get("click_action")
            if click_action:
                # Custom dispatcher (e.g. analyse: run-then-toggle).
                fn = getattr(self, click_action, None)
                if callable(fn):
                    try:
                        fn()
                    except Exception as e:
                        print("[Shotblocks] rail click {} failed: {}".format(click_action, e))
            else:
                # Default: flip the bool the state_attr points to.
                attr = btn.get("state_attr")
                if attr and "." not in attr:
                    new_val = not bool(getattr(self, attr, False))
                    setattr(self, attr, new_val)
                    print("[Shotblocks] {} = {}".format(attr.lstrip("_"), new_val))
        self.Redraw()

    # ------------------------------------------------------------------
    # Hit testing
    # ------------------------------------------------------------------

    def _hit_test_playhead_head(self, x, y, w):
        """True if (x, y) is inside the playhead handle's bbox.
        Hit zone matches the rendered square: PLAYHEAD_HEAD_W pixels
        wide, anchored to the right at the playhead column (matches
        C4D's own playhead layout where the cursor line aligns to the
        right edge of the head)."""
        if y < 0 or y >= RANGE_HEIGHT:
            return False
        px = self._frame_to_x(self.playhead_frame, w)
        return (px - PLAYHEAD_HEAD_W) <= x <= px

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
        # Handles flanking the active region — solid blue rectangles
        # in the range bar (C4D-native style). Hover lightens the
        # color of whichever handle the cursor is over.
        in_handle_color  = (COL_RANGE_HANDLE_HOVER if self._hover_range == "in"
                            else COL_RANGE_HANDLE)
        out_handle_color = (COL_RANGE_HANDLE_HOVER if self._hover_range == "out"
                            else COL_RANGE_HANDLE)
        self.DrawSetPen(in_handle_color)
        # Each handle is 8 px wide (doubled from the original 4 px).
        # The in handle's right edge anchors at rin_x; the out
        # handle's left edge anchors at rout_x — so the handles
        # frame the active range without overlapping it.
        self.DrawRectangle(max(LEFT_RAIL_WIDTH, rin_x - 7), 0, rin_x, RANGE_HEIGHT)
        self.DrawSetPen(out_handle_color)
        self.DrawRectangle(rout_x, 0, min(w, rout_x + 7), RANGE_HEIGHT)
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

        # Audio re-sync runs here (rather than just before
        # _draw_audio_block as it used to) so the beat grid below has
        # a current AudioTrack on the very first DrawMsg after a doc
        # switch — without this the grid wouldn't appear until the
        # second redraw.
        self._sync_audio_for_active_doc()
        # Per-track state (target/lock/visibility/mute/solo) lives on
        # the same helper null as shots & audio. Hydrate once per draw;
        # the function self-debounces via a signature cache so the cost
        # is one helper-null read on idle frames.
        try:
            self._hydrate_tracks_from_doc(c4d.documents.GetActiveDocument())
        except Exception as e:
            print("[Shotblocks] _hydrate_tracks_from_doc failed: {}".format(e))

        # v9 beat grid — drawn here so it sits *behind* shots and the
        # audio block but *above* the lane backgrounds. The lattice
        # serves as a project-wide rhythmic reference for aligning
        # cuts; shots and audio paint over it on each track.
        # Skipped when no audio track, the grid is low-confidence,
        # or the user has the analysis toggled off.
        if (self._audio_track.decoded is not None
                and self._audio_track.analysis_visible
                and grid_is_displayable(self._audio_track.beat_grid)):
            try:
                self._draw_beat_grid(w, h)
            except Exception as e:
                print("[Shotblocks] beat-grid draw failed: {}".format(e))

        # Orphan-count transition log. Cheap predicate per shot — just a
        # BaseLink dereference. Logging happens *only* on increase so the
        # user gets a single console message per camera deletion.
        doc_for_orphans = c4d.documents.GetActiveDocument()
        orphan_count = sum(1 for s in shots if self._is_orphan(s, doc_for_orphans))
        if orphan_count > self._last_orphan_count:
            print("[Shotblocks] camera deleted; {} shot(s) now orphaned. "
                  "Cmd+Z to restore.".format(orphan_count))
        self._last_orphan_count = orphan_count

        # Shots. During an in-flight move/resize drag, paint the
        # dragged shot(s) LAST so their edges stay visible on top of
        # neighbors as the drag approaches them. Otherwise the right
        # edge of a left-to-right resize disappears under whichever
        # shot is later in iteration order.
        drag_top_ids = self._drag_top_ids
        if drag_top_ids:
            bottom = [s for s in shots if s["id"] not in drag_top_ids]
            top    = [s for s in shots if s["id"] in drag_top_ids]
            draw_order = bottom + top
        else:
            draw_order = shots
        for shot in draw_order:
            track  = _shot_track(shot)
            # Skip shots on tracks the user has hidden via the eye
            # toggle. Locked tracks still draw — only visibility
            # gates the paint.
            if not self._track_attrs("video", track)["visible"]:
                continue
            yt     = self._track_y_top(track)
            self._draw_shot_block(shot, w, yt, shot["id"] in self._selected_ids)

        # Audio blocks — draw every loaded audio track. Each lane
        # stacks below the video tracks; the audio mixin owns the Y
        # math. Empty placeholder tracks (decoded=None) are skipped.
        for ai, atrack in enumerate(self._audio_tracks):
            if atrack.decoded is not None:
                self._draw_audio_block(w, track_idx=ai)

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

        # Play-range visualization: dim the timeline area OUTSIDE the
        # active range, and drop a blue vertical line at each handle
        # column connecting the range-bar handle all the way down to
        # the canvas bottom. Skipped when the range covers
        # (effectively) the full doc — that's the "cleared" state
        # and should look like a clean timeline.
        doc_for_range = c4d.documents.GetActiveDocument()
        if doc_for_range is not None:
            doc_first_r, doc_last_r = self._doc_bounds()
            if self._range_is_active(range_in, range_out,
                                     doc_first_r, doc_last_r):
                rin_x_clamped  = max(LEFT_RAIL_WIDTH, rin_x)
                rout_x_clamped = max(LEFT_RAIL_WIDTH, rout_x)
                # Dim spans from the bottom of the RANGE BAR (right
                # below the handles) down to canvas bottom — covers
                # the ruler, lanes, and audio block. This connects
                # visually to the handles instead of leaving a gap
                # around the ruler labels.
                dim_top = RANGE_HEIGHT
                # Translucent dim: 45° diagonal hatch pattern. C4D
                # 2026's DrawSetPen has no alpha, and tests with
                # partial-alpha BaseBitmaps (both PNG-loaded and
                # programmatically constructed with AddChannel)
                # showed DrawBitmap doesn't honor the alpha channel
                # when blending against the non-bitmap canvas
                # surface. A diagonal hatch reads as "translucent"
                # to the eye without any actual alpha — dark pixels
                # cover every Nth column on each row, leaving the
                # underlying timeline content visible through the
                # gaps. Stride 8 keeps the call count low enough
                # for the per-frame playback redraw; smoother
                # dithers (checker, vstripe) were tried and
                # stuttered playback.
                self.DrawSetPen(COL_RANGE_OUTSIDE_DIM)
                STRIDE = 8
                THICK = 1
                if rin_x_clamped > LEFT_RAIL_WIDTH:
                    lo_x1 = LEFT_RAIL_WIDTH
                    lo_x2 = rin_x_clamped - 1
                    self._draw_diagonal_hatch(
                        lo_x1, dim_top, lo_x2, h, STRIDE, THICK)
                if rout_x_clamped < w:
                    hi_x1 = rout_x_clamped + 1
                    hi_x2 = w
                    self._draw_diagonal_hatch(
                        hi_x1, dim_top, hi_x2, h, STRIDE, THICK)
                # Blue vertical lines at each handle's column. Start
                # at y=RANGE_HEIGHT so they connect cleanly to the
                # bottom edge of the handle rectangle above.
                self.DrawSetPen(COL_RANGE_LINE)
                self.DrawLine(rin_x,  RANGE_HEIGHT, rin_x,  h)
                self.DrawLine(rout_x, RANGE_HEIGHT, rout_x, h)

        # Playhead. C4D-native style: a solid red square in the range
        # bar with the cursor line aligned to its RIGHT edge (matching
        # how C4D's own timeline draws the playhead). The square's
        # left edge sits PLAYHEAD_HEAD_W pixels left of the playhead
        # frame so the right edge lands exactly on the cursor column.
        # Drawn AFTER the range dim so the playhead always sits on
        # top of the muted outside area.
        px = self._frame_to_x(self.playhead_frame, w)
        self.DrawSetPen(COL_CURSOR)
        # Bottom of the square clamped to RANGE_HEIGHT - 1 (the last
        # row of the range bar) so it doesn't paint over the boundary
        # row where the ruler begins. Otherwise the red square reads
        # as visually "extending beyond" the gray range bar.
        self.DrawRectangle(px - PLAYHEAD_HEAD_W, 0, px, RANGE_HEIGHT - 1)
        self.DrawLine(px, RANGE_HEIGHT, px, h)

        # Snap indicator — yellow vertical lines at each frame the
        # in-flight drag is currently magnetized to. Drawn after the
        # playhead so a snap-to-playhead overrides the playhead line
        # visually with the snap signal. Cleared when the drag commits.
        if self._snap_indicator_frames:
            self.DrawSetPen(COL_SNAP_INDICATOR)
            for frame in self._snap_indicator_frames:
                ix = self._frame_to_x(frame, w)
                self.DrawLine(ix, 0, ix, h)

        # Right-side dB meter — drawn before the busy overlay and
        # the rail so those still paint on top of any pixels that
        # stray into their territory. The meter reads RMS at the
        # playhead's audio-frame position from the cached envelope.
        if self._audio_track.decoded is not None:
            try:
                self._draw_db_meter(w, h)
            except Exception as e:
                print("[Shotblocks] dB meter draw failed: {}".format(e))

        # Busy overlay — paints over the timeline area when a long-
        # blocking action (v9 analysis) is in progress. Drawn before
        # the rail so the rail still reads cleanly underneath but
        # AFTER everything else, so the dim doesn't leave gaps.
        if self._busy_label is not None:
            self._draw_busy_overlay(w, h, self._busy_label)

        # Left rail — drawn last so its background covers any chrome that
        # extends to x=0 (e.g. range-bar leftover, ruler leftover, lane
        # tail). The rail owns columns x ∈ [0, LEFT_RAIL_WIDTH).
        self._draw_rail(w, h, lane_count)

    # `_draw_rail` and friends (`_draw_diagonal_hatch`, `_draw_dashed_hline`,
    # `_draw_dashed_vline`, `_draw_shot_block`, `_draw_block_bitmap`,
    # `_draw_shot_block_procedural`, `_block_too_narrow_for_glyph`,
    # `_label_bg_for_state`) all live on `DrawingCanvasMixin` in
    # `sb_canvas_drawing.py`. They're called from `DrawMsg` (above) and
    # resolve via MRO.

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
        audio_path = None if cameras else drag_audio_path(self, msg)
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
            # Resolve which audio lane the drop landed on. If y is
            # inside an existing audio lane row, drop there (replacing
            # that lane's content). Otherwise create a new lane at
            # the next free index. Falls back to lane 0 if local_xy
            # isn't available (legacy single-track behavior).
            drop_audio_lane = 0
            if local_xy is not None:
                drop_audio_lane = self._resolve_audio_drop_lane(local_xy[1])
            self._clear_drag()
            return self._import_audio_file(audio_path, drop_frame, drop_audio_lane)

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

    # `_drag_audio_path` is now `drag_audio_path` in `sb_canvas_audio`.

    def _resolve_audio_drop_lane(self, y):
        """Translate a drop's local y to an audio lane index. If the
        cursor sits inside an existing loaded audio lane's row, drop
        there (replaces that lane's content). Otherwise create a new
        lane appended at the next free index. Used by the drag-receive
        path when an audio file is being dropped on the canvas."""
        # If no audio loaded yet, lane 0 is the home.
        loaded_count = sum(1 for t in self._audio_tracks if t.decoded is not None)
        if loaded_count == 0:
            return 0
        # Check whether y lands inside an existing lane row.
        for i, t in enumerate(self._audio_tracks):
            if t.decoded is None:
                continue
            ay1, ay2 = self._audio_y_bounds(i)
            if ay1 <= y <= ay2:
                return i
        # Y is below the audio strip (or above it) — append a new lane.
        return loaded_count

    def _import_audio_file(self, audio_path, drop_frame, drop_lane=0):
        """Bring a WAV or MP3 file in as a document audio track.
        If `drop_lane` is inside the existing range, REPLACES that
        lane's contents; if it's the next free index, APPENDS a new
        lane. Wraps the persistence write in undo so the user can
        Cmd+Z back."""
        doc = c4d.documents.GetActiveDocument()
        # Make sure a slot exists for `drop_lane`. New lanes get a
        # fresh AudioTrack instance whose persist callback wires
        # back to this canvas.
        while len(self._audio_tracks) <= drop_lane:
            t = AudioTrack()
            t._persist_cb = self._persist_audio_tracks
            self._audio_tracks.append(t)
        target = self._audio_tracks[drop_lane]
        try:
            doc.StartUndo()
            _get_or_create_helper(doc)
            target.import_file(audio_path, doc,
                               drop_in_frame=drop_frame,
                               drop_track=drop_lane)
            # Persist the full list (not just `target`) so a fresh-
            # appended lane gets serialized at the same time.
            from sb_persistence import _write_audios
            payload = [t.to_persisted_dict(doc)
                       for t in self._audio_tracks
                       if t.decoded is not None or t.path]
            _write_audios(doc, payload, with_undo=False)
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
                extra_points=self._snap_extras())
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
            # Per-track row control hover — independent from rail
            # buttons; both can be None and the rail still paints.
            kind, idx, ctrl = self._track_row_at(x, y)
            new_row_hover = (kind, idx, ctrl) if ctrl is not None else None
        else:
            new_rail_hover = None
            new_row_hover  = None
        if new_rail_hover != self._rail_hover:
            self._rail_hover = new_rail_hover
            self.Redraw()
        if new_row_hover != self._track_ctrl_hover:
            self._track_ctrl_hover = new_row_hover
            self.Redraw()
        # Level-keyframe hover — resolve which audio clip the cursor
        # is on (if any) and check its keyframes. Storing a tuple
        # (track_idx, kf_idx) so post-razor clips on lanes != 0
        # also get the larger hover-radius node.
        w = self.GetWidth()
        new_kf_hover = (-1, -1)
        hit = self._hit_test_audio(x, y, w)
        if hit is not None:
            _kind, hit_idx, _region = hit
            kfi = self._hit_test_level_kf(x, y, w, hit_idx)
            if kfi >= 0:
                new_kf_hover = (hit_idx, kfi)
        if new_kf_hover != self._level_kf_hover_idx:
            self._level_kf_hover_idx = new_kf_hover
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

        # Audio clips — iterate every loaded entry so multi-clip-per-
        # lane (post-razor or just two A1/A2 clips) all show hover
        # edges. Returned id matches the `hover_key` the audio drawer
        # uses ("audio" for idx 0, "audio_<i>" otherwise) so the
        # animation system writes to and reads from the same slot.
        for i, atrack in enumerate(self._audio_tracks):
            if atrack.decoded is None:
                continue
            ay1, ay2 = self._audio_y_bounds(i)
            if not (ay1 - Y_BUFFER <= y <= ay2 + Y_BUFFER):
                continue
            ax1, ax2 = self._audio_x_bounds(w, i)
            if not (ax1 <= x <= ax2):
                continue
            edge_zone = min(CURSOR_EDGE_PX, max(1, (ax2 - ax1) // 3))
            hover_key = "audio" if i == 0 else "audio_{}".format(i)
            if (x - ax1) <= edge_zone:
                return (hover_key, "left")
            if (ax2 - x) <= edge_zone:
                return (hover_key, "right")

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
        Set Range / Delete / Duplicate; audio block → Delete; range
        bar → Clear Range; empty canvas → Range to All."""
        w = self.GetWidth()
        doc = c4d.documents.GetActiveDocument()
        shots, _ = _read_shots(doc)

        # Range-bar right-click takes priority — its only entry is
        # "Clear Range" which resets the range to span the full doc
        # (effectively turning the range visualization off).
        if y < RANGE_HEIGHT:
            bc = c4d.BaseContainer()
            bc.SetString(MENU_CLEAR_RANGE, "Clear Range")
            result = self._show_popup(bc, x, y)
            self._dispatch_menu_result(result, doc, shots)
            return True

        # Level-keyframe right-click — only when a node is under the
        # cursor. Independent of Pen mode being on; the user might
        # right-click a node from a previous Pen session without re-
        # entering the mode. Need to resolve which clip first so we
        # check the right keyframe list.
        audio_hit = self._hit_test_audio(x, y, w)
        if audio_hit is not None:
            _kind, hit_idx, _region = audio_hit
            kf_idx = self._hit_test_level_kf(x, y, w, hit_idx)
            if kf_idx >= 0:
                self._show_level_kf_menu(x, y, kf_idx, doc, hit_idx)
                return True

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
            # Make the hit audio block the active selection so Delete
            # (and any later audio menu items) are unambiguous about
            # what they target. `audio_hit` shape: ("audio", idx, region).
            self._audio_selected = True
            self._audio_selected_idx = audio_hit[1]
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

    def _show_level_kf_menu(self, x, y, kf_index, doc, track_idx=0):
        """Right-click menu for a level keyframe on the audio clip at
        `track_idx`. Lists the interp modes (with a marker on the
        current one) and a Delete entry. Persists with undo on change."""
        if not (0 <= track_idx < len(self._audio_tracks)):
            return
        track = self._audio_tracks[track_idx]
        if track is None or not (0 <= kf_index < len(track.level_keyframes)):
            return
        kf = track.level_keyframes[kf_index]
        cur = kf.get("interp", "linear")

        def _label(name, code):
            return ("• " if cur == code else "  ") + name

        bc = c4d.BaseContainer()
        bc.SetString(MENU_LVL_INTERP_LIN,   _label("Linear",        "linear"))
        bc.SetString(MENU_LVL_INTERP_HOLD,  _label("Hold",          "hold"))
        bc.SetString(MENU_LVL_INTERP_IN,    _label("Ease In",       "ease_in"))
        bc.SetString(MENU_LVL_INTERP_OUT,   _label("Ease Out",      "ease_out"))
        bc.SetString(MENU_LVL_INTERP_INOUT, _label("Ease In/Out",   "ease_in_out"))
        # Separator + delete.
        bc.InsData(0, c4d.BaseContainer())  # menu separator (best effort)
        bc.SetString(MENU_LVL_DELETE, "Delete Keyframe")
        result = self._show_popup(bc, x, y)
        if result in (None, 0):
            return
        if result == MENU_LVL_DELETE:
            track.remove_level_keyframe(kf_index)
        else:
            mapping = {
                MENU_LVL_INTERP_LIN:   "linear",
                MENU_LVL_INTERP_HOLD:  "hold",
                MENU_LVL_INTERP_IN:    "ease_in",
                MENU_LVL_INTERP_OUT:   "ease_out",
                MENU_LVL_INTERP_INOUT: "ease_in_out",
            }
            new_interp = mapping.get(result)
            if new_interp is None:
                return
            track.set_level_keyframe(kf_index, interp=new_interp)
        # Persist + redraw via the multi-track writer.
        self._persist_audio_tracks(doc)
        self._refresh_audio_loaded_sig(doc)
        self.Redraw()

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
                # Shot frames are inclusive [in, out]; the range model
                # is half-open [in, out_exclusive). The range bar's
                # right edge is drawn at frame x = out, so without the
                # +1 it lands on the shot's last frame and visually
                # cuts into the shot.
                self._set_range(doc, s["in_frame"], s["out_frame"] + 1)
        elif result == MENU_SET_RANGE_SEL:
            sel = [s for s in shots if s["id"] in self._selected_ids]
            if sel:
                in_f  = min(s["in_frame"]  for s in sel)
                out_f = max(s["out_frame"] for s in sel) + 1
                self._set_range(doc, in_f, out_f)
        elif result == MENU_RANGE_TO_ALL:
            if shots:
                in_f  = min(s["in_frame"]  for s in shots)
                out_f = max(s["out_frame"] for s in shots) + 1
                self._set_range(doc, in_f, out_f)
        elif result == MENU_CLEAR_RANGE:
            doc_first, doc_last = self._doc_bounds()
            self._set_range(doc, doc_first, doc_last)

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

        # Ctrl+Shift+A → run v9 onset analysis on the audio track.
        # Mirrors the analyse rail button; faster path for power users.
        if (qualifier & _QCTRL) and (qualifier & _QSHIFT) and channel == ord('A'):
            self._analyse_audio()
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

        # Up / Down arrow → jump playhead to previous / next edit point
        # (any shot in_frame or out_frame across all tracks). NLE
        # convention; lets the user step from cut to cut without
        # eyeballing the timeline.
        if not (qualifier & (_QCTRL | _QSHIFT | _QALT)):
            if channel == _KEY_UP:
                self._jump_to_edit_point(direction=-1)
                return True
            if channel == _KEY_DOWN:
                self._jump_to_edit_point(direction=+1)
                return True

        # Backslash → toggle between fit-all zoom and the previous
        # zoom (Railcut / Premiere convention). Stash the current
        # window before fitting so the next press restores it. If we
        # were already at fit-all, restore the stash if there is one;
        # otherwise no-op.
        if (not (qualifier & (_QCTRL | _QSHIFT | _QALT))
                and channel == ord('\\')):
            self._toggle_zoom_fit()
            return True

        # `/` → set play range to selection (or to all shots if
        # nothing is selected). Mirrors the right-click menu entries
        # "Set Range to Selection" / "Range to All" — one keystroke
        # to fit the range bar around the work you're focused on.
        if (not (qualifier & (_QCTRL | _QSHIFT | _QALT))
                and channel == ord('/')):
            self._range_to_selection_or_all()
            return True

        # Alt + arrow → nudge selected shots.
        #   Alt+Left/Right       = ±1 frame
        #   Alt+Shift+Left/Right = ±10 frames
        #   Alt+Up/Down          = ±1 track (Up = up, Down = down)
        # Conflict-free with bare Up/Down (edit-point jump) because Alt
        # is required here. Ctrl-held is excluded to leave room for
        # future C4D-style transport hotkeys.
        if (qualifier & _QALT) and not (qualifier & _QCTRL):
            shift = bool(qualifier & _QSHIFT)
            step = 10 if shift else 1
            if channel == _KEY_LEFT:
                self._nudge_selection(df=-step, dt=0)
                return True
            if channel == _KEY_RIGHT:
                self._nudge_selection(df=+step, dt=0)
                return True
            if channel == _KEY_UP and not shift:
                self._nudge_selection(df=0, dt=-1)
                return True
            if channel == _KEY_DOWN and not shift:
                self._nudge_selection(df=0, dt=+1)
                return True

        return False

    def _nudge_selection(self, df, dt):
        """Move all selected shots by (df frames, dt tracks) as a rigid
        group. Uses `_resolve_group_move` in replace mode so collisions
        trim neighbors (same as a drag-move). No-op if nothing is
        selected.
        """
        if not self._selected_ids:
            return
        doc = c4d.documents.GetActiveDocument()
        shots, next_id = _read_shots(doc)
        target_ids = set(self._selected_ids)
        # Track lock — bail if any selected shot lives on a locked
        # track, OR (for a vertical nudge) if any destination track
        # is locked.
        from sb_shot_model import _shot_track as _st
        src_tracks = {_st(s) for s in shots if s["id"] in target_ids}
        if self._any_video_track_locked(src_tracks):
            print("[Shotblocks] nudge blocked: source track locked")
            return
        if dt != 0:
            dst_tracks = {t + dt for t in src_tracks}
            if self._any_video_track_locked(dst_tracks):
                print("[Shotblocks] nudge blocked: destination track locked")
                return
        # Anchor = the first selected shot (any selected shot works for
        # non-snap mode; we're not snapping).
        anchor_id = next(iter(target_ids))
        new_shots, _ = _resolve_group_move(
            shots, target_ids, anchor_id, df, dt,
            mode="replace", snap_frames=0)
        doc.StartUndo()
        _write_shots(doc, new_shots, next_id, with_undo=True)
        doc.EndUndo()
        c4d.EventAdd()
        self.Redraw()

    def _range_to_selection_or_all(self):
        """`/` hotkey: set play range to current selection, or to the
        full extent of all shots if nothing is selected. Matches the
        right-click menu's "Set Range to Selection" / "Range to All"
        entries. Shot frames are inclusive [in, out]; the range model
        is half-open [in, out_exclusive), so out_f = max_out + 1 to
        keep the range bar's right edge hugging the shot's tail rather
        than cutting one frame into it."""
        doc = c4d.documents.GetActiveDocument()
        shots, _ = _read_shots(doc)
        if self._selected_ids:
            sel = [s for s in shots if s["id"] in self._selected_ids]
            if not sel:
                return
            in_f  = min(s["in_frame"]  for s in sel)
            out_f = max(s["out_frame"] for s in sel) + 1
        elif shots:
            in_f  = min(s["in_frame"]  for s in shots)
            out_f = max(s["out_frame"] for s in shots) + 1
        else:
            return
        self._set_range(doc, in_f, out_f)

    def _toggle_zoom_fit(self):
        """Toggle the visible window between the doc's full range and
        whatever the user had before the last fit."""
        doc = c4d.documents.GetActiveDocument()
        if doc is None:
            return
        fps = self._doc_fps(doc)
        try:
            doc_first = int(doc.GetMinTime().GetFrame(fps))
            doc_last  = int(doc.GetMaxTime().GetFrame(fps))
        except Exception:
            return
        if doc_last <= doc_first:
            return
        at_fit = (self.visible_first, self.visible_last) == (doc_first, doc_last)
        stash = getattr(self, "_zoom_fit_stash", None)
        if at_fit and stash is not None:
            # Restore the pre-fit window.
            self.visible_first, self.visible_last = stash
            self._zoom_fit_stash = None
        else:
            # Stash the current window and snap to fit-all.
            self._zoom_fit_stash = (self.visible_first, self.visible_last)
            self.visible_first = doc_first
            self.visible_last  = doc_last
        self._request_peak_rebuild()
        self.Redraw()

    def _jump_to_edit_point(self, direction):
        """Move the playhead to the nearest edit point in `direction`
        (-1 = previous, +1 = next). Edit points are every shot's
        `in_frame` and `out_frame + 1` (the cut-after frame) across all
        tracks. If no edit point exists in that direction, the playhead
        doesn't move.

        Audio playback re-seeks if running, so the user can spacebar-
        play, Up/Down to the next cut, and continue without an audio
        gap or drift.
        """
        doc = c4d.documents.GetActiveDocument()
        shots, _ = _read_shots(doc)
        if not shots:
            return
        # Build the set of edit points. `out_frame + 1` rather than
        # `out_frame` because a shot covers [in, out] inclusive — the
        # cut happens AFTER `out`, at `out + 1`.
        points = set()
        for s in shots:
            points.add(int(s["in_frame"]))
            points.add(int(s["out_frame"]) + 1)
        cur = self.playhead_frame
        if direction < 0:
            candidates = [p for p in points if p < cur]
            if not candidates:
                return
            target = max(candidates)
        else:
            candidates = [p for p in points if p > cur]
            if not candidates:
                return
            target = min(candidates)
        fps = self._doc_fps(doc)
        self._set_playhead_with_playback_resync(
            target, fps, seek_audio=True)
        # Mirror to C4D's transport so the viewport jumps with us.
        try:
            doc.SetTime(c4d.BaseTime(target, fps))
        except Exception as e:
            print("[Shotblocks] edit-point jump SetTime failed: {}".format(e))
        c4d.EventAdd()
        self.Redraw()

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
        # Doc range changed → effective zoom changed too. Schedule a
        # peak-cache rebuild so the waveform paints sharply.
        self._request_peak_rebuild()
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

    # `_toggle_playback` (start/stop spacebar playback) and
    # `_route_camera_for_frame` (active-shot camera router + rig
    # pipeline driver) live on `PlaybackCanvasMixin` in
    # `sb_canvas_playback.py`.

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

    # `_poll_analysis_thread` lives on `AudioCanvasMixin`.

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

    # `_playback_tick` (per-Timer-tick video-clock advance) and
    # `_set_playhead_with_playback_resync` (re-anchor playback after a
    # mid-flight playhead jump) live on `PlaybackCanvasMixin` in
    # `sb_canvas_playback.py`.

    # Audio block (v7), dB meter, beat grid, busy overlay, peak ticks,
    # audio drag handlers, persistence sync — all on `AudioCanvasMixin`
    # in `sb_canvas_audio.py`. The canvas keeps `_import_audio_file`
    # because its cross-cluster caller is the drag-receive handler above.

    # ------------------------------------------------------------------
    # Click / drag — left button
    # ------------------------------------------------------------------

    def _on_left_press(self, x, y, qualifier):
        # Rail click — handled before any timeline gesture. The rail
        # owns x in [0, LEFT_RAIL_WIDTH); modifiers don't change rail
        # behavior (no Alt+drag-pan inside the rail). Try the per-track
        # row controls first; if the click missed them, fall through to
        # the global rail buttons.
        if x < LEFT_RAIL_WIDTH:
            if self._handle_track_row_click(x, y):
                return True
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
            # Double-click on the bar (not on a handle) → clear range.
            # Two LMB presses inside DOUBLE_CLICK_WINDOW_S, on the
            # body or empty area of the range bar, reset to full doc.
            DOUBLE_CLICK_WINDOW_S = 0.4
            now = _monotonic()
            is_double = ((now - self._last_range_lmb_t) <= DOUBLE_CLICK_WINDOW_S
                         and region != "in" and region != "out")
            self._last_range_lmb_t = now
            if is_double:
                doc = c4d.documents.GetActiveDocument()
                doc_first, doc_last = self._doc_bounds()
                self._set_range(doc, doc_first, doc_last)
                return True
            if region == "in":
                self._drag_range_handle("in", x, y)
            elif region == "out":
                self._drag_range_handle("out", x, y)
            elif region == "body":
                self._drag_range_body(x, y)
            else:
                # Click landed in the range bar but outside the
                # active range and not on a handle — treat it as a
                # playhead scrub (snap to click x, drag to scrub).
                # Mirrors the ruler-band behavior so the user can
                # reach the playhead from either the range bar's
                # muted strips or the ruler itself.
                self._drag_playhead(x, y)
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
            _kind, track_idx, region = audio_hit
            self._audio_selected = True
            self._audio_selected_idx = track_idx
            # Clear shot selection so only the audio block reads selected.
            self._selected_ids.clear()
            self.Redraw()
            ctrl_held = bool(qualifier & _QCTRL)
            if region == "left":
                self._drag_audio_resize("left", x, y, track_idx)
            elif region == "right":
                self._drag_audio_resize("right", x, y, track_idx)
            elif self._razor_enabled and region == "body":
                # Razor on audio body — split at click frame (or
                # snap target). Returns False if the click was too
                # close to an edge to produce two non-empty halves.
                self._razor_audio_at(x, y, w, track_idx)
            elif self._pen_enabled:
                # Pen mode on the audio body: hit an existing node and
                # drag it, or add a new one at the click position and
                # immediately enter the drag loop. Edge-resize bypasses
                # this above so the user can still trim while Pen is on.
                kf_idx = self._hit_test_level_kf(x, y, w, track_idx)
                if kf_idx < 0:
                    kf_idx = self._add_level_kf_at(x, y, w, track_idx)
                if kf_idx >= 0:
                    self._drag_level_kf(kf_idx, x, y, track_idx)
            elif self._slip_enabled or ctrl_held:
                # Slip: either the rail-button tool is on (so slip is
                # the default body-drag), or the user held Ctrl to
                # invoke slip as a one-off gesture without flipping
                # the tool. Plain body-drag in this branch still moves
                # the clip on the timeline.
                # (Alt+drag is reserved for canvas pan — see
                # `_on_left_press` above — so slip uses Ctrl.)
                self._drag_audio_slip(x, y, track_idx)
            else:
                self._drag_audio_move(x, y, track_idx)
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

        if self._razor_enabled and region == "body":
            self._razor_shot_at(shot_id, x, y, w)
            return True
        if region == "body":
            self._drag_move(shot_id, x, y)
        elif region in ("left", "right"):
            self._drag_resize(shot_id, region, x, y)
        return True

    # ------------------------------------------------------------------
    # Drag-gesture cluster — `_drag_loop`, `_parse_drag_state`,
    # `_is_drag_terminal`, `_drag_move`, `_drag_resize`, `_drag_marquee`,
    # `_shots_in_rect`, `_drag_range_handle`, `_drag_range_body`,
    # `_drag_playhead`, `_commit_range_drag`, `_drag_pan`, `_drag_zoom`,
    # `_pan_by_wheel`, `_zoom_around_cursor`, `_render_preview_shots`
    # all live on `DragCanvasMixin` in `sb_canvas_drag.py`. The input
    # handlers below invoke them via `self.*` (resolving through MRO).
    # ------------------------------------------------------------------

    # ------------------------------------------------------------------
    # Selection operations (delete, duplicate)
    # ------------------------------------------------------------------

    def _razor_target_frame(self, x, w):
        """Convert click x to a doc-frame, snapping to nearby edit
        points when Snap is enabled. Reuses `_snap_frames` /
        `_snap_extras` so the razor lines up with the same targets
        as other gestures (shot edges, peak markers, beat grid)."""
        raw = self._x_to_frame(x, w)
        if not self._snap_enabled:
            return raw
        from sb_shot_model import _magnetic_snap_edge
        doc = c4d.documents.GetActiveDocument()
        shots, _ = _read_shots(doc) if doc is not None else ([], 0)
        snapped, _targets = _magnetic_snap_edge(
            shots, target_id=None, edge_frame=raw,
            snap_frames=self._snap_frames(),
            extra_points=self._snap_extras())
        return snapped

    def _razor_shot_at(self, shot_id, x, y, w):
        """Razor-tool click on a shot's body — split it at the click
        frame (snapped if Snap is on). Refuses to split if the click
        is too close to either edge to produce two non-empty halves.
        Wrapped in undo so a single Cmd+Z restores the pre-split shot."""
        from sb_shot_model import _split_shot, _shot_track
        doc = c4d.documents.GetActiveDocument()
        if doc is None:
            return
        shots, next_id = _read_shots(doc)
        target = next((s for s in shots if s["id"] == shot_id), None)
        if target is None:
            return
        # Track lock check — locked tracks block all mutations,
        # razor included.
        if self._track_is_locked("video", _shot_track(target)):
            print("[Shotblocks] razor blocked: track locked")
            return
        frame = self._razor_target_frame(x, w)
        new_shots = _split_shot(shots, shot_id, frame, next_id)
        if new_shots is shots:
            print("[Shotblocks] razor: split refused at frame {}".format(frame))
            return
        # Carry the source shot's camera link forward to the new
        # right-half id so the right half stays connected to the
        # same camera (same orphan/live state).
        src_cam = self._cam_refs.get(shot_id) or _get_shot_cam(doc, shot_id)
        doc.StartUndo()
        _write_shots(doc, new_shots, next_id + 1, with_undo=True)
        if src_cam is not None:
            self._remember_cam(next_id, src_cam)
        doc.EndUndo()
        c4d.EventAdd()
        self.Redraw()
        print("[Shotblocks] razor: split shot {} at frame {} → new id {}".format(
            shot_id, frame, next_id))

    def _razor_audio_at(self, x, y, w, track_idx):
        """Razor-tool click on an audio block — split that lane's
        clip at the click frame (snapped). The right half stays on
        the same lane immediately after the cut."""
        doc = c4d.documents.GetActiveDocument()
        if doc is None:
            return
        if self._track_is_locked("audio", track_idx):
            print("[Shotblocks] razor blocked: audio track locked")
            return
        track = self._audio_tracks[track_idx]
        if track.decoded is None:
            return
        frame = self._razor_target_frame(x, w)
        right = track.split_at(frame, doc)
        if right is None:
            print("[Shotblocks] razor: audio split refused at frame {}".format(frame))
            return
        # Insert the right half immediately after the source on its
        # OWN lane index — visually it stays in the same row. The
        # canvas list ordering follows lane number (the audio
        # renderer iterates `_audio_tracks` in index order). Each
        # lane currently holds one clip; the right half therefore
        # appends as a new entry whose `.track` matches the source
        # lane and the renderer paints it in the same row.
        right.track = track.track
        # Insert at track_idx + 1 so audio_tracks list order doesn't
        # diverge from lane order. Subsequent draws look up by index.
        self._audio_tracks.insert(track_idx + 1, right)
        self._persist_audio_tracks(doc)
        self._refresh_audio_loaded_sig(doc)
        print("[Shotblocks] razor: split audio at frame {} (lane {})".format(
            frame, track_idx))

    def _delete_selected(self):
        if self._audio_selected:
            self._delete_selected_audio()
            return
        if not self._selected_ids:
            return
        doc = c4d.documents.GetActiveDocument()
        shots, next_id = _read_shots(doc)
        target_ids = set(self._selected_ids)
        # Track lock — block if any selected shot lives on a locked track.
        from sb_shot_model import _shot_track as _st
        touched = {_st(s) for s in shots if s["id"] in target_ids}
        if self._any_video_track_locked(touched):
            print("[Shotblocks] delete blocked: track locked")
            return
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

    # `_delete_selected_audio`, `_on_analyse_click`, `_on_waveform_click`,
    # `_analyse_audio`, `_spawn_analysis_worker`, `_request_peak_rebuild`,
    # `_maybe_kick_peak_rebuild`, `_drain_peak_rebuild` — all on the
    # `AudioCanvasMixin` in `sb_canvas_audio.py`.

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
        # Track lock — block when any source OR landing track is locked.
        # Duplicates target track+1 (or same track at the cap), so both
        # must be unlocked for the operation to succeed cleanly.
        from sb_shot_model import _shot_track as _st
        touched = set()
        for s in srcs:
            t = _st(s)
            touched.add(t)
            touched.add(min(t + 1, MAX_TRACKS - 1))
        if self._any_video_track_locked(touched):
            print("[Shotblocks] duplicate blocked: track locked")
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
                                             extra_points=self._snap_extras())
            else:
                # Duplicate lands right after the source with the
                # required gap so adjacent clips never share a
                # boundary frame.
                new_in = src["out_frame"] + 1 + CLIP_GAP_FRAMES
                copy = _make_shot(dup_id, new_in, new_in + duration,
                                  src["cam_name"], src_track)
                shots.append(copy)
                shots, _ = _resolve_position(shots, dup_id, copy["in_frame"],
                                             copy["track"], mode, snap_frames,
                                             extra_points=self._snap_extras())
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

