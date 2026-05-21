# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Shotblocks is a **Cinema 4D 2026.2.0 Windows-only Python plugin** for camera animation: a timeline-based shot sequencer with physically-grounded motion, beat-synced behavior, and a preset shot library. The signature verb is **slate** — non-destructively aligning shot positions to motion-energy peaks in the audio.

Authoritative project context lives under `.agent/`. **Start there before non-trivial work** — the router is the entry point:

- `.agent/router.md` — task-keyed navigation into the rest of the docs
- `.agent/constitution.md` — non-negotiable principles (timeline metaphor, hard cuts only, drag-primary direct manipulation, slate semantics, single-target Windows/2026.2.0 scope)
- `.agent/context/architecture.md` — system shape; layers, data flow per frame, persistence, slate engine
- `.agent/context/pitfalls.md` — known traps; check before reinventing a fix
- `.agent/context/c4d-plugin-development.md` — TagData / GeDialog / GeUserArea lifecycle, threading rules
- `.agent/open-questions.md` — decisions explicitly deferred; check before assuming something is settled

When a decision is hard, the order of authority is: constitution → glossary → architecture → workflow → review lens. If you cannot resolve a question from these documents, ask the user, then write the answer back into the right file.

## The dev loop

Every code change runs through one PowerShell command — deploy `src/` to C4D's plugins folder, force-kill C4D, relaunch with the canonical test scene:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev-loop.ps1
```

The force-kill is unconditional by design. If only deploying (rare):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1
```

`deploy.ps1` uses `robocopy /MIR` so renames and deletes propagate. The C4D prefs folder hardcodes a build-hash suffix (`Maxon Cinema 4D 2026_1ABCDC12`); if Maxon reissues the hash after an update, edit `$c4dPrefs` in `scripts/deploy.ps1`.

Verification is by inspection: check Extensions → Console in C4D after relaunch. The `[Shotblocks] loaded (tag=..., command=..., dialog=...)` line confirms registration; load errors appear here. There is no test suite — verify changes manually in `scenes/dev-test.c4d`.

Junctions (`mklink /J`) for zero-copy dev do **not** load reliably from this C4D install. Copy-on-deploy is the canonical workflow; don't reintroduce junctions without verifying.

## Debugging method — measure, don't guess

This is a hard process rule, learned the expensive way. Bug-chasing sessions go in circles when fixes are shipped on theory and the user is used as the debugger. Don't do that.

1. **No code change until a measurement proves the cause.** For a layout/visual bug: a CDP `getBoundingClientRect` dump (`node scripts/cdp-eval.mjs "<expr>"`, store on `window.__SHOTBLOCKS_STORE__`). For a behavior bug: a console log, the C4D Console, or a store snapshot. If the cause can't be measured yet, instrument *first* and ship that — a deploy that produces a fact, not a guess.
2. **State one falsifiable hypothesis before touching anything** — "X is wider than Y; if I measure them equal, I'm wrong" — not "let me try X."
3. **A failed fix gets reverted before the next attempt.** Never stack a new fix on a failed one; that is how a session accumulates wrong guesses and regresses.
4. **Two failed attempts on the same bug → stop guessing and instrument.** No third blind attempt.
5. **When the user says something factual about when/where it broke** ("it worked before X", "check the console"), that is ground truth — a constraint to work backward from, not a suggestion to weigh against a theory.

## Code layout

The current `src/` is a flatter `sb_*` module convention rather than the package layout sketched in `architecture.md` (which is aspirational):

- `shotblocks.pyp` — plugin entry point. Registers the tag, command, and dialog. Thin: it inserts its own folder onto `sys.path` so the `sb_*` siblings import cleanly, then wires the dialog's Timer/CoreMessage dispatch.
- `sb_rig_tag.py` — the `ShotblocksTag` (TagData). Per-frame Execute runs the procedural pipeline. Parameter IDs match `res/description/tshotblocks.h`.
- `sb_rig_spring.py`, `sb_rig_quat.py`, `sb_rig_noise.py`, `sb_rig_zoom.py` — rig subsystems composed by the tag.
- `sb_canvas*.py` — `ShotblocksTimelineCanvas` (the GeUserArea) and its split-out drawing/drag/playback/audio panels.
- `sb_shot_model.py`, `sb_persistence.py` — pure-Python shot list + helper-null serialization to the document.
- `sb_audio_*.py` — decode (WAV/MP3 via bundled `minimp3.dll`), onsets, peaks, playback, waveform, meter.
- `src/vendor/` — bundled binary deps with verbatim license files. `minimp3.dll` is the only deployed binary; `build/` keeps the rebuild source and is excluded from deploy via `robocopy /XD build`.
- `src/res/` — required global stubs (`c4d_symbols.h`, `strings_en-US/c4d_strings.str`) plus the tag's `.res`/`.h`/`.str` and icon.

## Plugin model essentials

- **Single tag, single dialog, single command.** The Shotblocks tag is the only user-visible plugin element; rig behaviors (spring-damper, look-at, noise, autofocus, framing, zoom) are internal subsystems exposed in its Attribute Manager, not separate tags.
- **The command and the dialog share one plugin ID.** C4D's layout-restore matches saved async-dialog slots to registered commands by ID; mismatched IDs produce "Plugin not found" in the saved layout slot. `PLUGIN_ID_DIALOG = PLUGIN_ID_COMMAND` in `shotblocks.pyp` is intentional.
- **No rig nulls.** The tag's `Execute` reads the camera's evaluated pose and writes the procedural result directly back to the camera. Every behavior is math on the pose, not a chain of null objects in the OM. This was a v10 decision and is documented in `.agent/skills/rig-hierarchy.md` and the architecture.
- **Tag pose writes go through `SetRelRot`/`SetRelPos`** (local channels) rather than `SetMg`. World-matrix writes get clobbered by C4D's world-from-local recompose; local-channel writes survive.
- **`id(tag)` and `GetUniqueIP()` churn on every Execute.** Per-tag state is keyed via a marker in the tag's `BaseContainer`, not by Python identity.
- **Threading.** Plugin lifecycle methods run on the main thread. Audio decode, onset analysis, and zoom-driven peak rebuilds run on worker threads and signal completion via `c4d.SpecialEventAdd(<plugin_id>)`, which fires a `CoreMessage` on the main thread. **The dialog Timer must be off while workers run** — every Timer tick contends with the worker for the GIL (a 60 fps timer makes a 10-second analysis take 60 seconds).
- **`SceneHookData` is not exposed in C4D 2026.2.0 Python.** Document persistence uses a hidden `BaseObject` (`NBIT_OHIDE`) inserted into the document with shot data serialized as JSON in its `BaseContainer`. Every helper-container write inside `StartUndo/EndUndo` must follow a single `AddUndo` (undo registers at `AddUndo` time, not at end-of-block).
- **`CUSTOMGUI_VECTOR2D` is UserData-only in C4D 2026.** The `.res` parser rejects the keyword and silently empties the AM; the 2D joystick widget is reachable only via `tag.AddUserData` with `DESC_CUSTOMGUI`.
- **Don't `except: pass` at C4D API boundaries.** Silent swallow hid a multi-month bug. Always log the exception.
- **Plugin IDs `1000001-1000010` are the reserved testing range.** Real IDs come from Maxon's generator before any public release.

## Versioning & scope

**Sole target: C4D 2026.2.0 on Windows.** No macOS, no older C4D versions. Don't write speculative cross-platform or cross-version code; there's no `c4d_compat.py` and won't be one until at least two targets exist. macOS is the natural next milestone after v0; older versions are not on the roadmap.

## Commits

Trunk-based on `main`. **One commit per atomic, verified feature or fix** — not one per milestone. An atomic commit is the smallest change that is *complete and leaves the code building and working*; it may touch several files (the Inspector panel = store flags + component + wiring + CSS in one commit) but it is one whole change, never a half-built state.

- **Verify before committing.** A v2 change is only real after a deploy + C4D restart confirms it works. Don't commit unverified work.
- **One change per commit.** If the subject needs "and" (`add Inspector and fix waveform`), it's two commits. A bug found while building a feature is committed separately, before the feature.
- **The test:** if you `git checkout` to a commit, the app must build and run. If it wouldn't, the commit is too granular — keep working.
- A "round" (`round 15`) is a mental milestone unit, not a commit unit — a round is several commits.

Subject format: `<task-id>: <imperative summary>` (one sentence, no "and"), or topic prefixes `chore:` / `docs:` / `refactor:` for non-task work. Don't commit unless explicitly asked. See `.agent/context/version-control.md` for the full policy and what not to commit.

## Licensing

MIT (decided 2026-05-10). Every bundled dependency must be MIT/BSD/Apache/CC0/PD compatible. LGPL and GPL are excluded — this rules out libmpg123 and ffmpeg for the audio decoder; `minimp3` (CC0) is what we ship.

## Style

- No emojis in code or commits unless asked.
- Default to no comments. Only comment when the *why* is non-obvious — a hidden constraint, a workaround for a specific C4D quirk, behavior that would surprise the next reader. Don't narrate what the code does.
- Prefer editing existing files over creating new ones. Don't create markdown unless asked.
- React/CEF rewrites of the UI are off the table — help through the immediate problem.
