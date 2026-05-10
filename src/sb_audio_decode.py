"""WAV decoding for the v7 audio subsystem (and a format-agnostic
dispatcher used since v8).

Pure Python — no `c4d` import, no third-party deps. Uses the stdlib
`wave` module, which the v7 spike confirmed is bundled with C4D 2026's
Python build (3.11.4). MP3 support lives in `sb_audio_decode_mp3` and
is dispatched from `load_audio()` below.

Scope is intentionally narrow: open a WAV file, return raw samples plus
the metadata downstream modules need. Channel mixdown to mono and the
peak cache live in sibling modules.

Returns a `DecodedAudio` namedtuple:
    samples       — bytes (raw little-endian PCM, exactly as wav.readframes returned)
    sample_rate   — int Hz (e.g. 44100)
    sample_width  — int bytes per sample per channel (1, 2, 3, 4)
    n_channels    — int (1 = mono, 2 = stereo)
    n_frames      — int (frames; for stereo, frames * 2 = sample count)
    duration_s    — float

The raw `bytes` is intentional — winsound expects bytes, peak cache
prefers bytes for cheap struct.unpack iteration, and copying out to a
list of ints would balloon a 5-minute 44.1k stereo file from ~52 MB to
~200 MB+ (Python int overhead). Decoders for compressed formats land
in v8+ as separate modules with the same return shape.
"""

import os
import wave
from collections import namedtuple


DecodedAudio = namedtuple("DecodedAudio", [
    "samples", "sample_rate", "sample_width", "n_channels",
    "n_frames", "duration_s",
])


# Cap rejects decoded payload over this many bytes. 5-min 48k stereo
# 16-bit ≈ 55 MB; this lets ~30 min through, which is plenty for v7.
# Larger files get rejected with a clear message rather than blowing
# C4D's memory.
_MAX_BYTES = 350 * 1024 * 1024  # 350 MB hard ceiling


class AudioDecodeError(Exception):
    """Raised when a WAV file is unreadable, unsupported, or oversized."""


def load_wav(path):
    """Decode a .wav file and return a `DecodedAudio`.

    Raises `AudioDecodeError` on any failure (file missing, not a WAV,
    compressed payload, oversized). Does not catch — callers decide
    whether to log + ignore or surface to the user.
    """
    if not path:
        raise AudioDecodeError("empty audio path")
    if not os.path.exists(path):
        raise AudioDecodeError("audio file not found: {}".format(path))

    try:
        wav = wave.open(path, "rb")
    except wave.Error as e:
        raise AudioDecodeError("not a readable WAV: {} ({})".format(path, e))
    except Exception as e:
        raise AudioDecodeError("could not open: {} ({}: {})".format(
            path, type(e).__name__, e))

    try:
        n_channels   = wav.getnchannels()
        sample_width = wav.getsampwidth()
        sample_rate  = wav.getframerate()
        n_frames     = wav.getnframes()
        comp_type    = wav.getcomptype()

        if comp_type not in ("NONE",):
            raise AudioDecodeError(
                "compressed WAV not supported in v7 ({}); "
                "re-export as uncompressed PCM".format(comp_type))
        if sample_width not in (1, 2, 3, 4):
            raise AudioDecodeError(
                "unsupported sample width: {} bytes".format(sample_width))
        if n_channels < 1 or n_channels > 8:
            raise AudioDecodeError(
                "unsupported channel count: {}".format(n_channels))

        total_bytes = n_frames * n_channels * sample_width
        if total_bytes > _MAX_BYTES:
            raise AudioDecodeError(
                "WAV too large for v7: {:.1f} MB (cap {:.0f} MB). "
                "Trim or down-sample before importing.".format(
                    total_bytes / (1024 * 1024),
                    _MAX_BYTES / (1024 * 1024)))

        samples = wav.readframes(n_frames)
    finally:
        wav.close()

    duration_s = n_frames / float(sample_rate) if sample_rate > 0 else 0.0

    return DecodedAudio(
        samples=samples,
        sample_rate=sample_rate,
        sample_width=sample_width,
        n_channels=n_channels,
        n_frames=n_frames,
        duration_s=duration_s,
    )


def is_wav_path(path):
    """Cheap extension check used by the canvas drag-receive filter
    before we bother decoding. Case-insensitive."""
    if not path:
        return False
    return os.path.splitext(path)[1].lower() == ".wav"


def is_audio_path(path):
    """True if the path's extension matches any decoder we ship.
    Drag-receive uses this to pick which paths to accept.

    The MP3 branch only returns True when the bundled minimp3 DLL
    actually loaded — drops of `.mp3` files are silently rejected on
    a build where the DLL is missing or unloadable, instead of
    failing mid-import."""
    if is_wav_path(path):
        return True
    try:
        from sb_audio_decode_mp3 import is_mp3_path, is_available
        if is_mp3_path(path) and is_available():
            return True
    except ImportError:
        pass
    return False


def load_audio(path):
    """Format-agnostic decode dispatcher. Picks `load_wav` or
    `load_mp3` by extension. Raises `AudioDecodeError` if no decoder
    is available for the file's extension."""
    if is_wav_path(path):
        return load_wav(path)
    ext = os.path.splitext(path)[1].lower()
    if ext == ".mp3":
        try:
            from sb_audio_decode_mp3 import load_mp3
        except ImportError as e:
            raise AudioDecodeError(
                "MP3 decoder module not available: {}".format(e))
        return load_mp3(path)
    raise AudioDecodeError(
        "unsupported audio format: {} (only .wav and .mp3)".format(ext))
