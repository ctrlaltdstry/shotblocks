# Audio Subsystem

The audio handling deserves its own document because it is novel territory for C4D plugins and a primary value driver for this product.

## Requirements

- Drag-and-drop import of WAV, MP3, AAC
- Decode and cache samples per document
- Display waveform on the timeline (zoomable)
- Playback synced to viewport scrub
- Auto-detect onsets and infer beat grid
- Manual marker placement via hotkey while scrubbing
- Sidechain mode: amplitude / frequency-band → rig parameter

## Decoder choice

_(decision pending — options: pure Python WAV + bundled lightweight MP3/AAC decoder, or a small C extension)_

Constraints:
- Must work on the current target (C4D 2026.2.0 on Windows). macOS support returns to the requirements list when macOS is added to the target list.
- Must not require system codec installation
- License must be compatible with plugin distribution

## Caching strategy

_(populate)_

## Onset detection algorithm

See `.agent/skills/onset-detection.md`.

## Playback sync

The hard part. C4D's timeline scrub fires events; we need audio playback to follow scrub position with low latency. Approach:
- Audio playback runs on a worker thread with a position-feedback loop
- Scrub events update the target position; audio thread seeks
- For continuous playback (spacebar), audio plays freely and timeline cursor follows audio time

## Waveform rendering

Pre-render the waveform to a bitmap at multiple zoom levels, blit to the timeline area. Regenerate only on audio change or zoom change. Never recompute per-frame.
