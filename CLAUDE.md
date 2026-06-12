# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Shotblocks is a **Cinema 4D 2026.2.0 Windows-only plugin** for camera animation: a timeline-based shot sequencer with physically-grounded motion, beat-synced behavior, and a preset shot library. The signature verb is **slate** — non-destructively aligning shot positions to motion-energy peaks in the audio.

Two plugins ship side by side: a small **Python plugin** at `src/` that registers the camera rig tag (spring/damper, quat look-at, fBm noise, autofocus, framing, zoom — the per-frame TagData), and a **C++ plugin** at `host/shotblocks/` whose docked dialog hosts a WebView2 React UI for the timeline. The v1 Python timeline UI has been retired; v2 owns the timeline.

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

Verification is by inspection: check Extensions → Console in C4D after relaunch. The `[Shotblocks] camera rig tag loaded (id=1000001)` line confirms registration of the Python tag; load errors appear here. The C++ v2 plugin logs its own load line. There is no test suite — verify changes manually in `scenes/dev-test.c4d`.

Junctions (`mklink /J`) for zero-copy dev do **not** load reliably from this C4D install. Copy-on-deploy is the canonical workflow; don't reintroduce junctions without verifying.

## Debugging method — measure, don't guess

This is a hard process rule, learned the expensive way. Bug-chasing sessions go in circles when fixes are shipped on theory and the user is used as the debugger. Don't do that.

1. **No code change until a measurement proves the cause.** For a layout/visual bug: a CDP `getBoundingClientRect` dump (`node scripts/cdp-eval.mjs "<expr>"`, store on `window.__SHOTBLOCKS_STORE__`). For a behavior bug: a console log, the C4D Console, or a store snapshot. If the cause can't be measured yet, instrument *first* and ship that — a deploy that produces a fact, not a guess.
2. **State one falsifiable hypothesis before touching anything** — "X is wider than Y; if I measure them equal, I'm wrong" — not "let me try X."
3. **A failed fix gets reverted before the next attempt.** Never stack a new fix on a failed one; that is how a session accumulates wrong guesses and regresses.
4. **Two failed attempts on the same bug → stop guessing and instrument.** No third blind attempt.
5. **When the user says something factual about when/where it broke** ("it worked before X", "check the console"), that is ground truth — a constraint to work backward from, not a suggestion to weigh against a theory.

## Code layout

The Python plugin under `src/` is rig-only after the v2 timeline port. The C++ plugin and its React UI under `host/shotblocks/` own the timeline.

**Python (`src/`) — the camera rig tag:**
- `shotblocks.pyp` — plugin entry point. Registers only the Shotblocks tag. Inserts its own folder onto `sys.path` so the `sb_rig_*` siblings import cleanly.
- `sb_rig_tag.py` — the `ShotblocksTag` (TagData). Per-frame `Execute` runs the procedural pipeline. Parameter IDs match `res/description/tshotblocks.h`.
- `sb_rig_spring.py`, `sb_rig_quat.py`, `sb_rig_noise.py`, `sb_rig_zoom.py` — rig subsystems composed by the tag.
- `src/vendor/` — bundled binary deps with verbatim license files. `minimp3.dll` ships but is currently unused by the Python plugin (kept for an eventual audio-reactive rig parameter); `build/` keeps the rebuild source and is excluded from deploy via `robocopy /XD build`.
- `src/res/` — required global stubs (`c4d_symbols.h`, `strings_en-US/c4d_strings.str`) plus the tag's `.res`/`.h`/`.str` and `tshotblocks.tif` icon.

**C++ (`host/shotblocks/`) — the timeline plugin:**
- `source/main.cpp` — single-file plugin. Registers the v2 command + dialog, hosts the WebView2 (via C4D 2026's `HtmlViewerCustomGui`), runs the loopback HTTP server bridge, drives playback timer + camera routing + persistence.
- `web/src/` — React + TypeScript + Vite UI. Zustand store, ~30 hooks, ~20 components, flat layout. `vite-plugin-singlefile` bundles into one `dist/index.html` loaded via `file://`.

## Plugin model essentials

- **Single tag.** The Shotblocks tag is the only user-visible Python plugin element; rig behaviors (spring-damper, look-at, noise, autofocus, framing, zoom) are internal subsystems exposed in its Attribute Manager, not separate tags. The C++ v2 plugin provides its own command + docked dialog for the timeline UI; their ID rule (the v2 command and its async dialog share one plugin ID so C4D's layout-restore can match the saved slot — mismatched IDs produce "Plugin not found") lives in `host/shotblocks/source/main.cpp`.
- **No rig nulls.** The tag's `Execute` reads the camera's evaluated pose and writes the procedural result directly back to the camera. Every behavior is math on the pose, not a chain of null objects in the OM. This was a v10 decision and is documented in `.agent/skills/rig-hierarchy.md` and the architecture.
- **Tag pose writes go through `SetRelRot`/`SetRelPos`** (local channels) rather than `SetMg`. World-matrix writes get clobbered by C4D's world-from-local recompose; local-channel writes survive.
- **`id(tag)` and `GetUniqueIP()` churn on every Execute.** Per-tag state is keyed via a marker in the tag's `BaseContainer`, not by Python identity.
- **Threading.** Plugin lifecycle methods (Python tag `Execute`, C++ `Message`/`Timer`) run on the main thread. The C++ v2 plugin's loopback HTTP bridge runs on a worker thread; v2 audio decode and peaks computation happen in the WebView2 process via WebAudio. Cross-thread signalling uses `c4d.SpecialEventAdd(<plugin_id>)` → `CoreMessage` on the main thread (legacy v1 pattern; the C++ side uses Windows messages + the dialog's `Message()` dispatch).
- **`SceneHookData` is not exposed in C4D 2026.2.0 Python.** Document persistence uses a hidden `BaseObject` (`NBIT_OHIDE`) inserted into the document with state serialized in its `BaseContainer` (v2 uses JSON in keyed entries). Every helper-container write inside `StartUndo/EndUndo` must follow a single `AddUndo` (undo registers at `AddUndo` time, not at end-of-block).
- **`CUSTOMGUI_VECTOR2D` is UserData-only in C4D 2026.** The `.res` parser rejects the keyword and silently empties the AM; the 2D joystick widget is reachable only via `tag.AddUserData` with `DESC_CUSTOMGUI`.
- **Don't `except: pass` at C4D API boundaries.** Silent swallow hid a multi-month bug. Always log the exception.
- **Plugin IDs `1000001-1000010` are the reserved testing range.** Real IDs come from Maxon's generator before any public release.

## Versioning & scope

**Targets: C4D 2026.2.0 on Windows and macOS (Apple Silicon), as of v1.2.0.** No older C4D versions — not on the roadmap. The platform split lives in the C++ plugin (`#ifdef _WIN32`), the web bridge transport, and the cursor layers; read the macOS entries in `.agent/context/pitfalls.md` before touching any of it. Release packaging is `tools/package_plugin.py` over the stamped two-OS binaries in `native/builds/`. Mac dev loop: `tools/build_native_mac.sh` + `scripts/deploy-mac.sh` (no force-kill script yet — quit C4D manually).

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
