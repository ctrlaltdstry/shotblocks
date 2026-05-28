# Handoff — end of 2026-05-28 session

Big session. **Plan 4.1 (live Stage render) finished and shipped**,
**Plan 5 (v1 polish pass) items 1–5 shipped plus a large second wave of
polish**, and **two render bugs fixed**. The only remaining v1 work is
the **camera-rig-tag rework (Plan 5 item 7)** — deferred to its own
focused design session, which is what the NEXT chat should start on.

## Read these first

1. `CLAUDE.md` — non-negotiable rules. Especially the dev-loop, the
   "measure before fixing" rule, and "two failed attempts on the same
   bug → stop and surface the architectural alternative."
2. `.agent/router.md` → `.agent/constitution.md` — project principles.
3. `.agent/plans/v1-plan-5-polish-pass.md` — the polish plan; item 7 is
   the camera-rig-tag rework, the next session's subject.
4. `.agent/skills/rig-hierarchy.md` + `.agent/skills/spring-damper.md` —
   the rig design (no rig nulls; tag does math on the camera pose).
5. `src/sb_rig_tag.py` and the `src/sb_rig_*.py` siblings — the actual
   rig code (see "Camera-rig-tag — starting point" below).

## What shipped this session (29 commits, `a8e61d3`..`d8e070f`)

**Plan 4.1 — live Stage render (FINISHED):**
- `a8e61d3` fix render-time Stage camera switching. Root cause was a
  BaseContainer marker-key collision: the Stage helper's identity marker
  was written to BC key `1100`, which on an `Ostage` IS
  `STAGEOBJECT_CLINK` (the camera-link param). They clobbered each other →
  duplicate Stages + empty camera links. Fixed by moving the marker to a
  private key. (Memory: `c4d-bc-marker-key-param-collision`.)
- `3077d97` tie the Stage process to whole-sequence render mode — in
  individual-shots mode JS flushes the Stage track and the render-time
  enable only fires when keyframes exist.

**Render bug fix (pre-existing, found this session):**
- `4cf7d8f` individual-shots Render Queue jobs all rendered the SAME
  camera. A BatchRender queue ENTRY has its own camera index, separate
  from the take's SetCamera, and it wins at render time. Fixed via
  `SetActiveCameraIndex(entry, camPos + 1)`. (Memory:
  `c4d-batchrender-per-entry-camera`.)

**Plan 5 — polish pass (items 1–5 + a big second wave):**
- Settings default camera → Redshift when installed (`3db1e0e`).
- Hide Add-to-Queue/Settings buttons in whole-sequence mode (`08112d2`).
- Remove Dump Stage button + `[dump]` debug logging (`30c75b8`).
- Custom styled tooltips + tool shortcuts; Pen=P, Shift+M=marker toggle;
  Motion Library button disabled (placeholder) (`6a0154f`).
- Menu + camera-tag icons (purple set), 64×64 PNGs in `src/res/icons/`,
  loaded by C++ command + Python tag (`8eb172d`, `8aad6c4`).
- Render mode now defaults to **whole-sequence** (`66e5b82`).
- Debug overlay hidden by default; backtick still toggles it (`9ec4b61`).
- Timecode: Ctrl-click toggles timecode/frames; smooth per-frame scrub
  readout; click-drag scrubs with infinite edge-wrap via a C++
  `warp-cursor` command (SetCursorPos) — Pointer Lock was avoided because
  WebView2 shows an unsuppressable "press Esc" banner (`757f388`,
  `6603f29`, `60f3329`).
- Purple primary accent `#824CEE` (clip bodies `#A47BF2`); timecode stays
  blue `#007AFF` as a distinct readout (`4f9d837`).
- Vertical timeline zoom gated on having audio content (`5de6dd5`).
- Audio-clip delete is now a single undo step — byte removal bundled into
  the save-state undo block (`1f00f4f`).
- Clip hover polish: no native tooltip on clips, edge-hover brackets lost
  the yellow stroke (clean fill only, incl. roll), label band keeps a
  stable height when text drops on narrow clips (`769c6cb`).
- Snap-indicator lines fade to transparent at top/bottom (`72158e9`).
- Play-range bar restyle to final Figma (blue 10% interior, gray→blue
  handle iterations settled on `#007AFF`) (`11eaecf`).
- Clip edge handles scale on narrow clips + hide when too small
  (`0beb50d`); empty-state drop-zone text/icon tidy (`f05b5fc`).
- Add Camera placement: at the playhead if the 72-frame span is clear,
  else flush against the colliding clip on the roomier side (`d8e070f`).
- Playhead line stays visible at the last frame (`b4a95f2`).

## NEXT SESSION — Camera-rig-tag rework (Plan 5 item 7)

Mike wants to re-examine and tweak what the Shotblocks camera-animation
tag does. This is open-ended and deserves a focused session. **Start by
asking Mike which behaviors he wants to change** — don't assume.

### Camera-rig-tag — starting point (what exists today)

The tag is the **Python** plugin under `src/` (separate from the C++
timeline). It's applied to a camera; its per-frame `Execute` runs a
procedural pipeline on the camera's evaluated pose and writes the result
back via `SetRelRot`/`SetRelPos` (local channels, never `SetMg`).

- `src/sb_rig_tag.py` (1392 lines) — the `ShotblocksTag` (TagData).
  Composes the subsystems. Param IDs at the top match
  `res/description/tshotblocks.h`. Two modes: **Additive** (read keyframed
  pose, spring against it, write smoothed result — user keyframes never
  modified) and **Replace** (deferred/stubbed — short-circuits with a
  warning; presets/look-at-driven, none of which exist yet).
- `src/sb_rig_spring.py` (121) — spring-damper (pos + rot smoothing).
- `src/sb_rig_quat.py` (201) — quaternion look-at / slerp helpers.
- `src/sb_rig_noise.py` (395) — fBm/value-noise handheld + walk-cycle.
- `src/sb_rig_zoom.py` (231) — beat/zoom punch behavior.

### Hard rules for the rig tag (from memory + CLAUDE.md)

- **No rig nulls.** Every behavior is math on the camera pose, not a null
  chain. (`.agent/skills/rig-hierarchy.md`, memory `no-rig-nulls`.)
- **Writes go through `SetRelRot`/`SetRelPos`**, not `SetMg` — world
  writes get clobbered by C4D's world-from-local recompose. (memory
  `c4d-setrelrot-vs-setmg`.)
- **Per-tag state keyed by `tag.GetUniqueIP()`**, not `id(tag)` — C4D
  churns the Python wrapper every Execute. (memory
  `c4d-basetag-python-wrapper-churn`.)
- **Noise above the spring's ~1.5 Hz corner must go post-spring** or the
  low-pass eats it. (memory `noise-band-placement`.)
- **Use fBm, not sum-of-sines**, for organic noise — Mike rejected sines.
  (memory `noise-fbm-over-sines`.)
- **`CUSTOMGUI_VECTOR2D` is UserData-only** in C4D 2026 (.res parser
  rejects it; empties the AM). The 2D joystick (Frame Offset) is added via
  `tag.AddUserData`. (memory `c4d-customgui-vector2d-userdata-only`.)
- **Don't `except: pass` at C4D API boundaries** — log the exception.
- **Read the Python source before guessing** on constants/ordering/
  semantics — it's authoritative. (memory `mine-python-for-constants`.)

### Known rig-tag deferred bug (relevant)

Cameras using the Shotblocks rig tag render as a single frozen frame —
the spring-damper / fBm state isn't initialized cold at render time (the
renderer doesn't tick Execute like live playback). Filed and deferred;
relates to a future "bake to keyframes" capability. Worth deciding
whether the rework addresses this.

## Dev loop (re-stated)

- `powershell -ExecutionPolicy Bypass -File scripts\dev-loop.ps1` —
  kills C4D, deploys, relaunches with `dev-test.c4d`. Run from the repo
  ROOT (running it from a subdir prints only the PowerShell banner).
- **Python rig** changes ship via the `src/` deploy — no build step.
- **C++ timeline** changes need
  `cmake --build c:/Dev/c4d_sdk_2026/build-win64 --target shotblocks --config Release`
  BEFORE dev-loop. Watch the **600-line function cap** on `Dispatch` —
  extract new handlers into private methods (e.g. `HandleWarpCursor`,
  `RemoveOrphanedAudioBytes`).
- **Web** changes: `npm run build` in `host/shotblocks/web` (Vite catches
  type errors that `tsc --noEmit` sometimes misses — trust the build).
- Verify in the live app before committing. One atomic change per commit.

## Working tree

`scenes/dev-test.c4d` shows as modified — autosave noise, **don't
commit**. The random-named junk scenes at the repo root (`efwefwfew.c4d`,
`sdfsdfsdfsdf.c4d`, `scenes/frames/`, etc.) and the two old
`HANDOFF-*SCRUB-BUG*.md` files are untracked session debris — delete at
will. `scenes/test stage animation.c4d` is the Stage render reference;
keep it.

Good luck with the rig tag.
