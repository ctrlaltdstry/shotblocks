# Handoff — end of 2026-05-29 session

Next session's job: **build the Chase / Follow-Target camera behavior.**
The design is already done and specced — this is an implementation
session, not a design one. Read the spec, then start building.

## Read these first

1. `CLAUDE.md` — non-negotiable rules. Especially the **dev loop**, the
   **"measure before fixing"** rule, and **"two failed attempts on the
   same bug → stop and surface the architectural alternative."** (This
   session lost time guessing at a layout bug and at a playback bug
   before resetting to measurement — don't repeat that. After the FIRST
   failed fix, reset to the known-good baseline and re-apply one change
   at a time.)
2. **`.agent/plans/rig-chase-follow.md`** — the full Chase/Follow spec.
   This is the task. All the key decisions are already made (see below).
3. `.agent/skills/spring-damper.md` — the lag/overshoot engine the chase
   reuses.
4. `src/sb_rig_tag.py` + `src/sb_rig_spring.py` — the rig tag and the
   spring it composes. Read how `_read_keyframed_target` /
   `_execute` / `_write_back` work; chase plugs in as a new position-
   target source.

## The task — Chase / Follow-Target (decided design)

A camera that **pursues a moving object with its own momentum** — trails
it, lags, overshoots on turns — instead of being rigidly parented. Use
case: a camera chasing a flying mouse-cursor as it darts between objects.

**Decisions already locked in (do NOT re-litigate; build to these):**
- **New pure-function module `src/sb_rig_follow.py`** — no `c4d` import,
  exactly like `sb_rig_spring`/`sb_rig_noise`/`sb_rig_zoom`. Signature
  idea: given (target pos, target velocity, current cam state, knobs) →
  return the **desired camera position**. The existing position spring
  does the lag/overshoot. This module is **front-end-agnostic** on
  purpose: the tag drives it now, the v2 motion-layers Targeting "Chase"
  pill drives the *same module* later. Build the math once.
- **Velocity-relative pursuit:** desired pos =
  `target_pos − (velocity_dir × follow_distance)` + a small height/side
  bias. The "behind it along its heading" model.
- **Position only.** Chase drives the camera *body*. **Aim stays on the
  existing Look-At Target + angular spring** (they compose — you can
  chase one object and look at another, or set both to the cursor).
- The two **failure modes are the real work** (need live tuning against
  a real flying-cursor anim, not theory):
  1. *Low-speed direction jitter* — velocity direction flips when slow;
     fix = low-pass the velocity + fade the velocity-relative offset out
     to a neutral world-offset hold below a speed threshold.
  2. *Reverse whip-around* — cap how fast the "behind" point re-orients
     on a sharp reversal (a re-orient damping knob).
- **Implied knobs:** Follow Target (own object link, separate from
  Look-At Target), Follow Distance, Position Damping (exists), Velocity
  Smoothing, Re-orient Speed, Height/Side Bias.

**Open questions to resolve before/while implementing** (in the spec):
- Velocity source: target frame-to-frame position delta (simplest, fits
  the stateless-sample philosophy) vs CTrack-derived. Delta + low-pass
  is probably enough.
- Chase needs prev-frame smoothed velocity → per-tag runtime state.
  Decide how it **resets on scrub-back / shot boundary** (likely: snap
  to current desired spot on reset, like the spring's `reset_to_target`
  already does — see `_RUNTIME` / `request_reset` in sb_rig_tag.py).
- The world-offset "gentle hold" shape at low speed.

**How to verify:** you'll need a scene with an animated object to chase.
Make one (animate a null/cube flying around), drop the rig tag on a
camera, set Follow Target to the flying object, scrub/play and judge the
feel. There's a `scenes/dev-test.c4d` on disk (now gitignored) you can
use or replace.

## Where it fits the roadmap

Built **pre-v2 as a rig-tag knob**, deliberately so the v2 motion-layers
Targeting "Chase" pill reuses the same `sb_rig_follow.py` engine
(Plans 2–4 of `.agent/plans/motion-layers-roadmap.md`, which now links to
the chase spec). It may end up its own small pre-v2 release increment
(like v1.2 Live Aim) — that placement is an open call.

## Current rig-tag state (just reworked this session — context)

The camera-rig tag AM was reworked and **committed** this session
(commit `5dc0fe1`):
- **Additive-only** — the Replace mode was removed (never built).
- **Damping** = Linear / Angular **percent sliders**, default 0%.
- **Look At + Framing** are still separate groups (an "Aim" merge was
  tried and reverted — left as-is).
- **Noise** = "Handheld Noise" checkbox (was a profile dropdown);
  sliders + artist labels (Shake Amount, Drift Speed, Walk Cycle, Seed).
- **Zoom** = sliders + renamed section "Zoom" (Frequency, Amount, Hold,
  Snap In, Pull Back, Return).
- **`.res` slider lesson (important for any AM work):** a
  `CUSTOMGUI REALSLIDER` fills width by default — **do NOT add
  `FIT_H`/`SCALE_H`**, it breaks the layout (collapses sliders + sibling
  fields). Copy the SDK's own working `.res` form
  (`c4d_sdk_2026/plugins/.../oenoise.res`). Memory:
  `feedback_c4d_res_slider_no_fit_h`.

## Also shipped this session (context, all committed + pushed)

- **Playback fix** (`ad83fa1`): v2 spacebar now delegates to C4D's native
  `RunAnimation` transport instead of a hand-rolled per-frame `SetTime`
  timer. Cached sims/Alembic now play smoothly; uncached sims run; the
  earlier per-frame-`ExecutePasses` approach **crashed** (re-entered the
  sim/Alembic cache build). I/O play range now sets C4D's loop times
  live. Memory: `feedback_c4d_playback_delegate_to_runanimation`. Don't
  reintroduce a manual playback timer.
- **Live Aim roadmap** (`9c1d41e`): the mouse→keyframes performance-
  capture feature, planned as **v1.2**. Research in
  `.agent/research/live-camera-control.md`. (Separate from chase; both
  are "procedural camera authoring.")

## Git / GitHub (set up this session)

- Repo is now on GitHub (**private**): `github.com/ctrlaltdstry/shotblocks`.
  `origin` is configured, `main` tracks `origin/main`.
- **Workflow is trunk-based on `main`** — commit straight to main, no
  branches (solo project; CLAUDE.md confirms). Push to back up.
- **Mike is new to git** — explain in plain terms, no unexplained jargon.
  Commit only when asked; push only when asked (it's outward-facing).
- One commit per atomic, verified change. End commit messages with the
  `Co-Authored-By: Claude Opus 4.8 (1M context)` line.

## Dev loop (re-stated)

- `powershell -ExecutionPolicy Bypass -File scripts\dev-loop.ps1` from
  the repo ROOT — kills C4D, deploys, relaunches with `dev-test.c4d`.
- **Python rig** changes (`src/`) ship via that deploy — **no build
  step.** The chase work is Python-only, so the loop is fast: edit
  `sb_rig_follow.py` / `sb_rig_tag.py` → dev-loop → judge feel.
- (C++ timeline changes would need
  `cmake --build c:/Dev/c4d_sdk_2026/build-win64 --target shotblocks
  --config Release` first — but chase doesn't touch C++.)
- Verify in the live app before committing.

## Working tree

Untracked debris safe to ignore or delete: the two `HANDOFF-*SCRUB-BUG*`
files (that bug is long fixed), `Icons/`, and random junk scenes
(`ertergerg34.c4d`, `sdfsdfsdfsd.c4d`, `test.c4d`). `dev-test.c4d` is now
gitignored (autosave noise). Nothing uncommitted that matters.

Good luck with the chase camera.
