"""Waveform peak cache for the v7 audio subsystem.

Pure Python — no `c4d`, no NumPy. The cache reduces a `DecodedAudio`'s
raw PCM bytes into a list of `(min, max)` tuples normalized to [-1, 1],
one per "column" where a column is `samples_per_column` consecutive
samples. The renderer draws one vertical line per column.

Built once at import. The renderer downsamples the cache to the
on-screen block width via nearest-neighbor at draw time — cheap
enough to do every redraw, with no rebuild during pan/zoom. (An
earlier version rebuilt the cache when zoom changed; that put a
multi-hundred-ms full-file scan into every zoom-drag tick, which
made zoom unusable.)

Build perf: the hot loop uses `array.array('h'/'i'/'b').frombytes(raw)`
to decode the entire buffer in one C call, then iterates the array
in Python with min/max per column. For 170 s × 48 kHz stereo 16-bit
that's ~150 ms total on a typical laptop — acceptable for a one-time
import cost.

Trim-aware slicing is supported: callers pass audio-frame bounds and
get back the corresponding peak slice. v7's audio block is
draggable + edge-resizable per the user's design decision; the canvas
converts edge positions to sample offsets and asks for a sliced peak
window.
"""

import array
from collections import namedtuple


PeakCache = namedtuple("PeakCache", [
    "peaks",                # list of (float min, float max), -1..1
    "samples_per_column",   # int, audio-frames per column
    "n_columns",             # int, len(peaks)
    "source_rate",          # int Hz, copied from DecodedAudio for sanity checks
    "source_n_frames",      # int, copied from DecodedAudio
])


def build(decoded, samples_per_column):
    """Build a `PeakCache` over the entire decoded audio at the given rate.

    `samples_per_column` is the number of audio frames each column
    summarizes. At zoom level F frames-per-pixel and source rate R,
    the canvas should request `samples_per_column = max(1, R / fps * F)`
    so one column equals one pixel of the final waveform render.
    """
    if samples_per_column < 1:
        samples_per_column = 1

    n_frames = decoded.n_frames
    nch      = decoded.n_channels
    sw       = decoded.sample_width
    raw      = decoded.samples

    if n_frames <= 0 or nch <= 0:
        return PeakCache([], samples_per_column, 0, decoded.sample_rate, 0)

    # Normalization scale: full-scale signed N-bit -> 1.0.
    # Sample widths: 1 byte = unsigned 0..255 (centered at 128).
    #                2/3/4 bytes = signed little-endian.
    if sw == 1:
        norm = 1.0 / 128.0
    elif sw == 2:
        norm = 1.0 / 32768.0
    elif sw == 3:
        norm = 1.0 / (1 << 23)
    elif sw == 4:
        norm = 1.0 / (1 << 31)
    else:
        # Caught upstream in load_wav; defensive only.
        return PeakCache([], samples_per_column, 0,
                         decoded.sample_rate, n_frames)

    n_columns = (n_frames + samples_per_column - 1) // samples_per_column
    peaks     = [(0.0, 0.0)] * n_columns

    # Decode the entire buffer to a flat array of channel-interleaved
    # samples in one C call. `array.array.frombytes` is two-three orders
    # of magnitude faster than per-sample struct.unpack_from.
    if sw == 1:
        # WAV 8-bit is unsigned 0..255. Use 'B' then center.
        flat = array.array('B')
        flat.frombytes(raw)
        center = 128
    elif sw == 2:
        flat = array.array('h')   # signed short, native byte order on Windows = LE
        flat.frombytes(raw)
        center = 0
    elif sw == 4:
        flat = array.array('i')   # signed int32 LE
        flat.frombytes(raw)
        center = 0
    elif sw == 3:
        # No native 24-bit type. Fall back to per-sample read — uncommon
        # in practice (24-bit WAV is rare from consumer tools).
        flat = None
        center = 0
    else:
        return PeakCache([], samples_per_column, 0,
                         decoded.sample_rate, n_frames)

    samples_per_col_x_nch = samples_per_column * nch

    if flat is not None:
        # Iterate the flat array, building per-column min/max. Stride
        # by samples_per_col_x_nch so each column covers exactly
        # samples_per_column audio frames across all channels.
        n_total = len(flat)
        for col in range(n_columns):
            i0 = col * samples_per_col_x_nch
            i1 = i0 + samples_per_col_x_nch
            if i1 > n_total:
                i1 = n_total
            if i0 >= i1:
                peaks[col] = (0.0, 0.0)
                continue
            # Slice + min/max are C-implemented; this is the fast path.
            seg = flat[i0:i1]
            seg_min = min(seg) - center
            seg_max = max(seg) - center
            mn = seg_min * norm
            mx = seg_max * norm
            if mn < -1.0: mn = -1.0
            if mx >  1.0: mx =  1.0
            peaks[col] = (mn, mx)
    else:
        # 24-bit fallback — rare. Per-sample loop preserved for
        # correctness; performance acceptable for short clips.
        bytes_per_frame = sw * nch
        for col in range(n_columns):
            f0 = col * samples_per_column
            f1 = min(n_frames, f0 + samples_per_column)
            if f1 <= f0:
                peaks[col] = (0.0, 0.0)
                continue
            b0 = f0 * bytes_per_frame
            b1 = f1 * bytes_per_frame
            mn =  1e9
            mx = -1e9
            for off in range(b0, b1, 3):
                lo = raw[off]
                md = raw[off + 1]
                hi = raw[off + 2]
                v_int = lo | (md << 8) | (hi << 16)
                if v_int & 0x800000:
                    v_int -= 0x1000000
                v = v_int * norm
                if v < mn: mn = v
                if v > mx: mx = v
            if mn > mx:
                mn = mx = 0.0
            if mn < -1.0: mn = -1.0
            if mx >  1.0: mx =  1.0
            peaks[col] = (mn, mx)

    return PeakCache(
        peaks=peaks,
        samples_per_column=samples_per_column,
        n_columns=n_columns,
        source_rate=decoded.sample_rate,
        source_n_frames=n_frames,
    )


def slice_peaks(cache, audio_frame_start, audio_frame_end):
    """Return the peak slice covering audio-frame range [start, end).

    Used by the renderer to draw only the visible / non-trimmed portion
    of the waveform. Returns a `(peaks_slice, col_offset_within_cache)`
    tuple. Out-of-range bounds are clamped silently.

    `audio_frame_start` and `audio_frame_end` are in audio frames
    (i.e. samples per channel), not document/timeline frames.
    """
    if cache.n_columns == 0 or cache.samples_per_column <= 0:
        return [], 0
    spc = cache.samples_per_column

    if audio_frame_start < 0:
        audio_frame_start = 0
    if audio_frame_end < audio_frame_start:
        audio_frame_end = audio_frame_start

    col_start = audio_frame_start // spc
    col_end   = (audio_frame_end + spc - 1) // spc
    col_start = max(0, min(col_start, cache.n_columns))
    col_end   = max(col_start, min(col_end, cache.n_columns))

    return cache.peaks[col_start:col_end], col_start


def should_rebuild(cache, new_samples_per_column, threshold=0.01):
    """Decide whether a zoom-driven peak cache rebuild is worth it.

    Returns True when the new samples-per-column differs from the
    cached rate by more than `threshold` (default 1 %). The threshold
    keeps us from rebuilding on every pan-induced redraw at the same
    zoom level (where samples-per-column is identical) or on hairline
    zoom drifts that don't visibly improve the waveform.
    """
    if cache is None or cache.n_columns == 0:
        return True
    if new_samples_per_column < 1:
        new_samples_per_column = 1
    cur = cache.samples_per_column
    if cur < 1:
        return True
    ratio = new_samples_per_column / float(cur)
    return abs(ratio - 1.0) > threshold
