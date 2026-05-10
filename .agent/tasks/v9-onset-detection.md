# Task: v9 — Onset detection + beat grid

## Goal

Detect attack points in the imported audio and infer a beat grid from
them. Result the user sees: tick marks on the audio block at detected
onsets, plus a subtler grid of inferred beats.

## Why

Every downstream audio feature in `.agent/context/audio.md` waits on
this. Sidechain mode (audio amplitude → rig parameter) needs an
envelope; the slate engine (audio beats × motion energy) needs a beat
grid; manual marker placement is meaningful only when there's a
detected baseline to nudge. v7 + v8 got bytes onto the timeline; v9
turns those bytes into something the rest of the system can hang
behavior off.

Pure-Python implementation per `.agent/skills/onset-detection.md` —
"a basic spectral-flux + peak-pick implementation is ~200 lines,
sufficient for v1." No new bundled binaries (the licensing decision
locks us to permissive deps; nothing on PyPI is worth pulling in for
this).

## Read first

- `.agent/skills/onset-detection.md` — algorithm sketch (spectral flux,
  adaptive threshold, peak pick; histogram inter-onset intervals for
  beats).
- `.agent/context/audio.md` — sets up onsets/beats as foundation for
  sidechain + slate.
- `.agent/tasks/v8-mp3-decoding.md` — for the current shape of
  `DecodedAudio` (samples=bytes int16-LE, sample_rate, n_channels,
  n_frames, duration_s) and how the audio track persists.
- `src/sb_audio_decode.py`, `src/sb_audio_track.py` — the data we
  start from.

## Scope (v9)

**In:**

1. **Spectral flux onset detection.** Pure Python, no third-party
   deps. Stdlib `math` + `array` is enough. Operates on the existing
   `DecodedAudio.samples` byte buffer. Mixdown to mono, frame the
   signal (~512–1024 samples per FFT frame, 50 % hop), compute
   short-time magnitude spectrum, sum positive spectral differences.
   Adaptive threshold (median over a moving window + offset).
   Peak-pick the thresholded function with a minimum onset spacing.
   Output: list of onset frame indices (in audio-frames, same units
   as `trim_start_audio_frames`).
2. **Beat grid inference.** From the onset list: histogram
   inter-onset intervals, pick the dominant interval as one beat,
   autocorrelate for refinement, phase-align to the strongest onsets.
   Output: (period_frames, phase_frames). Confidence score so the
   canvas can suppress a low-confidence grid (avoids drawing nonsense
   for ambient / non-rhythmic material).
3. **Persistence.** Onset list and beat grid persist to the helper
   null alongside the existing audio dict. New JSON keys, not a new
   BCKEY — this is metadata about an already-persisted track.
4. **Canvas overlay.** Onset tick marks drawn on the audio block at
   the appropriate x positions (filtered by visible range to keep
   draws cheap). Beat grid rendered as a subtler vertical lattice
   across the audio block — only when confidence clears a threshold.
5. **Recompute on import / re-decode.** When an audio file is
   imported or reloaded from disk, kick off onset detection
   automatically. Long files block the main thread for a noticeable
   moment (a 3-min track is ~8M samples; FFT-less spectral flux on
   that is in the ~1–3 s range in pure Python). Acceptable for v9 —
   show a one-line console log; defer threading to v10+ if it
   actually annoys.

**Out (deferred):**

- Manual onset marker placement / nudging (v10+). v9 is detection-only.
- Tempo detection beyond a single global value (no time-signature
  inference, no tempo-change detection). Phase + period only.
- Threading or progress UI. If the freeze becomes intolerable on
  long tracks, that's a v10 problem.
- Sidechain coupling. Onsets exist; nothing reads them yet.

## Approach

### New / changed files

| File | Change |
|---|---|
| `src/sb_audio_onsets.py` | **New.** Pure functions. `detect_onsets(decoded) -> list[int]`. `infer_beat_grid(onsets, decoded) -> (period, phase, confidence)`. No `c4d` imports — testable in stock Python via `vendor/build/`-style smoke scripts. |
| `src/sb_audio_track.py` | Hold `onsets: list[int]` and `beat_grid: (period, phase, confidence) \| None`. Compute on `import_file` / `load_from_doc` after decode succeeds. Persist via `_persist`. Reset on `clear`. |
| `src/sb_persistence.py` | Extend the existing audio JSON schema with `onsets` (list of int) and `beat_grid` (object). No new BCKEY. |
| `src/sb_canvas.py` | Draw onset ticks + beat grid in the audio-block draw path. ~30 lines. Honor the visible-range cull the waveform draw already uses. |

### Algorithm notes

The skill doc says "spectral flux + peak pick." For pure-Python
implementation without numpy:

- **FFT.** Stdlib has none. Two options:
  - Pure-Python radix-2 FFT (~30 lines, slow but cache-friendly).
  - Skip the FFT entirely: spectral flux can be approximated cheaply
    by **band-passed energy difference** — split the signal into a
    handful of frequency bands via simple IIR filters, sum |sample|
    per frame per band, take positive differences across bands.
    Lossier than a real spectrum but ~5× faster in pure Python. Worth
    spiking both before committing.
- **Frame size.** 1024 samples at 48 kHz = 21 ms; that's the standard
  ballpark.
- **Adaptive threshold.** Moving median of the flux signal over
  ~200 ms, plus a fixed offset. Tighter than a global threshold for
  music with dynamic range.
- **Min onset spacing.** ~50 ms is a good default — fast enough to
  catch hi-hats, slow enough to avoid double-triggering on a single
  attack envelope.
- **Beat inference.** Histogram inter-onset intervals; the mode is
  often a multiple of the true beat (every-other-onset hits).
  Autocorrelate the onset function (treat onsets as a sparse spike
  train) over a tempo-bracketed lag range (60–240 BPM →
  `sample_rate / 4` to `sample_rate` lags) and pick the peak. Phase
  is the offset of the strongest onset within one period. Confidence
  = autocorrelation peak height divided by mean.

### Performance budget

A 3-minute 48 kHz mono track is ~8.6 M samples. With 1024-sample
frames at 50 % hop, that's ~17k frames. In pure Python an FFT-free
band-energy approach should land under 2 s on a modern laptop; with a
real radix-2 FFT, expect 5–8 s. If the FFT-free approach gives
acceptable detection quality on the user's actual material, ship that.

### Persistence schema extension

Current audio dict keys (from `sb_persistence._read_audio` /
`_write_audio`):

```json
{
  "path": "...",
  "path_is_relative": true,
  "in_frame": 100,
  "out_frame": 5000,
  "trim_start_audio_frames": 0
}
```

Add (both optional, both stored as audio-frame indices, not doc-frames):

```json
{
  "onsets": [12345, 23890, 35012, ...],
  "beat_grid": {
    "period": 22050,
    "phase":  3000,
    "confidence": 0.74
  }
}
```

Confidence is stored so the canvas can decide whether to draw the
grid without recomputing.

## Open questions

1. **FFT or band-energy.** Spike both on a real song; pick whichever
   detects onsets cleanly within the perf budget. The user has
   `scenes/ES_Our Last Stand - FormantX.mp3` (170 s, 48 kHz stereo)
   which is a fine test case — has clear hits.
2. **Mono mixdown placement.** Compute it once and cache, or fold
   into the onset detector? Probably cache on `DecodedAudio` as a
   lazy property — the peak cache and any future sidechain envelope
   will want it too.
3. **What's the visual treatment for low-confidence grids?** Hide
   entirely, or draw faded? Default: hide. Non-rhythmic material
   shouldn't get a phantom grid. Threshold ~0.5 (autocorrelation
   peak ≥ 50 % above mean).
4. **Recompute on edge-resize?** Edge-resize changes
   `trim_start_audio_frames` but the onsets are in source-audio
   coordinates, so no recompute needed — the canvas just shifts
   them by the same offset the waveform already shifts. Confirm this
   is what the trim path actually does.

## Done when

- [ ] `src/sb_audio_onsets.py` exists, pure-Python, no `c4d` import.
- [ ] `detect_onsets(decoded) -> list[int]` returns plausible onset
      positions for the test MP3 (spot-checked: leading silence
      empty, downbeats present, no double-triggers).
- [ ] `infer_beat_grid(onsets, decoded)` returns
      `(period, phase, confidence)`. On a 4/4 song, period × fps
      should be near 60 / BPM (within ±5 %).
- [ ] Audio import auto-runs both. Console log shows a one-line
      summary: `audio analysed: 312 onsets, ~120 BPM (conf 0.81)`.
- [ ] Onsets and beat grid persist; reload from disk replays them.
- [ ] Canvas draws onset ticks and a grid (when confidence clears
      threshold) inside the audio block, culled to visible range.
- [ ] Manual checklist (≤ 8 items) appended to this file and passes.

## Notes

(populate during implementation)
