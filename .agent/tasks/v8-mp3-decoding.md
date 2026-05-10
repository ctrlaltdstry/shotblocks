# Task: v8 — MP3 decoding via bundled minimp3

## Goal

Let users drop `.mp3` files onto the timeline and have them decode to
the same `DecodedAudio` shape the rest of the audio subsystem already
consumes. WAV stays the existing path; MP3 becomes a sibling decoder
module that produces identical output downstream.

## Why

v7 shipped audio with WAV-only import. MP3 is the format users
actually have on disk — soundtracks, voice memos, references. Without
MP3, every test or real session starts with a re-export step. AAC and
others are deferred (see scope).

The licensing decision was made: **Shotblocks is MIT-licensed**. That
locks the decoder choice — minimp3 (public domain / CC0, single-header
C) is the only option that's both permissively licensed and fast
enough for multi-minute files. Pure-Python decoders are too slow;
LGPL/FFmpeg paths are off the table under MIT.

## Scope (v8)

**In:**

1. **MP3 decoding via minimp3.** Compile minimp3 to a small DLL, ship
   it under `src/vendor/`, load via `ctypes`. Decode `.mp3` files into
   the existing `DecodedAudio` namedtuple shape (int16 PCM bytes,
   sample_rate, sample_width=2, n_channels, n_frames, duration_s).
2. **Drag-receive accepts `.mp3`.** Extend `sb_canvas.py`'s
   drag-receive filter so `.mp3` paths route through the new
   `sb_audio_decode_mp3.load_mp3(...)` instead of `load_wav(...)`.
3. **Persistence works unchanged.** The existing audio JSON on the
   helper null already stores a path string — no schema change needed.
   `_sync_audio_for_active_doc` dispatches on extension.
4. **Vendor-DLL load is robust.** If the DLL is missing, fails to
   load, or is wrong-arch, we surface a one-line console warning and
   fall back to "MP3 unsupported" silently for drag-drops. The plugin
   never crashes on a broken vendor build.
5. **License notice ships with the plugin.** A
   `src/vendor/minimp3_LICENSE.txt` file with minimp3's CC0 dedication
   sits next to the DLL. Mentioned briefly in the project's top-level
   `LICENSE` (added as part of this task — Shotblocks-as-MIT was
   decided and needs to be on disk).

**Out (deferred):**

- AAC / M4A — no permissively-licensed AAC decoder exists. Revisit if
  user demand justifies the licensing complexity.
- FLAC, Vorbis — cheap to add later (dr_flac, stb_vorbis are MIT-ish)
  but not requested for v8.
- macOS build of the DLL — Windows-only target per the project
  constitution. macOS comes back when macOS comes back.
- Streaming decode for very large files — minimp3 loads the whole
  file. The 350 MB cap from `sb_audio_decode.py` carries over.
- Variable-bitrate accurate seeking — we decode the whole file once
  on import, so seek precision is whatever the existing playback
  module already does.

## Approach

### New / changed files

| File | Change |
|---|---|
| `LICENSE` | **New.** MIT license at repo root. |
| `src/vendor/minimp3.dll` | **New.** Built from minimp3 source, x64 Windows. ~80–120 KB. |
| `src/vendor/minimp3_LICENSE.txt` | **New.** minimp3's CC0 notice verbatim. |
| `src/vendor/README.md` | **New.** How the DLL was built, exact source revision, rebuild command. |
| `src/sb_audio_decode_mp3.py` | **New.** ctypes wrapper. Public surface: `load_mp3(path) -> DecodedAudio` + `is_mp3_path(path)`. Same exception type (`AudioDecodeError` from `sb_audio_decode`) so callers don't branch. |
| `src/sb_audio_decode.py` | Light edit. Re-export `AudioDecodeError` so the MP3 module can `from .sb_audio_decode import AudioDecodeError`. Update the module docstring (no longer "WAV-only — MP3 in v8+"). |
| `src/sb_canvas.py` | Drag-receive filter accepts `.mp3` in addition to `.wav`. Dispatch on extension to pick `load_wav` vs `load_mp3`. The existing `DRAGTYPE_BROWSER_SOUND` handling already covers MP3 file drops; only the extension filter changes. |
| `src/sb_audio_track.py` | If it currently hard-codes `is_wav_path`, replace with `is_audio_path` that checks `.wav` or `.mp3`. |
| `.agent/context/audio.md` | Update "Decoder choice" section: "**Decided.** MIT license → minimp3 (CC0) for MP3, bundled DLL via ctypes. WAV via stdlib `wave`. AAC deferred." |
| `.agent/licensing.md` | Update "Status" from Undecided to **MIT, decided 2026-05-10**. |

### minimp3 ctypes surface

minimp3 exposes a C API in `minimp3_ex.h` (the streaming/file-loading
layer over the core decoder). The relevant call is
`mp3dec_load_buf(...)` — give it a buffer of the whole MP3 file, it
fills a `mp3dec_file_info_t` with int16 PCM samples + metadata. We
build a small C shim DLL that wraps this in a function returning a
heap-allocated buffer the Python side can copy out and free.

Approximate shim signature:

```c
// returns 0 on success, nonzero on failure
int sb_mp3_decode_file(
    const wchar_t* path,
    int16_t** out_samples,    // malloc'd; caller must free via sb_mp3_free
    size_t* out_n_samples,    // total int16 count (frames * channels)
    int* out_sample_rate,
    int* out_n_channels);

void sb_mp3_free(void* p);
```

Python side:
1. Call `sb_mp3_decode_file`, check return code.
2. `ctypes.string_at(out_samples, out_n_samples * 2)` to copy bytes.
3. Call `sb_mp3_free(out_samples)` immediately.
4. Build `DecodedAudio` with `sample_width=2`, computed `n_frames`,
   computed `duration_s`. Apply the same 350 MB cap.

### Build pipeline

We need to compile minimp3 to `minimp3.dll`. Options:

- **MSVC** via `cl.exe` if it's already installed for C4D plugin SDK
  work. One-line invocation: `cl /LD /O2 minimp3_shim.c`.
- **MinGW-w64** (`x86_64-w64-mingw32-gcc`) if MSVC isn't on the box.
- **clang-cl** if present.

The build command goes in `src/vendor/README.md` so future-me (or a
contributor) can rebuild deterministically. The DLL is committed —
this is consistent with how Shotblocks already commits other binary
assets.

### Error handling

minimp3 returns negative error codes for: bad header, truncated file,
unsupported (free-format) bitstream. The Python wrapper translates
each to `AudioDecodeError("MP3 decode failed: <reason>")` so the
canvas drag-receive logs the same one-liner it already logs for bad
WAVs. No new exception type.

### Performance check

A 5-minute 192 kbps MP3 is ~7 MB on disk and ~50 MB decoded. minimp3
on a modern laptop decodes it in well under a second. Acceptable for
synchronous import (no progress bar needed). If we ever hit a 30-min
podcast, the 350 MB cap rejects it before decode anyway.

## Open questions

1. **Where does the C4D plugin look for the DLL?** The plugin's
   working directory at runtime isn't necessarily the install dir.
   Need to compute the path relative to the `.pyp` file's location
   (probably `os.path.dirname(__file__) + "/vendor/minimp3.dll"`) and
   verify that path is right after the deploy script copies things
   into C4D's plugin dir.

2. **Does the deploy script (`scripts/deploy.ps1`) already copy
   non-`.py` files?** If it currently filters to `*.py`, we need to
   loosen the filter so `vendor/` ships. Check before writing the
   wrapper.

3. **Compiler availability on the dev machine.** If neither MSVC nor
   MinGW is installed, the first session of v8 has a setup step. Worth
   checking up front so the work isn't blocked mid-implementation.

4. **Does C4D 2026's Python ctypes call convention work with `cdecl`
   vs `stdcall`?** Default minimp3 functions are cdecl. Confirm
   `ctypes.CDLL` (not `WinDLL`) loads cleanly, since `WinDLL` assumes
   stdcall on 32-bit (a non-issue on x64 but worth verifying once).

5. **Unicode paths.** Some users will have non-ASCII characters in
   audio filenames. The C shim takes `wchar_t*` and uses `_wfopen`
   internally to avoid the ANSI codepage trap. Confirm Python passes
   `ctypes.c_wchar_p` correctly.

## Done when

- [ ] `LICENSE` file at repo root contains MIT text.
- [ ] `src/vendor/minimp3.dll` is committed and loads via `ctypes` in
      C4D 2026.2.0 / Windows.
- [ ] `src/vendor/minimp3_LICENSE.txt` and `src/vendor/README.md`
      (with rebuild instructions) are in place.
- [ ] `src/sb_audio_decode_mp3.py` exposes `load_mp3(path) ->
      DecodedAudio` and `is_mp3_path(path) -> bool`. Returns the same
      shape as `load_wav`.
- [ ] Dropping a `.mp3` file onto the timeline imports it: console
      logs `audio imported: <basename> (<duration>s)`, waveform
      renders, spacebar plays.
- [ ] Persistence: save/reopen with an MP3-imported doc, audio
      re-loads.
- [ ] Failure modes:
  - [ ] Truncated/corrupt MP3 → console logs `audio decode failed:
        ...`, no crash.
  - [ ] Missing `minimp3.dll` (rename it temporarily) → console logs
        `MP3 decoder unavailable`, `.mp3` drops are silently rejected,
        plugin still works for WAV.
  - [ ] Non-ASCII filename (e.g. `音楽.mp3`) decodes correctly.
- [ ] `.agent/context/audio.md` decoder section updated.
- [ ] `.agent/licensing.md` status updated to MIT + date.
- [ ] Manual test checklist (10 items, modeled on v7's) appended at
      bottom of this file and passed.

## Implementation status (Phase 1)

**Built:**
- `src/vendor/minimp3.dll` — compiled from minimp3 rev
  `afb604c06bc8beb145fecd42c0ceb5bda8795144` via MSVC 2022 Build Tools
  (cl.exe, `/MT` static CRT). 155 KB. Exports `sb_mp3_decode_file`
  and `sb_mp3_free` from a thin C shim
  (`src/vendor/build/minimp3_shim.c`) wrapping `mp3dec_load_buf`.
- `src/vendor/minimp3_LICENSE.txt` — verbatim CC0 dedication from the
  minimp3 repo.
- `src/vendor/README.md` — provenance, layout, rebuild command,
  smoke-test instructions. Also documents the requirement that any
  future vendor lib be MIT/BSD/Apache/CC0/PD compatible.
- `src/vendor/build/smoke_load.py` — standalone test that runs in
  stock Python (no C4D needed) to confirm the DLL loads, the ctypes
  symbols match, and the error paths fire correctly.
- `src/sb_audio_decode_mp3.py` — ctypes wrapper. Public surface:
  `load_mp3(path)`, `is_mp3_path(path)`, `is_available()`,
  `load_error()`. Reuses `AudioDecodeError` and `DecodedAudio` from
  `sb_audio_decode` so the rest of the audio subsystem is
  format-agnostic. Lazy-loads the DLL on first use; caches the
  failure mode so we don't retry every import.
- `src/sb_audio_decode.py` — added the format-agnostic dispatcher
  `load_audio(path)` and `is_audio_path(path)`. `is_audio_path`
  filters MP3 paths by *also* requiring `is_available()` so a broken
  vendor build silently falls back to "WAV only" instead of failing
  mid-import.
- `src/sb_canvas.py` — drag-receive now uses `is_audio_path`;
  `_drag_wav_path` → `_drag_audio_path`, `_import_audio_wav` →
  `_import_audio_file`. Log strings updated.
- `src/sb_audio_track.py` — `import_file` and `load_from_doc` now
  call `load_audio` instead of `load_wav`. No persistence-schema
  change (path string + `path_is_relative` flag covers MP3 too).
- `scripts/deploy.ps1` — added `/XD build` so the vendor rebuild
  source isn't deployed to the C4D plugins folder.
- `LICENSE` (repo root) — MIT, `Copyright (c) 2026 Michael Slater`,
  with a notice line acknowledging the bundled minimp3.
- `.agent/licensing.md` — Status updated to **MIT, decided 2026-05-10**
  with implications for bundled deps.
- `.agent/context/audio.md` — Decoder-choice section moved from
  "decision pending" to **Decided**.

**Notes / divergences from the spec:**
- The spec called out two refactors not strictly needed for MP3: the
  rename of `_drag_wav_path` → `_drag_audio_path` and the
  introduction of `load_audio` / `is_audio_path` dispatchers. Both
  were done because keeping WAV-specific names would have left the
  canvas and track modules lying about what they handle. Net change
  in `sb_canvas.py` is essentially zero lines (same logic, renamed
  identifiers).
- The spec's ctypes signature passed `int16_t**` directly. minimp3's
  `mp3dec_file_info_t.buffer` is typed `mp3d_sample_t*` (which is
  `short` on Windows, not `int16_t`), so the shim casts at the
  assignment site and the ctypes side declares `POINTER(c_int16)`.
  Same memory layout; cleaner C compilation.
- `MINIMP3_FLOAT_OUTPUT 0` is set so the decoder emits int16 PCM,
  matching the WAV path's `sample_width=2`. Float output would have
  forced peaks/playback to handle two sample formats.
- Build artifacts kept under `src/vendor/build/` (rebuild source
  + smoke test). Excluded from deployment via robocopy `/XD build`.

## Manual test checklist (Phase 1)

Run on C4D 2026.2.0 / Windows. Need a small test MP3 (≈10 s, mono or
stereo, any bitrate) plus the WAV used in the v7 checklist.

**1 — Drag an MP3 into an empty timeline.**
   Expected: console logs `audio imported: <basename> (<duration>s)`.
   Audio block appears below the divider with the waveform visible
   and the file basename labelled.

**2 — Drop a WAV after MP3 was working.**
   Expected: WAV replaces the MP3. Old waveform gone, new one drawn.
   Both formats coexist via the dispatcher; no regression.

**3 — Drop a non-audio file (e.g. .png, .txt).**
   Expected: drop is silently ignored. The drag-receive filter
   (`is_audio_path`) rejects unsupported extensions before any
   decode attempt.

**4 — Drop a corrupt or truncated MP3.**
   Expected: console logs `audio import failed: MP3 decode failed:
   ... (path)`. No crash. Plugin remains functional.

**5 — Drop a renamed file (something.mp3 that's actually a JPEG).**
   Expected: console logs `audio import failed: no MP3 frames found
   in <path> (not an MP3?)`.

**6 — Spacebar plays MP3 in sync.**
   Move the playhead inside the audio block. Hit spacebar.
   Expected: video plays, audio plays. Audio is heard with at most
   ~250 ms startup latency. Hit spacebar again — audio pauses.

**7 — Looped playback wraps an MP3.**
   Set the play range to span the audio block. Confirm Loop toggle
   is on. Spacebar; let it loop at least twice.
   Expected: each loop cycle replays the audio from in_frame.

**8 — Edge-resize an MP3 audio block.**
   Click the right ~24 px of the block, drag right.
   Expected: block extends; new tail past end-of-audio plays silence
   (zero-fill, same as WAV path). Drag the left edge inward; head
   trim works the same way.

**9 — Persistence across save/reopen with MP3.**
   Save the doc. Close it. Reopen.
   Expected: MP3 audio block reappears, waveform visible, spacebar
   plays. Console logs `audio loaded for doc: <path> (<duration>s,
   <rate> Hz)`.

**10 — Non-ASCII MP3 filename.**
   Rename a working MP3 to something like `音楽.mp3` (or use any
   non-ASCII name in your locale). Drop it.
   Expected: imports cleanly. The C shim uses `_wfopen` so wide-char
   paths round-trip correctly.

**11 — Missing DLL fallback.**
   Rename `src/vendor/minimp3.dll` → `minimp3.dll.bak` temporarily,
   redeploy, restart C4D. Drag an MP3.
   Expected: drop is silently rejected (no crash, no error dialog).
   If you check the console after triggering the load attempt by
   importing `sb_audio_decode_mp3` and calling `load_error()`, the
   message names the missing DLL path. Restore the DLL, redeploy:
   MP3 imports work again.

**12 — WAV regressions.**
   Re-run the v7 manual checklist (or at least items 1, 3, 5, 6, 8).
   Expected: no behavior change for WAV paths.

**Out of scope for this checklist:** AAC, FLAC, Vorbis, scrub audio,
onset markers, multiple audio tracks, sidechain, slate engine.

## Notes

(populate during testing if anything surprises us)
