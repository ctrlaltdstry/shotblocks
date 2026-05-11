"""Shotblocks drag-gesture canvas mixin.

The mouse-drag gesture cluster — the generic `_drag_loop` MouseDrag poller
and every higher-level handler that runs on top of it: shot move / resize,
rubber-band marquee selection, range-bar handle and body drags, playhead
scrub, Alt+LMB pan, Alt+RMB zoom, wheel pan / zoom, and the per-tick
preview-shots pipeline. Pulled out of `sb_canvas.py` for code-locality
alongside the audio and drawing mixins.

`ShotblocksTimelineCanvas` inherits `DragCanvasMixin` so all the methods
here see the same `self` as the rest of the canvas: shot-model helpers,
frame-to-x math, the GeUserArea MouseDrag* API, snap-target computation
(`_snap_frames`, `_snap_extras` — those stay on the canvas), and the
audio mixin's `_request_peak_rebuild` (called by the zoom gestures) all
stay one attribute lookup away. The split exists for code-locality, not
for any runtime independence.

Drag handlers WRITE the four drag-only instance vars
(`_preview_shots`, `_preview_range`, `_snap_indicator_frames`,
`_marquee_rect`) initialized by `_drag_init_state`. The drawing cluster
READS them — `DrawMsg` and friends consult these to paint the in-flight
gesture before any document commit. That cross-mixin coupling is by
design: drag state is canvas-local view state, not document state.

Input handlers (`_on_left_press`, `_on_right_press`, the wheel /
keyboard branches) stay on the canvas and call the drag methods via
`self._drag_move(...)` etc., resolving through MRO. The static methods
`_parse_drag_state` and `_is_drag_terminal` are also used by the
canvas's rail-button press loop; they resolve through MRO the same way.

Module-top canvas constants (`SHOT_HEIGHT`, `_KEY_MLEFT`, `_KEY_MRIGHT`,
`_MOUSE_DRAG_FLAG`, `_qualifier_mode`) are lazy-imported inside method
bodies — same approach the audio and drawing mixins use for
sb_canvas-owned constants.
"""

import math

import c4d

from sb_shot_model import (
    MAX_TRACKS, MIN_SHOT_FRAMES,
    _shot_track, _displayed_lane_count,
    _resolve_position, _resolve_resize, _resolve_group_move,
    _magnetic_snap_edge,
)
from sb_persistence import (
    _read_shots, _write_shots,
    _read_range, _write_range,
)


# ---------------------------------------------------------------------------
# Drag canvas mixin — generic drag-loop + every gesture handler that
# polls it (move, resize, marquee, range, playhead, pan, zoom, wheel).
# ---------------------------------------------------------------------------

class DragCanvasMixin(object):
    """Drag-gesture cluster methods + per-instance preview state for the
    timeline canvas.

    `ShotblocksTimelineCanvas` inherits this. The mixin assumes `self`
    is a canvas instance with the rest of the canvas's helpers
    available (`_frame_to_x`, `_x_to_frame`, `_frames_per_pixel`,
    `_track_y_top`, `_y_to_track`, `_snap_frames`, `_snap_extras`,
    `_doc_fps`, `_doc_bounds`, `_clamp_visible`, `_route_camera_for_frame`,
    `_set_playhead_with_playback_resync`, `_request_peak_rebuild`, the
    GeUserArea MouseDrag* API, etc.).
    """

    # ------------------------------------------------------------------
    # Per-instance state — call from the canvas's __init__.
    # ------------------------------------------------------------------

    def _drag_init_state(self):
        """Initialize per-instance drag state. Call from the canvas's
        `__init__` so a fresh canvas starts with no in-flight gesture
        (no preview shots, no marquee rect, no preview range, and no
        snap indicator). The drawing cluster reads these directly,
        so they must exist before the first DrawMsg.
        """
        # Marquee drag state — non-None during a marquee, holds (x0, y0, x1, y1).
        self._marquee_rect = None

        # Drag preview overrides — if non-None, DrawMsg uses these instead of doc
        self._preview_shots = None
        self._preview_range = None  # (in_frame, out_frame) or None

        # Frames the in-flight drag's snap is currently aligned with.
        # A tuple of frame integers; empty when no snap is active.
        # Drawn in DrawMsg as vertical yellow lines so the user sees
        # exactly where the magnetic snap pulled the shot.
        self._snap_indicator_frames = ()

    # ------------------------------------------------------------------
    # Drag loops — uses MouseDragStart / MouseDrag / MouseDragEnd
    # ------------------------------------------------------------------

    def _drag_loop(self, button_key, mx, my, on_tick):
        """Generic drag-poll loop. Calls on_tick(accum_dx, accum_dy, qualifier)
        per motion update. Returns (final_dx, final_dy, final_qualifier) or None
        on failure."""
        from sb_canvas import _MOUSE_DRAG_FLAG, ShotblocksTimelineCanvas
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
        from sb_canvas import _KEY_MLEFT, _qualifier_mode
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
            extra = self._snap_extras()
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
        extra = self._snap_extras()
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
        from sb_canvas import _KEY_MLEFT, _qualifier_mode
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
                    extra_points=self._snap_extras())
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
            extra_points=self._snap_extras())
        _write_shots(doc, new_shots, _read_shots(doc)[1], with_undo=True)
        doc.EndUndo()
        self._snap_indicator_frames = ()
        c4d.EventAdd()

    def _drag_marquee(self, mx, my, additive):
        """Plain LMB-drag-on-empty-canvas marquee. Selects shots whose body
        bbox intersects the rectangle. Additive = Shift held."""
        from sb_canvas import _KEY_MLEFT
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
        from sb_canvas import SHOT_HEIGHT
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
        from sb_canvas import _KEY_MLEFT
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
        """Press in the range-bar body. Distinguishes click vs drag:
        if the user releases without meaningfully moving the cursor,
        snap the playhead to the click x. If they drag, slide the
        active range as before.

        The threshold (CLICK_DRAG_THRESHOLD_PX) is small enough that
        a deliberate drag feels responsive but accidental jitter
        during a click stays in the click branch.
        """
        from sb_canvas import _KEY_MLEFT
        CLICK_DRAG_THRESHOLD_PX = 3
        w = self.GetWidth()
        fpp = self._frames_per_pixel(w)
        doc = c4d.documents.GetActiveDocument()
        doc_first, doc_last = self._doc_bounds()
        orig_in, orig_out = _read_range(doc)
        length = orig_out - orig_in
        max_abs_dx = [0]   # tracks the largest |dx| reached during the gesture

        def on_tick(adx, _ady, _qual):
            if abs(adx) > max_abs_dx[0]:
                max_abs_dx[0] = abs(adx)
            # Only paint the dragged preview once movement clears the
            # click-vs-drag threshold; below that, leave the range
            # alone so a click-and-release doesn't visually shift it.
            if max_abs_dx[0] >= CLICK_DRAG_THRESHOLD_PX:
                delta = int(round(adx * fpp))
                new_in = max(doc_first, min(orig_in + delta, doc_last - length))
                self._preview_range = (new_in, new_in + length)
                self.Redraw()

        self._drag_loop(_KEY_MLEFT, mx, my, on_tick)
        if max_abs_dx[0] >= CLICK_DRAG_THRESHOLD_PX:
            # Drag — commit the new range position.
            self._commit_range_drag(doc, orig_in, orig_out)
        else:
            # Click — discard any preview and snap the playhead.
            self._preview_range = None
            fps = self._doc_fps(doc) if doc is not None else 24
            target_frame = self._x_to_frame(mx, w)
            target_frame = max(doc_first, min(doc_last, target_frame))
            self._set_playhead_with_playback_resync(
                target_frame, fps, seek_audio=True)
            if doc is not None:
                try:
                    doc.SetTime(c4d.BaseTime(target_frame, fps))
                except Exception as e:
                    print("[Shotblocks] SetTime failed: {}".format(e))
            c4d.EventAdd()
            self.Redraw()

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
        from sb_canvas import _KEY_MLEFT, _qualifier_mode, ShotblocksTimelineCanvas
        w = self.GetWidth()
        fpp = self._frames_per_pixel(w)
        doc = c4d.documents.GetActiveDocument()
        fps = self._doc_fps(doc) if doc is not None else 24
        doc_first, doc_last = self._doc_bounds()

        shots, _ = _read_shots(doc) if doc is not None else ([], 0)
        # Playhead-scrub snap excludes the playhead itself from extras
        # (otherwise the playhead snaps to its own current position).
        # Everything else from `_snap_extras` applies — audio block
        # edges + prominent-peak frames.
        scrub_extras = tuple(p for p in self._snap_extras()
                             if p != self.playhead_frame)

        def snap_frame(f, qual):
            mode = _qualifier_mode(qual, self._snap_enabled)
            if mode != "snap":
                self._snap_indicator_frames = ()
                return f
            snapped, targets = _magnetic_snap_edge(
                shots, target_id=None, edge_frame=f,
                snap_frames=self._snap_frames(),
                extra_points=scrub_extras)
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

        # Snapshot whether playback was active when the scrub started.
        # If it was, the helper re-anchors the playback clock and the
        # drag-end commit seeks the audio.
        was_playing = self._playing

        if snap_on_click:
            raw = self._x_to_frame(mx, w)
            snapped = snap_frame(raw, 0)
            new_frame = max(doc_first, min(doc_last, snapped))
            # Re-anchor video clock + playhead. seek_audio=False during
            # drag — audio resync costs ~tens of ms per call so we defer
            # to drag-end. Same for the per-tick handler below.
            self._set_playhead_with_playback_resync(new_frame, fps,
                                                     seek_audio=False)
            push_to_doc(self.playhead_frame)
            self.Redraw()
        orig_frame = self.playhead_frame

        def on_tick(adx, _ady, qual):
            raw = orig_frame + int(round(adx * fpp))
            snapped = snap_frame(raw, qual)
            new_frame = max(doc_first, min(doc_last, snapped))
            if new_frame != self.playhead_frame:
                self._set_playhead_with_playback_resync(new_frame, fps,
                                                         seek_audio=False)
                push_to_doc(new_frame)
                self.Redraw()

        self._drag_loop(_KEY_MLEFT, mx, my, on_tick)
        # Drag committed — if we were playing, seek the audio to the
        # final scrub frame so audio catches up to the video clock.
        # The single audio re-issue is fine here (one per gesture).
        if was_playing and self._playing:
            self._set_playhead_with_playback_resync(
                self.playhead_frame, fps, seek_audio=True)
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

    def _drag_pan(self, mx, my):
        """Alt+LMB drag-pan. Held LMB so MouseDrag actually delivers motion
        (MMB is intercepted by C4D's framework regardless of qualifier)."""
        from sb_canvas import _KEY_MLEFT
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
        from sb_canvas import _KEY_MRIGHT
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
        # Drag is done — request a peak-cache rebuild at the new zoom
        # so the waveform sharpens. The debounce lets a rapid double
        # zoom-drag collapse into a single rebuild.
        self._request_peak_rebuild()

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
        # Debounced waveform peak-cache rebuild at the new zoom level.
        self._request_peak_rebuild()

    # ------------------------------------------------------------------
    # Render preview during drag without committing to the document
    # ------------------------------------------------------------------

    def _render_preview_shots(self, shots_or_none):
        """Cache an override list for the next paint. Pass None to clear."""
        self._preview_shots = shots_or_none
        self.Redraw()
