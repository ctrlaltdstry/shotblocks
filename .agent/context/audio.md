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

**Decided.** WAV via stdlib `wave`. MP3 via bundled minimp3 (CC0)
loaded with ctypes from `src/vendor/minimp3.dll`. The dispatcher
`sb_audio_decode.load_audio(path)` picks by extension and returns the
same `DecodedAudio` shape regardless of source format.

AAC is shelved — no permissively-licensed decoder of decent quality
exists, and Shotblocks is MIT-licensed (see `.agent/licensing.md`).
FLAC (dr_flac) and Vorbis (stb_vorbis) are cheap to add later if
needed.

Constraints honored:
- Works on C4D 2026.2.0 / Windows. macOS returns when macOS is back on the target list.
- No system codec installation required — the decoder DLL ships with the plugin.
- License is MIT-compatible (CC0 is public-domain-equivalent).

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
