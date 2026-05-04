# Onset Detection

Onset detection is finding the attack points in audio. It is the first step toward beat detection.

## Algorithm summary

1. Compute spectral flux: positive change in magnitude spectrum frame-to-frame
2. Apply adaptive threshold (median or moving average + offset)
3. Peak-pick the thresholded function
4. Each peak is an onset candidate

## From onsets to beats

Onsets ≠ beats. Beats are the regular pulse; onsets include every attack, including offbeats and ghost notes.

To infer the beat grid:
1. Compute inter-onset intervals
2. Histogram the intervals; the dominant value is roughly one beat (or a multiple thereof)
3. Autocorrelate the onset function to find the period more precisely
4. Phase-align to the strongest onsets to find downbeat candidates

## Library options

- **librosa** (Python) — heavy, but reference quality
- **aubio** — lighter, C with Python bindings
- **Custom** — a basic spectral-flux + peak-pick implementation is ~200 lines, sufficient for v1

## Tuning notes

- Bass-heavy tracks: filter out below 60 Hz before flux computation, or onset will fire on every kick subharmonic
- Sparse music: lower the threshold; raise the minimum onset spacing
- Dense music (drum-and-bass, hardcore): higher threshold, accept some false negatives over false positives
