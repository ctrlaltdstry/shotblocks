# Handoff — end of 2026-06-07 session

This session: built the **object Motion tag** (inertia/weight) and **rebuilt
the camera Chase** as a world-anchored sphere, then reorganized the camera
tag UI into tabs. All committed and **pushed** (origin/main = `1a6e5b9`).

There is **no committed-but-unfinished work** and **no open bug**. A new
session can start fresh on whatever's next.

## Read these first
1. `CLAUDE.md` — rules. Especially the **dev loop**, **measure-before-fixing**,
   and **two failed attempts → stop and instrument**. This session held to
   that with gitignored `src/_*.py` probes (pure-math checks before C4D
   wiring); it paid off repeatedly. Keep doing it.
2. `.agent/router.md` + `.agent/constitution.md` — project shape & scope.
3. The two plans written this session (below) for the rig details.

## What shipped this session (commits on origin/main, all past tag v1.1.0)
- `e500384` noise: add `gain_scale` (Contrast) to the fBm sampler.
- `1c7fb16` **Shotblocks Motion tag** — 2nd Python tag (id 1000002) giving ANY
  object inertial weight: Weight / Drift / Lean / Turn-Ease + Handheld noise.
  Aim-down-DRIFTED-travel (the nose follows the drifted path, not the rigid
  spline tangent, so body + nose share one physics world). Engine
  `src/sb_rig_inertia.py`. Plan: `.agent/plans/motion-tag-object.md`.
- `b7828a2` Motion-tag plan + gitignore generalized to `src/_*.py`.
- `1a6e5b9` **Chase = world-anchored sphere** rewrite + camera tag UI tabs.
  Plan: `.agent/plans/rig-chase-sphere.md`.

## Current rig state
- **Camera rig tag** (`src/sb_rig_tag.py`, id 1000001): AM is now 4 TABS —
  General (Aim / Smoothing / Advanced) · Chase · Framing (Frame Offset /
  Handheld) · Zoom. Chase = the sphere model: Radius + Strength + Orbit
  (longitude) + Height Angle (latitude) + Camera Roll + Look-Ahead; always
  aims at the target; world-anchored so placement never fights itself.
  Artist-friendly labels throughout (Position/Rotation, Aim Strength, Lean
  Into Turns, Punch In/Ease Out/Settle, etc.).
- **Object Motion tag** (`src/sb_motion_tag.py`, id 1000002): Weight/Drift/
  Lean/Turn-Ease + noise. **Object nose must point -Z** (the aim axis) —
  needs a user-manual note before release.
- Engines (pure functions, no `c4d` import, standalone-testable):
  `sb_rig_spring`, `sb_rig_noise` (has `gain_scale`), `sb_rig_quat`,
  `sb_rig_follow` (gutted to a small sphere `camera_position` + `lead_point`),
  `sb_rig_inertia` (new — offset-spring drift + g-lean + aim-down-travel).

## Open follow-ups (none blocking; pick up if relevant)
1. **User-manual note: Motion tag nose must point -Z.** In
   `host/shotblocks/web` manual page, before any release.
2. **Camera Chase + object Motion tag as one workflow.** "Follow a flying
   object without motion sickness" = Motion tag on the object + Chase on the
   camera pointed at it. Built separately; never verified as a combined rig.
3. **Eyeball-tuned gains** live as constants atop `sb_rig_inertia.py`
   (drift/lean) and in the chase radius-lock / turn-ease easing. Adjust vs
   real scenes if the feel drifts; behavior is correct, only the *amounts*
   are taste.
4. **Not released.** 7 commits sit on main past v1.1.0; none of this rig work
   is in a release build. Release only when the user asks (bump 3 version
   files → package.ps1 → ISCC → tag; see `reference_release_process` memory).

## Process lessons that worked (reuse these)
- Pure engines tested STANDALONE with `python` before C4D wiring.
- **Test through the tag's own module namespace**, not by importing a symbol
  directly — a missing `from_basis` import slipped past a standalone test that
  imported it itself.
- C4D gotchas confirmed this session: DEGREE params read in RADIANS;
  `CUSTOMGUI_VECTOR2D` joystick is too sensitive + its number fields aren't
  editable (we replaced both joysticks with plain sliders); `MatrixToHPB`
  flips representation near +/-90 pitch (use quaternions / basis); `SetMg`
  corrupts pos/rot/scale under a scaled parent (use `SetRel*`); un-keyed
  rotation axes persist our writes (read the authored pose from the matrix /
  CTracks, not `GetRel*`); Align-to-Spline leaves an object's BANK free.

## Dev loop (re-stated)
- `powershell -ExecutionPolicy Bypass -File scripts\dev-loop.ps1` from repo
  ROOT — kills C4D, deploys `src/`, relaunches with `dev-test.c4d`. Python rig
  changes need NO build step. (C++ timeline changes would need a cmake build
  first, but none of this session touched C++.)
- Verify in the live app before committing. Commit/push only when asked.

## Git
- Trunk-based on `main`; `origin` = github.com/ctrlaltdstry/shotblocks (private).
- One commit per atomic verified change; end messages with the
  `Co-Authored-By: Claude Opus 4.8 (1M context)` line.
- Untracked debris safe to ignore: `Cursors/`, `Icons/`, `wizard art/`, junk
  `scenes/*.c4d`, old `HANDOFF-*SCRUB-BUG*` files. Not ours to commit.
