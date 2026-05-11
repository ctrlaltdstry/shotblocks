# Rig Hierarchy — historical note

**This document describes an approach the project considered and
rejected during v10 implementation.** Keeping it here for context so
future readers understand why the codebase has no rig-null code.

## The legacy approach (rejected)

Physical camera rigs work as a chain of independent joints:

```
world_null              — placement and worldspace anchor (dolly)
  └─ boom_null          — vertical / crane height (translates Y)
      └─ pan_null       — horizontal rotation (rotates Y)
          └─ tilt_null  — vertical rotation (rotates X)
              └─ camera — focal length, focus, sensor
```

3D software typically mirrors this with a chain of null objects.
Most published C4D rig tutorials build exactly this hierarchy. The
appeal: each null has one job, animations on one channel don't bleed
into others, spring-damper on each null is independent and well-
behaved.

The original Shotblocks architecture (v0–v9 docs, pre-v10) called
for this same null chain, auto-generated when the Shotblocks tag was
applied to a camera.

## Why we rejected it

During v10 implementation, the practical costs surfaced:

1. **OM clutter.** Every tagged camera adds four nulls to the
   user's Object Manager. After a few cameras, the OM is dominated
   by Shotblocks scaffolding.

2. **Buried tag.** Reparenting the camera under the null chain
   means the Shotblocks tag (which lives on the camera) is now four
   levels deep. Selecting it requires expanding four nulls in the
   OM. The tag is the *primary* surface the user interacts with;
   burying it is hostile.

3. **Hiding the nulls breaks the camera.** C4D's `NBIT_OHIDE`
   hides an object *and its descendants* in the OM. Hiding the four
   nulls also hides the camera under them — the user looks at the
   OM and their camera has vanished. There's no built-in way to
   hide the nulls but show the camera inside.

4. **The math doesn't need them.** Every behavior in the architecture
   (spring-damper, look-at, autofocus, noise, framing) can be
   implemented as math on the camera's pose. The null chain is a
   convenience for *manual keyframing of separated channels*, not a
   requirement for procedural behavior.

5. **Constitution principle 2.** "The user owns the camera;
   Shotblocks directs it." Wrapping the user's camera in four
   plugin-generated objects inverts that.

## What we do instead

The Shotblocks tag operates directly on the camera's pose each
frame. Its `Execute`:

1. Reads the camera's evaluated pose (post-animation pass, so user
   keyframes have already been applied).
2. Runs the procedural pipeline as math:
   - **Spring-damper** smooths position, rotation, focal length,
     focus distance. State held on the tag.
   - **Look-at** (v11+) computes a target rotation from a target
     object's position.
   - **Framing rule** (v11+) offsets the look-at target.
   - **Noise** (v11+) samples a noise function and adds a delta.
   - **Autofocus** (v11+) computes focus distance from a target or
     raycast.
3. Writes the final pose to the camera (via `SetMg` / `SetRelPos` /
   etc.). The camera's parent in the OM is whatever the user chose
   — Shotblocks does not reparent.

State that would have lived on the nulls (e.g., the boom's
keyframable Y height for a crane preset) is exposed instead as
**parameters on the tag** or **animation tracks on a preset**.
Presets that author a crane move keyframe a parameter like
`tag.preset_boom_y`; the tag's Execute reads that parameter and adds
it to the position output.

## When a user wants to animate the rig manually

In the legacy null-chain design, the answer was "keyframe the boom
null directly." In the no-nulls design, the answer is one of:

- **Additive mode**: keyframe the camera itself. The tag's
  spring-damper smooths your animation; everything else layers on
  top.
- **Replace mode + preset**: pick a preset that exposes the rig
  parameter the user wants (boom_y, dolly_x), and keyframe that
  parameter on the tag.

The first is the common case (motion designers with AE muscle
memory). The second is the procedural-authoring case.

## Bake-down

Unchanged from the legacy design: the bake-down operation steps
through the frame range, records the camera's evaluated pose (now
trivially equal to whatever the tag wrote), and produces reduced
F-curves on a standard camera. See `skills/fcurve-baking.md`.

## Reference

- Decision made during v10 implementation, 2026-05-11.
- See `.agent/tasks/v10-rig-pipeline.md` "What actually shipped"
  for the implementation specifics.
