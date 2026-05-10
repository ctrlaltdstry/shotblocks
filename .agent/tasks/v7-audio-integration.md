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

## Implementation status (Phase 1)

**Built:**
- `sb_audio_decode.py` — WAV decoder via stdlib `wave`, returns
  `DecodedAudio(samples, sample_rate, sample_width, n_channels,
  n_frames, duration_s)`. 350 MB hard cap on payload (≈30 min stereo).
- `sb_audio_peaks.py` — Min/max peak cache with `samples_per_column`
  granularity, lazy rebuild (1 % zoom-change threshold), trim-aware
  slicing.
- `sb_audio_render.py` — Pure-function `draw_waveform`. Accepts any
  draw target with `DrawSetPen` / `DrawLine` / `DrawRectangle`.
- `sb_audio_track.py` — Per-document state, project-relative path
  resolution against `doc.GetDocumentPath()`, drag-edit mutators
  (`set_in_frame`, `resize_left_edge`, `resize_right_edge`),
  audio-frame ↔ doc-frame conversions.
- `sb_audio_playback.py` — winsound + worker thread. `SND_MEMORY |
  SND_ASYNC` is unsupported in C4D 2026's Python (verified by spike);
  workaround = synchronous `SND_MEMORY` calls on a daemon thread,
  ~250 ms chunk granularity. Zero-fills past end-of-audio. Stop is
  immediate via `SND_PURGE`.
- `sb_persistence.py` — added `BCKEY_AUDIO_JSON` (1013) +
  `_read_audio` / `_write_audio` mirroring the range-bar pattern.
- `sb_canvas.py` — wired drag-receive (`DRAGTYPE_FILES`,
  `DRAGTYPE_FILENAME_OTHER`, `DRAGTYPE_BROWSER_SOUND`), audio-block
  draw + hit-test + move/resize drag handlers, playback `set_audio` /
  `play` / `sync` / `pause` calls in `_toggle_playback` and
  `_playback_tick`, doc-load sync via `_sync_audio_for_active_doc`.
- `shotblocks.pyp` — default dialog `inith` raised 240 → 320 so the
  audio block fits in the default canvas (the v7 spike showed
  `audio_bot=264 > h=240` at the old default).

**Notes / divergences from the original spec:**
- The user upgraded the design from "fixed full-length, not draggable"
  to "draggable + edge-resize like a shot." That added the
  `_drag_audio_move`, `_drag_audio_resize`, and trim-aware sample
  offset paths. As a result, `sb_canvas.py` grew by ~370 lines
  (over the spec's ~200-line target). About 80 of those are the
  drag/resize handlers the upgrade required.
- Audio block uses procedural draw rather than the existing
  `audio-normal-body` / `audio-selected-body` PNGs. The PNGs were
  authored before trim was on the table — bringing them in would
  need head/tail trim states the bitmaps don't carry. The
  procedural body keeps v7 simple; the bitmaps stay available for
  v8 polish.

## Manual test checklist (Phase 1)

Run on C4D 2026.2.0 / Windows. Need a small test WAV (≈10 s, mono or
stereo, 16-bit PCM) and a typical project with at least one camera +
one shot.

**1 — Drag a WAV into an empty timeline.**
   Expected: console logs `audio imported: <basename> (<duration>s)`.
   The audio block appears below the video/audio divider with the
   waveform visible and the file basename labelled in the top-left.

**2 — Drop a non-WAV (e.g. .mp3 or .png).**
   Expected: drop is silently ignored (the drag-receive filter rejects
   non-`.wav`). Console may log a one-time `drag-receive type=...`
   line for diagnostic purposes.

**3 — Spacebar plays audio in sync.**
   Move the playhead to a frame inside the audio block. Hit spacebar.
   Expected: video plays, audio plays. Audio is heard with at most
   ~250 ms (one chunk) startup latency. Hit spacebar again — audio
   pauses within ~250 ms.

**4 — Looped playback wraps audio.**
   Set the play range to span the audio block. Confirm Loop toggle
   (left rail) is on. Spacebar; let it loop at least twice.
   Expected: each loop cycle replays the audio from in_frame.

**5 — Drag the audio block.**
   Click in the middle of the audio block, drag horizontally.
   Expected: block follows the cursor; duration unchanged. Release;
   undo (Cmd+Z) returns it to its original frame.

**6 — Edge-resize the audio block (right edge).**
   Click the right ~24 px of the block, drag right.
   Expected: block extends; the new tail past end-of-audio plays
   silence (zero-fill). Drag the right edge inward; the block shortens.

**7 — Edge-resize (left edge).**
   Click the left ~24 px of the block, drag right (inward).
   Expected: block shortens from the head — the audio at the new
   in_frame is audio that was previously a few frames in. Drag past
   the original start: the head pins to the audio start (no negative
   trim).

**8 — Persistence across save/reopen.**
   Save the doc. Close it. Reopen.
   Expected: the audio block reappears at the same frame range,
   waveform visible, spacebar plays. Console logs `audio loaded for
   doc: <path> (<duration>s, <rate> Hz)`.

**9 — Audio file moved away.**
   Save the doc. Externally move the WAV file out of its folder.
   Reopen the doc.
   Expected: console logs `audio re-load failed: audio file not
   found: <path>`. No waveform renders. Spacebar still plays video;
   audio is silent. Drop a fresh WAV → recovery is clean.

**10 — Multiple successive imports.**
   With one WAV imported, drop another WAV.
   Expected: the new WAV replaces the first. Old waveform is gone,
   new one drawn. Spacebar plays the new audio.

**Out of scope for this checklist (v8+):** MP3/AAC, scrub audio,
onset markers, multiple audio tracks, sidechain, slate engine.
