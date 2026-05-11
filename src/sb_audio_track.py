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
from sb_persistence   import _read_audio, _write_audio


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

    def import_file(self, abs_path, doc, drop_in_frame=0):
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
        self.trim_start_audio_frames = 0

        # Timeline placement: in_frame at drop point; out_frame
        # computed from audio duration in doc-frame units.
        fps = self._doc_fps(doc)
        duration_doc_frames = max(1, int(round(decoded.duration_s * fps)))
        self.in_frame  = max(0, int(drop_in_frame))
        self.out_frame = self.in_frame + duration_doc_frames - 1

        stored, is_rel = self._to_persisted_path(abs_path, doc)
        self.path_is_relative = is_rel
        self._persist(doc, stored, is_rel)

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
        """Edge-drag the leading edge. Adjusts trim_start so audio frame
        N within the source still plays at the same wall time. Out-frame
        stays put (so the clip's tail doesn't move during a head trim).
        Clamps to [0, out_frame] and to the audio's available frames.
        """
        if self.decoded is None:
            return
        new_in = int(new_in)
        if new_in > self.out_frame:
            new_in = self.out_frame
        delta = new_in - self.in_frame
        if delta == 0:
            return
        # Convert delta in doc-frames to delta in audio-frames.
        fps = self._doc_fps(doc)
        rate = self.decoded.sample_rate
        delta_audio = int(round(delta * (rate / max(1, fps))))
        new_trim = self.trim_start_audio_frames + delta_audio
        if new_trim < 0:
            # User dragged the head further left than the audio's start
            # — pin to 0 and adjust new_in correspondingly.
            recovery = -new_trim
            recovery_doc = int(round(recovery * (max(1, fps) / rate)))
            new_in = self.in_frame + delta + recovery_doc
            new_trim = 0
        if new_trim >= self.decoded.n_frames:
            # User dragged past end — leave a 1-frame minimum clip.
            new_trim = max(0, self.decoded.n_frames - 1)
            new_in   = max(self.in_frame, self.out_frame - 1)
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
        self.in_frame         = 0
        self.out_frame        = 0
        self.trim_start_audio_frames = 0
        self.onsets           = []
        self.prominent_peaks  = []
        self.beat_grid        = None
        self.analysis_visible = False
        self.waveform_visible = True

    def _doc_fps(self, doc):
        try:
            fps = int(doc.GetFps())
        except Exception:
            fps = 0
        return fps if fps > 0 else 24

    def _persist(self, doc, stored_path, is_relative):
        d = {
            "path":             stored_path,
            "path_is_relative": bool(is_relative),
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
        _write_audio(doc, d)

    def _persist_current(self, doc):
        stored, is_rel = self._to_persisted_path(self.path, doc)
        self.path_is_relative = is_rel
        self._persist(doc, stored, is_rel)

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

    def maybe_rebuild_peaks(self, samples_per_column):
        if self.decoded is None:
            return
        if not should_rebuild(self.peaks, samples_per_column):
            return
        self.peaks = build_peaks(self.decoded, samples_per_column=int(samples_per_column))
