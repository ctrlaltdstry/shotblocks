# Task: v12 — Framing rule on look-at

## Goal

A `Frame Offset` parameter on the Shotblocks tag that shifts the
aim point in **screen space** instead of dead center. The user
picks a 2D offset as a fraction of the viewport (e.g. (0.167, 0.167)
= the top-left rule-of-thirds intersection). A convenience cycle
("Rule of Thirds") sets the offset to one of the nine canonical
zones in one click. Plays through the same HPB rotation spring that
v10/v11 already use — framing is a refinement of the look-at aim,
not a new pipeline.

## Why

- **Cinematography 101.** Centered framing is the exception, not
  the rule. Rule-of-thirds is the single most common framing
  decision in live-action and motion design. v11's look-at always
  centers the target; v12 lets the user say "off-center it, but
  keep tracking."
- **Constitution principle 9** (presets are first-class). The
  rule-of-thirds cycle is the first taste of preset-style
  configuration on the tag — one click, sensible defaults, then
  freely editable.
- **Unblocks downstream preset library.** A preset that says "shoot
  this subject in a low-angle three-quarter framing" needs framing
  offset as a first-class parameter. v12 lands the primitive; the
  preset library composes it.
- **Cheap.** ~10 lines of math added to the existing look-at helper
  + three parameters. Highest payoff-to-scope ratio of the
  candidate v12 behaviors.

## Read first

- `.agent/tasks/v11-look-at.md` "What actually shipped" — the
  `VectorToHPB` + `SetRelRot` discoveries that framing builds on.
- `.agent/constitution.md` — principle 2 (additive vs replace),
  principle 9 (presets).
- `src/sb_rig_tag.py` `_compute_look_at_local_rot` — the function
  we extend.

## Scope (v12)

**In:**

1. **Three new tag parameters:**
   - `Frame Offset X` (real, -0.5..0.5, default 0.0) — fraction of
     horizontal viewport. +0.167 = target ⅓ from the right edge.
   - `Frame Offset Y` (real, -0.5..0.5, default 0.0) — fraction of
     vertical viewport. Positive = up.
   - `Rule of Thirds` (cycle: Off / Left / Right / Top / Bottom /
     TL / TR / BL / BR, default Off) — convenience preset. On
     change to a non-Off value, sets X/Y to the corresponding
     ⅓-intersection (±0.167) and resets itself to Off so the user
     sees the cycle as a "load this preset" button, not a binding.

2. **Math: screen-space offset via local-direction nudge.** In
   `_compute_look_at_local_rot`, after computing `local_dir`:
   ```
   distance    = |local_dir|
   fov_h       = current horizontal FOV in radians (from focal_length + aperture)
   fov_v       = vertical FOV (from fov_h + viewport aspect, or sensor height)
   half_w      = distance * tan(fov_h / 2)
   half_h      = distance * tan(fov_v / 2)
   offset_lp   = world_right * (u * half_w) + world_up * (v * half_h)
                 # in PARENT-frozen local space; for unparented cameras,
                 # world_right = (1,0,0), world_up = (0,1,0)
   local_dir' = local_dir - offset_lp
   hpb        = VectorToHPB(local_dir')
   ```
   Subtraction (not addition) because moving the AIM up-right is
   the same as moving the TARGET down-left in screen space — the
   camera rotates to put the now-offset target back on the optical
   axis, which puts the *real* target off-axis by the desired
   fraction.

3. **FOV computed per frame.** Read the camera's focal length and
   aperture each Execute (they may be keyframed). Use
   `c4d.utils.FocalLengthToFOV(focal_mm, aperture_mm)` if
   available; otherwise compute manually
   (`fov = 2 * atan(aperture / (2 * focal))`).
   Vertical FOV: derive from horizontal via the render aspect ratio
   read off `doc.GetActiveRenderData()`.

4. **World horizon, not camera-relative.** `world_right` and
   `world_up` are computed in the camera's parent-frozen local
   space (so a camera under a rotated parent still gets sane
   axes), but they are NOT the camera's own banked axes. This
   means the framing offset stays oriented to the horizon: if the
   user banks the camera 45°, the rule-of-thirds line stays
   horizontal in world, not in camera. This is usually what's
   wanted; document the choice.

5. **Works identically in additive + replace mode.** The framing
   offset is part of `_compute_look_at_local_rot`'s output. The
   strength slider in additive mode blends the framed-look-at
   rotation with the user's keyed rotation, same as v11.

**Out (deferred):**

- Banked-camera-relative framing (offset rotates with bank).
  Reconsider only if users ask.
- Animated framing offsets via UI affordance. The params are
  keyframable for free because they live on the tag's
  description; no extra UI for v12.
- Smart framing (face detection, subject-aware offset). Far future.
- Per-shot framing override (in the shot's `rig_state` dict).
  Storage already routes through tag overrides; v12 ships the
  tag-level param. Per-shot override editing waits for the v11+
  inspector panel.
- Vertical-format / portrait-aware affordances. The 2D X/Y works
  regardless of viewport aspect; no special-casing needed.

## Approach

### Files

| File | Change |
|---|---|
| `src/sb_rig_tag.py` | Add 3 parameter IDs. Read offset in `_execute`, pass into `_compute_look_at_local_rot`. Read FOV per frame. Handle the Rule-of-Thirds cycle (set X/Y on change, reset cycle to Off). |
| `src/res/description/tshotblocks.h` | Add `SHOTBLOCKS_FRAME_OFFSET_X`, `SHOTBLOCKS_FRAME_OFFSET_Y`, `SHOTBLOCKS_RULE_OF_THIRDS` plus the cycle constants. |
| `src/res/description/tshotblocks.res` | Three REAL/CYCLE fields under the Look-At group (or a new "Framing" group — pick during impl). |
| `src/res/strings_en-US/description/tshotblocks.str` | Display strings for the params and the 9 cycle entries. |

### Cycle-to-XY mapping

```
Off    -> (no-op; cycle stays Off)
Left   -> X=-0.167, Y= 0.000
Right  -> X=+0.167, Y= 0.000
Top    -> X= 0.000, Y=+0.167
Bottom -> X= 0.000, Y=-0.167
TL     -> X=-0.167, Y=+0.167
TR     -> X=+0.167, Y=+0.167
BL     -> X=-0.167, Y=-0.167
BR     -> X=+0.167, Y=-0.167
```

(0.167 ≈ 1/6, which is the distance from screen center to a
rule-of-thirds line — the lines are at ±1/6 from center, since
center is 0 and the edges are ±0.5.)

After the cycle sets X/Y, immediately write it back to Off via
`tag[SHOTBLOCKS_RULE_OF_THIRDS] = 0`. The user sees the cycle as a
momentary button, not a persistent mode.

### Edge cases

- **Offset = (0, 0).** Math degenerates to plain look-at. No
  branching needed — `offset_lp` is a zero vector and `local_dir' =
  local_dir`.
- **FOV unavailable / focal length zero.** Skip the offset for
  this frame; print warning once. Same defensive shape as the rest
  of the helper.
- **Distance is very small (target near camera position).**
  `half_w` and `half_h` shrink to zero with distance, so the
  *world-space* offset shrinks too — visually, screen-space stays
  consistent. This is correct, not a bug.

## Open questions

1. **Cycle naming.** "Rule of Thirds" implies a specific framing
   tradition. The cycle could be named "Framing Preset" with the
   same 9 entries. Lean toward the more specific name — it's
   discoverable and matches what cinematographers actually search
   for. Reconsider if we add center-weighted-square or 16:9-safe
   presets later.

2. **Param group in AM.** New "Framing" group or extend the
   existing "Look At" group? Lean toward a new "Framing" group so
   the look-at section stays minimal. Decide during res-file work.

3. **Render-aspect read.** `doc.GetActiveRenderData()` gives a
   `BaseContainer` we read width/height off. If renderdata is
   unset for some reason, fall back to a 16:9 assumption. Verify
   in impl.

## Done when

- [ ] Three new params visible in the tag's AM under a "Framing"
      group (or extended Look-At group).
- [ ] With Frame Offset X = 0.167 and a Target set, viewport
      shows the target on the right rule-of-thirds vertical.
- [ ] Frame Offset Y = 0.167 puts the target on the top
      rule-of-thirds horizontal.
- [ ] Rule-of-Thirds cycle: selecting "TL" writes X=-0.167,
      Y=+0.167, and the cycle resets to Off in the AM display.
- [ ] Changing focal length on the camera (via AM or keyframe)
      keeps the target on the chosen ⅓ line — FOV recomputes
      each frame.
- [ ] Animating the target's position keeps the target framed
      on the chosen ⅓ line across playback.
- [ ] Spring damping still smooths the framed aim — fast target
      produces a whip-pan that settles to the offset position.
- [ ] Strength slider in additive mode blends correctly — at 0.5,
      the camera's rotation is partway between keyed and
      framed-look-at.
- [ ] Save/load round-trips the three params.
- [ ] Manual checklist (≤ 8 items) appended to this file and
      passes.

## Manual checklist

Set up: dev-test scene with a tagged camera, target cube at
(0, 100, 0).

- [ ] **Center framing baseline.** Frame Offset = (0, 0). Target
      is dead center in the viewport (same as v11).
- [ ] **Right ⅓.** Frame Offset X = 0.167. Target lands on the
      right vertical ⅓ line.
- [ ] **Top-left ⅓ via cycle.** Click Rule of Thirds = TL. AM
      shows X = -0.167, Y = +0.167, cycle reset to Off. Target
      sits at the top-left ⅓ intersection.
- [ ] **Focal length change.** Bump focal length 35mm → 85mm.
      Target stays on the chosen ⅓ line (no drift toward center
      or edge as FOV narrows).
- [ ] **Animated target.** Keyframe the cube moving across the
      scene. Camera tracks it; target stays pinned to the chosen
      ⅓ position throughout.
- [ ] **Strength = 0.5.** Camera's framing is halfway between
      keyed rotation and ⅓-framed aim. Visible blend.
- [ ] **Spring damping with framing.** High damping + animated
      target = visible lag, but the target settles to the chosen
      ⅓ position (not to center).
- [ ] **Save / reopen.** All three params persist across a doc
      save and reopen.

## Notes

(Filled in during impl — final FOV helper, final cycle reset
behavior, anything surprising about the parent-frozen local space
math.)

## What actually shipped (post-iteration)

The spec went through several rewrites in C4D. Final state diverges
from the spec in three ways — preserving here so future readers
don't reinvent the dead ends.

### Single 2D Vector Field via UserData, not two REALs

The spec called for two `REAL` parameters (X and Y) plus a Rule of
Thirds cycle. The user (rightly) asked for a single draggable
joystick instead. C4D exposes a "2D Vector Field" widget via
`CUSTOMGUI_VECTOR2D`, but:

1. The `.res` resource compiler **does not recognise**
   `CUSTOMGUI_VECTOR2D` as a keyword. Adding it to a `VECTOR` or
   `VECTOR2D` field in `.res` empties the entire Attribute Manager
   (the description fails to parse and C4D silently falls back to
   "Basic Properties only").
2. The numeric form (`CUSTOMGUI 200000101`) is also rejected.
3. Both `VECTOR2D` (DTYPE 1050090) and the symbolic `CUSTOMGUI`
   name break the parser the same way.

The widget DOES exist — it's what the User Data dialog labels
"2D Vector Field." It's just only reachable via the UserData API,
not via `.res`. So: the Frame Offset parameter ships as a UserData
slot added programmatically on tag apply (and defensively on first
Execute, so tags from older saves get fixed up). The slot's
descriptor sets `DESC_CUSTOMGUI = CUSTOMGUI_VECTOR2D`.

The slot index is stashed in the tag's BaseContainer under
`_BCKEY_FRAME_OFFSET_UD_IDX` so reads can rebuild the DescID
deterministically across reloads. UserData DescIDs are 2-level
(`(ID_USERDATA, DTYPE_SUBCONTAINER, 0)` + `(slot_index,
DTYPE_VECTOR, 0)`).

### Sensitivity / clamping

The joystick widget without `DESC_MIN` / `DESC_MAX` treats each
pixel of drag as ~millions of units. Tried `DESC_MINSLIDER` /
`DESC_MAXSLIDER` (soft slider window, no hard clamp) first —
produced a half-working widget in C4D 2026 (empty dragbox, no
scrub). Hard clamp `DESC_MIN = (-1, -1, 0)`,
`DESC_MAX = (1, 1, 0)` works correctly. Drag-range maps to ±100%
of viewport — one full viewport in either direction. The unit is
`DESC_UNIT_PERCENT`, step is `0.001` (= 0.1% per tick).

If the user ever needs to push the target further than one
viewport offset (rare), they'd need a code change to widen the
clamp.

### Axis inversion

The natural mental model for the joystick is "drag the dot to
where you want the subject in the frame." The natural math model
for the look-at offset is "where to nudge the aim point," which
is the opposite sign on both axes (move aim up-right = subject
appears down-left). `_read_frame_offset` inverts both X and Y as
it reads the slot — single source of truth for the convention
flip, all downstream math sees aim-nudge values.

### Rule of Thirds preset removed

The spec included a 9-entry Rule of Thirds cycle as a one-click
preset. Removed — the joystick is direct enough that a preset is
overkill, and the cycle code (write XY, re-fire MSG hook, reset
cycle to Off) was the only path using `_write_frame_offset`.
Removing the preset lets us drop the cycle handler, the cycle
parameter, the 9 cycle constants, the XY mapping table, and the
`SHOTBLOCKS_GRP_FRAMING` group from the `.res` entirely. The tag
has only the Look-At group params plus the UserData Frame Offset
slot.

### FOV math

Computed from first principles: `fov_h = 2 * atan(aperture / (2 *
focal))`. Vertical FOV derives from horizontal via the render
aspect read off `doc.GetActiveRenderData()` (fallback 16:9).
Recomputed every Execute so focal-length keyframes track.

### What didn't change

The core offset math (subtract `offset_lp = world_right * (u *
half_w) + world_up * (v * half_h)` from `local_dir`) is exactly as
specified. World-horizon-aligned (not camera-bank-aligned). FOV
computed per-frame from focal length and aperture. Works
identically in additive and replace modes — framing is part of
the look-at output, which the strength slider blends in additive.
