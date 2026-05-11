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

Five lazy caches on `AudioTrack`, all built on first read after
import / load_from_doc / clear:

- `peaks` — `PeakCache` (per-column min/max for waveform rendering),
  built eagerly on import.
- `_mono` — int16 mono mixdown of the decoded samples. Used by
  onset detection and the dB meter envelope.
- `_drum_band` — bandpass-filtered mono (kick + snare/HH bands
  summed). Used by prominent-peak detection only. See
  `sb_audio_filters.drum_band`.
- `_meter_envelope` — `StereoEnvelope` of per-channel RMS in dBFS.
  Used by the right-side meter.
- Onset-pipeline FFT tables — bit-reversal + twiddles cached
  per-FFT-size in `sb_audio_onsets._FFT_CACHE`.

All but `peaks` are `None`-cleared on every audio change. The
peaks cache is rebuilt eagerly on import for the renderer.

## Detection layers (v9)

Three distinct detection layers run during analysis:

- **Onsets** — every spectral-flux attack on the full mono signal.
  Dense (~1-2/sec). Computed but not drawn. Reserved for v10+
  sidechain envelope and slate engine.
- **Prominent peaks** — envelope local-maxima on the **drum-band
  filtered** signal (kick 35-140 Hz + snare/HH 2-8 kHz, summed,
  vocals/pads suppressed). Drawn as yellow ticks; act as snap
  targets. NOT spectral-flux derived — the bandpass strips the
  data down to drum-relevant content first, then a simple
  envelope walk picks local maxima above an absolute floor.
- **Beat grid** — autocorrelation of the onset spike train,
  yielding (period, phase, confidence). Drawn as canvas-wide
  dashed vertical lines with adaptive density (thins at low
  zoom). Snap target.

Algorithm details: `.agent/skills/onset-detection.md` and the
`## What actually shipped (post-iteration)` section of
`.agent/tasks/v9-onset-detection.md`.

## dB meter (v9)

Premiere/FCP-style stereo meter on the far-right of the dialog
(50 px panel). Reads RMS at the playhead's audio-frame position
from `_meter_envelope`. Decays to silence over ~1.5 s when playback
stops; tracks live during scrub.

Implementation: `sb_audio_meter.build_envelope()` builds the cache;
`sb_canvas._draw_db_meter()` paints it. Channel count is capped at
2 — higher-channel-count audio gets fed L/R only.

## Threading model

The v9 analysis pipeline runs on a `threading.Thread`. Critical
constraint discovered empirically: the dialog timer must be OFF
during analysis. Each Timer tick contends with the worker for the
GIL; even a 7 fps timer doubled analysis time. Solution:

- `_refresh_timer` checks playback / hover-anim only — not
  analysis.
- Worker fires `c4d.SpecialEventAdd(PLUGIN_ID_COMMAND)` on
  completion. The dialog's `CoreMessage` handler matches the id
  and calls `_poll_analysis_thread` on the main thread.
- The busy panel paints once at start, again at completion. No
  animation during analysis.

Two-phase start so the busy panel actually paints before the
worker steals the GIL: click → set label + Redraw + post a
deferred event → CoreMessage handler spawns the worker on the
NEXT event tick (after the redraw has been serviced).

## Playback sync

The hard part. C4D's timeline scrub fires events; we need audio playback to follow scrub position with low latency. Approach:
- Audio playback runs on a worker thread with a position-feedback loop
- Scrub events update the target position; audio thread seeks
- For continuous playback (spacebar), audio plays freely and timeline cursor follows audio time

## Waveform rendering

Pre-render the waveform to a bitmap at multiple zoom levels, blit to the timeline area. Regenerate only on audio change or zoom change. Never recompute per-frame.
