# Task: v11 — Look-at behavior

## Goal

The Shotblocks tag can aim the camera at a user-picked target each
frame. In additive mode, this corrective rotation blends with the
user's keyframed rotation via a strength slider. In replace mode,
look-at fully drives rotation. The spring-damper from v10 smooths
the resulting rotation, giving the camera physical weight as it
tracks moving targets.

## Why

- **Cinematographic mental model.** "This camera looks at that
  subject" is the most common intent. v10 forces the user to
  keyframe rotation manually to keep a subject framed; look-at
  automates it.
- **Replace mode finally does something.** v10 exposed the mode
  parameter but replace mode was idle (no procedural drivers
  existed). Look-at is the first real driver, making the mode
  meaningful.
- **Unblocks the rest of the v11+ behaviors** that depend on
  rotation logic: framing rule offsets the look-at target;
  autofocus needs a target reference; noise applies rotational
  shake on top. Look-at is the load-bearing piece.

## Read first

- `.agent/constitution.md` — principle 2 (additive vs replace),
  principle 7 (physical motion).
- `.agent/context/architecture.md` — "Rig behaviors" section, the
  no-rig-nulls decision, the per-frame data flow.
- `.agent/skills/spring-damper.md` — quaternion smoothing note at
  the bottom; we need it now.
- `.agent/skills/rig-hierarchy.md` (historical) — note that
  look-at in our architecture is math on the camera's pose, not a
  pan/tilt null pair.
- `src/sb_rig_tag.py` — the v10 tag. Look-at slots into the same
  pipeline; spring already smooths rotation, we just change what
  the rotation target is.

## Scope (v11)

**In:**

1. **Two new tag parameters:**
   - `Target` (BaseLink) — the object the camera aims at. The
     camera's -Z axis points at the target's world position each
     frame.
   - `Up Target` (BaseLink, optional) — defines the up vector.
     Camera's +Y points toward this object's world position. If
     empty, fall back to world Y.

2. **Strength slider (additive mode only):**
   - `Look-At Strength` (real 0..1, default 1.0 when a target is
     set, 0.0 when not).
   - 0 = look-at off, user's rotation unchanged.
   - 1 = full look-at, camera aims exactly at target.
   - Between = slerp from the user's keyframed rotation toward the
     look-at rotation.
   - In replace mode, the strength parameter is hidden / ignored;
     look-at fully drives rotation.

3. **Quaternion math:**
   - HPB Euler decomposition breaks down near vertical aim (gimbal
     lock). v10 was fine without quaternions because we only
     decomposed once per frame. v11 needs to slerp between two
     rotations (user-keyed and look-at), which requires
     quaternions for stable interpolation.
   - Spring-damping the rotation also needs to operate on a
     wraparound-safe representation. Two options:
     - Continue smoothing HPB Euler in the spring (current v10
       behavior), but compute the *target* rotation via
       quaternions and convert to HPB just before the spring step.
       Works as long as the user doesn't keyframe rotations that
       cross the ±π boundary mid-shot.
     - Move the spring to operate on quaternions directly. More
       work; needed eventually for shaky-cam noise too. v11+
       deferred.
   - Pick option 1 for v11 (HPB spring on quat-derived target).
     Document the gimbal-edge case; revisit if it bites.

4. **Replace mode unhid.** v10's replace-mode warning becomes
   conditional: if `Target` is set, replace mode actually runs
   look-at. If `Target` is None, the warning still fires (no
   driver, nothing to do).

5. **Target world-position read once per frame.** Resolving a
   BaseLink and reading the target's `GetMg().off` is cheap, but
   we should still cache the resolved BaseObject ref on the
   tag's runtime state and re-resolve only when it goes stale
   (e.g., target deleted). Same pattern as the v5+ camera
   BaseLink resolution.

6. **Frame-independent look-at:** the target's position at *this
   frame* is what we aim at — we read the target's evaluated
   `GetMg().off` post-animation (the standard read just like
   the camera's pose). If the target itself is animated, our
   look-at tracks it.

**Out (deferred):**

- Quaternion spring smoothing (v12+ — needed for noise/shake).
- Framing rule offset (rule-of-thirds, etc.) — v12+.
- Aim constraint *modes* (point, plane, screen-space). Just
  point-at-target for v11.
- Twist/roll override — the up-target system handles roll
  implicitly; explicit roll override is a v12+ preset feature.
- Look-at trajectory prediction — for fast-moving targets, leading
  the target the way a real operator would. Far-future.

## Approach

### Math

Per-frame, after we've computed the smoothed position (the v10
pipeline as-is):

```
target_pos_world = target_link.GetMg().off   # or None if no target
up_pos_world     = up_link.GetMg().off       # or None
cam_pos_world    = (spring's smoothed position, in world space)
```

Build a look-at world matrix:

```
forward = normalize(target_pos_world - cam_pos_world)   # -Z direction
up_ref  = (up_pos_world - cam_pos_world).normalize() if up_link else Vector(0, 1, 0)
right   = normalize(cross(up_ref, forward))
up      = cross(forward, right)
look_at_mg = Matrix(
    off = cam_pos_world,
    v1  = right,
    v2  = up,
    v3  = -forward,   # camera looks along -Z
)
```

Convert `look_at_mg` to HPB Euler. That's the rotation target the
spring chases.

In additive mode with strength `s ∈ [0, 1]`:
- Read user's keyframed rotation (from animation tracks, as v10
  already does for additive smoothing).
- Convert both user-rot and look-at-rot to quaternions.
- Slerp from user-quat to look-at-quat by `s`.
- Convert blended quat back to HPB.
- Feed that HPB into the spring as the target.

In replace mode:
- Look-at-rot IS the target. No slerp.

### Files

| File | Change |
|---|---|
| `src/sb_rig_quat.py` | **New.** Pure-Python quaternion helpers: `from_matrix`, `to_matrix`, `to_hpb`, `from_hpb`, `slerp`. ~80 lines. No `c4d` import. |
| `src/sb_rig_tag.py` | Read the two BaseLinks at execute time. After v10's position-spring step, compute the look-at world matrix, slerp with user rotation (additive) or use directly (replace), feed to rotation spring. |
| `src/res/description/tshotblocks.h` | Add `SHOTBLOCKS_LOOK_AT_TARGET`, `SHOTBLOCKS_UP_TARGET`, `SHOTBLOCKS_LOOK_AT_STRENGTH`. |
| `src/res/description/tshotblocks.res` | Add `LINK` fields for the two targets and a `REAL` for strength. |
| `src/res/strings_en-US/description/tshotblocks.str` | Display strings. |

### BaseLink storage on the tag

C4D `.res` supports `LINK` fields directly. Read in code via
`tag[SHOTBLOCKS_LOOK_AT_TARGET]` which returns the linked object
(or None). No manual BaseLink wrangling required.

### Edge cases

- **Target == camera.** Forward vector would be zero; cross
  products blow up. Detect and short-circuit (look-at is a no-op
  for this frame; use user's rotation in additive, hold last
  rotation in replace).
- **Up-target collinear with forward.** Rare but possible. If
  `cross(up_ref, forward)` is near zero, fall back to world Y for
  up_ref this frame.
- **Camera and target both animated, both move fast.** The aim
  jumps frame-to-frame. The spring smooths it.
- **Strength = 0 with no user keyframes.** Camera holds whatever
  rotation it last had. This is fine; equivalent to "look-at off."

## Open questions

1. **Hidden parameter when irrelevant.** Should `Look-At Strength`
   show in AM only when `Target` is set? Cleaner UI but C4D's
   description-system parameter hiding is awkward (`HideAttr` in
   `GetDDescription`). Probably fine to leave visible and just
   ignore when no target — strength=0 default is harmless.

2. **Should the strength slider apply to up-vector blending too?**
   E.g., at strength=0.5, the camera blends halfway to look-at
   rotation, but does its up-vector also blend halfway toward
   the up-target's contribution? Slerping the full quaternion
   handles this automatically — the up component is part of the
   rotation being slerped. So: yes, by virtue of quaternion math.

3. **What about an Align-to-Spline–driven camera?** v10's lessons
   say the spring sees AtS output as the keyframed pose. With
   look-at, in additive mode, we'd read the camera's evaluated
   rotation (post-AtS), slerp toward look-at, smooth, write. The
   AtS-driven roll/heading combined with a look-at strength of,
   say, 0.5 would give "camera tries to track the subject but
   biases toward following the spline." Worth testing as a sanity
   check.

## Done when

- [ ] `sb_rig_quat.py` exists, pure-Python, no `c4d` import.
      Smoke test: roundtrip HPB → quat → HPB matches input within
      epsilon for non-gimbal cases.
- [ ] Tag has three new parameters in AM: `Target` (link),
      `Up Target` (link), `Look-At Strength` (real 0..1).
- [ ] With a tagged camera and a target object set, the camera
      aims at the target across playback.
- [ ] Animating the target's position causes the camera to
      track it (additive mode, strength = 1).
- [ ] Strength slider at 0.5 produces a visible half-blend
      between user-keyed rotation and the look-at rotation.
- [ ] Spring's rotation damping smooths the look-at output —
      fast-moving target produces a visible whip-pan with weight.
- [ ] Replace mode + target set = camera always aims at target
      (no console warning).
- [ ] Replace mode + no target = console warning persists; tag
      is idle.
- [ ] Up-target set = camera's top points toward up-target.
      Empty = world Y.
- [ ] Cmd+Z reverts target / strength edits like any other AM
      change.
- [ ] Manual checklist (≤ 8 items) appended to this file and
      passes.

## Manual checklist

Set up: dev-test scene with the existing animated camera (its
position keys remain). Add a cube at (0, 100, 0) and another at
(0, 500, 0). These will be aim/up targets.

- [ ] **Basic look-at.** Set tag's Target to the first cube.
      Strength = 1. Scrub through playback. Camera always frames
      the cube regardless of its own position motion.
- [ ] **Animated target.** Keyframe the cube to move from (0,100,0)
      to (500, 100, 0) over 60 frames. Playback. Camera tracks
      the cube across the screen.
- [ ] **Strength blend.** Strength = 0.5. Camera's rotation is
      partway between its keyed rotation and the aim direction.
- [ ] **Strength = 0.** Look-at off; camera uses its keyed
      rotation as in v10.
- [ ] **Up-target.** Set Up Target to the second cube. Camera's
      +Y now points toward that cube. Move it around; camera
      banks accordingly.
- [ ] **Rotation damping with look-at.** Animate the target
      quickly across the scene. With rotation damping high
      (~0.8), camera lags the aim with a visible whip-pan feel.
      With damping low, camera snaps to aim.
- [ ] **Replace mode + target.** Switch to replace mode. Camera
      aims exactly at target; user's keyed rotation is ignored.
      No console warning.
- [ ] **Replace mode + no target.** Clear the Target link.
      Console warning fires; tag is idle (camera returns to
      user-keyed rotation untouched).

## Notes

## What actually shipped (post-iteration)

The spec went through several rewrites before landing. The
final implementation diverges from the original plan in important
ways — preserving here so future readers don't reinvent the dead
ends.

### Use SetRelRot, not SetMg

The biggest surprise: writing `cam.SetMg(matrix)` to apply the
look-at world matrix **does not work** when another tag (e.g.
Align-to-Spline) is also driving the camera. C4D's expression
cycle ends with a "recompose world from local Rel channels" pass —
whatever world matrix we write via `SetMg` gets thrown away and
the world is rebuilt from whoever last wrote `Rel*` channels.

Diagnostic confirmed: `SetMg(m)` immediately followed by
`cam.GetMg()` returns our matrix exactly. But on the next Execute
call, `cam.GetMg().v3` was the AtS spline tangent direction — our
matrix had been overwritten between frames by the recompose.

**The fix:** write `cam.SetRelRot(hpb)` with the local HPB
rotation. The recompose then uses *our* local channel value to
build the world matrix.

Memory: `feedback_c4d_setrelrot_vs_setmg.md`.

### Match the canonical SDK pattern exactly

The Maxon SDK example
`Cinema-4D-Cpp-API-Examples/plugins/example.main/source/tag/lookatcamera.cpp`
implements look-at in 5 lines:

```python
local_dir = (~(cam.GetUpMg() * cam.GetFrozenMln())) * target_world_pos - cam.GetRelPos()
hpb = c4d.utils.VectorToHPB(local_dir)
hpb.z = cam.GetRelRot().z   # preserve bank
cam.SetRelRot(hpb)
```

`VectorToHPB` is the c4d.utils helper that converts a direction
vector into the HPB rotation that would aim local -Z down that
direction. Using it on a *parent-frozen-local-space* direction
vector handles parent hierarchies and frozen transforms for free.

We replaced our hand-rolled basis-vector + quaternion math with
this. Mistakes in the hand-rolled version were producing the
"camera flipping around at random points" symptom.

### Up-target deferred

The constitution-pick was "full orientation with up target." The
SDK pattern doesn't use one — `VectorToHPB` implicitly uses world
+Y, and bank is preserved from the camera's current rotation.
v11 ships this way; up-target support is deferred to v11.1+
(would require a bank-computation overlay on top of the base
aim).

### Tag execution priority is NOT the answer

I spent significant time bumping the tag's expression priority
(`CYCLE_GENERATORS` with priority 300) thinking that would make
our writes win against Align-to-Spline. It didn't. The recompose
semantics are what matter, not the cycle. Default
`TAG_EXPRESSION | TAG_VISIBLE` with no priority bump is correct —
matches the SDK example exactly.

### Damping works the same as v10

Rotation damping now smooths the look-at HPB target. Each frame,
the look-at math computes the target HPB; the rotation spring
chases it. Fast target motion → camera lags behind (whip pan).
Slow target → near-instant aim. Same damping curve as v10
applies — the spring math is unchanged.

Added one new helper: `_unwrap_angle` shifts the target HPB by
±2π so it's within π of the spring's current value. Without this,
when the look-at HPB crosses the ±π boundary the spring would
chase the long way around (full revolution for visually identical
orientations).

### Replace mode finally does something

Per the original spec, replace mode + Target set lets look-at
fully drive rotation (no blend with keyframed rotation). Replace
mode + no Target = console warning and idle (matches v10
behavior). Mode parameter is selectable in AM, persists through
save/load.

### Final parameter set

In tag AM under "Look At" group:
- `Target` (BaseLink) — required for look-at to do anything
- `Up Target` (BaseLink) — currently unused (deferred)
- `Look-At Strength` (0..1) — in additive mode, slerps between
  keyframed rotation and look-at rotation

### Future work (v11.1+)

- Implement up-target as a bank-correction term on top of
  VectorToHPB's output
- Quaternion-based rotation spring (replaces HPB spring with
  shortest-arc quaternion lerp toward target) — needed when look-at
  hits gimbal regions or when noise/shake ships
