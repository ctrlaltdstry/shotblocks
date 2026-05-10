# v7 — Audio Subsystem (Phase 1)

The first audio milestone. This task **does not** ship the full audio
feature set described in `.agent/context/audio.md` — that's multi-phase
work. v7's scope is the foundation: get audio data flowing from disk
into the plugin, render a waveform on the timeline, and play back in
sync with spacebar. Onset detection, sidechain modes, and the beat
grid are deferred to v8+.

## Read first

These docs already describe intent. Don't re-derive from scratch.

- `.agent/context/architecture.md` (audio subsystem references at lines
  82, 141, 207, 225, 246, 307–308 and the slate-engine block).
- `.agent/context/audio.md` (requirements, decoder constraints,
  caching, playback sync, waveform rendering — all written before any
  code).
- `.agent/skills/onset-detection.md` (out of scope for v7 but useful to
  skim so v7 leaves room for it).

## Scope (v7)

**In:**

1. **WAV decoding only.** Drag a `.wav` file onto the timeline; the
   plugin decodes it via Python's stdlib `wave` module (no external
   dependency). MP3/AAC via a bundled decoder is v8+.
2. **Per-document audio.** One audio track per document for v7 (the
   architecture allows multiple audio tracks; v7 ships one). Stored
   on the helper null alongside shots and play range.
3. **Waveform rendering.** A precomputed peak cache (min/max per
   horizontal pixel column at the current zoom) rendered procedurally
   per redraw. No bitmap caching for v7 — we draw lines per column
   each `DrawMsg`. Optimize later if it lags.
4. **Audio playback synced to the timeline.** When spacebar plays,
   audio plays from `playhead_frame` in sync with the doc's frame
   advance. When spacebar pauses, audio pauses. Looping respects the
   `_loop_enabled` flag (wrap audio to range_in when the playhead
   wraps).
5. **Audio block on the timeline.** Renders below track 0 (per
   architecture's "video grows up, audio grows down" rule). Uses the
   already-existing `AUDIO_HEIGHT = 96` and the audio bitmap PNGs
   (`audio-normal-body`, `audio-selected-body`, etc.) we built for v6.
   The waveform draws inside the body region of the audio block.

**Out (deferred to v8+):**

- MP3 / AAC decoding (needs a bundled decoder).
- Onset detection and beat-grid inference.
- Sidechain audio → rig parameter coupling.
- Multiple concurrent audio tracks.
- Audio scrubbing (audio plays only on spacebar; scrub is silent in v7).
- Bitmap-cached waveform (we redraw procedurally; cache later if perf
  demands it).
- Slate engine (audio beats × motion energy).

## Architectural decisions to make BEFORE coding

The user explicitly asked to plan this for cleaner organization than
the existing 3000-line `sb_canvas.py`. Audio is enough new code to
warrant its own modules. **Don't add audio code to `sb_canvas.py`.**

Recommended split:

| Module | Responsibility | Imports c4d? |
|---|---|---|
| `sb_audio_decode.py` | Open a WAV, return sample arrays + metadata. Stdlib `wave` only. Pure-Python testable. | No |
| `sb_audio_peaks.py` | Build a peak-cache (min/max per pixel column) from sample arrays at a given samples-per-pixel rate. Pure-Python testable. | No |
| `sb_audio_playback.py` | Open an audio output stream, push samples in sync with timeline frame advance. Plays from a position, pauses, seeks, stops. | Maybe (depends on chosen output API) |
| `sb_audio_render.py` | Pure-function waveform drawing. Takes a draw target (canvas-like protocol), a peak slice, a target rect, and color tokens. No knowledge of `c4d.gui.GeUserArea`. | No |
| `sb_audio_track.py` | Per-document audio state: file path, decoded samples, peak cache, current playback position. Persists path + (eventually) onset list to the helper null. | Yes (persistence) |

The canvas (`sb_canvas.py`) will:
- Hold a reference to a `sb_audio_track` instance for the active doc.
- During `DrawMsg`, hand the track + a draw target to
  `sb_audio_render.draw_audio_block(...)`.
- Hook `_on_drag_receive` to detect `.wav` files and load them via
  `sb_audio_decode.load_wav(...)`.
- Hook `_playback_tick` to call `track.advance(playhead_frame)` so the
  audio playback module stays in sync with the timeline frame.

This keeps the canvas as **the C4D-touching surface** and pushes audio
math into pure modules that can be unit-tested without C4D.

## Unknowns to investigate first (before writing feature code)

These four questions should be answered with quick spikes, not
guessed at:

1. **Audio output API in C4D 2026 Python.** Is there a way to play
   audio from the bundled Python interpreter? Options to test:
   - `c4d.modules.snd` (older C4D versions had a Sound module — does
     it exist in 2026?)
   - `winsound.PlaySound` (Windows-only stdlib; can it play from
     in-memory samples or only from files?)
   - `simpleaudio` / `sounddevice` / `pyaudio` (pip wheels — would need
     to be bundled with the plugin; check Windows wheel availability).
   - Last resort: write a temp WAV file per-shot and shell out via
     `os.startfile` (no — kills sync).

   This is the make-or-break question. If we can't play audio from
   inside C4D Python, audio playback gets cut from v7 and we ship
   "waveform display only."

2. **WAV decoding via `wave` stdlib in C4D 2026's Python.** Is the
   `wave` module bundled? Quick test: `import wave; wave.open(...)`
   in the C4D Python console.

3. **Drag-receive of file paths.** The current `_on_drag_receive` was
   built for Object Manager → canvas drops (`BaseObject` references).
   For audio we need filesystem-path drops. Verify that
   `BFM_DRAGRECEIVE` carries file paths when the drag source is OS
   file explorer, and what `msg.GetData(...)` returns. If file drops
   work differently (or not at all), v7 falls back to a "browse for
   audio file" menu item.

4. **Layout below track 0.** The audio block renders below track 0
   per architecture. Verify that `_track_y_top` math currently allows
   negative-track-style indexing, or whether we need a separate
   `_audio_track_y_top` helper. Audio's height is `AUDIO_HEIGHT = 96`,
   not `SHOT_HEIGHT = 48`, so the Y math has to handle mixed heights.

## Open design questions

To answer with the user before implementing:

1. **Audio block visual extent.** The architecture says audio grows
   downward from track 0. Should the audio block span the *entire*
   audio file's duration on the timeline (one long block from 0 to
   end-of-audio), or be a movable/trimmable clip like a shot block?
   v7 default: **one long fixed block from frame 0 to end-of-audio**,
   not draggable. Trimming is v8+.

2. **What happens at the end of the audio file?** If the audio file
   is 1000 frames long but the play range goes to 2000, what does
   playback do at frame 1000? v7 default: **silence past the end**.
   Audio playback module zero-fills.

3. **Audio file path persistence.** Store project-relative when
   possible (per architecture); fall back to absolute. Both stored as
   strings on the helper null.

## Definition of done

v7 ships when:

- A user can drag a WAV file onto the timeline.
- The waveform appears below track 0 in an audio block.
- Spacebar plays the audio in sync with the playhead.
- Pausing pauses audio. Wrap-around (loop on) wraps audio too.
- The audio file path persists across save/reopen.
- All audio code lives in `sb_audio_*.py` modules; `sb_canvas.py`
  grew by less than ~200 lines.
- An eight-test manual checklist (modeled on
  `v6-playback-engine.md`) exists at the bottom of v7's task file
  and passes on C4D 2026.2.0 / Windows.

## Estimated complexity

Significant: ~3 sessions of focused work likely.
- Session 1: investigate the four unknowns; pick decoder + output APIs.
- Session 2: build the modules, wire drag-receive, render waveform.
- Session 3: playback sync, persistence, bug-fix pass, manual tests.

## Picking back up

The next chat should:
1. Read this file plus `audio.md` and the four architecture
   references listed above.
2. Run quick spikes on the four unknowns first.
3. Lock in the design decisions, then start with `sb_audio_decode.py`
   as the leaf-most module.
