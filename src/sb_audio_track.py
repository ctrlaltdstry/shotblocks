"""Per-document audio track state.

Owns the in-memory audio data for the active document: file path,
decoded samples, peak cache, and timeline placement (where on the
timeline the block sits, what's trimmed off the head). Touches `c4d`
only for path resolution against the active doc.

v7 ships exactly one track per document. Future versions may
generalize to a list; the persistence key (`BCKEY_AUDIO_JSON`) stores
a single dict for now.

The cache lifecycle:
- Construction does NOT decode — call `load()` to perform the
  expensive decode + peak build.
- `load()` is safe to call from any thread (no `c4d` calls in the
  decode path) but the persistence write must happen on the main
  thread.
- Renderer / playback see the in-memory data via attributes, not
  through method calls that touch `c4d`.
"""

import os

import c4d

from sb_audio_decode  import load_audio, AudioDecodeError
from sb_audio_peaks   import build as build_peaks, should_rebuild
from sb_audio_onsets  import analyse as analyse_audio, mixdown_to_mono
from sb_audio_meter   import build_envelope, sample_at as sample_meter_envelope
from sb_audio_filters import drum_band
# Persistence moved up to the canvas: it owns the list of AudioTrack
# instances and writes the whole list (or a single dict for back-compat
# read) via sb_persistence's _read_audios / _write_audios.


class AudioTrackError(Exception):
    """Raised when an audio operation cannot be completed (file missing,
    decode failed, etc.). Caller decides whether to surface to the user
    or log + ignore."""


class AudioTrack(object):
    """Per-document audio state. One instance lives on the canvas; it's
    rebuilt lazily when the active document changes or audio is
    (re)imported."""

    def __init__(self):
        self.path             = ""    # absolute path resolved from persisted form
        self.path_is_relative = False
        self.decoded          = None  # DecodedAudio or None
        self.peaks            = None  # PeakCache or None
        self._mono            = None  # array('h'), built lazily by `mono` property
        self._drum_band       = None  # array('h'), built lazily by `drum_band` property
        self._meter_envelope  = None  # StereoEnvelope, built lazily by `meter_envelope`

        # Lane index — which audio row this clip sits on. 0 is the
        # row directly below the video stack; positive integers stack
        # downward. Mirrors the shot-model `track` field. Set on
        # import_file or load_from_doc; persisted alongside the path.
        self.track = 0

        # Persistence callback — the canvas sets this when it owns
        # the track. When set, AudioTrack mutations that historically
        # called `_persist_current(doc)` now invoke the callback
        # instead, so the canvas can write the whole multi-track
        # list in one helper-null write. None = no-op (track is
        # detached from a doc).
        self._persist_cb = None

        # Timeline placement (doc/timeline frames, NOT audio frames).
        self.in_frame  = 0       # first timeline frame the clip plays on
        self.out_frame = 0       # last timeline frame the clip covers (inclusive)
        # Trim — how many audio frames are skipped at the head when
        # playback hits in_frame. Edge-resize on the left edge increments
        # this; edge-resize on the right edge moves out_frame. Trim from
        # the tail is implicit (out_frame's distance from in_frame caps
        # the played duration).
        self.trim_start_audio_frames = 0

        # v9 onset analysis. All three default empty/None so the canvas
        # treats "not analysed yet" the same as "low confidence".
        # Stored in source-audio-frame indices so trim/move don't
        # invalidate them — the canvas shifts at draw time.
        self.onsets           = []   # list[int] — every detected attack
        self.prominent_peaks  = []   # list[int] — subset that "stands out"
                                     #   visually; drawn on the audio
                                     #   block and used as snap targets.
                                     #   Distinct from `self.peaks`,
                                     #   which is the waveform PeakCache.
        self.beat_grid        = None # (period_af, phase_af, confidence) or None
        # User-visible toggle. The rail button starts each track at
        # False (no analysis run yet); the first click runs analysis
        # and flips this to True. Subsequent clicks toggle visibility
        # WITHOUT re-running. A new audio import resets it to False
        # (the just-cleared analysis is no longer relevant). Persisted
        # so opening a previously-analysed doc shows whatever state
        # the user left it in.
        self.analysis_visible = False
        # Independent toggle for the waveform render (without affecting
        # peak ticks or beat grid). Default True so newly-imported
        # audio shows its waveform by default. Persisted alongside
        # `analysis_visible` so per-doc preference survives save/load.
        self.waveform_visible = True

        # Level keyframes — list of dicts {"af": int, "gain": float,
        # "interp": str}. `af` is the audio-frame index within the
        # source file (so trim/move don't invalidate the curve),
        # `gain` is a 0..1 linear multiplier (1.0 = unity), `interp`
        # selects the segment-out curve to the next keyframe:
        # "linear" | "hold" | "ease_in" | "ease_out" | "ease_in_out".
        # Always kept sorted by `af`. Empty = no level automation
        # (playback writes samples at unity).
        self.level_keyframes = []

    # ------------------------------------------------------------------
    # Path resolution
    # ------------------------------------------------------------------

    def _doc_folder(self, doc):
        """Return the active doc's folder, or '' if the doc is unsaved."""
        if doc is None:
            return ""
        try:
            folder = doc.GetDocumentPath()
            return folder or ""
        except Exception:
            return ""

    def _to_persisted_path(self, abs_path, doc):
        """Decide how `abs_path` should be stored: project-relative when
        possible (doc is saved AND audio is under the doc folder),
        absolute otherwise. Returns `(stored_string, is_relative_bool)`.
        """
        folder = self._doc_folder(doc)
        if not folder:
            return abs_path, False
        try:
            rel = os.path.relpath(abs_path, folder)
        except ValueError:
            # Different drive on Windows — relpath raises.
            return abs_path, False
        # Reject relpath results that escape the folder (../../...).
        # Storing those as relative is brittle; absolute is honest.
        if rel.startswith(".."):
            return abs_path, False
        return rel, True

    def _from_persisted_path(self, stored, is_relative, doc):
        """Reverse `_to_persisted_path` — produce an absolute path that
        the decoder can open. Falls back to `stored` if the doc folder
        isn't available; the decoder will raise if the file is missing.
        """
        if not is_relative:
            return stored
        folder = self._doc_folder(doc)
        if not folder:
            return stored
        return os.path.normpath(os.path.join(folder, stored))

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def import_file(self, abs_path, doc, drop_in_frame=0, drop_track=0):
        """User dragged an audio file (.wav or .mp3) onto the timeline.
        Decode via the format-agnostic dispatcher, build peaks, compute
        initial timeline range from the audio's duration, persist, and
        replace any existing track.

        `drop_in_frame` is the timeline frame the drop landed on; the
        clip's in-point starts there. The default in-block runs to
        `in_frame + duration_in_doc_frames`.

        Raises `AudioTrackError` on failure.
        """
        try:
            decoded = load_audio(abs_path)
        except AudioDecodeError as e:
            raise AudioTrackError(str(e))

        # Build the peak cache once at a fixed high density. The
        # renderer downsamples to on-screen pixel width via
        # nearest-neighbor at draw time. We deliberately do NOT rebuild
        # on zoom changes — the array.array fast path is still O(N) over
        # the entire file, which would freeze the UI on every zoom-drag
        # tick. 1024 samples/column ≈ 21 ms/col at 48 kHz; even at the
        # tightest practical zoom (~1 doc-frame per pixel), this gives
        # multiple peak entries per pixel, so visual fidelity holds.
        peaks = build_peaks(decoded, samples_per_column=1024)

        self.path             = abs_path
        self.decoded          = decoded
        self.peaks            = peaks
        self._mono            = None    # rebuilt lazily on first analysis
        self._drum_band       = None    # rebuilt lazily on first analysis
        self._meter_envelope  = None    # rebuilt lazily on first meter draw
        # New source → previous analysis markers no longer apply to the
        # current audio. Cleared so the canvas stops drawing them, and
        # visibility resets to False so the next button click runs
        # analysis on the new file rather than just toggling stale
        # markers back on.
        self.onsets           = []
        self.prominent_peaks  = []
        self.beat_grid        = None
        self.analysis_visible = False
        self.waveform_visible = True
        self.level_keyframes  = []
        self.trim_start_audio_frames = 0

        # Timeline placement: in_frame at drop point; out_frame
        # computed from audio duration in doc-frame units.
        fps = self._doc_fps(doc)
        duration_doc_frames = max(1, int(round(decoded.duration_s * fps)))
        self.track     = max(0, int(drop_track))
        self.in_frame  = max(0, int(drop_in_frame))
        self.out_frame = self.in_frame + duration_doc_frames - 1

        stored, is_rel = self._to_persisted_path(abs_path, doc)
        self.path_is_relative = is_rel

    def load_from_doc(self, doc):
        """Read the persisted audio dict from the helper null and
        re-decode the WAV. Returns True if a track was loaded, False if
        none is persisted. On decode failure, persists nothing-changed
        and returns False (the user sees the absence; they can re-drop)."""
        d = _read_audio(doc)
        if d is None:
            self._reset()
            return False

        is_rel  = bool(d.get("path_is_relative", False))
        stored  = d.get("path", "")
        abs_path = self._from_persisted_path(stored, is_rel, doc)

        try:
            decoded = load_audio(abs_path)
        except AudioDecodeError as e:
            print("[Shotblocks] audio re-load failed: {}".format(e))
            self._reset()
            self.path             = abs_path
            self.path_is_relative = is_rel
            # Keep the placement so the canvas can render an
            # "audio missing" state if it wants to. v7 just logs.
            self.in_frame  = int(d.get("in_frame",  0))
            self.out_frame = int(d.get("out_frame", 0))
            return False

        self.path             = abs_path
        self.path_is_relative = is_rel
        self.decoded          = decoded
        self.peaks            = build_peaks(decoded, samples_per_column=1024)
        self._mono            = None
        self._drum_band       = None
        self._meter_envelope  = None
        self.track     = max(0, int(d.get("track", 0)))
        self.in_frame  = int(d.get("in_frame",  0))
        self.out_frame = int(d.get("out_frame", self.in_frame +
                                                int(decoded.duration_s * 24)))
        self.trim_start_audio_frames = max(0, int(d.get("trim_start_audio_frames", 0)))

        # v9 — restore persisted analysis if present. Each field is
        # independently optional so a partial blob (e.g. older save
        # before peaks shipped) still loads everything it has.
        def _ints(seq):
            try:
                return [int(x) for x in (seq or [])]
            except (TypeError, ValueError):
                return []
        self.onsets           = _ints(d.get("onsets"))
        self.prominent_peaks  = _ints(d.get("prominent_peaks"))
        self.analysis_visible = bool(d.get("analysis_visible", False))
        # `waveform_visible` defaults to True for legacy docs that
        # were saved before the toggle existed — they get the
        # historical "always show waveform" behavior.
        self.waveform_visible = bool(d.get("waveform_visible", True))
        raw_grid = d.get("beat_grid")
        if isinstance(raw_grid, dict):
            try:
                self.beat_grid = (int(raw_grid["period"]),
                                  int(raw_grid["phase"]),
                                  float(raw_grid["confidence"]))
            except (KeyError, TypeError, ValueError):
                self.beat_grid = None
        else:
            self.beat_grid = None
        # Level keyframes — list of {"af", "gain", "interp"} dicts.
        # Tolerate per-entry corruption: drop malformed entries
        # rather than rejecting the whole curve.
        raw_kfs = d.get("level_keyframes") or []
        kfs = []
        for k in raw_kfs:
            try:
                af   = int(k["af"])
                gain = float(k.get("gain", 1.0))
                interp = str(k.get("interp", "linear"))
            except (TypeError, ValueError, KeyError):
                continue
            if interp not in ("linear", "hold", "ease_in",
                              "ease_out", "ease_in_out"):
                interp = "linear"
            kfs.append({"af": af, "gain": max(0.0, min(1.0, gain)),
                        "interp": interp})
        kfs.sort(key=lambda k: k["af"])
        self.level_keyframes = kfs
        return True

    def clear(self, doc):
        """Remove the audio track from the document and the in-memory state."""
        self._reset()
        _write_audio(doc, None)

    # ------------------------------------------------------------------
    # Mutations from canvas drags
    # ------------------------------------------------------------------

    def set_in_frame(self, new_in, doc, persist=True):
        """Move the clip horizontally (drag-move). Preserves duration."""
        if self.decoded is None:
            return
        delta = int(new_in) - self.in_frame
        if delta == 0:
            return
        self.in_frame  += delta
        self.out_frame += delta
        if persist:
            self._persist_current(doc)

    def resize_left_edge(self, new_in, doc, persist=True):
        """Edge-drag the leading edge. Adjusts trim_start so audio
        content stays anchored in doc-time — the source frame currently
        playing at doc-frame X keeps playing at doc-frame X, regardless
        of where the left edge moves.

        `new_in` is clamped from below by two constraints:
        - Doc-frame 0 — the clip's left edge cannot precede the
          timeline. Slip (`_drag_audio_slip`) is the gesture for
          exposing earlier audio without moving the clip; resize is
          strictly a clip-boundary operation.
        - The audio "anchor" — the doc-frame where the source's first
          sample plays, given the current trim. The left edge cannot
          go past the anchor because the source has no earlier audio
          to expose.

        The clip's left edge stops at whichever limit it reaches first.
        Drag past either limit stalls (subsequent left-drag is a no-op
        until the user reverses direction).
        """
        if self.decoded is None:
            return
        new_in = int(new_in)
        if new_in > self.out_frame:
            new_in = self.out_frame

        # Anchor: the doc-frame where source frame 0 plays. With the
        # current (in_frame, trim_start), source frame `trim_start`
        # plays at doc-frame `in_frame`, so frame 0 plays at
        # `in_frame - trim_doc_equivalent`. Negative anchors are
        # allowed (audio extends off the left of the timeline) — the
        # doc-frame-0 clamp above already keeps the clip's left edge
        # from going there.
        fps = self._doc_fps(doc)
        rate = self.decoded.sample_rate
        trim_doc = int(round(self.trim_start_audio_frames
                             * (max(1, fps) / rate)))
        anchor_doc = self.in_frame - trim_doc

        # Take the tighter of doc-frame 0 and the anchor; that's the
        # earliest doc-frame the left edge can land on.
        min_in = max(0, anchor_doc)
        if new_in < min_in:
            new_in = min_in
        if new_in == self.in_frame:
            return

        # Recompute trim so the audio anchor (and therefore all
        # in-source content) stays at the same doc-frame.
        new_trim = int(round((new_in - anchor_doc)
                             * (rate / max(1, fps))))
        if new_trim < 0:
            new_trim = 0
        if new_trim >= self.decoded.n_frames:
            new_trim = max(0, self.decoded.n_frames - 1)
        self.in_frame = new_in
        self.trim_start_audio_frames = new_trim
        if persist:
            self._persist_current(doc)

    def resize_right_edge(self, new_out, doc, persist=True):
        """Edge-drag the trailing edge. Just moves out_frame. Playback
        zero-fills past end-of-audio per the v7 design decision."""
        if self.decoded is None:
            return
        new_out = int(new_out)
        if new_out <= self.in_frame:
            new_out = self.in_frame + 1
        if new_out == self.out_frame:
            return
        self.out_frame = new_out
        if persist:
            self._persist_current(doc)

    # ------------------------------------------------------------------
    # Sampling helpers (used by playback)
    # ------------------------------------------------------------------

    def audio_frame_to_doc_frame(self, audio_frame, fps):
        """Inverse of `doc_frame_to_audio_frame`. Converts a source-
        rate audio-frame index to its doc-frame position on the
        timeline, given the current `in_frame` and `trim_start`.

        Returns a float doc-frame (sub-frame precision) so callers
        rendering at the pixel level can avoid quantization jitter
        as the audio block is dragged. The audio-frame may sit
        *outside* the clip's [in_frame, out_frame] range — the
        caller decides whether to draw it (the canvas-wide beat
        grid does, since markers conceptually exist before/after
        the visible clip).
        """
        if self.decoded is None:
            return -1.0
        rate = self.decoded.sample_rate
        fps = max(1, int(fps))
        rel_audio = audio_frame - self.trim_start_audio_frames
        return self.in_frame + rel_audio * (fps / float(rate))

    def doc_frame_to_audio_frame(self, doc_frame, fps):
        """Convert a timeline frame to an absolute audio-frame index
        within the source file, accounting for in_frame and trim."""
        if self.decoded is None:
            return -1
        if doc_frame < self.in_frame or doc_frame > self.out_frame:
            return -1
        rate = self.decoded.sample_rate
        fps  = max(1, int(fps))
        rel_doc_frames = doc_frame - self.in_frame
        return self.trim_start_audio_frames + int(round(
            rel_doc_frames * (rate / float(fps))))

    def audio_frames_for_visible_window(self, fps):
        """Return (start, end) audio-frame indices covering the entire
        clip's currently-visible duration. Used by the renderer to
        slice the peak cache."""
        if self.decoded is None:
            return 0, 0
        rate = self.decoded.sample_rate
        fps  = max(1, int(fps))
        n_doc_frames = max(0, self.out_frame - self.in_frame + 1)
        end = self.trim_start_audio_frames + int(round(
            n_doc_frames * (rate / float(fps))))
        if end > self.decoded.n_frames:
            end = self.decoded.n_frames
        return self.trim_start_audio_frames, end

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _reset(self):
        self.path             = ""
        self.path_is_relative = False
        self.decoded          = None
        self.peaks            = None
        self._mono            = None
        self._drum_band       = None
        self._meter_envelope  = None
        self.track            = 0
        self.in_frame         = 0
        self.out_frame        = 0
        self.trim_start_audio_frames = 0
        self.onsets           = []
        self.prominent_peaks  = []
        self.beat_grid        = None
        self.analysis_visible = False
        self.waveform_visible = True
        self.level_keyframes  = []

    def _doc_fps(self, doc):
        try:
            fps = int(doc.GetFps())
        except Exception:
            fps = 0
        return fps if fps > 0 else 24

    def to_persisted_dict(self, doc):
        """Build the JSON-serializable dict for this track. Caller is
        responsible for assembling them into the doc-level list and
        writing via `_write_audios`. Path is project-relative when
        possible (doc saved + audio under the doc folder); absolute
        otherwise."""
        stored, is_rel = self._to_persisted_path(self.path, doc)
        self.path_is_relative = is_rel
        return self._build_persist_dict(stored, is_rel)

    def _build_persist_dict(self, stored_path, is_relative):
        d = {
            "path":             stored_path,
            "path_is_relative": bool(is_relative),
            "track":            int(self.track),
            "in_frame":         int(self.in_frame),
            "out_frame":        int(self.out_frame),
            "trim_start_audio_frames": int(self.trim_start_audio_frames),
        }
        # Only carry analysis fields when populated — keeps the blob
        # small for tracks the user hasn't analysed yet.
        if self.onsets:
            d["onsets"] = [int(x) for x in self.onsets]
        if self.prominent_peaks:
            d["prominent_peaks"] = [int(x) for x in self.prominent_peaks]
        if self.beat_grid is not None:
            period, phase, conf = self.beat_grid
            d["beat_grid"] = {
                "period":     int(period),
                "phase":      int(phase),
                "confidence": float(conf),
            }
        # Visibility flags persist separately from the data — the
        # user might toggle off views they want to keep around.
        if self.analysis_visible:
            d["analysis_visible"] = True
        # `waveform_visible` only written when False (the non-default).
        # Legacy docs without the key load as True, matching the
        # always-visible behavior they had pre-toggle.
        if not self.waveform_visible:
            d["waveform_visible"] = False
        # Level keyframes — only when populated, to keep the blob
        # small for clips with no automation.
        if self.level_keyframes:
            d["level_keyframes"] = [
                {"af": int(k["af"]),
                 "gain": float(k.get("gain", 1.0)),
                 "interp": str(k.get("interp", "linear"))}
                for k in self.level_keyframes
            ]
        return d

    def _persist_current(self, doc):
        """Notify the canvas (via the callback it wired up) that this
        track's state changed and the doc-level audio list needs a
        rewrite. No-op when the track is detached (no callback).
        Drag handlers pass `persist=False` and then drive persistence
        manually at drag-end; this path catches the non-drag mutators
        (analyse, set_in_frame from non-drag callers, etc.)."""
        cb = self._persist_cb
        if cb is None:
            return
        try:
            cb(doc)
        except Exception as e:
            print("[Shotblocks] AudioTrack persist callback raised: {}".format(e))

    # ------------------------------------------------------------------
    # Mono mixdown + onset analysis (v9)
    # ------------------------------------------------------------------

    @property
    def meter_envelope(self):
        """Lazy stereo dBFS envelope used by the right-side meter.
        Built once on first read after import / load_from_doc and
        held for the life of the track. Returns None until decoded
        audio is available."""
        if self._meter_envelope is None and self.decoded is not None:
            self._meter_envelope = build_envelope(self.decoded)
        return self._meter_envelope

    def meter_levels_at(self, audio_frame):
        """Per-channel dBFS at `audio_frame` for the right-side meter.
        Returns a list of floats matching the envelope's channel
        count (1 for mono, 2 for stereo). Returns empty list when
        no audio is loaded."""
        env = self.meter_envelope
        if env is None:
            return []
        return sample_meter_envelope(env, audio_frame)

    @property
    def mono(self):
        """Lazy mono mixdown of the decoded samples. Built on first
        access and cached for the life of the track. Cleared on import
        / reload / clear (where `decoded` itself changes).

        v10+ sidechain envelope work will read this same buffer."""
        if self._mono is None and self.decoded is not None:
            self._mono = mixdown_to_mono(self.decoded)
        return self._mono

    @property
    def drum_band(self):
        """Lazy drum-band-filtered mono signal: kick (50-120 Hz) +
        snare/hi-hat (2-8 kHz) bandpasses summed. Suppresses vocals,
        pads, and melodic instruments so the prominent-peak detector
        sees only drum-relevant transients.

        Cheaper stand-in for ML stem separation (Demucs/Spleeter)
        — see `sb_audio_filters.drum_band` for design notes."""
        if self._drum_band is None and self.decoded is not None:
            mono = self.mono
            if mono:
                self._drum_band = drum_band(mono, self.decoded.sample_rate)
        return self._drum_band

    def analyse(self, doc):
        """Run onset detection + beat-grid inference on the current
        decoded audio. Called when the user clicks the "Analyse" rail
        button or hits the hotkey. Persists results immediately so
        Cmd+Z can revert the analysis along with any other helper-null
        change captured in the same undo step.

        Returns a (n_onsets, bpm_or_None, confidence) tuple for the
        caller to log; raises nothing — failure paths are silent and
        leave existing analysis intact. (A no-audio call is a no-op.)
        """
        if self.decoded is None:
            return (0, 0, None, 0.0)
        onsets, peaks, grid, elapsed = analyse_audio(
            self.decoded, mono=self.mono, peak_signal=self.drum_band)
        self.onsets          = onsets
        self.prominent_peaks = peaks
        self.beat_grid       = grid
        self._persist_current(doc)

        bpm = None
        conf = 0.0
        if grid is not None:
            period, _phase, conf = grid
            if period > 0:
                bpm = 60.0 * self.decoded.sample_rate / float(period)
        print("[Shotblocks] audio analysed: {} onsets, {} peaks, {} "
              "({:.2f}s, conf {:.2f})".format(
                  len(onsets), len(peaks),
                  "~{:.0f} BPM".format(bpm) if bpm else "no grid",
                  elapsed, conf))
        return (len(onsets), len(peaks), bpm, conf)

    # ------------------------------------------------------------------
    # Zoom-aware peak rebuild — called by renderer when zoom changes
    # ------------------------------------------------------------------

    def split_at(self, doc_frame, doc):
        """Split this clip at `doc_frame`. Self becomes the LEFT half:
        out_frame is moved to `doc_frame - 1`. Returns a new AudioTrack
        representing the RIGHT half (in_frame = doc_frame, trim_start
        advanced past the split point).

        Returns None when the split frame is outside (in_frame,
        out_frame] (must produce two non-empty halves), or when the
        decoded buffer hasn't been loaded.

        Both halves share the same source file and decoded reference
        — `decoded` and `peaks` are pointers, not copies. Level
        keyframes are partitioned by audio-frame: keyframes whose `af`
        is before the split go to the left, the rest go to the right
        (with `af` rebased onto the right's trim).
        """
        if self.decoded is None:
            return None
        frame = int(doc_frame)
        if frame <= self.in_frame or frame > self.out_frame:
            return None
        fps_for_split = self._cached_fps_for_split(doc)
        rate = self.decoded.sample_rate
        af_at_split = self.doc_frame_to_audio_frame(frame, fps_for_split)
        if af_at_split < 0:
            return None

        right = AudioTrack()
        right._persist_cb = self._persist_cb
        right.path             = self.path
        right.path_is_relative = self.path_is_relative
        right.decoded          = self.decoded   # shared
        right.peaks            = self.peaks     # shared
        right._mono            = self._mono
        right._drum_band       = self._drum_band
        right._meter_envelope  = self._meter_envelope
        right.track     = self.track
        right.in_frame  = frame
        right.out_frame = self.out_frame
        right.trim_start_audio_frames = af_at_split

        # Partition level keyframes by audio-frame.
        left_kfs  = []
        right_kfs = []
        for k in self.level_keyframes:
            if k["af"] < af_at_split:
                left_kfs.append(dict(k))
            else:
                right_kfs.append(dict(k))
        # Onsets / peaks / beat grid are source-frame indexed and
        # apply to the whole file — leave them on both halves so
        # snap/analysis still works on either side of the cut.
        right.onsets           = list(self.onsets)
        right.prominent_peaks  = list(self.prominent_peaks)
        right.beat_grid        = self.beat_grid
        right.analysis_visible = self.analysis_visible
        right.waveform_visible = self.waveform_visible
        right.level_keyframes  = right_kfs

        # Mutate self into the left half.
        self.out_frame = frame - 1
        self.level_keyframes = left_kfs
        return right

    def _cached_fps_for_split(self, doc):
        """Wrapper around `_doc_fps` so the split path has a clearly-
        named call site (it's the only place that needs fps without
        a surrounding playback / drag context)."""
        return self._doc_fps(doc)

    # ------------------------------------------------------------------
    # Level keyframes — mutation + evaluation
    # ------------------------------------------------------------------

    def add_level_keyframe(self, audio_frame, gain, interp="linear"):
        """Insert a keyframe at `audio_frame` with the given gain.
        Replaces any existing keyframe within `MERGE_AF_TOLERANCE`
        (treats nearby clicks as moving the existing node). Returns
        the index of the inserted/updated keyframe.

        The audio-frame must be inside [0, decoded.n_frames]; callers
        should clamp before calling. `gain` is clamped to [0, 1]."""
        MERGE_AF_TOL = 8  # within ~8 audio frames = same node
        gain = max(0.0, min(1.0, float(gain)))
        if interp not in ("linear", "hold", "ease_in",
                          "ease_out", "ease_in_out"):
            interp = "linear"
        af = int(audio_frame)
        # Find an existing kf to merge with.
        for i, k in enumerate(self.level_keyframes):
            if abs(k["af"] - af) <= MERGE_AF_TOL:
                k["af"]   = af
                k["gain"] = gain
                # Don't clobber an existing interp on a re-add at the
                # same position — caller can pass interp= explicitly
                # to change it.
                return i
        kf = {"af": af, "gain": gain, "interp": interp}
        self.level_keyframes.append(kf)
        self.level_keyframes.sort(key=lambda k: k["af"])
        return self.level_keyframes.index(kf)

    def remove_level_keyframe(self, index):
        """Drop the keyframe at `index`. No-op on out-of-range."""
        if 0 <= index < len(self.level_keyframes):
            del self.level_keyframes[index]

    def set_level_keyframe(self, index, *, audio_frame=None,
                            gain=None, interp=None):
        """Update one or more attributes on an existing keyframe.
        Re-sorts when `audio_frame` changes."""
        if not (0 <= index < len(self.level_keyframes)):
            return
        k = self.level_keyframes[index]
        if audio_frame is not None:
            k["af"] = int(audio_frame)
        if gain is not None:
            k["gain"] = max(0.0, min(1.0, float(gain)))
        if interp is not None and interp in (
                "linear", "hold", "ease_in", "ease_out", "ease_in_out"):
            k["interp"] = interp
        self.level_keyframes.sort(key=lambda k: k["af"])

    def evaluate_level(self, audio_frame):
        """Evaluate the level curve at the given audio-frame index.
        Returns a linear gain in [0, 1]. No keyframes → unity (1.0).
        Before the first keyframe and after the last, returns the
        nearest keyframe's gain (curve flatlines at the edges)."""
        kfs = self.level_keyframes
        if not kfs:
            return 1.0
        af = int(audio_frame)
        if af <= kfs[0]["af"]:
            return kfs[0]["gain"]
        if af >= kfs[-1]["af"]:
            return kfs[-1]["gain"]
        # Find the segment [kfs[i], kfs[i+1]] containing `af`.
        # Linear scan — keyframe counts are small (dozens at most).
        for i in range(len(kfs) - 1):
            a, b = kfs[i], kfs[i + 1]
            if a["af"] <= af < b["af"]:
                interp = a.get("interp", "linear")
                if interp == "hold":
                    return a["gain"]
                # Normalized position in the segment.
                t = (af - a["af"]) / float(b["af"] - a["af"])
                if interp == "ease_in":
                    t = t * t
                elif interp == "ease_out":
                    t = 1.0 - (1.0 - t) * (1.0 - t)
                elif interp == "ease_in_out":
                    # Smoothstep: 3t^2 - 2t^3.
                    t = t * t * (3.0 - 2.0 * t)
                # "linear" — t stays as-is.
                return a["gain"] + (b["gain"] - a["gain"]) * t
        return kfs[-1]["gain"]

    def maybe_rebuild_peaks(self, samples_per_column):
        if self.decoded is None:
            return
        if not should_rebuild(self.peaks, samples_per_column):
            return
        self.peaks = build_peaks(self.decoded, samples_per_column=int(samples_per_column))
