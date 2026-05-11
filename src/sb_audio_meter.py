"""Stereo dBFS RMS envelope for the right-side audio meter.

Builds a per-channel RMS-over-window envelope from the decoded
audio at construction time. The renderer reads at the playhead's
current audio-frame position to drive the meter bars.

Pure Python — no `c4d`, no third-party deps. Operates directly on
the int16 PCM buffer that `sb_audio_decode.load_audio()` returns.

The envelope is independent of the mono mixdown the onset
detector uses: the meter wants per-channel levels (a stereo bar
pair), so we deinterleave on the fly without ever building a mono
buffer for it.

Resolution: ENVELOPE_WIN_MS samples per envelope entry. At
~20 ms windows on a 170 s file → ~8.5k entries per channel; each
entry is a single float dBFS value (-60..0). Total memory: ~70 KB.

Cached lazily on the AudioTrack the same way the mono mixdown is.
"""

import math
from array import array
from collections import namedtuple


# Window over which one envelope entry RMS-averages. 20 ms balances
# responsiveness (a tight kick hit takes ~30 ms to peak in this
# window) against smoothing (avoids per-sample jitter the eye can't
# read anyway). Premiere/FCP meters use roughly the same scale.
ENVELOPE_WIN_MS = 20

# Floor for dBFS. Anything below this clips to FLOOR_DBFS so the
# meter never tries to take log10 of zero. Matches the standard
# digital meter range.
FLOOR_DBFS = -60.0

# Source full-scale for int16. RMS is computed in absolute sample
# values; full-scale is 32767 (peak) → 32767 / sqrt(2) ≈ 23170 RMS
# for a sine. We use the peak value as the dBFS reference: 0 dBFS
# corresponds to a sample of magnitude 32767.
INT16_FULL_SCALE = 32767.0


StereoEnvelope = namedtuple("StereoEnvelope", [
    "channels",       # list[list[float]] — one dBFS list per channel
    "samples_per_entry",  # int — audio frames covered by one envelope entry
    "n_channels",     # int — typically 1 or 2
])


def build_envelope(decoded):
    """Return a `StereoEnvelope` for `decoded.samples`.

    For mono audio there's just one channel; for stereo (the common
    case from MP3 / WAV imports) there are two. Higher channel
    counts are folded into the first two so the meter always shows
    a left/right pair.

    Each entry's value is dBFS in [FLOOR_DBFS, 0]: 0 dB = full-scale
    sine, FLOOR_DBFS = silence (or below the floor).
    """
    if decoded is None or decoded.sample_width != 2:
        # Higher-bit-depth widths would need a wider int dtype; the
        # ship-from-WAV/MP3 path always lands at 16-bit so this is a
        # tight fit. Easy to extend when something produces 24/32-bit.
        return StereoEnvelope([], ENVELOPE_WIN_MS * 48, 0)

    nch = max(1, decoded.n_channels)
    sample_rate = decoded.sample_rate
    n_frames = decoded.n_frames
    if n_frames <= 0 or sample_rate <= 0:
        return StereoEnvelope([], 1, nch)

    # Source samples as int16 array. Same trick as the mono mixdown:
    # `array.frombytes` is two-three orders of magnitude faster than
    # struct.unpack_from per-sample.
    src = array('h')
    src.frombytes(decoded.samples)

    samples_per_entry = max(1, int(round(ENVELOPE_WIN_MS / 1000.0 * sample_rate)))
    n_entries = (n_frames + samples_per_entry - 1) // samples_per_entry

    # Build per-channel envelopes. Cap at 2 channels (left/right);
    # higher channel counts get the first two used as the meter pair.
    n_meter_ch = min(2, nch)
    envelopes = [[FLOOR_DBFS] * n_entries for _ in range(n_meter_ch)]

    floor_lin = (10.0 ** (FLOOR_DBFS / 20.0)) * INT16_FULL_SCALE
    inv_full_scale_sq = 1.0 / (INT16_FULL_SCALE * INT16_FULL_SCALE)

    for ch in range(n_meter_ch):
        ch_env = envelopes[ch]
        for e in range(n_entries):
            f0 = e * samples_per_entry
            f1 = min(n_frames, f0 + samples_per_entry)
            if f1 <= f0:
                continue
            i0 = f0 * nch + ch
            i1 = f1 * nch + ch
            # Sum-of-squares over the window for this channel only.
            ssq = 0.0
            i = i0
            while i < i1:
                v = src[i]
                ssq += v * v
                i += nch
            n_samp = f1 - f0
            if n_samp <= 0:
                continue
            mean_sq = ssq / n_samp
            # Compute RMS in normalized units, then dBFS. Fast-path
            # the FLOOR check so silent windows don't waste a sqrt.
            if mean_sq < floor_lin * floor_lin * inv_full_scale_sq:
                continue
            rms_norm = math.sqrt(mean_sq * inv_full_scale_sq)
            db = 20.0 * math.log10(rms_norm) if rms_norm > 0.0 else FLOOR_DBFS
            if db < FLOOR_DBFS:
                db = FLOOR_DBFS
            elif db > 0.0:
                db = 0.0
            ch_env[e] = db
    return StereoEnvelope(
        channels=envelopes,
        samples_per_entry=samples_per_entry,
        n_channels=n_meter_ch,
    )


def sample_at(envelope, audio_frame):
    """Return per-channel dBFS at `audio_frame`. Returns a list of
    floats matching `envelope.n_channels`. Out-of-range frames clamp
    to FLOOR_DBFS — the caller draws a fully-empty meter then."""
    if envelope is None or envelope.n_channels == 0 or not envelope.channels:
        return []
    spe = envelope.samples_per_entry
    if spe <= 0:
        return [FLOOR_DBFS] * envelope.n_channels
    idx = audio_frame // spe
    out = []
    for ch_env in envelope.channels:
        if 0 <= idx < len(ch_env):
            out.append(ch_env[idx])
        else:
            out.append(FLOOR_DBFS)
    return out
