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

        # External-playback detection state. C4D 2026 Python doesn't
        # expose GetPlayMode, so we infer "C4D is playing natively"
        # from the EVMSG_TIMECHANGED cadence: consecutive +1 frame
        # deltas at roughly doc-fps means playback; non-+1 deltas
        # or a long gap means scrub or stop. When we detect external
        # playback start, we kick off audio once; when it stops, we
        # stop audio. _ext_last_frame is the frame on the previous
        # TIMECHANGED; _ext_last_t is its wall time;
        # _ext_consec_advances counts back-to-back +1 frames (need
        # a few before we commit to "playing"); _ext_playing tracks
        # whether we've issued audio.play() for the external session.
        self._ext_last_frame    = None
        self._ext_last_t        = 0.0
        self._ext_consec_advances = 0
        self._ext_playing       = False

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

        # If audio was playing because C4D was driving playback
        # natively, stop it before we kick off our own — otherwise
        # we'd have two streams running. Clearing the external-play
        # state also prevents the sync detector from racing us.
        if self._ext_playing:
            self._audio_playback.stop()
            self._ext_playing = False
        self._ext_consec_advances = 0
        self._ext_last_frame = None
        self._ext_last_t = 0.0

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
                # Reset every Shotblocks rig tag's spring state at the
                # loop boundary so accumulated bank / position /
                # rotation lag from end-of-range doesn't damp into the
                # next pass. Without this, a roll value or framing
                # offset tweaked mid-playback leaves the camera
                # banked, and the spring "settles" from that bank
                # toward zero over a few frames after the wrap —
                # visible as the horizon being non-level just after
                # the restart.
                self._reset_all_rig_tags(doc)
                # Force the next call to _route_camera_for_frame to
                # treat the wrap as a fresh shot transition too;
                # otherwise a same-camera same-shot wrap wouldn't
                # re-push overrides or re-call request_reset.
                self._last_active_shot_id = None
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

    def _sync_playhead_from_doc(self, doc):
        """Mirror C4D's current document time into our playhead.

        Called from the dialog's CoreMessage handler so the Shotblocks
        cursor follows C4D's native transport controls (play / pause
        / jump-to-start / jump-to-end / time-slider scrub). Returns
        True iff the playhead actually moved (caller can use this to
        skip a redundant redraw).

        Also infers whether C4D is in native playback (consecutive
        +1 frame advances) and drives audio playback accordingly —
        otherwise pressing C4D's play button would scrub the cursor
        silently. There's no GetPlayMode in C4D 2026 Python; cadence
        is the only signal.

        Skips the sync entirely during Shotblocks's own playback —
        _playback_tick is already driving the doc time, so reading it
        back would create a feedback loop. Also skips if the doc
        time is already at our playhead (the message fired for an
        unrelated mutation).
        """
        if doc is None or self._playing:
            return False
        try:
            fps = self._doc_fps(doc)
            doc_frame = int(doc.GetTime().GetFrame(fps))
        except Exception:
            return False
        if doc_frame == self.playhead_frame:
            return False

        prev_frame = self.playhead_frame
        self.playhead_frame = doc_frame
        # Route the camera so the viewport reflects the active shot at
        # the new frame, same as our own playback tick does.
        try:
            self._route_camera_for_frame(doc, doc_frame)
        except Exception:
            pass

        # External-playback detection. A +1 frame delta means C4D
        # might be playing; a few of them in a row commits us. Any
        # other delta (scrub jump, rewind, fast-fwd) breaks the run.
        now = _monotonic()
        delta = doc_frame - (self._ext_last_frame
                             if self._ext_last_frame is not None
                             else prev_frame)
        gap = now - self._ext_last_t if self._ext_last_t else 0.0
        # Cadence sanity: TIMECHANGED during native playback fires
        # at roughly doc-fps cadence; a gap > 2× the frame period is
        # a scrub pause, not playback.
        frame_period = 1.0 / max(1, fps)
        is_playback_tick = (delta == 1 and gap < frame_period * 3.0)
        if is_playback_tick:
            self._ext_consec_advances += 1
        else:
            self._ext_consec_advances = 0
        self._ext_last_frame = doc_frame
        self._ext_last_t = now

        # Two consecutive +1 ticks → commit to "external playback."
        # Kick audio once; it plays through Windows to end-of-clip
        # without further intervention. Calling play() again per
        # tick would rebuild the temp WAV file and stutter the audio.
        if self._ext_consec_advances >= 2 and not self._ext_playing:
            if self._audio_track.decoded is not None:
                target_af = self._audio_track.doc_frame_to_audio_frame(
                    doc_frame, fps)
                if target_af >= 0:
                    self._audio_playback.play(target_af)
                    self._ext_playing = True
                    # Keep the dialog Timer alive so we can detect
                    # the C4D pause (a stop produces NO event at all,
                    # so we have to poll for idleness).
                    dlg = self._playback_owner_dialog
                    if dlg is not None:
                        try:
                            dlg.request_anim_tick()
                        except Exception:
                            pass
        # A non-+1 tick (scrub, jump, or playback stopped) drops us
        # out of "external playback" mode; halt the audio that was
        # tracking it. Future +1 runs will start a fresh play().
        elif not is_playback_tick and self._ext_playing:
            self._audio_playback.stop()
            self._ext_playing = False

        return True

    def _reset_all_rig_tags(self, doc):
        """Snap every Shotblocks rig tag's spring state to its target
        on the next Execute. Called at loop boundaries so accumulated
        bank / position / rotation lag from end-of-range doesn't
        damp into the start of the next pass (visible as a non-level
        horizon for the first few frames after a wrap, when the user
        had been tweaking roll or framing mid-playback).

        Walks the doc once and tags every camera that carries a
        Shotblocks tag. Cheap — typically a handful of objects.
        """
        if doc is None:
            return
        try:
            from sb_rig_tag import ShotblocksTag, request_reset
        except Exception:
            return
        try:
            obj = doc.GetFirstObject()
        except Exception:
            return
        # Iterative depth-first walk to avoid recursion limits on
        # deep scene hierarchies.
        stack = []
        while obj is not None:
            try:
                t = obj.GetFirstTag()
                while t is not None:
                    if isinstance(t.GetNodeData(), ShotblocksTag):
                        request_reset(t)
                    t = t.GetNext()
            except Exception:
                pass
            child = None
            try:
                child = obj.GetDown()
            except Exception:
                pass
            if child is not None:
                stack.append(obj.GetNext())
                obj = child
            else:
                nxt = None
                try:
                    nxt = obj.GetNext()
                except Exception:
                    nxt = None
                while nxt is None and stack:
                    nxt = stack.pop()
                obj = nxt

    def _check_external_play_idle(self):
        """Polled by the dialog Timer while external audio is playing.

        When C4D's native play button stops, no event is emitted — the
        TIMECHANGED stream just halts. Our state machine can only
        detect that via the absence of ticks, so we sweep here: if it
        has been longer than ~3 frame periods since the last
        TIMECHANGED, treat it as a stop and halt the audio.

        Cheap: a getattr + time math when idle, slightly more when
        we actually need to stop. Returns True iff audio was still
        active (so the Timer keeps firing).
        """
        if not self._ext_playing:
            return False
        try:
            doc = c4d.documents.GetActiveDocument()
            fps = self._doc_fps(doc) if doc is not None else 24
        except Exception:
            fps = 24
        idle_s = _monotonic() - self._ext_last_t
        frame_period = 1.0 / max(1, fps)
        if idle_s > frame_period * 3.0:
            # No tick in 3 frame periods → C4D stopped. Halt audio.
            self._audio_playback.stop()
            self._ext_playing = False
            self._ext_consec_advances = 0
            return False
        return True

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
