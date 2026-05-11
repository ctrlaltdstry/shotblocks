"""Pure-Python IIR filters for the v9 audio analysis pipeline.

The peak detector wants to "see" only drum-relevant content (kick
band ~50-120 Hz, snare/hi-hat band ~2-8 kHz) so vocals, pads, and
sustained melodic instruments don't drag the prominence-detection
thresholds around. A biquad bandpass per band, applied in series
on the source-rate mono signal, achieves that without any
machine-learning stem separation.

Coefficients use the standard "Audio EQ Cookbook" (Robert
Bristow-Johnson) bandpass design with constant skirt gain. Q
controls bandwidth in octaves — Q=1 gives ~1-octave passband,
which we use for both the kick (~50-120 Hz, 1.3 octaves) and
snare/hi-hat (~2-8 kHz, 2 octaves) bands.

All operations run on `array.array('h')` int16 buffers and
preserve the int16 type. Filter state is per-call so a single
buffer can be processed end-to-end without exposing state.
"""

import math
from array import array


def _biquad_bandpass_coefs(sample_rate, f0, q):
    """Constant-skirt-gain biquad bandpass coefficients.
    Returns (b0, b1, b2, a1, a2) with a0 normalized to 1."""
    if sample_rate <= 0 or f0 <= 0 or q <= 0:
        return (1.0, 0.0, 0.0, 0.0, 0.0)
    omega = 2.0 * math.pi * f0 / sample_rate
    sin_w = math.sin(omega)
    cos_w = math.cos(omega)
    alpha = sin_w / (2.0 * q)
    a0 = 1.0 + alpha
    b0 = alpha / a0
    b1 = 0.0
    b2 = -alpha / a0
    a1 = -2.0 * cos_w / a0
    a2 = (1.0 - alpha) / a0
    return (b0, b1, b2, a1, a2)


def _apply_biquad(samples, b0, b1, b2, a1, a2, scale=1.0):
    """Apply a biquad filter to an int16 sample buffer, returning a
    new `array('h')` of the same length. `scale` is a post-filter
    gain (the bandpass attenuates the signal energy outside its
    passband, so we boost a bit to compensate before clipping back
    to int16).

    Direct-form-I implementation: keeps two delay registers each on
    input and output. Pure Python is slow per-sample but a 3-min
    track at 48 kHz is ~8.6M samples per pass — runs in ~5-8 s
    on a typical CPU, comparable to the FFT pass.
    """
    n = len(samples)
    out = array('h', [0]) * n
    x1 = 0.0
    x2 = 0.0
    y1 = 0.0
    y2 = 0.0
    for i in range(n):
        x0 = float(samples[i])
        y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2 = x1
        x1 = x0
        y2 = y1
        y1 = y0
        v = int(y0 * scale)
        if v > 32767:
            v = 32767
        elif v < -32768:
            v = -32768
        out[i] = v
    return out


def bandpass(samples, sample_rate, f0, q, gain_db=0.0):
    """Apply a single-stage biquad bandpass to `samples`. Returns a
    new int16 array.

    `f0` is the centre frequency in Hz, `q` controls bandwidth.
    `gain_db` post-filter gain compensation; bandpass output is
    typically lower-energy than the input so a small boost (~12 dB)
    keeps peaks visible without clipping.
    """
    b0, b1, b2, a1, a2 = _biquad_bandpass_coefs(sample_rate, f0, q)
    scale = 10.0 ** (gain_db / 20.0)
    return _apply_biquad(samples, b0, b1, b2, a1, a2, scale=scale)


def sum_int16(a, b):
    """Return `a + b` clipped to int16. Both inputs must be the
    same length `array('h')`."""
    n = min(len(a), len(b))
    out = array('h', [0]) * n
    for i in range(n):
        v = a[i] + b[i]
        if v > 32767:
            v = 32767
        elif v < -32768:
            v = -32768
        out[i] = v
    return out


def drum_band(mono, sample_rate):
    """Build a "drum-band" signal: the mono input passed through a
    kick-band bandpass + a snare/hi-hat bandpass, summed. Vocals,
    pads, and melodic instruments are suppressed (their energy
    sits between these two bands), leaving drum transients as the
    dominant content.

    This is a cheap stand-in for stem separation. Real ML models
    (Demucs, Spleeter) do a much better job but require model
    weights and PyTorch/ONNX runtime — both rejected as deps for
    this plugin. The bandpass approach gets ~70% of the benefit
    with zero new dependencies.

    Returns a new int16 mono buffer the same length as `mono`.
    """
    if not mono or sample_rate <= 0:
        return array('h')
    # Kick / low-percussion band: ~35-140 Hz. Centre 70 Hz, Q ≈ 0.5
    # (≈2 octave bandwidth). Wide enough to catch low-tuned kicks,
    # sub drops, and bass-heavy hits whose energy sits below 50 Hz
    # OR up to 140 Hz. The earlier narrow band (Q=1.1) was missing
    # bassy percussion that didn't sit precisely on 80 Hz. Vocals
    # don't have meaningful energy this low so the wider band
    # doesn't reintroduce vocal contamination.
    kick = bandpass(mono, sample_rate, f0=70.0, q=0.5, gain_db=0.0)
    # Snare / hi-hat band: ~2-8 kHz. Centre 4 kHz, Q ≈ 0.7 (≈2
    # octave bandwidth). Catches snare crack and cymbal energy
    # while rejecting most vocal formants (which sit at 500 Hz
    # to 2 kHz).
    snare = bandpass(mono, sample_rate, f0=4000.0, q=0.7, gain_db=0.0)
    return sum_int16(kick, snare)
