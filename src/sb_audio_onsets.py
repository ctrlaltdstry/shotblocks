"""Onset / prominent-peak detection and beat-grid inference for v9.

Pure Python — no `c4d`, no third-party deps. Operates on a mono int16
sample buffer (`array.array('h')` produced by `sb_audio_track.mono`)
and the source `DecodedAudio` namedtuple's metadata.

Three things come out of `analyse(decoded)`:

  - **onsets** — every attack the spectral-flux pipeline finds. Dense
    (~1-3/sec on rhythmic music). Currently invisible in the UI; kept
    around because the v10+ sidechain envelope and slate engine will
    want them.
  - **peaks** — the small subset of onsets whose envelope amplitude
    sticks far above its neighbourhood. These are the "big hits" the
    user wants to cut on. Drawn as tall ticks on the audio block and
    used as snap targets.
  - **beat_grid** — (period, phase, confidence) inferred from the
    onset spike train via autocorrelation. Drawn as canvas-wide
    dashed gray lines behind everything when confidence clears
    CONFIDENCE_FLOOR.

Pipeline:

  1. Mixdown to mono (caller does this; we receive an `array('h')`).
  2. Decimate to ANALYSIS_RATE for everything below — onset detection
     doesn't care about content above 11 kHz, and the FFT count drops
     by the decimation factor squared in wall time.
  3. Frame at FFT_SIZE samples / 50 % hop, Hann window, real FFT,
     half-wave-rectified spectral flux (high-passed to skip kick
     subharmonics), normalize.
  4. Peak-pick with adaptive threshold (moving median + offset) and
     min spacing → onsets.
  5. Pick the **prominent** subset: per-onset amplitude envelope
     value, retain only those well above their local neighbourhood.
  6. Beat grid: autocorrelate the onset spike train across a
     BPM-bounded lag range; check half-lag for tempo doubling
     (common autocorrelation failure on bass-heavy music); phase
     from the strongest onset, not the first.

All audio-frame outputs are in **source-rate frames** so they survive
the decimation and match `DecodedAudio.n_frames`,
`trim_start_audio_frames`, and the canvas's audio-frame math.
"""

import math
import time
from array import array


# ---------------------------------------------------------------------------
# Tunables
# ---------------------------------------------------------------------------

FFT_SIZE        = 256               # samples per analysis frame
HOP_SIZE        = 192               # ~75 % step (lower overlap → fewer frames)
HP_BIN_LOW_HZ   = 60.0              # ignore DC + sub-bass for flux
THRESHOLD_OFFSET = 0.10             # added to moving-median threshold
THRESHOLD_WIN_MS = 200              # window for moving median
MIN_ONSET_GAP_MS = 50               # minimum spacing between onsets
GRID_BPM_MIN    = 60                # tempo search range (autocorrelation)
GRID_BPM_MAX    = 200
CONFIDENCE_FLOOR = 0.5              # beat grid hidden below this in canvas

# Prominent-peak detection — pure envelope local-maxima. No
# spectral flux involved; we walk the amplitude envelope itself
# and pick its tall spikes. Matches what the user sees in the
# waveform display.
#
# Pipeline:
#   1. Build the amplitude envelope at ENV_BIN_MS resolution
#      (max |sample| within each bin so brief peaks don't get
#      averaged away).
#   2. Smooth lightly via SMOOTH_BINS-bin moving average to kill
#      single-bin noise spikes.
#   3. Find every local maximum (bin > both neighbours).
#   4. Reject any whose value is below max(global_floor,
#      median * MEDIAN_RATIO). Median-relative gate kicks in for
#      tracks with a high noise floor where the global cutoff is
#      too permissive; global gate kicks in for tracks with sparse
#      peaks where the median is near silence.
#   5. Enforce MIN_GAP spacing — keep the higher of any two
#      maxima within the gap.
PEAK_ENV_BIN_MS         = 5      # envelope time resolution
PEAK_SMOOTH_BINS        = 5      # ~25 ms moving-average smoothing
PEAK_GLOBAL_FLOOR_PCT   = 0.65   # absolute floor: below this fraction of
                                 # the file's loudest bin, never qualify.
                                 # The drum-band filter (sb_audio_filters)
                                 # already removes vocals/pads from the
                                 # signal, so the floor is the only
                                 # threshold needed. Local-prominence
                                 # checking was tried and removed — it
                                 # punished loud sections (rolling baseline
                                 # too high) and over-fired in quiet
                                 # intros (rolling baseline too low).
PEAK_MIN_GAP_MS         = 400    # min spacing between prominent peaks.
                                 # When two candidates land closer than
                                 # this, the louder one wins and the other
                                 # is dropped. 400 ms ≈ slower than any
                                 # meaningful musical subdivision at
                                 # typical tempos, so close-together
                                 # markers feel like "the same hit
                                 # detected twice" rather than a fast
                                 # rhythmic pattern.

# Onset detection runs on a heavily downsampled signal — only the
# envelope shape matters for onsets, not high-frequency content.
# 11025 Hz is the standard onset-detection rate (covers everything
# up to ~5.5 kHz, well past kicks/snares/hats). Decimation factor is
# typically 4 (48 kHz → 11.025 kHz, 44.1 → 11.025).
ANALYSIS_RATE = 11025


# ---------------------------------------------------------------------------
# Mono mixdown
# ---------------------------------------------------------------------------

def mixdown_to_mono(decoded):
    """Return an `array('h')` of int16 mono samples for `decoded`.

    Stereo → average of L/R; >2 channels → mean of all channels. Works
    on the raw `decoded.samples` bytes (little-endian PCM, sample_width
    bytes per channel-sample). Only sample_width=2 is supported here —
    matches the WAV/MP3 paths we ship.
    """
    if decoded is None or decoded.sample_width != 2:
        # Higher widths would need scaling. Easy to add when something
        # actually produces 24/32-bit output; for now signal nothing.
        return array('h')
    nch = decoded.n_channels
    if nch < 1:
        return array('h')
    src = array('h')
    src.frombytes(decoded.samples)
    if nch == 1:
        return src
    nframes = len(src) // nch
    mono = array('h', [0]) * nframes
    if nch == 2:
        for i in range(nframes):
            j = i << 1
            mono[i] = (src[j] + src[j + 1]) >> 1
        return mono
    for i in range(nframes):
        s = 0
        base = i * nch
        for c in range(nch):
            s += src[base + c]
        mono[i] = s // nch
    return mono


# ---------------------------------------------------------------------------
# FFT — iterative radix-2 Cooley-Tukey, in-place on parallel real/imag arrays
# ---------------------------------------------------------------------------

def _bit_reverse_indices(n):
    """Precompute the bit-reversal permutation for size n (n = 2**k)."""
    bits = n.bit_length() - 1
    out = [0] * n
    for i in range(n):
        x = i
        r = 0
        for _ in range(bits):
            r = (r << 1) | (x & 1)
            x >>= 1
        out[i] = r
    return out


def _twiddles(n):
    """Precompute exp(-2*pi*i*k/n) for k in [0, n/2). Returned as
    parallel cos/sin lists so the FFT inner loop avoids complex
    arithmetic (faster in pure Python)."""
    half = n >> 1
    cs = [0.0] * half
    sn = [0.0] * half
    for k in range(half):
        a = -2.0 * math.pi * k / n
        cs[k] = math.cos(a)
        sn[k] = math.sin(a)
    return cs, sn


# Cache per-size bit-reversal + twiddle tables — `analyse` is called
# once per audio import, but inside it we hit the same FFT_SIZE for
# every frame, so this saves ~17k recomputations on a 3-min track.
_FFT_CACHE = {}


def _get_fft_tables(n):
    t = _FFT_CACHE.get(n)
    if t is None:
        t = (_bit_reverse_indices(n), _twiddles(n))
        _FFT_CACHE[n] = t
    return t


def _fft_magnitudes(re, im, n, br, cs, sn):
    """In-place radix-2 FFT, then return magnitudes for bins [0, n/2].

    `re`/`im` are mutable lists of length `n`; caller fills `re` from
    the windowed sample frame and zeros `im` before each call. We
    permute via `br` (bit reversal), butterfly in log2(n) stages, then
    take sqrt(re*re + im*im) for the lower half + Nyquist bin.
    """
    # Bit-reversal permutation. Swap when br[i] > i to avoid double swaps.
    for i in range(n):
        j = br[i]
        if j > i:
            re[i], re[j] = re[j], re[i]
            # im is all-zero on entry; no need to swap.

    # Cooley-Tukey butterflies. `size` doubles each stage from 2 → n.
    size = 2
    while size <= n:
        half = size >> 1
        step = n // size
        for start in range(0, n, size):
            k = 0
            for i in range(start, start + half):
                # Twiddle index: k = (i-start) * step. Inline because
                # multiplication is cheaper than recomputing in the loop.
                tc = cs[k]
                ts = sn[k]
                ai = i + half
                tr = re[ai] * tc - im[ai] * ts
                ti = re[ai] * ts + im[ai] * tc
                re[ai] = re[i] - tr
                im[ai] = im[i] - ti
                re[i] = re[i] + tr
                im[i] = im[i] + ti
                k += step
        size <<= 1

    # Magnitudes for the lower half + Nyquist (bins [0, n/2]).
    half = n >> 1
    mags = [0.0] * (half + 1)
    for i in range(half + 1):
        mags[i] = math.sqrt(re[i] * re[i] + im[i] * im[i])
    return mags


# ---------------------------------------------------------------------------
# Spectral flux + onset peak pick
# ---------------------------------------------------------------------------

def _hann_window(n):
    """Return a Hann window of length n. Reduces spectral leakage so
    a sustained tone doesn't smear flux across neighbouring frames
    and look like an onset."""
    if n <= 1:
        return [1.0] * n
    w = [0.0] * n
    denom = float(n - 1)
    for i in range(n):
        w[i] = 0.5 - 0.5 * math.cos(2.0 * math.pi * i / denom)
    return w


def _moving_median(values, win):
    """O(n*win) moving median — cheap enough for ~17k flux samples
    with win~10 and avoids pulling in heapq tricks."""
    n = len(values)
    if n == 0 or win <= 1:
        return list(values)
    half = win // 2
    out = [0.0] * n
    for i in range(n):
        lo = max(0, i - half)
        hi = min(n, i + half + 1)
        window = sorted(values[lo:hi])
        out[i] = window[len(window) >> 1]
    return out


def _decimate(mono, src_rate, target_rate):
    """Integer-factor decimation with running-average pre-filter.

    Source rate is always >= target_rate in practice (48 k or 44.1 k
    → 22 kHz). Computes the smallest integer factor that brings rate
    at-or-below target, averages each block of `factor` source samples
    to a single output sample. The averaging is a crude FIR low-pass —
    not ideal but enough for onset detection, where we only need the
    energy envelope to survive.

    Returns (decimated_array, effective_rate, factor).
    """
    factor = max(1, int(round(src_rate / float(target_rate))))
    if factor == 1:
        return mono, src_rate, 1
    n = len(mono) // factor
    out = array('h', [0]) * n
    inv = 1.0 / factor
    for i in range(n):
        base = i * factor
        s = 0
        for k in range(factor):
            s += mono[base + k]
        out[i] = int(s * inv)
    return out, src_rate / float(factor), factor


def _compute_spectral_flux(mono, sample_rate):
    """Return (flux_values, source_audio_frames_per_flux_frame).

    flux_values[k] = positive spectral difference between flux frame
    k and k-1. The second return value is the stride in *source-rate*
    audio frames between consecutive flux entries — i.e. HOP_SIZE
    multiplied by the decimation factor. The caller multiplies onset
    flux indices by this to get source-rate audio-frame positions.
    """
    decimated, _eff_rate, factor = _decimate(mono, sample_rate, ANALYSIS_RATE)
    n = len(decimated)
    src_stride = HOP_SIZE * factor
    if n < FFT_SIZE * 2:
        return [], src_stride
    br, (cs, sn) = _get_fft_tables(FFT_SIZE)
    win = _hann_window(FFT_SIZE)

    # Skip bins below HP_BIN_LOW_HZ to suppress kick subharmonics.
    # bin_hz uses the *post-decimation* rate.
    eff_rate = sample_rate / float(factor)
    bin_hz = eff_rate / float(FFT_SIZE)
    bin_lo = max(1, int(math.ceil(HP_BIN_LOW_HZ / bin_hz)))
    bin_hi = (FFT_SIZE >> 1) + 1

    re = [0.0] * FFT_SIZE
    im = [0.0] * FFT_SIZE

    n_frames = 1 + (n - FFT_SIZE) // HOP_SIZE
    flux = [0.0] * n_frames
    prev_mags = None
    for f in range(n_frames):
        off = f * HOP_SIZE
        # Hann-windowed real samples. The window kills spectral
        # leakage; without it, sustained tones look like onsets.
        for i in range(FFT_SIZE):
            re[i] = decimated[off + i] * win[i]
            im[i] = 0.0
        mags = _fft_magnitudes(re, im, FFT_SIZE, br, cs, sn)
        if prev_mags is not None:
            s = 0.0
            for b in range(bin_lo, bin_hi):
                d = mags[b] - prev_mags[b]
                if d > 0.0:
                    s += d
            flux[f] = s
        prev_mags = mags

    # Normalize to [0, 1] so thresholds are tunable in absolute terms.
    if flux:
        m = max(flux)
        if m > 0.0:
            inv = 1.0 / m
            for i in range(len(flux)):
                flux[i] *= inv
    return flux, src_stride


def _peak_pick(flux, src_stride, sample_rate):
    """Pick onsets from the spectral-flux signal.

    Returns parallel lists `(audio_frame_positions, strengths)`. The
    strength is the flux value at the onset's flux-frame index — used
    later for phase alignment (strongest-onset phase) and prominent-
    peak filtering.

    Adaptive: subtract a moving-median "background" and require the
    residual to clear THRESHOLD_OFFSET. Enforce MIN_ONSET_GAP_MS
    between consecutive onsets so a single attack's envelope doesn't
    fire twice.
    """
    n = len(flux)
    if n == 0:
        return [], []

    # Moving-median window in *flux frames*, derived from
    # THRESHOLD_WIN_MS and the source-rate stride per flux frame.
    flux_frames_per_s = sample_rate / float(src_stride)
    win = max(3, int(round(THRESHOLD_WIN_MS / 1000.0 * flux_frames_per_s)))
    if (win & 1) == 0:
        win += 1
    median = _moving_median(flux, win)

    # Min spacing in flux frames.
    min_gap = max(1, int(round(MIN_ONSET_GAP_MS / 1000.0 * flux_frames_per_s)))

    positions = []
    strengths = []
    last_flux_idx = -10**9
    for i in range(1, n - 1):
        v = flux[i]
        thr = median[i] + THRESHOLD_OFFSET
        if v < thr:
            continue
        # Local-max check against neighbours.
        if v < flux[i - 1] or v < flux[i + 1]:
            continue
        if i - last_flux_idx < min_gap:
            # Already fired recently — keep the higher peak.
            if positions and v > strengths[-1]:
                positions[-1] = i * src_stride
                strengths[-1] = v
                last_flux_idx = i
            continue
        positions.append(i * src_stride)
        strengths.append(v)
        last_flux_idx = i
    return positions, strengths


# ---------------------------------------------------------------------------
# Beat grid inference — autocorrelation of the onset spike train
# ---------------------------------------------------------------------------

def _build_spike_train(onsets, strengths, n_audio_frames, src_stride):
    """Convert sparse onset list to a dense weighted signal at the
    flux-frame rate (one entry per `src_stride` source-rate frames).
    Used by autocorrelation. Strength-weighted so strong hits drive
    the autocorrelation peak more than ghost notes."""
    n = max(0, n_audio_frames // src_stride)
    spikes = [0.0] * n
    for af, w in zip(onsets, strengths):
        idx = af // src_stride
        if 0 <= idx < n:
            spikes[idx] = max(spikes[idx], float(w))
    return spikes


def _autocorrelate(signal, lag_lo, lag_hi):
    """Return the autocorrelation of `signal` for lags in [lag_lo, lag_hi).
    Plain O(N*L) double loop — N is ~17k for a 3-min track, lag span
    ~hundreds; well under a second."""
    n = len(signal)
    if n < lag_hi:
        lag_hi = n
    if lag_lo >= lag_hi:
        return []
    out = [0.0] * (lag_hi - lag_lo)
    for lag in range(lag_lo, lag_hi):
        s = 0.0
        end = n - lag
        for i in range(end):
            s += signal[i] * signal[i + lag]
        out[lag - lag_lo] = s
    return out


def infer_beat_grid(onsets, strengths, src_stride, decoded):
    """Return (period_audio_frames, phase_audio_frames, confidence)
    for the dominant pulse in `onsets`. Returns None if there's not
    enough data or the autocorrelation peak is too weak.

    Two key behaviours beyond the textbook autocorrelation:

    1. *Half-tempo escape.* On bass-heavy material the spike train's
       autocorrelation often peaks at 2× the true beat (every-other-
       beat correlation is stronger when the kick lands on those
       beats). After picking the dominant lag we check whether
       half-the-lag has comparable energy and prefer the faster
       tempo when it does — i.e., 173 BPM beats 86.5 BPM if both
       autocorrelation values are within range.
    2. *Strongest-onset phase.* The first onset is rarely the
       downbeat (intros, pickups, breath sounds). Instead, score
       every candidate phase modulo the period by summing the
       strengths of onsets that land near it; pick the highest.
    """
    if len(onsets) < 8:
        return None

    sample_rate = decoded.sample_rate
    spikes = _build_spike_train(onsets, strengths, decoded.n_frames, src_stride)
    if not spikes:
        return None

    # BPM bounds → lag bounds in flux frames.
    flux_per_s = sample_rate / float(src_stride)
    lag_hi = max(2, int(round(60.0 / GRID_BPM_MIN * flux_per_s)) + 1)
    lag_lo = max(1, int(round(60.0 / GRID_BPM_MAX * flux_per_s)))
    ac = _autocorrelate(spikes, lag_lo, lag_hi)
    if not ac:
        return None

    # Find the peak lag and compute confidence as peak/mean.
    best_idx = 0
    best_val = ac[0]
    for i in range(1, len(ac)):
        if ac[i] > best_val:
            best_val = ac[i]
            best_idx = i
    mean = sum(ac) / len(ac)
    if mean <= 0.0 or best_val <= 0.0:
        return None

    period_flux = best_idx + lag_lo

    # Half-tempo escape: if half the period also lands a strong AC
    # value (within DOUBLING_THRESHOLD of the chosen peak), prefer
    # the faster tempo. Walk down halving until either the half-lag
    # falls below GRID_BPM_MAX's lag bound or its AC value drops
    # below the threshold.
    DOUBLING_THRESHOLD = 0.55   # half-period must be >=55% of full
    while True:
        half = period_flux // 2
        if half < lag_lo:
            break
        ac_idx = half - lag_lo
        if ac_idx < 0 or ac_idx >= len(ac):
            break
        if ac[ac_idx] >= DOUBLING_THRESHOLD * best_val:
            period_flux = half
            best_val = ac[ac_idx]
        else:
            break

    confidence = (best_val / mean - 1.0) / 2.0  # 0 when peak == mean
    confidence = max(0.0, min(1.0, confidence))
    period_audio = period_flux * src_stride
    if period_audio <= 0:
        return None

    # Phase: score every candidate phase by the total strength of
    # onsets that land within a small window of (k*period + phase)
    # for any k. Walk phase across [0, period) at a coarse resolution
    # (one flux-frame step) — period_flux is at most ~50 entries in
    # the BPM range we search, so this is O(period * len(onsets))
    # and tiny next to the FFT.
    phase_audio = _best_phase(onsets, strengths, period_audio, src_stride)

    return (int(period_audio), int(phase_audio), float(confidence))


def _best_phase(onsets, strengths, period_audio, src_stride):
    """Pick the phase offset that maximizes total onset strength
    landing near (k*period + phase) for any k.

    Iterates phase candidates at flux-frame resolution (`src_stride`
    audio-frames each) since aligning to sub-flux-frame precision is
    pointless when onsets themselves only quantize to that grid.
    Tolerates a 1-flux-frame tolerance window on either side so the
    score isn't sensitive to rounding.
    """
    if not onsets:
        return 0
    period_flux = max(1, period_audio // src_stride)
    tol = 1
    best_phase_flux = 0
    best_score = -1.0
    for p_flux in range(period_flux):
        s = 0.0
        for af, w in zip(onsets, strengths):
            d = (af // src_stride - p_flux) % period_flux
            if d <= tol or d >= period_flux - tol:
                s += w
        if s > best_score:
            best_score = s
            best_phase_flux = p_flux
    return best_phase_flux * src_stride


# ---------------------------------------------------------------------------
# Prominent-peak filter — selects "big visible hits" from the onsets
# ---------------------------------------------------------------------------

def detect_prominent_peaks(mono, onsets, decoded):
    """Find audio frames where the amplitude envelope locally peaks.

    Pure envelope-walking: no spectral flux, no onset filter, no
    local-context ratio. The user reads the waveform visually and
    expects ticks where the line is tallest — this matches that
    intuition directly.

    Algorithm:
      1. Bin the mono signal into ENV_BIN_MS chunks; each bin's
         value is the max |sample| in the chunk (so a single
         transient survives without being averaged into mush).
      2. Smooth across SMOOTH_BINS bins to kill single-bin noise.
      3. Walk the smoothed envelope; every bin that strictly
         exceeds both neighbours is a candidate peak.
      4. Reject candidates below max(global_floor, median_floor):
         the higher of the two thresholds wins. Global floor catches
         "compared to the loudest moment in the song"; median floor
         catches "compared to the song's typical noise level".
      5. Enforce MIN_GAP_MS spacing.

    `onsets` is unused — kept in the signature so the call site
    in `analyse()` doesn't need to change. Returns
    (peak_audio_frames, peak_envelope_strengths).
    """
    if not mono:
        return [], []
    sample_rate = decoded.sample_rate
    n = len(mono)
    if n <= 0:
        return [], []

    # Step 1: per-bin |sample| max envelope.
    samples_per_bin = max(1, int(round(PEAK_ENV_BIN_MS / 1000.0 * sample_rate)))
    n_bins = (n + samples_per_bin - 1) // samples_per_bin
    env = [0] * n_bins
    for b in range(n_bins):
        i0 = b * samples_per_bin
        i1 = min(n, i0 + samples_per_bin)
        m = 0
        for i in range(i0, i1):
            v = mono[i]
            absv = v if v >= 0 else -v
            if absv > m:
                m = absv
        env[b] = m

    # Step 2: smooth via centred SMOOTH_BINS-bin moving average.
    if PEAK_SMOOTH_BINS > 1 and n_bins >= PEAK_SMOOTH_BINS:
        half = PEAK_SMOOTH_BINS // 2
        smoothed = [0.0] * n_bins
        # Rolling-window sum for O(N).
        running = 0
        for i in range(min(PEAK_SMOOTH_BINS, n_bins)):
            running += env[i]
        for b in range(n_bins):
            lo = b - half
            hi = b + half + 1
            if lo < 0 or hi > n_bins:
                # Edge: fall back to a per-bin recompute over the
                # truncated window. Cheap because edges are rare.
                lo_c = max(0, lo)
                hi_c = min(n_bins, hi)
                s = 0
                for j in range(lo_c, hi_c):
                    s += env[j]
                smoothed[b] = s / float(hi_c - lo_c)
            else:
                # Maintain running sum: drop the bin that just left,
                # add the bin that just entered.
                if b > half:
                    running += env[b + half] - env[b - half - 1]
                smoothed[b] = running / float(PEAK_SMOOTH_BINS)
    else:
        smoothed = [float(v) for v in env]

    # Global maximum drives the absolute floor.
    global_max = 0.0
    for v in smoothed:
        if v > global_max:
            global_max = v
    if global_max <= 0.0:
        return [], []
    abs_floor = global_max * PEAK_GLOBAL_FLOOR_PCT

    # Walk the smoothed envelope; pick local maxima above the floor.
    # Use ≥ on one side and > on the other so flat tops register
    # exactly once (at the leftmost equal bin).
    candidates = []  # list of (audio_frame, smoothed_env_value)
    for b in range(1, n_bins - 1):
        v = smoothed[b]
        if v < abs_floor:
            continue
        if v < smoothed[b - 1] or v <= smoothed[b + 1]:
            continue
        af = b * samples_per_bin + samples_per_bin // 2
        candidates.append((af, v))

    if not candidates:
        return [], []

    # Step 5: enforce MIN_GAP. Sweep keeping the louder of any two
    # within the gap.
    min_gap = int(round(PEAK_MIN_GAP_MS / 1000.0 * sample_rate))
    kept = []
    for af, v in candidates:
        if kept and af - kept[-1][0] < min_gap:
            if v > kept[-1][1]:
                kept[-1] = (af, v)
            continue
        kept.append((af, v))

    positions = [k[0] for k in kept]
    strengths = [k[1] for k in kept]
    return positions, strengths


# ---------------------------------------------------------------------------
# Public entry points
# ---------------------------------------------------------------------------

def detect_onsets(mono, decoded):
    """Run spectral-flux onset detection on a mono int16 buffer.

    Returns parallel lists `(positions, strengths, src_stride)`.
    `positions` are source-rate audio-frame indices; `strengths`
    are normalized flux values (≈ relative onset energy);
    `src_stride` is the source-rate frames per flux frame (needed
    by `infer_beat_grid` to reuse the same time grid).

    `mono` is the `array('h')` produced by `mixdown_to_mono(decoded)`.
    """
    if not mono or decoded is None:
        return [], [], HOP_SIZE
    flux, src_stride = _compute_spectral_flux(mono, decoded.sample_rate)
    if not flux:
        return [], [], src_stride
    positions, strengths = _peak_pick(flux, src_stride, decoded.sample_rate)
    return positions, strengths, src_stride


def analyse(decoded, mono=None, peak_signal=None):
    """One-shot: onsets, prominent peaks, beat grid, wall-clock time.

    Returns (onsets, peaks, beat_grid_or_None, elapsed_seconds).
      - `onsets`: list of source-rate audio-frame indices (every
        attack the spectral-flux pipeline picked, on the full-
        spectrum mono signal).
      - `peaks`: prominent peaks from the envelope walker. When
        `peak_signal` is supplied (typically a drum-bandpass
        filtered version of the mono), peaks are detected on
        that signal — vocals/pads are suppressed so only
        drum-relevant transients drive the peak filter.
        Defaults to the full mono if no peak_signal is given.
      - `beat_grid`: (period, phase, confidence) or None.

    `mono` and `peak_signal` are both optional. Caller logs the
    elapsed seconds for a perf-regression check.
    """
    t0 = time.monotonic()
    if mono is None:
        mono = mixdown_to_mono(decoded)
    onsets, strengths, src_stride = detect_onsets(mono, decoded)
    # Peaks run on `peak_signal` when provided (e.g. drum-band
    # filtered mono); otherwise fall back to the full mono. Onsets
    # and beat grid stay on the full-spectrum mono — they need the
    # widest frequency content to fire on every attack.
    if peak_signal is None:
        peak_signal = mono
    peaks, _peak_envs = detect_prominent_peaks(peak_signal, onsets, decoded)
    grid = (infer_beat_grid(onsets, strengths, src_stride, decoded)
            if onsets else None)
    return onsets, peaks, grid, time.monotonic() - t0


def grid_is_displayable(grid):
    """Confidence gate for the canvas. Hidden when the autocorrelation
    didn't land a clear peak — matches the open-question default of
    'no phantom grid for ambient material'."""
    if grid is None:
        return False
    _period, _phase, conf = grid
    return conf >= CONFIDENCE_FLOOR
