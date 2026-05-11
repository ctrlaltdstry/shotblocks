"""Shotblocks audio canvas mixin.

The audio-block draw / hit-test / drag / sync code, plus the dB meter,
the busy overlay, the beat grid, the analysis worker plumbing, and the
zoom-driven peak-cache rebuild worker — everything in `sb_canvas.py`'s
"audio block (v7)" cluster.

`ShotblocksTimelineCanvas` inherits `AudioCanvasMixin` so all the
methods here see the same `self` as the rest of the canvas: shot-model
helpers, frame-to-x math, the GeUserArea Draw* API, etc. all stay one
attribute lookup away. The split exists for code-locality, not for any
runtime independence.

Module-level helpers are stateless conveniences that don't need to
hang off the canvas class.
"""

import math
import os
import threading
from time import monotonic as _monotonic

import c4d

from sb_persistence import _get_or_create_helper
from sb_audio_decode import is_audio_path
from sb_audio_track  import AudioTrack
from sb_audio_render import draw_waveform
from sb_audio_onsets import analyse as analyse_audio
from sb_audio_meter  import FLOOR_DBFS as METER_FLOOR_DBFS
from sb_audio_playback import AudioPlayback
from sb_toolbar import load_bitmap


# ---------------------------------------------------------------------------
# Audio-only visual-language tokens (kept colocated with the audio code so
# any styling change touches one file).
# ---------------------------------------------------------------------------

def _rgb(hex6):
    return c4d.Vector(
        int(hex6[0:2], 16) / 255.0,
        int(hex6[2:4], 16) / 255.0,
        int(hex6[4:6], 16) / 255.0,
    )

# Audio block — body fill is a deep teal so the waveform reads cleanly
# against it and the block is unmistakably distinct from a video shot.
COL_AUDIO_BODY          = _rgb("1d3a44")  # deep teal, mid-saturation
COL_AUDIO_BODY_SELECTED = _rgb("2a5666")  # lighter teal when selected
COL_AUDIO_BORDER        = _rgb("3a6a78")
COL_AUDIO_WAVEFORM      = _rgb("617c7c")  # white blended 30% against the
                                          # audio body bg (#1d3a44). C4D
                                          # 2026's DrawSetPen has no alpha
                                          # so we color-shift to approximate
                                          # 30 %-white-on-teal opacity.
# Selected-state waveform color. The selected audio body bitmap is
# bright kelly green (#328647 — see src/res/icons/shots/audio-
# selected-mid.png), so the 30%-white-blend used for the unselected
# state washes out. Instead we go DARKER on selection: a dim shadow
# of the bg green that reads as "waveform" against the bright body.
COL_AUDIO_WAVEFORM_SEL  = _rgb("143620")  # darkened audio-selected green
COL_AUDIO_CENTERLINE    = _rgb("3a6a78")  # same as border — subtle reference
COL_AUDIO_LABEL         = _rgb("c0e8f0")
# v9 analysis visuals.
#   peak ticks: warm yellow on the audio block — distinct from snap
#               yellow (snap is brighter). Prominent peaks only;
#               the onset list is computed but never drawn.
#   beat grid:  neutral mid-gray, drawn as canvas-wide dashed
#               vertical lines behind everything. The dash pattern
#               itself is what differentiates the grid from solid
#               playhead / range lines.
COL_AUDIO_PEAK_TICK     = _rgb("ffd166")  # mustard
COL_BEAT_GRID           = _rgb("3b3b3b")  # midway between #5a5a5a and the
                                          # lane bg #1c1c1c — visually 50%
                                          # less prominent than the previous
                                          # gray. C4D's DrawSetPen has no
                                          # alpha so we color-shift instead.


# ---------------------------------------------------------------------------
# Audio-only layout constants
# ---------------------------------------------------------------------------

AUDIO_HEIGHT        = 96   # audio tracks render at 2x shot height per design;
                           # not yet wired into track-Y math (waits for the
                           # audio subsystem in v7+).

# Horizontal interior padding mirrors the canvas-level constant; the
# audio block extends edge-to-edge so the waveform's visible peaks
# land at the SAME pixel column as their doc-frame projection. Peak
# ticks and beat-grid lines (both drawn via the canonical
# `audio_frame_to_doc_frame → _frame_to_x` path) then line up exactly
# with what the user sees in the waveform — which is what makes a
# snap feel like it actually snapped to the peak. The dot grips
# baked into the audio-block edge bitmap are partially overlapped by
# waveform pixels; the user prefers this over the misalignment
# caused by a wider inset.
AUDIO_WF_INSET_PX   = 0
# Vertical inset on each side of the waveform inside the audio
# block, in pixels. Centers the waveform vertically and leaves
# breathing room top/bottom so the peak markers (top) and the
# block's bottom edge bitmap (bottom) don't visually compete with
# the waveform crests. At AUDIO_HEIGHT=96 a 14 px inset on each
# side leaves a 68 px band (~71 % of the block's height).
AUDIO_WF_INSET_Y    = 14

# Right-side audio meter. A vertical strip on the far right of the
# dialog hosts a Premiere/FCP-style stereo dB meter — two thin bars
# with a gradient fill (green → yellow → red), a peak-hold tick,
# and a dB scale. Reserves horizontal space; the timeline content
# area's right edge moves left by RIGHT_METER_PANEL_W when audio is
# loaded so the meter doesn't overlap the timeline.
RIGHT_METER_PANEL_W   = 50    # total meter panel width
RIGHT_METER_BAR_W     = 8     # each L/R bar
RIGHT_METER_BAR_GAP   = 2     # gap between L and R bars
RIGHT_METER_PAD_X     = 4     # left/right padding inside the panel
# RIGHT_METER_TOP_PAD is derived from layout constants on the canvas
# side (RANGE_HEIGHT + RULER_HEIGHT + 4) and passed in at draw time.
RIGHT_METER_BOT_PAD   = 4
# Scale labels every 6 dB from 0 down to -54.
RIGHT_METER_LABELS_DB = (0, -6, -12, -18, -24, -30, -36, -42, -48, -54)
# Peak-hold sample sticks at the most-recent peak and decays at this
# many dB per second. 12 dB/s matches the typical DAW visual.
PEAK_HOLD_DECAY_DB_S  = 12.0
# When playback stops, the meter bars decay from their last level
# toward FLOOR_DBFS at this rate — ~1.5 seconds to reach silence
# from -10 dB. Avoids the bars looking "stuck" on a loud value
# after pause; matches DAW conventions where stopped means silent.
METER_PAUSE_DECAY_DB_S = 40.0
# Color stops along the meter, in dBFS. Below GREEN_TOP_DB the bar
# is solid green; between GREEN_TOP_DB and YELLOW_TOP_DB it fades
# green → yellow; above that it fades yellow → red.
METER_GREEN_TOP_DB    = -18.0
METER_YELLOW_TOP_DB   = -6.0
METER_RED_DB          = -3.0  # not strictly used — "red" zone above this

# Target output size (height) for the bitmap-driven peak marker.
# Width scales from the source bitmap's aspect ratio so authoring
# at any reasonable size produces correctly-proportioned output.
PEAK_MARKER_BITMAP_H = 8       # fits in the audio block's top label band


# ---------------------------------------------------------------------------
# Module-level helpers (stateless; no `self` needed)
# ---------------------------------------------------------------------------

def db_to_y(db, y_top, y_bot):
    """Map a dBFS value to a y pixel within [y_top, y_bot].
    0 dBFS sits at y_top, FLOOR_DBFS at y_bot. Linear in between."""
    if db >= 0.0:
        return y_top
    if db <= METER_FLOOR_DBFS:
        return y_bot
    # Progress = 0 at 0 dB → y_top, 1 at FLOOR_DBFS → y_bot.
    progress = (-db) / (-METER_FLOOR_DBFS)
    return int(round(y_top + progress * (y_bot - y_top)))


def y_to_db(y, y_top, y_bot):
    """Inverse of `db_to_y`."""
    if y <= y_top:
        return 0.0
    if y >= y_bot:
        return METER_FLOOR_DBFS
    progress = (y - y_top) / float(y_bot - y_top)
    return progress * METER_FLOOR_DBFS


def meter_color_for_db(db):
    """Green → yellow → red gradient per dB. Matches Premiere/FCP
    defaults: solid green below METER_GREEN_TOP_DB (~-18 dB),
    ramping to yellow at METER_YELLOW_TOP_DB (~-6 dB), then red
    above ~-3 dB."""
    if db <= METER_GREEN_TOP_DB:
        return _rgb("3acb3a")  # solid green
    if db <= METER_YELLOW_TOP_DB:
        # Green → yellow
        t = (db - METER_GREEN_TOP_DB) / float(METER_YELLOW_TOP_DB - METER_GREEN_TOP_DB)
        r = int(58  + (245 - 58)  * t)
        g = int(203 + (220 - 203) * t)
        b = int(58  + (40  - 58)  * t)
        return c4d.Vector(r / 255.0, g / 255.0, b / 255.0)
    # Yellow → red above -6 dB
    t = (db - METER_YELLOW_TOP_DB) / float(0.0 - METER_YELLOW_TOP_DB)
    if t > 1.0:
        t = 1.0
    r = int(245 + (235 - 245) * t)
    g = int(220 + (50  - 220) * t)
    b = int(40  + (50  - 40)  * t)
    return c4d.Vector(r / 255.0, g / 255.0, b / 255.0)


def target_samples_per_column(canvas):
    """Compute the ideal `samples_per_column` for the current
    zoom: one peak-cache column per on-screen pixel of the audio
    block, mapped through the doc-frame ↔ audio-frame ratio.
    Returns max(1, …) so very-zoomed-in cases don't ask for
    impossible sub-sample columns.
    """
    track = canvas._audio_track
    if track.decoded is None:
        return 1024
    w = canvas.GetWidth()
    if w <= 0:
        return 1024
    fpp = canvas._frames_per_pixel(w)
    doc = c4d.documents.GetActiveDocument()
    fps = canvas._doc_fps(doc) if doc is not None else 24
    rate = track.decoded.sample_rate
    # audio-frames per doc-frame: rate / fps. audio-frames per
    # on-screen pixel: that times frames_per_pixel.
    spc = int(round(rate / float(fps) * fpp))
    return max(1, spc)


def drag_audio_path(canvas, msg):
    """Pull a supported audio file path (`.wav` or `.mp3`) out of a
    drag message, if the drag type is one of the file-drop types.
    Returns None on miss. Tolerates the several shapes
    GetDragObject returns for file drops in different C4D builds
    (string, list of strings, dict).

    Module-level so the drag-receive plumbing on the canvas can call
    this without needing to mix audio-specific drag parsing into the
    non-audio drag code path.
    """
    try:
        drag_info = canvas.GetDragObject(msg)
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
    if drag_type not in canvas._audio_drag_logged_types:
        canvas._audio_drag_logged_types.add(drag_type)
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


# ---------------------------------------------------------------------------
# Audio canvas mixin — all per-instance audio behavior
# ---------------------------------------------------------------------------

class AudioCanvasMixin(object):
    """Audio-cluster methods + per-instance state for the timeline canvas.

    `ShotblocksTimelineCanvas` inherits this. The mixin assumes `self`
    is a canvas instance with the rest of the canvas's helpers
    available (`_frame_to_x`, `_doc_fps`, `_drag_loop`, etc.).
    """

    # ------------------------------------------------------------------
    # Per-instance state — call from the canvas's __init__.
    # ------------------------------------------------------------------

    def _audio_init_state(self):
        """Initialize all per-instance audio state. Call from the
        canvas's `__init__` so a fresh canvas has zeroed buffers,
        empty caches, and a ready AudioTrack / AudioPlayback pair.
        """
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

        # Standalone chrome bitmaps (peak marker). Lazy-loaded on first
        # read; None on load failure so the procedural fallback
        # (2-px DrawLine tick) keeps working.
        self._chrome_bitmaps_cache = None

        # Busy overlay — when set to a string, DrawMsg paints a panel
        # with that label centered over the timeline area. v9 analysis
        # uses this together with the worker thread below to keep the
        # main UI alive during the multi-second FFT pass.
        # `_busy_started_t` is set when the overlay is shown so the
        # animated dots in `_draw_busy_overlay` can sample
        # `_monotonic() - _busy_started_t` for their cycle position.
        self._busy_label     = None
        self._busy_started_t = 0.0

        # Right-side dB meter state, all per-channel (typically 2 for
        # stereo). `_peak_hold_db` is the held-peak yellow tick at the
        # top of each bar, decaying at PEAK_HOLD_DECAY_DB_S/sec when
        # the current level falls below it. `_meter_displayed_db` is
        # what's currently painted in the bar; during playback it
        # tracks the envelope level at the playhead, when stopped it
        # decays toward FLOOR_DBFS over METER_PAUSE_DECAY_DB_S so the
        # bars don't freeze on the last value. `_meter_anim_t` anchors
        # both decays' clocks.
        self._peak_hold_db        = []
        self._meter_displayed_db  = []
        self._meter_anim_t        = _monotonic()
        # Last seen playhead_frame; the meter snaps to live envelope
        # any tick where this changes (treats playhead movement as
        # "scrubbing" → live read), and decays otherwise.
        self._meter_last_playhead = -1

        # Waveform peak-cache zoom rebuild. The cache is built at a
        # fixed `samples_per_column` once on import (cheap renderer
        # downsample handles any block width). At extreme zoom-in
        # this looks blocky because one cache column maps to many
        # pixels. To stay sharp without freezing on every zoom event:
        # set `_pending_peak_rebuild_t` to a future wall-clock time
        # whenever the zoom changes; the dialog timer fires
        # `_maybe_kick_peak_rebuild` each tick, which spawns a worker
        # thread once the debounce elapses. Completion fires via
        # SpecialEventAdd → CoreMessage → `_drain_peak_rebuild`.
        self._pending_peak_rebuild_t = 0.0
        self._peak_rebuild_thread    = None
        self._peak_rebuild_result    = None
        self._peak_rebuild_event_id  = 0

        # v9 analysis worker. Off-main-thread so the FFT loop doesn't
        # freeze the dialog. The thread populates `_analysis_result`
        # on success or `_analysis_error` on failure; the main-thread
        # timer poller (see `_poll_analysis_thread`) observes the
        # populated field, writes results back to the AudioTrack, and
        # clears the busy overlay. Strict main-thread / worker
        # separation: the worker never touches `c4d` or mutates the
        # AudioTrack; the main thread does both.
        self._analysis_thread = None
        self._analysis_result = None
        self._analysis_error  = None
        # Two-phase start: True between `_analyse_audio` posting the
        # deferred SpecialEventAdd and `_spawn_analysis_worker` actually
        # starting the thread. Lets the busy panel paint before the
        # worker steals the GIL.
        self._analysis_pending_start = False
        # Plugin id the worker thread fires via `c4d.SpecialEventAdd`
        # to signal completion on the main thread. The dialog sets
        # this in its CreateLayout via `PLUGIN_ID_COMMAND`. Default
        # 0 disables the signal (worker still runs, but the result
        # only ever surfaces if something else calls
        # `_poll_analysis_thread` — leaves room to fall back to a
        # timer-based poll if SpecialEventAdd is ever unavailable).
        self._analysis_complete_event_id = 0

    # ------------------------------------------------------------------
    # Lazy bitmap cache — chrome bitmaps (peak markers)
    # ------------------------------------------------------------------

    @property
    def _chrome_bitmaps(self):
        """Lazy dict of standalone chrome bitmaps: peak marker
        (normal + selected variants). None entries are tolerated by
        the draw paths which fall back to procedural rendering."""
        if self._chrome_bitmaps_cache is None:
            here = os.path.dirname(os.path.abspath(__file__))
            icons = os.path.join(here, "res", "icons")
            self._chrome_bitmaps_cache = {
                # Only the peak markers use chrome bitmaps now —
                # playhead and range handles draw as procedural
                # rectangles for the C4D-native look.
                "peak":          load_bitmap(os.path.join(icons, "peak-marker.png")),
                "peak-selected": load_bitmap(os.path.join(icons, "peak-marker-selected.png")),
            }
        return self._chrome_bitmaps_cache

    # ------------------------------------------------------------------
    # Geometry helpers
    # ------------------------------------------------------------------

    def _meter_panel_x_bounds(self, w):
        """Pixel x-bounds of the right-side dB meter panel.
        (x1, x2) inclusive-exclusive. The panel hugs the right edge
        of the canvas so no audio content can leak through past it
        on the right side. Returns None when no audio is loaded."""
        if self._audio_track.decoded is None:
            return None
        x2 = w
        x1 = x2 - RIGHT_METER_PANEL_W
        return (x1, x2)

    def _audio_x_bounds(self, w):
        """Pixel bounds of the audio block on screen. Mirrors
        `_shot_x_bounds` for shots."""
        return self._shot_x_bounds(self._audio_track.in_frame,
                                   self._audio_track.out_frame, w)

    def _audio_y_bounds(self):
        """(top, bottom) Y bounds of the audio block in canvas pixels.
        Audio renders below track 0, separated by LANE_GAP. Used by
        the draw path AND by the canvas-side `_compute_hover_band`
        (the audio block's hover-edge detection).
        """
        from sb_canvas import SHOT_HEIGHT, LANE_GAP
        t0_bot   = self._track_0_top() + SHOT_HEIGHT
        audio_top = t0_bot + LANE_GAP
        audio_bot = audio_top + AUDIO_HEIGHT
        return audio_top, audio_bot

    # ------------------------------------------------------------------
    # Sync (load/clear in-memory state from persistence)
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
    # Drawing — audio block, beat grid, dB meter, busy overlay
    # ------------------------------------------------------------------

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

        # Waveform extends edge-to-edge so its visible peaks line up
        # exactly with peak ticks and beat-grid lines (both drawn via
        # `audio_frame_to_doc_frame → _frame_to_x`). On very narrow
        # blocks we still leave a tiny inset to avoid drawing past
        # the body's border bitmap.
        clip_w = ax2 - ax1
        band_w = min(AUDIO_WF_INSET_PX, max(0, clip_w // 3))
        wf_x1 = ax1 + band_w
        wf_x2 = ax2 - band_w
        wf_y1 = ay1 + AUDIO_WF_INSET_Y
        wf_y2 = ay2 - AUDIO_WF_INSET_Y
        if wf_x2 <= wf_x1 or wf_y2 <= wf_y1 or track.peaks is None:
            return

        # Compute the audio-frame range that actually maps to the
        # currently-visible block, then slice the peak cache. The cache
        # is built once at import time at a fixed high resolution
        # (samples_per_column=256 — see AudioTrack.import_file). We
        # never rebuild during draw — that put a multi-hundred-ms
        # full-file scan into every zoom-drag tick, freezing the UI.
        doc      = c4d.documents.GetActiveDocument()
        fps      = self._doc_fps(doc)
        af0, af1 = track.audio_frames_for_visible_window(fps)
        block_pixels = max(1, wf_x2 - wf_x1)

        from sb_audio_peaks import slice_peaks
        peaks_slice, _col_offset = slice_peaks(track.peaks, af0, af1)
        if not peaks_slice:
            return

        # When the user drags the right edge past end-of-audio, the
        # block's pixel width is wider than the audio actually covers.
        # Project the audio's end (`af1`, already clamped to
        # `decoded.n_frames` by `audio_frames_for_visible_window`) to
        # a doc-frame and back to pixels — that's how many pixels the
        # waveform should ACTUALLY paint. The remainder (past end of
        # audio) draws as silence (centerline only) so the waveform
        # doesn't visually stretch to fill the extended block.
        end_df  = track.audio_frame_to_doc_frame(af1, fps)
        end_x   = self._frame_to_x(end_df, w)
        wf_audio_x2 = min(wf_x2, max(wf_x1, int(end_x)))
        audio_pixels = max(1, wf_audio_x2 - wf_x1)

        # Downsample/upsample the slice to exactly audio_pixels columns
        # so 1 list entry = 1 pixel column of the audio portion. Cheap
        # nearest-neighbor pick.
        n = len(peaks_slice)
        if n != audio_pixels:
            scaled = [None] * audio_pixels
            for x in range(audio_pixels):
                scaled[x] = peaks_slice[(x * n) // audio_pixels]
            peaks_slice = scaled

        # Waveform render — gated on the per-track `waveform_visible`
        # toggle. When hidden, the audio body and edge handles still
        # paint; only the waveform line itself is suppressed. Peak
        # ticks and beat grid have their own independent toggle
        # (`analysis_visible`).
        if track.waveform_visible:
            # Waveform color depends on selection state. The selected
            # body bitmap is bright kelly green, which washes out the
            # dim white-blend used on the unselected (dark teal) body.
            # Switch to a dark-on-green color when selected so the
            # waveform stays legible.
            wf_color = COL_AUDIO_WAVEFORM_SEL if self._audio_selected else COL_AUDIO_WAVEFORM
            draw_waveform(self,
                          peaks_slice,
                          (wf_x1, wf_y1, wf_audio_x2, wf_y2),
                          fg_rgb=wf_color,
                          mid_rgb=COL_AUDIO_CENTERLINE,
                          x_offset=0)
            # Past end-of-audio: draw the centerline only (silence)
            # so the block reads as "no audio here" rather than a
            # stretched repeat of the last peaks. Skipped when the
            # block ends at end-of-audio (the common case).
            if wf_audio_x2 < wf_x2:
                cy = (wf_y1 + wf_y2) // 2
                self.DrawSetPen(COL_AUDIO_CENTERLINE)
                self.DrawLine(wf_audio_x2, cy, wf_x2, cy)

        # v9 prominent-peak ticks. Skipped fast when the user has
        # analysis toggled off — we still keep the data on the
        # AudioTrack so re-toggling on doesn't require re-analyzing.
        # Wrapped in try/except so a bug in the overlay doesn't kill
        # the rest of the draw (the rail + playhead are painted after
        # this and need to render even when the overlay fails).
        if track.analysis_visible:
            try:
                self._draw_audio_overlay(track, ax1, ay1, ax2, ay2)
            except Exception as e:
                print("[Shotblocks] audio-overlay draw failed: {}".format(e))

        # Label — file basename, top-left of the block.
        try:
            base = os.path.basename(track.path) or "audio"
        except Exception:
            base = "audio"
        # `_TEXT_BG_TRANS` lives on the canvas module; use a transparent
        # bg when available so the label glyphs don't paint over the
        # bitmap's rounded corners. Falls back to body color when not.
        from sb_canvas import _TEXT_BG_TRANS
        self.DrawSetTextCol(COL_AUDIO_LABEL, _TEXT_BG_TRANS or body_color)
        self.DrawText(base, ax1 + 6, ay1 + 4)

    def _draw_db_meter(self, w, h):
        """Premiere/FCP-style stereo dB meter on the right edge.

        Two narrow vertical bars side-by-side (L and R), filled
        bottom-up from -60 dBFS to the current dBFS reading, with a
        green→yellow→red gradient. A horizontal yellow tick marks the
        peak-hold (highest level reached recently, decaying at
        PEAK_HOLD_DECAY_DB_S per second). A dB scale runs along the
        right side at 6 dB intervals.

        Reads from `AudioTrack.meter_levels_at(audio_frame)` where
        `audio_frame` is derived from the current playhead position.
        Falls back to FLOOR_DBFS when the playhead sits outside the
        clip's audio range.
        """
        FLOOR_DBFS = METER_FLOOR_DBFS

        bounds = self._meter_panel_x_bounds(w)
        if bounds is None:
            return
        panel_x1, panel_x2 = bounds

        track = self._audio_track
        # Read levels at the playhead. The doc-frame → audio-frame
        # conversion lives on AudioTrack already (used for playback
        # sync). Returns -1 when playhead is outside the clip.
        doc = c4d.documents.GetActiveDocument()
        fps = self._doc_fps(doc) if doc is not None else 24
        af = track.doc_frame_to_audio_frame(self.playhead_frame, fps)
        if af >= 0:
            levels = track.meter_levels_at(af)
        else:
            # Playhead outside the clip — meter is silent.
            env = track.meter_envelope
            n_ch = env.n_channels if env is not None else 0
            levels = [FLOOR_DBFS] * n_ch
        if not levels:
            return

        n_ch = len(levels)
        # Reset all per-channel state when the channel count changes
        # (new audio import with a different layout).
        if (len(self._peak_hold_db) != n_ch
                or len(self._meter_displayed_db) != n_ch):
            self._peak_hold_db       = [FLOOR_DBFS] * n_ch
            self._meter_displayed_db = [FLOOR_DBFS] * n_ch
            self._meter_anim_t       = _monotonic()

        # Per-frame state advance. Two animations run in parallel:
        #   - Bar level: tracks the live envelope during playback OR
        #     while the playhead is moving (scrub). Decays toward
        #     FLOOR_DBFS at METER_PAUSE_DECAY_DB_S/sec when the
        #     playhead has been stationary. Distinguishing scrub from
        #     pause via "did the frame change since last draw" lets
        #     scrubbing show live levels without a separate flag.
        #   - Peak-hold tick: holds the highest recent bar level and
        #     decays at PEAK_HOLD_DECAY_DB_S.
        now = _monotonic()
        dt = max(0.0, now - self._meter_anim_t)
        self._meter_anim_t = now
        is_playing = bool(self._playing)
        playhead_moved = (self.playhead_frame != self._meter_last_playhead)
        self._meter_last_playhead = self.playhead_frame
        meter_live = is_playing or playhead_moved
        for ch in range(n_ch):
            target = levels[ch]
            displayed = self._meter_displayed_db[ch]
            if meter_live:
                # Snap to the envelope value during playback or scrub.
                # Visually the meter "is" the audio at the current
                # playhead frame.
                displayed = target
            else:
                # Stopped + playhead stationary — decay from whatever
                # was last shown toward FLOOR_DBFS so the bars don't
                # sit frozen on a loud value.
                displayed -= METER_PAUSE_DECAY_DB_S * dt
                if displayed < FLOOR_DBFS:
                    displayed = FLOOR_DBFS
            self._meter_displayed_db[ch] = displayed

            # Peak hold: held value can only decrease via decay, snaps
            # up when current level rises. Tracks the displayed bar
            # level (not the raw envelope) so the held tick reflects
            # what the user actually saw.
            held = self._peak_hold_db[ch]
            if displayed > held:
                held = displayed
            else:
                held -= PEAK_HOLD_DECAY_DB_S * dt
                if held < displayed:
                    held = displayed
            if held < FLOOR_DBFS:
                held = FLOOR_DBFS
            self._peak_hold_db[ch] = held

        # Panel bg.
        self.DrawSetPen(_rgb("1a1a1a"))
        self.DrawRectangle(panel_x1, 0, panel_x2, h)
        # Left border line on the panel — same color as the rail
        # border on the canvas side. Hardcoded here rather than
        # imported so the audio module doesn't reach into canvas
        # styling for one shade of dark gray.
        self.DrawSetPen(_rgb("2a2a2a"))
        self.DrawLine(panel_x1, 0, panel_x1, h)

        # Bars area: top of the bars at RIGHT_METER_TOP_PAD, bottom
        # at h - RIGHT_METER_BOT_PAD. Y maps linearly: top = 0 dB,
        # bottom = FLOOR_DBFS. RIGHT_METER_TOP_PAD is derived from
        # canvas-level layout constants (range bar + ruler heights)
        # via `_meter_top_pad`.
        bars_y_top = self._meter_top_pad()
        bars_y_bot = h - RIGHT_METER_BOT_PAD
        if bars_y_bot - bars_y_top < 20:
            return  # not enough vertical room to draw a meaningful meter
        bars_h = bars_y_bot - bars_y_top

        # Stack the bars on the LEFT of the panel; dB scale labels
        # live to the right of them. Total bar block width:
        #   n_ch bars + (n_ch - 1) gaps.
        bars_total_w = n_ch * RIGHT_METER_BAR_W + (n_ch - 1) * RIGHT_METER_BAR_GAP
        bars_x0 = panel_x1 + RIGHT_METER_PAD_X
        bars_x_end = bars_x0 + bars_total_w

        # Fill each bar.
        for ch in range(n_ch):
            bx1 = bars_x0 + ch * (RIGHT_METER_BAR_W + RIGHT_METER_BAR_GAP)
            bx2 = bx1 + RIGHT_METER_BAR_W

            # Black bar background (the "headroom" zone above the level).
            self.DrawSetPen(_rgb("0a0a0a"))
            self.DrawRectangle(bx1, bars_y_top, bx2, bars_y_bot)

            # Gradient fill from the bottom up to the displayed level
            # (which during playback equals the envelope, after pause
            # decays toward FLOOR_DBFS — see the per-frame update above).
            cur_db = self._meter_displayed_db[ch]
            level_y = db_to_y(cur_db, bars_y_top, bars_y_bot)
            # Draw row-by-row so each pixel row gets a color matching
            # its dB. Iterating bars_y_bot → level_y. Per-row pen set
            # is a few hundred calls per frame at typical dialog sizes
            # — fine for the meter's update cadence.
            row = bars_y_bot - 1
            while row >= level_y:
                row_db = y_to_db(row, bars_y_top, bars_y_bot)
                self.DrawSetPen(meter_color_for_db(row_db))
                self.DrawLine(bx1, row, bx2 - 1, row)
                row -= 1

            # Peak-hold tick: thin yellow line at the held dB.
            held_db = self._peak_hold_db[ch]
            if held_db > FLOOR_DBFS:
                hold_y = db_to_y(held_db, bars_y_top, bars_y_bot)
                self.DrawSetPen(meter_color_for_db(held_db))
                self.DrawLine(bx1, hold_y, bx2 - 1, hold_y)

        # dB scale on the right side of the panel.
        self.DrawSetTextCol(_rgb("9a9a9a"), _rgb("1a1a1a"))
        scale_x = bars_x_end + 4
        for db in RIGHT_METER_LABELS_DB:
            ty = db_to_y(db, bars_y_top, bars_y_bot)
            label = "{:d}".format(db) if db != 0 else "0"
            # Tick mark.
            self.DrawSetPen(_rgb("5a5a5a"))
            self.DrawLine(bars_x_end, ty, scale_x - 1, ty)
            # Label.
            self.DrawSetTextCol(_rgb("9a9a9a"), _rgb("1a1a1a"))
            self.DrawText(label, scale_x, ty - 5)
        # "dB" label at the bottom.
        self.DrawText("dB", scale_x, bars_y_bot - 12)

    def _meter_top_pad(self):
        """Top inset of the dB meter bars. Pulled from canvas-level
        layout constants so the meter's top edge lines up with the
        bottom of the ruler. Module-level value in the original
        canvas was the literal `RANGE_HEIGHT + RULER_HEIGHT + 4`.
        """
        from sb_canvas import RANGE_HEIGHT, RULER_HEIGHT
        return RANGE_HEIGHT + RULER_HEIGHT + 4

    def _draw_busy_overlay(self, w, h, label):
        """Paint a static status panel near the canvas center while a
        long blocking action is in progress.

        v9 analysis runs on a worker thread that needs the GIL to
        itself — any per-tick redraw on the main thread starves the
        worker (verified: 60 fps timer turned a 10s analysis into 60s).
        So the panel paints once when the work starts and once when
        it finishes; no animation between.
        """
        from sb_canvas import LEFT_RAIL_WIDTH, COL_ACCENT
        pw = 240
        ph = 44
        cx = (LEFT_RAIL_WIDTH + w) // 2
        cy = h // 2
        x1 = cx - pw // 2
        y1 = cy - ph // 2
        x2 = x1 + pw
        y2 = y1 + ph

        self.DrawSetPen(_rgb("1c1c1c"))
        self.DrawRectangle(x1, y1, x2, y2)
        self.DrawSetPen(COL_ACCENT)
        self.DrawLine(x1, y1, x2, y1)
        self.DrawLine(x1, y2, x2, y2)
        self.DrawLine(x1, y1, x1, y2)
        self.DrawLine(x2, y1, x2, y2)

        self.DrawSetTextCol(_rgb("e0e0e0"), _rgb("1c1c1c"))
        text_w = self.DrawGetTextWidth(label)
        self.DrawText(label, cx - text_w // 2, cy - 6)

    def _draw_beat_grid(self, w, h):
        """Draw the beat grid as faint dashed vertical lines that span
        the full canvas (rail-right edge to right border, ruler-bottom
        to canvas-bottom). The lattice anchors to the audio track —
        moving / trimming the audio shifts the grid via the same
        `audio_frame_to_doc_frame` math the peak ticks use, which is
        why it must be called only when an audio track is loaded.

        Dashing is done by drawing 4-px segments with 4-px gaps. C4D
        2026's DrawLine doesn't support dash styles directly, so we
        chunk each vertical line into segments. A 173 BPM track over
        a 1000-frame project yields maybe ~10 visible beats at typical
        zoom; the inner segment loop is cheap.
        """
        from sb_canvas import LEFT_RAIL_WIDTH, RANGE_HEIGHT, RULER_HEIGHT
        track = self._audio_track
        grid  = track.beat_grid
        if grid is None:
            return
        period_af, phase_af, _conf = grid
        if period_af <= 0:
            return

        doc = c4d.documents.GetActiveDocument()
        fps = self._doc_fps(doc)
        # Vertical span: from the bottom of the ruler to the bottom of
        # the canvas. Skip the range bar + ruler area (they own that
        # band) so the grid doesn't fight the ruler labels.
        gy_top = RANGE_HEIGHT + RULER_HEIGHT
        gy_bot = h
        x_left = LEFT_RAIL_WIDTH
        x_right = w

        # Visible doc-frame range. We expand by one period on each
        # side so the off-screen grid lines just past the edges still
        # render without sudden pop-in when the user pans.
        vis_first = self.visible_first
        vis_last  = self.visible_last
        if vis_last <= vis_first:
            return

        # Convert a couple of audio-frame anchor points to doc-frames
        # so we can derive the grid's doc-frame period and phase
        # without recomputing per beat. Using two anchors at distance
        # `period_af` is exact regardless of fractional fps/sr ratio.
        df_phase = track.audio_frame_to_doc_frame(phase_af, fps)
        df_phase_plus = track.audio_frame_to_doc_frame(phase_af + period_af, fps)
        period_df = df_phase_plus - df_phase
        if period_df <= 0:
            return

        # Adaptive density: when the timeline is zoomed out enough that
        # adjacent beats land closer than MIN_BEAT_PX pixels apart, draw
        # only every Nth beat. N doubles each step (1 → 2 → 4 → 8 …) so
        # the visible grid stays a clean subdivision of the underlying
        # beats — drumming-friendly when the user zooms in/out.
        MIN_BEAT_PX = 12
        fpp = self._frames_per_pixel(w) or 1.0
        period_px = period_df / fpp
        stride = 1
        while period_px * stride < MIN_BEAT_PX:
            stride *= 2

        # First k such that (k * period_df + df_phase) >= vis_first.
        # Snap k_lo to the stride so we draw whichever beats fall on
        # the chosen subdivision (k = 0, stride, 2*stride, …); without
        # this, the visible grid would shift back and forth as the
        # user pans across stride boundaries.
        k_lo = int(math.floor((vis_first - df_phase) / period_df))
        k_hi = int(math.ceil((vis_last  - df_phase) / period_df))
        # Round k_lo DOWN to the nearest stride multiple so the
        # subdivision is stable across pans. floor-division on
        # negatives in Python rounds toward -∞, which is what we want.
        k_lo = (k_lo // stride) * stride

        # Round each beat to an int doc-frame the SAME way `_snap_extras`
        # rounds its grid targets. Without this, a beat draws at the
        # exact float position (e.g. doc-frame 17.4 → pixel column N)
        # but its snap target rounds to int (17 → pixel column N-1 or
        # N+1 depending on zoom). The visible "sometimes left,
        # sometimes right" jitter goes away when both paths use the
        # same int.
        self.DrawSetPen(COL_BEAT_GRID)
        DASH_ON  = 4
        DASH_OFF = 4
        for k in range(k_lo, k_hi + 1, stride):
            df_int = int(round(df_phase + k * period_df))
            x = self._frame_to_x(df_int, w)
            if x < x_left or x > x_right:
                continue
            # Draw the line as alternating 4 px on / 4 px off segments.
            y = gy_top
            while y < gy_bot:
                seg_end = min(y + DASH_ON, gy_bot)
                self.DrawLine(x, y, x, seg_end)
                y = seg_end + DASH_OFF

    def _draw_audio_overlay(self, track, ax1, ay1, ax2, ay2):
        """Draw v9 prominent-peak ticks on the audio block.

        Beat grid is NOT drawn here — it lives in `_draw_beat_grid`
        which fires once at the start of DrawMsg, behind shots and
        the audio block (so the grid spans the full canvas, not just
        the audio body).

        Tick x position is computed via the SAME projection as
        `_snap_extras` and the snap matcher: audio-frame →
        doc-frame → `_frame_to_x`. This is what makes a snapped
        clip edge land *exactly* under a peak tick. The earlier
        approach interpolated inside the waveform inset
        (`wf_x1..wf_x2`), which placed ticks ~`band_w` pixels off
        from the snap-target position; clips would snap to the
        peak's doc-frame but the visible tick sat to the right.

        The trade is that ticks may drift a few pixels off the
        underlying waveform peak (because the waveform itself is
        still drawn inside the inset). That's the right call —
        the tick's authoritative function is "this is where a
        snap will land", not "this is where the waveform crests."
        """
        if not track.prominent_peaks:
            return
        doc = c4d.documents.GetActiveDocument()
        fps = self._doc_fps(doc)
        w = self.GetWidth()
        # Pick the peak marker variant matching the audio block's
        # selection state. The selected variant is flattened against
        # the bright kelly green; the normal variant against the dim
        # green. Falls back to the normal bitmap if the selected one
        # didn't load.
        if self._audio_selected:
            bmp = (self._chrome_bitmaps.get("peak-selected")
                   or self._chrome_bitmaps.get("peak"))
        else:
            bmp = self._chrome_bitmaps.get("peak")

        # Each peak rounds to an int doc-frame the SAME way `_snap_extras`
        # computes its targets (`int(round(audio_frame_to_doc_frame))`).
        # Drawing from that int ensures the marker lands on the exact
        # pixel column a snap will pull to — no 0..1 frame jitter
        # between visual and snap as zoom or trim shifts the float
        # projection.
        if bmp is not None:
            src_w = bmp.GetBw()
            src_h = bmp.GetBh()
            # Scale to a fixed target height, width preserves aspect.
            # Source can be authored at any reasonable size.
            if src_h > 0:
                out_h = PEAK_MARKER_BITMAP_H
                out_w = max(1, int(round(src_w * out_h / float(src_h))))
            else:
                out_w, out_h = src_w, src_h
            marker_y = ay1 + 1
            for af in track.prominent_peaks:
                df_int = int(round(track.audio_frame_to_doc_frame(af, fps)))
                x = self._frame_to_x(df_int, w)
                if x < ax1 or x > ax2:
                    continue
                try:
                    self.DrawBitmap(bmp, x - out_w // 2, marker_y, out_w, out_h,
                                    0, 0, src_w, src_h,
                                    c4d.BMP_NORMALSCALED | c4d.BMP_ALLOWALPHA)
                except Exception as e:
                    print("[Shotblocks] peak bitmap draw failed: {}".format(e))
                    bmp = None
                    break
        if bmp is None:
            # Procedural fallback: 2-px vertical tick.
            self.DrawSetPen(COL_AUDIO_PEAK_TICK)
            tick_y1 = ay1 + 1
            tick_y2 = ay1 + 13
            for af in track.prominent_peaks:
                df_int = int(round(track.audio_frame_to_doc_frame(af, fps)))
                x = self._frame_to_x(df_int, w)
                if x < ax1 or x > ax2:
                    continue
                self.DrawLine(x,     tick_y1, x,     tick_y2)
                self.DrawLine(x + 1, tick_y1, x + 1, tick_y2)

    # ------------------------------------------------------------------
    # Hit-test + drag handlers
    # ------------------------------------------------------------------

    def _hit_test_audio(self, x, y, w):
        """Return None, ('audio', 'left'|'right'|'body') for clicks on
        the audio block. Used by left-press to dispatch to the right
        drag handler."""
        from sb_canvas import EDGE_HIT_PX
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
        from sb_canvas import _KEY_MLEFT
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
        from sb_canvas import _KEY_MLEFT
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

    # ------------------------------------------------------------------
    # Delete (selection-aware; canvas dispatches here when the audio
    # block owns the selection or when the audio menu item fires).
    # ------------------------------------------------------------------

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

    # ------------------------------------------------------------------
    # Analyse (v9 onset detection) — rail-button + hotkey handlers
    # ------------------------------------------------------------------

    def _on_analyse_click(self):
        """Rail-button click handler for analyse. Three states:

        - **No audio loaded.** Print and return. The user clicked a
          button that's effectively disabled.
        - **No analysis data yet.** Run analysis (which is itself
          slow — uses the busy overlay and worker thread) and flip
          `analysis_visible = True` once results land. The `True`
          flip is tied to the worker-completion handler so a click
          while results are arriving doesn't get overwritten.
        - **Analysis data exists.** Pure toggle: flip
          `analysis_visible` and persist immediately. No re-run.
          The user's existing markers stay alive; only the canvas
          visibility changes.

        Hotkey (Ctrl+Shift+A) routes through the same method so the
        toggle/run logic stays in one place.
        """
        track = self._audio_track
        if track.decoded is None:
            print("[Shotblocks] analyse: no audio loaded")
            return
        # Has analysis already been run?
        already_have_data = bool(track.prominent_peaks
                                 or track.onsets
                                 or track.beat_grid)
        if already_have_data:
            doc = c4d.documents.GetActiveDocument()
            track.analysis_visible = not track.analysis_visible
            try:
                doc.StartUndo()
                track._persist_current(doc)
                doc.EndUndo()
            except Exception as e:
                print("[Shotblocks] analyse toggle persist failed: {}".format(e))
                try:
                    doc.EndUndo()
                except Exception:
                    pass
            print("[Shotblocks] analysis visible = {}".format(track.analysis_visible))
            c4d.EventAdd()
            self.Redraw()
            return
        # First run on this audio — kick off the worker.
        self._analyse_audio()

    def _on_waveform_click(self):
        """Rail-button click handler for the waveform toggle. Flips
        `track.waveform_visible` and persists immediately. No-op when
        no audio is loaded. Cmd+Z reverts the toggle along with any
        other helper-null change captured in the same undo step."""
        track = self._audio_track
        if track.decoded is None:
            print("[Shotblocks] waveform toggle: no audio loaded")
            return
        doc = c4d.documents.GetActiveDocument()
        track.waveform_visible = not track.waveform_visible
        try:
            doc.StartUndo()
            track._persist_current(doc)
            doc.EndUndo()
        except Exception as e:
            print("[Shotblocks] waveform toggle persist failed: {}".format(e))
            try:
                doc.EndUndo()
            except Exception:
                pass
        print("[Shotblocks] waveform visible = {}".format(track.waveform_visible))
        c4d.EventAdd()
        self.Redraw()

    def _analyse_audio(self):
        """Run v9 onset detection on the current audio track.

        Called by `_on_analyse_click` only when there's no analysis
        data yet (subsequent clicks just toggle visibility). Sets
        `analysis_visible = True` on success so the data is shown
        as soon as it lands.

        Wraps in StartUndo/EndUndo so Cmd+Z reverts the analysis
        write — the helper-null write inside `_persist_current` will
        register a single AddUndo on the helper.
        """
        if self._audio_track.decoded is None:
            print("[Shotblocks] analyse: no audio loaded")
            return
        if self._analysis_thread is not None and self._analysis_thread.is_alive():
            # Already analysing — let the existing worker finish.
            return

        # Two-phase start so the busy panel paints BEFORE the worker
        # steals the GIL. Phase 1 (this method): set the label,
        # request a redraw, and post a deferred event back to
        # ourselves. Phase 2 (the deferred handler, on the next event-
        # loop tick): actually start the worker thread. Without this
        # split the worker grabs the GIL before C4D services the
        # queued DrawMsg, and the user sees a blank ~1s pause before
        # the panel appears.
        self._busy_label      = "Analysing audio…"
        self._busy_started_t  = _monotonic()
        self._analysis_result = None
        self._analysis_error  = None
        self._analysis_pending_start = True

        # Trigger a paint, then poke ourselves so CoreMessage spawns
        # the worker on the *next* tick — after C4D has had a chance
        # to dispatch the redraw.
        self.Redraw()
        evt_id = self._analysis_complete_event_id
        if evt_id:
            try:
                c4d.SpecialEventAdd(evt_id)
            except Exception:
                # Fallback: spawn immediately. The popup-paint delay
                # comes back, but analysis still works.
                self._spawn_analysis_worker()

    def _spawn_analysis_worker(self):
        """Phase 2 of analysis kickoff. Spawns the worker thread.

        Called from `_poll_analysis_thread` when it sees
        `_analysis_pending_start = True` — i.e. one event tick after
        `_analyse_audio` posted the deferred SpecialEventAdd. The
        intervening tick gave C4D time to paint the busy panel.
        """
        if not self._analysis_pending_start:
            return
        self._analysis_pending_start = False

        decoded = self._audio_track.decoded
        mono    = self._audio_track.mono
        # The drum-band signal is heavy to build (~5-8 s biquad pass
        # over the source-rate mono). Build it INSIDE the worker so
        # the main thread stays responsive while the busy panel
        # animates. Cached on the AudioTrack for subsequent analyses.
        track = self._audio_track
        complete_event_id = self._analysis_complete_event_id

        def _worker():
            try:
                # Lazy build of the drum-band buffer; fine off-thread
                # because it only reads `decoded` / `mono` (both
                # immutable from this point) and writes one private
                # cache slot on the AudioTrack.
                peak_signal = track.drum_band
                onsets, peaks, grid, elapsed = analyse_audio(
                    decoded, mono=mono, peak_signal=peak_signal)
                self._analysis_result = (onsets, peaks, grid, elapsed)
            except Exception as e:
                self._analysis_error = e
            # Wake the main thread on completion.
            if complete_event_id:
                try:
                    c4d.SpecialEventAdd(complete_event_id)
                except Exception:
                    pass

        t = threading.Thread(target=_worker, name="shotblocks-analyse",
                             daemon=True)
        self._analysis_thread = t
        t.start()

    def _poll_analysis_thread(self):
        """Main-thread handler for analysis events.

        Called from `CoreMessage(PLUGIN_ID_COMMAND, …)` for two
        distinct reasons (we tell them apart by what state we're in):

        1. **Pending start.** `_analyse_audio` set the busy label,
           triggered a redraw, and posted a SpecialEventAdd so this
           handler would fire one tick later — by which time the
           busy panel has painted. This branch spawns the worker
           thread.
        2. **Completion.** Worker thread finished and posted its own
           SpecialEventAdd. By the time we're here the worker has
           exited and populated `_analysis_result` or
           `_analysis_error`. We drain the result onto the
           AudioTrack, persist with undo, clear the busy overlay,
           and redraw.
        """
        # Phase 2 of the two-phase start: panel has painted, kick
        # off the worker now.
        if self._analysis_pending_start:
            self._spawn_analysis_worker()
            return

        thr = self._analysis_thread
        if thr is None and self._busy_label is None:
            return
        # Worker is done OR was already cleaned up but the busy
        # overlay is still set from the previous tick. Either way:
        # commit results (if any), tear down the overlay, redraw.
        if thr is not None:
            self._analysis_thread = None  # let GC drop the Thread
            err = self._analysis_error
            res = self._analysis_result
            self._analysis_error = None
            self._analysis_result = None
            if err is not None:
                print("[Shotblocks] analyse worker raised: {}".format(err))
            elif res is not None:
                onsets, peaks, grid, elapsed = res
                track = self._audio_track
                track.onsets          = onsets
                track.prominent_peaks = peaks
                track.beat_grid       = grid
                # First successful run flips visibility on so the
                # user sees the markers immediately. Subsequent
                # button clicks toggle without going through this
                # path (they go through `_on_analyse_click`'s
                # already-have-data branch).
                track.analysis_visible = True

                # Persist on the main thread with undo bracketing.
                doc = c4d.documents.GetActiveDocument()
                try:
                    doc.StartUndo()
                    track._persist_current(doc)
                    doc.EndUndo()
                except Exception as e:
                    print("[Shotblocks] analyse persist failed: {}".format(e))
                    try:
                        doc.EndUndo()
                    except Exception:
                        pass

                bpm = None
                conf = 0.0
                if grid is not None:
                    period, _phase, conf = grid
                    if period > 0:
                        bpm = 60.0 * track.decoded.sample_rate / float(period)
                print("[Shotblocks] audio analysed: {} onsets, {} peaks, "
                      "{} ({:.2f}s, conf {:.2f})".format(
                          len(onsets), len(peaks),
                          "~{:.0f} BPM".format(bpm) if bpm else "no grid",
                          elapsed, conf))
                # Log peak timestamps so the user can compare against
                # the song. Format: chunks of 8 per line, mm:ss.cc.
                # Wraps in print so the indent reads cleanly in the
                # C4D console; "1:23.45" is short enough that 8 fit.
                if peaks:
                    sr = track.decoded.sample_rate
                    def _ts(af):
                        s = af / float(sr)
                        return "{:d}:{:05.2f}".format(int(s // 60), s % 60)
                    timestamps = [_ts(af) for af in peaks]
                    print("[Shotblocks] peak times:")
                    for i in range(0, len(timestamps), 8):
                        print("    " + "  ".join(timestamps[i:i+8]))
                # One-shot debug: log the snap-target counts so a
                # user reporting "snap doesn't work" has data to
                # share. Cheap (only fires on completion).
                try:
                    n_extras = len(self._snap_extras())
                    print("[Shotblocks] snap targets active: {} "
                          "(includes playhead + audio edges + peaks + grid)".format(
                              n_extras))
                except Exception as e:
                    print("[Shotblocks] snap-targets log failed: {}".format(e))
                c4d.EventAdd()
        # Tear down overlay and force a final redraw so the markers
        # appear in the same paint as the overlay disappears.
        self._busy_label = None
        self.Redraw()

    # ------------------------------------------------------------------
    # Waveform peak-cache zoom rebuild (background, debounced)
    # ------------------------------------------------------------------

    PEAK_REBUILD_DEBOUNCE_S = 0.25

    def _request_peak_rebuild(self):
        """Mark that a peak-cache rebuild should run after the debounce
        window. Called from every zoom-changing code path. Safe to
        call many times in rapid succession — only the most recent
        timestamp is used.

        Cheap no-op when no audio is loaded. Wakes the dialog timer
        so `_maybe_kick_peak_rebuild` runs each tick until the
        debounce elapses and the worker takes over.
        """
        if self._audio_track.decoded is None:
            return
        self._pending_peak_rebuild_t = _monotonic() + self.PEAK_REBUILD_DEBOUNCE_S
        dlg = self._playback_owner_dialog
        if dlg is not None and hasattr(dlg, "request_anim_tick"):
            dlg.request_anim_tick()

    def _maybe_kick_peak_rebuild(self):
        """Called from the dialog Timer each tick. When the debounce
        elapsed and no rebuild is currently running, spawn the
        worker thread.

        The worker captures the target samples_per_column at spawn
        time, so if the user keeps zooming the rebuild uses the
        latest zoom state. While the worker runs, additional zoom
        events post new debounce timestamps but the kick is
        suppressed (worker.is_alive()) — when this worker finishes,
        the next tick re-evaluates and kicks a fresh worker if the
        zoom has changed enough to matter.
        """
        if self._pending_peak_rebuild_t <= 0.0:
            return
        if _monotonic() < self._pending_peak_rebuild_t:
            return
        # Debounce elapsed. Don't stack workers — if one is in flight,
        # leave the pending timestamp; we'll re-check next tick.
        if (self._peak_rebuild_thread is not None
                and self._peak_rebuild_thread.is_alive()):
            return

        track = self._audio_track
        if track.decoded is None or track.peaks is None:
            self._pending_peak_rebuild_t = 0.0
            return

        target_spc = target_samples_per_column(self)
        # Cheap escape: skip if the current cache is already a close
        # match (within ~1% — see `should_rebuild`).
        from sb_audio_peaks import should_rebuild
        if not should_rebuild(track.peaks, target_spc):
            self._pending_peak_rebuild_t = 0.0
            return

        decoded = track.decoded
        complete_event_id = self._peak_rebuild_event_id
        self._pending_peak_rebuild_t = 0.0

        def _worker():
            try:
                from sb_audio_peaks import build as build_peaks
                new_cache = build_peaks(decoded, samples_per_column=target_spc)
                self._peak_rebuild_result = new_cache
            except Exception as e:
                print("[Shotblocks] peak-rebuild worker raised: {}".format(e))
                self._peak_rebuild_result = None
            if complete_event_id:
                try:
                    c4d.SpecialEventAdd(complete_event_id)
                except Exception:
                    pass

        t = threading.Thread(target=_worker, name="shotblocks-peaks",
                             daemon=True)
        self._peak_rebuild_thread = t
        t.start()

    def _drain_peak_rebuild(self):
        """Main-thread completion handler for the peak-rebuild worker.
        Triggered by SpecialEventAdd → CoreMessage(PLUGIN_ID_TAG).
        Swaps the new cache onto the AudioTrack and redraws."""
        result = self._peak_rebuild_result
        self._peak_rebuild_result = None
        self._peak_rebuild_thread = None
        if result is None:
            return
        track = self._audio_track
        if track.decoded is None:
            return
        track.peaks = result
        self.Redraw()
