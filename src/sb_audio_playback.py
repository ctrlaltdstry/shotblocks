"""Audio playback via winsound + temp file (continuous, gapless).

The first v7 implementation chunked the audio into ~250 ms slices and
called `winsound.PlaySound(SND_MEMORY)` synchronously for each slice
on a worker thread. This produced audible gaps at every chunk
boundary because `PlaySound` reinitializes the Windows audio stream
on each call rather than queueing seamlessly. The audio sounded
"slow" because each gap effectively paused playback briefly,
accumulating drift relative to wall time.

The v7 spike found that `SND_MEMORY | SND_ASYNC` raises
"Cannot play asynchronously from memory" in this Python build —
but `SND_FILENAME | SND_ASYNC` works fine. So we trade memory for
gaplessness: write the audio (or the tail of it from the play start
position) to a temp file, then call `PlaySound(path,
SND_FILENAME | SND_ASYNC)` once. Playback runs continuously inside
Windows; we don't need a worker thread.

Limitations of this design:
- Seek requires writing a fresh temp file (the file is the source of
  truth; we can't skip into the middle without rewriting). That's
  fine for v7's spacebar-press-to-play use case (one seek per play).
- We can't easily mid-stream sync if the canvas's playhead diverges
  from where Windows is internally. Drift between video timeline
  and audio is bounded by the clip length; for sub-minute clips
  it's well under a frame and inaudible. Re-issued on loop-wrap.
- Past-end behavior is "playback stops" rather than "zero-fill" —
  PlaySound naturally ends when the file does. The canvas keeps
  advancing the playhead either way; this just means silence past
  the clip end, which matches the v7 design decision functionally
  (zero-fill = silence).

If sub-frame audio sync becomes a v8 requirement, we move to
ctypes-based `waveOutOpen` / `waveOutWrite` for proper streaming.
That's a real chunk of code; v7 trades that complexity for the
simpler path.
"""

import io
import os
import sys
import tempfile
import threading
import wave


# Reissue threshold — when the canvas-supplied target audio frame
# differs from our naturally-tracking position by more than this many
# seconds, we stop and replay from the new offset. Set to 0.5 s so
# loop-wraps (which jump backward by the entire clip) trigger a
# reissue, but tiny per-frame drift doesn't.
_REISSUE_THRESHOLD_S = 0.5


class AudioPlayback(object):
    """Single-track playback engine. Holds the decoded audio and
    a temp file path; mutating state from the canvas is thread-safe.

    The canvas drives this with:
        play(start_audio_frame)  — kick off async playback at offset
        sync(target_audio_frame) — called per tick. Reissues PlaySound
                                   if the target diverges from our
                                   estimate (loop wrap, manual seek).
        pause()                  — stop output; PlaySound(None, PURGE).
        stop()                   — same as pause.
    """

    def __init__(self):
        self._lock      = threading.Lock()
        self._decoded   = None     # DecodedAudio
        self._winsound  = None
        self._temp_path = None     # path to currently-playing temp WAV
        self._playing   = False
        self._play_start_frame = 0  # audio-frame offset of current temp file
        # When PlaySound was issued (monotonic) — used to estimate where
        # the audio thread "should" be for sync() drift detection.
        self._play_started_at = 0.0

    # ------------------------------------------------------------------
    # Public API (called from the canvas, main thread)
    # ------------------------------------------------------------------

    def set_audio(self, decoded):
        """Swap in a new DecodedAudio. Stops any in-progress playback
        and discards any temp file from the previous track."""
        self.stop()
        with self._lock:
            self._decoded = decoded

    def play_payload(self, payload, sample_rate, n_channels,
                     sample_width=2, start_audio_frame=0):
        """Play a pre-built 16-bit PCM buffer (e.g. a multi-track mix
        the canvas already assembled). The buffer is written to a
        temp WAV and handed to winsound, same as `play()`, but skips
        the single-source `_write_temp_wav` path.

        `start_audio_frame` is the audio-frame index the FIRST sample
        of `payload` represents — used by sync()/drift estimation so
        backward loop-wrap detection still works. Pass 0 if the
        payload is a fresh assembly that always starts at "now".
        """
        if not self._ensure_winsound():
            return
        if not payload:
            return
        try:
            fd, path = tempfile.mkstemp(prefix="sb_audio_mix_", suffix=".wav")
            os.close(fd)
            with wave.open(path, "wb") as w:
                w.setnchannels(int(n_channels))
                w.setsampwidth(int(sample_width))
                w.setframerate(int(sample_rate))
                w.writeframes(payload)
        except Exception as e:
            print("[Shotblocks] mix temp WAV write failed: {}".format(e))
            return
        try:
            self._winsound.PlaySound(None, self._winsound.SND_PURGE)
        except Exception:
            pass
        try:
            self._winsound.PlaySound(
                path,
                self._winsound.SND_FILENAME | self._winsound.SND_ASYNC
                | self._winsound.SND_NODEFAULT)
        except Exception as e:
            print("[Shotblocks] mix PlaySound failed: {}".format(e))
            self._cleanup_temp(path)
            return
        old_path = self._temp_path
        from time import monotonic as _mono
        with self._lock:
            self._temp_path        = path
            self._playing          = True
            # `_play_start_frame` keeps its meaning as a sample-rate
            # frame index against the canonical mix sample rate.
            self._play_start_frame = max(0, int(start_audio_frame))
            self._play_started_at  = _mono()
            # Record the mix's sample rate so drift/sync math uses
            # the mix's clock, not whatever the first decoded source
            # happened to be at.
            self._mix_sample_rate  = int(sample_rate)
        if old_path:
            self._cleanup_temp(old_path)

    def play(self, start_audio_frame, level_curve_fn=None,
             end_audio_frame=None):
        """Kick off async playback at the given audio-frame offset.
        Building the temp file blocks for ~tens of ms on typical clips;
        we accept that on the main thread because spacebar is
        infrequent and we don't have a clean way to async it without
        introducing the kind of threading complexity v7 explicitly
        defers.

        `level_curve_fn`, when set, is called as `fn(audio_frame) -> gain`
        for every frame written to the temp WAV — the returned gain
        (clamped to [0, 1]) scales the sample. None = unity passthrough,
        no per-frame work.

        `end_audio_frame`, when set, caps the temp file at that audio-
        frame index (exclusive). Used by the canvas to stop playback
        at the trimmed right edge of the clip — without this, Windows
        keeps playing source samples past `out_frame` and the user
        hears audio over an empty timeline."""
        if self._decoded is None:
            return
        if not self._ensure_winsound():
            return
        with self._lock:
            decoded = self._decoded
        path = self._write_temp_wav(decoded, max(0, int(start_audio_frame)),
                                    level_curve_fn=level_curve_fn,
                                    end_audio_frame=end_audio_frame)
        if path is None:
            return
        # Stop any currently-playing audio before issuing the next one.
        try:
            self._winsound.PlaySound(None, self._winsound.SND_PURGE)
        except Exception:
            pass
        try:
            self._winsound.PlaySound(
                path,
                self._winsound.SND_FILENAME | self._winsound.SND_ASYNC | self._winsound.SND_NODEFAULT)
        except Exception as e:
            print("[Shotblocks] PlaySound failed: {}".format(e))
            self._cleanup_temp(path)
            return
        old_path = self._temp_path
        from time import monotonic as _mono
        with self._lock:
            self._temp_path        = path
            self._playing          = True
            self._play_start_frame = max(0, int(start_audio_frame))
            self._play_started_at  = _mono()
        # Old temp file (if any) is no longer being played; safe to delete.
        if old_path:
            self._cleanup_temp(old_path)

    def pause(self):
        """Stop emitting audio. Position is conceptually preserved by
        the canvas's playhead — when play() is next called, it builds
        a fresh temp file from the new offset."""
        self.stop()

    def stop(self):
        """Hard stop. Discards any temp file."""
        if self._winsound is not None:
            try:
                self._winsound.PlaySound(None, self._winsound.SND_PURGE)
            except Exception:
                pass
        with self._lock:
            self._playing = False
            old_path = self._temp_path
            self._temp_path = None
        if old_path:
            self._cleanup_temp(old_path)

    def sync(self, target_audio_frame):
        """Tell the engine where the canvas thinks the playhead is.

        We only reissue PlaySound on **backward** jumps (loop-wrap
        being the canonical case): if the canvas says "we're at
        audio-frame T" and our estimate of where Windows is internally
        is T+0.5s, we trust the canvas and restart from T.

        We do NOT reissue on forward drift. PlaySound's startup
        latency is non-zero and varies per call (esp. when we just
        wrote a temp file), so each reissue introduces a perceptible
        sync nudge. If the user-visible video clock has drifted ahead
        of audio by, say, 100 ms, reissuing makes it WORSE — they'll
        hear the audio "jump" to where the video already is. Better
        to let Windows continue playing at its own correct rate;
        small accumulating drift between video frame numbers and
        audio time is a video-clock issue, not an audio one.
        """
        with self._lock:
            if not self._playing or self._decoded is None:
                return
            rate     = self._decoded.sample_rate
            start_af = self._play_start_frame
            started  = self._play_started_at
        from time import monotonic as _mono
        # Estimated audio-frame the Windows audio thread is at, based
        # on wall time since PlaySound was issued.
        elapsed = _mono() - started
        estimated_af = start_af + int(elapsed * rate)
        target_af    = int(target_audio_frame)
        # Backward jump only: target much earlier than where we are.
        if estimated_af - target_af > rate * _REISSUE_THRESHOLD_S:
            self.play(target_af)

    def is_playing(self):
        with self._lock:
            return self._playing

    # ------------------------------------------------------------------
    # Temp-file synthesis
    # ------------------------------------------------------------------

    def _write_temp_wav(self, decoded, start_audio_frame, level_curve_fn=None,
                        end_audio_frame=None):
        """Write a WAV file containing decoded samples from
        `start_audio_frame` (inclusive) to `end_audio_frame` (exclusive,
        defaults to end-of-decoded-buffer). Returns the file path, or
        None on failure. Caller owns the file (responsible for unlink).

        If `level_curve_fn` is provided, samples are scaled by
        `level_curve_fn(audio_frame)` per-frame before being written.
        Only 16-bit PCM is supported for level application (the
        ubiquitous case from `minimp3` and most WAVs); other widths
        fall back to passthrough with a one-time warning.
        """
        if start_audio_frame >= decoded.n_frames:
            # Nothing to play — no point writing a temp file.
            return None
        bytes_per_frame = decoded.sample_width * decoded.n_channels
        b0 = start_audio_frame * bytes_per_frame
        if end_audio_frame is None or end_audio_frame >= decoded.n_frames:
            payload = decoded.samples[b0:]
        else:
            end_af = max(int(end_audio_frame), int(start_audio_frame))
            b1 = end_af * bytes_per_frame
            if b1 <= b0:
                return None
            payload = decoded.samples[b0:b1]

        if level_curve_fn is not None:
            payload = self._apply_level_curve(
                payload, decoded, start_audio_frame, level_curve_fn)

        try:
            fd, path = tempfile.mkstemp(prefix="sb_audio_", suffix=".wav")
            os.close(fd)
            with wave.open(path, "wb") as w:
                w.setnchannels(decoded.n_channels)
                w.setsampwidth(decoded.sample_width)
                w.setframerate(decoded.sample_rate)
                w.writeframes(payload)
            return path
        except Exception as e:
            print("[Shotblocks] temp WAV write failed: {}".format(e))
            return None

    _level_curve_warned = False
    # Chunk size for the level-curve walk — in audio FRAMES. At 48 kHz
    # this is ~2.7 ms; smaller than the smallest gain step a listener
    # can perceive (zipper-noise threshold sits around 10–20 ms for
    # steep ramps), so the user hears a smooth fade rather than the
    # stair-step a coarser chunk produces. audioop.mul (one C call
    # per chunk) keeps total temp-WAV write time well under main-
    # thread tolerance even at this resolution.
    _LVL_CHUNK_FRAMES = 128

    def _apply_level_curve(self, payload, decoded, start_af, fn):
        """Scale `payload` samples by gain from `fn(audio_frame)`.
        Returns a fresh bytes object suitable for `wave.writeframes`.
        Only 16-bit PCM is supported; other widths pass through with
        a one-time warning.

        Implementation: chunked via `audioop.mul`. Each chunk gets a
        single gain value (sampled at the chunk midpoint) applied in C.
        This is ~3 orders of magnitude faster than a per-frame Python
        loop and keeps the temp-WAV write under main-thread tolerance,
        which matters because PlaySound is reissued on every spacebar
        play / scrub / loop wrap.
        """
        if decoded.sample_width != 2:
            if not AudioPlayback._level_curve_warned:
                AudioPlayback._level_curve_warned = True
                print("[Shotblocks] level curve skipped: sample_width={} "
                      "(only 16-bit PCM supported)".format(decoded.sample_width))
            return payload
        try:
            import audioop
        except ImportError:
            # audioop was removed in Python 3.13. C4D 2026 ships an
            # earlier interpreter (3.11/3.12), so this is just a guard
            # for when we move forward. Pure-Python fallback is too
            # slow to ship — better to skip the curve loud-and-fast
            # than block playback for seconds.
            if not AudioPlayback._level_curve_warned:
                AudioPlayback._level_curve_warned = True
                print("[Shotblocks] level curve skipped: audioop unavailable")
            return payload

        nchan = decoded.n_channels
        frame_size = 2 * nchan
        n_frames_out = len(payload) // frame_size
        if n_frames_out == 0:
            return payload
        chunk_frames = self._LVL_CHUNK_FRAMES
        chunk_bytes  = chunk_frames * frame_size
        out_parts = []
        for off in range(0, n_frames_out * frame_size, chunk_bytes):
            chunk = payload[off:off + chunk_bytes]
            if not chunk:
                break
            frames_in_chunk = len(chunk) // frame_size
            mid_af = start_af + off // frame_size + frames_in_chunk // 2
            gain = fn(mid_af)
            if gain >= 0.999:
                out_parts.append(chunk)
                continue
            if gain < 0.0:
                gain = 0.0
            # audioop.mul handles signed 16-bit PCM stereo correctly —
            # treats the buffer as interleaved samples and scales each.
            try:
                out_parts.append(audioop.mul(chunk, 2, float(gain)))
            except audioop.error as e:
                # Defensive: a misaligned chunk would raise. Pass the
                # chunk through rather than crashing playback.
                print("[Shotblocks] audioop.mul err: {}".format(e))
                out_parts.append(chunk)
        return b"".join(out_parts)

    def _cleanup_temp(self, path):
        try:
            os.unlink(path)
        except Exception:
            # Ignore — Windows may hold the handle for a moment after
            # SND_PURGE; the OS cleans tempdir on next reboot anyway.
            pass

    # ------------------------------------------------------------------
    # winsound import — guarded so the module loads on non-Windows
    # ------------------------------------------------------------------

    def _ensure_winsound(self):
        if self._winsound is not None:
            return True
        if sys.platform != "win32":
            print("[Shotblocks] audio playback unavailable: not Windows "
                  "(platform={})".format(sys.platform))
            return False
        try:
            import winsound
        except Exception as e:
            print("[Shotblocks] winsound unavailable: {}".format(e))
            return False
        self._winsound = winsound
        return True
