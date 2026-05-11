"""Shotblocks playback canvas mixin.

The spacebar-driven playback engine — `_toggle_playback` (start / stop),
`_playback_tick` (per-Timer-tick advance), `_route_camera_for_frame`
(switch the active BaseDraw's camera to the active shot's source camera
and drive the v10 rig pipeline), and `_set_playhead_with_playback_resync`
(re-anchor the wall-clock video clock when the playhead jumps mid-scrub).
Pulled out of `sb_canvas.py` for code-locality alongside the audio,
drawing, and drag mixins.

`ShotblocksTimelineCanvas` inherits `PlaybackCanvasMixin` so all the
methods here see the same `self` as the rest of the canvas: the
`playhead_frame` shared with the drawing / drag / audio clusters,
`_doc_fps` and `_audio_track` / `_audio_playback` from the audio
mixin, the dialog reference at `_playback_owner_dialog` set after
AttachUserArea, etc. all stay one attribute lookup away. The split
exists for code-locality, not for any runtime independence.

The hover-fade `_anim_tick` rides the same dialog Timer as
`_playback_tick` but is its own concern — it stays on the canvas.

Module-top canvas constants are lazy-imported inside method bodies as
needed — same approach the audio / drawing / drag mixins use for
sb_canvas-owned constants. (None of the four playback methods touch
canvas-top constants today; `_route_camera_for_frame`'s rig hookup
lazy-imports `sb_rig_tag` only when a shot is actually active.)
"""

from time import monotonic as _monotonic

import c4d

from sb_persistence import _read_shots, _read_range, _get_shot_cam
from sb_shot_model  import _active_shot_at


# ---------------------------------------------------------------------------
# Playback canvas mixin — spacebar play/pause, the per-tick video clock,
# the active-camera router, and the playhead-resync helper.
# ---------------------------------------------------------------------------

class PlaybackCanvasMixin(object):
    """Playback-engine methods + per-instance playback state for the
    timeline canvas.

    `ShotblocksTimelineCanvas` inherits this. The mixin assumes `self`
    is a canvas instance with the rest of the canvas's helpers
    available (`playhead_frame`, `_doc_fps`, `_audio_track`,
    `_audio_playback`, plus the `_playback_owner_dialog` reference
    the dialog sets after AttachUserArea).
    """

    # ------------------------------------------------------------------
    # Per-instance state — call from the canvas's __init__.
    # ------------------------------------------------------------------

    def _playback_init_state(self):
        """Initialize per-instance playback state. Call from the canvas's
        `__init__` so a fresh canvas starts paused, with no dialog timer
        owner attached yet (the dialog assigns `_playback_owner_dialog`
        right after `AttachUserArea`), the toggle debounce clock at zero,
        loop-on-cycle enabled (matches the toolbar checkbox default),
        and no remembered active-shot id (so the first
        `_route_camera_for_frame` call after open treats any shot as a
        fresh transition and resets the rig spring cleanly).
        """
        # _playback_owner_dialog is set by the dialog right after
        # AttachUserArea — the canvas asks the dialog to start/stop
        # its Timer rather than owning timer mechanics itself.
        # _loop_enabled is the Shotblocks-owned cycle toggle (the
        # toolbar checkbox); on by default so playback feels alive
        # on first launch.
        self._playing               = False
        self._playback_owner_dialog = None
        self._last_play_toggle_t    = 0.0
        self._loop_enabled          = True

        # Tracks which shot was active on the last call to
        # _route_camera_for_frame. Used to detect hard-cut transitions
        # so the rig tag's spring state can be reset (no smoothing
        # across cuts; constitution principle 4).
        self._last_active_shot_id = None

    # ------------------------------------------------------------------
    # Playback (v6) — spacebar drives a doc-FPS Timer on the dialog
    # ------------------------------------------------------------------

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
        is the signal.

        Also drives the v10 rig pipeline:
        - At active-shot transitions (the shot id changed since last
          call), push the new shot's `rig_state` overrides into the
          tag's runtime cache and request a spring reset (hard cut →
          no smoothing across the cut, per constitution principle 4).
        - When the active shot stays the same but its `rig_state`
          changed, push the new overrides without resetting the
          spring.
        """
        shots, _ = _read_shots(doc)
        active = _active_shot_at(shots, frame)
        if active is None:
            self._last_active_shot_id = None
            return
        cam = _get_shot_cam(doc, active.get("id"))
        if cam is None:
            return
        try:
            bd = doc.GetActiveBaseDraw()
            if bd is not None:
                # Only write the BaseDraw camera when it actually
                # changed. Re-assigning the same camera every tick
                # forces C4D to revalidate its viewport state.
                cur_cam = bd[c4d.BASEDRAW_DATA_CAMERA]
                if cur_cam is not cam:
                    bd[c4d.BASEDRAW_DATA_CAMERA] = cam
        except Exception as e:
            print("[Shotblocks] BaseDraw camera set failed: {}".format(e))

        # v10 rig wiring: notify the Shotblocks tag (if any) on the
        # active camera about the shot transition and its overrides.
        try:
            from sb_rig_tag import (
                ShotblocksTag, push_overrides, request_reset,
            )
        except Exception:
            return
        tag = None
        try:
            t = cam.GetFirstTag()
            while t is not None:
                if isinstance(t.GetNodeData(), ShotblocksTag):
                    tag = t
                    break
                t = t.GetNext()
        except Exception:
            tag = None
        if tag is None:
            self._last_active_shot_id = active.get("id")
            return

        sid = active.get("id")
        prev_sid = getattr(self, "_last_active_shot_id", None)
        overrides = active.get("rig_state") or {}
        push_overrides(tag, overrides)
        if sid != prev_sid:
            # Hard cut. Snap the spring to the new target on its first
            # frame so there's no carry-over smoothing across the cut.
            request_reset(tag)
        self._last_active_shot_id = sid

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

        # Order matters: set camera FIRST, then time. If we set time
        # before camera, C4D can render the next frame with the new
        # time but the previous camera (the redraw races our camera
        # write). Setting camera first guarantees the very next render
        # reflects both changes together.
        self._route_camera_for_frame(doc, self.playhead_frame)
        try:
            doc.SetTime(c4d.BaseTime(self.playhead_frame, fps))
        except Exception as e:
            print("[Shotblocks] SetTime failed: {}".format(e))
        # EventAdd is required: without it C4D coalesces multiple
        # SetTime calls into a single scene evaluation, dropping
        # rig-tag Execute calls and causing visible stutter.
        c4d.EventAdd()
        self.Redraw()

    def _set_playhead_with_playback_resync(self, new_frame, fps,
                                            seek_audio=False):
        """Move the playhead to `new_frame` AND re-anchor playback so
        the next `_playback_tick` continues from there.

        Without re-anchoring, `_playback_tick` computes
        `playhead = anchor_frame + (now - anchor_t) * fps` from the
        ORIGINAL anchor. A scrub-induced playhead change would be
        overwritten on the very next tick because the elapsed time
        from the old anchor is unchanged. Re-anchoring resets that
        clock to "right now at the new frame."

        `seek_audio=False` (the drag-tick case): the audio keeps
        playing from wherever it was. The video clock follows the
        scrub smoothly; audio catches up on drag release. Reissuing
        audio per tick would call `_write_temp_wav` per tick
        (~tens of ms each) and stutter badly.

        `seek_audio=True` (commit on drag release / click): force a
        full audio re-issue at the new position. Costly but happens
        once per scrub gesture.
        """
        self.playhead_frame = new_frame
        if self._playing:
            self._playback_anchor_t     = _monotonic()
            self._playback_anchor_frame = new_frame
            if (seek_audio
                    and self._audio_track.decoded is not None
                    and self._audio_playback.is_playing()):
                target_af = self._audio_track.doc_frame_to_audio_frame(
                    new_frame, fps)
                if target_af < 0:
                    target_af = 0
                # `sync()` only reissues on BACKWARD jumps (its drift
                # heuristic). Scrubbing is an explicit seek — call
                # `play()` directly so forward scrubs reposition the
                # audio too.
                self._audio_playback.play(target_af)
