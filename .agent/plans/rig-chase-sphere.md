# Plan: Chase — world-anchored sphere model (rewrite)

Status: **planned, not started** (2026-06-07). Exploration mode. Replaces the
shipped velocity-relative chase + orbit system (commit 882c379).

## Why rewrite

The current Chase is **velocity-relative pursuit** (camera trails BEHIND the
target's direction of travel) with **orbit/pitch/plane knobs layered on top of
that moving behind-point**. The behind-point itself re-orients as the target
turns, so orbit is orbiting around a moving, rotating reference. Result (user-
reported): the follow-distance placement and the orbit "compete" — the camera
gets pushed/rotated/pushed-back, doing several things at once. Too complex.

User wants it SIMPLER and re-conceived as a **sphere around the target**:
- An invisible sphere anchored at the target's POSITION, oriented to WORLD
  axes (turntable — not the target's heading).
- The camera body sits ON the sphere surface, always AIMING at the target.
- A 2D joystick places the camera on the surface (longitude + latitude),
  360° on all axes. Radius grows/shrinks the sphere (= the old follow dist).
- Camera springs (damps) toward its spot — the swoop/weight, kept.

This removes the heading-driven re-orientation entirely, which is what caused
the fighting: placement is now pure spherical coordinates, no velocity.

## Decisions (all user-confirmed 2026-06-07)

- **Sphere anchored to WORLD axes (turntable).** Lon/lat fixed in world
  space; the camera spot stays put in the world as the target flies through.
  No re-orientation as the target turns. (This is the core fix.)
- **One unified system — it's always the sphere.** No separate "behind
  chase." "Behind" is just the default joystick position (0,0). Keyframe the
  joystick for sweeps.
- **Joystick = CUSTOMGUI_VECTOR2D + percentage fields**, exactly like the
  existing Frame Offset widget (reuse that proven UserData plumbing).
- **Replace, but KEEP position damping** — camera springs toward its sphere
  spot (the weight the user liked), not rigid.
- **Damped (smooth follow)**, using the existing position spring.
- **Joystick (0,0) = behind + level** (eye-level, world -Z side of the
  sphere, equator). Drag X = spin around (longitude); drag Y = overhead/
  underneath (latitude).
- **Camera Roll** — keep the absolute roll knob (dutch / overhead bank).
- **Aim Lock** — keep (stiffens aim vs body damping so subject stays framed
  during the swoop). Cheap, no heading needed — fits the clean model.
- **Look-Ahead + Look-Ahead Distance** — keep (aim ahead along travel).
  AIM-ONLY: it needs a small velocity calc but never affects placement, so it
  does NOT reintroduce the competing-motion problem.
- **Remove old params cleanly** (exploration mode; breaking test scenes ok).

## Control surface (final)

| Control | Role | vs old |
|---|---|---|
| Chase Target (LINK) | object to orbit + aim at | kept |
| Radius (METER) | sphere size = camera distance | Follow Distance reused/renamed |
| Orbit Position (VECTOR2D joystick + %) | lon (X, spin) + lat (Y, pole), (0,0)=behind+level | replaces Orbit/Pitch/Plane/Reorient |
| Camera Roll (DEGREE) | absolute bank | kept (FOLLOW_CAM_ROLL) |
| Aim Lock (PERCENT) | aim stays locked under body damping | kept (FOLLOW_AIM_TRACK) |
| Look-Ahead (PERCENT) + Look-Ahead Distance (METER) | aim ahead along travel | kept (FOLLOW_AIM_LEAD / LEAD_DIST) |

**Removed IDs:** VEL_SMOOTH, REORIENT, HEIGHT_BIAS, SIDE_BIAS, ORBIT,
PITCH, ORBIT_WORLD, ORBIT_PLANE, ABS_ROLL (roll is now always available, no
opt-in toggle needed). Keep: ENABLED, TARGET, DISTANCE(->Radius), CAM_ROLL,
AIM_TRACK, AIM_LEAD, LEAD_DIST. New: an Orbit Position VECTOR2D UserData slot.

## Math model (simple)

cam_world = target_world + radius * sphereDir(lon, lat)

- sphereDir: world-anchored unit vector. lon = azimuth about world Y; lat =
  elevation toward world poles. (0,0) -> world -Z, equator (behind + level).
  At lat = +1 -> straight overhead (world +Y); lat = -1 -> underneath.
- Damp cam_world with the existing position spring (the swoop).
- Aim: point at target_world (blend toward Look-Ahead point by Aim-Lead),
  level horizon, then apply Camera Roll about the view axis. Aim Lock
  stiffens the aim spring vs the body damping.
- NO velocity needed for placement. A small smoothed target velocity is kept
  ONLY for the Look-Ahead aim point.

Joystick value convention: store lon/lat as the VECTOR2D x/y. Map the
percentage range to a full sphere: x in [-1,1] -> lon [-180,180] (or wider
for multi-turn keyframing, like Frame Offset's +/-300%); y in [-1,1] ->
lat [-90,90] (clamp at poles). Decide exact range in build; mirror Frame
Offset's hard MIN/MAX clamp (soft-only broke the widget in C4D 2026).

## Implementation steps

0. **Probe sphere math standalone** (gitignored src/_*.py): verify
   sphereDir(lon,lat) places correctly, (0,0)=behind+level, poles clean, and
   the aim-at-target + level + roll compose. Pure math, no C4D. (Phase-0
   discipline — measure before wiring.)
1. **sb_rig_follow.py** — gut the velocity-relative behind-point + orbit-on-
   top (desired_position, the great-circle/orbit-plane machinery, reorient
   slew, low-speed hold). Replace with a small `sphere_position(target,
   radius, lon, lat)` and KEEP the lead-point calc for Look-Ahead (it needs
   the smoothed velocity). Module gets much smaller. Keep it pure (no c4d).
2. **Resources** (tshotblocks.h/.res/.str): remove dead IDs, rename Follow
   Distance -> Radius, declare the Orbit Position group host for the joystick.
3. **sb_rig_tag.py**: add the Orbit Position VECTOR2D UserData (2nd slot, copy
   the Frame Offset _ensure/_read/_descid pattern + a new BC key for its
   index). Rewrite `_chase_local_target_pos` to the sphere model; drop the
   orbit-bypass-damping complexity (`follow_orbit` re-place, place_around_
   subject). Keep aim-lead (`follow_lead_world`) + Aim Lock paths.
4. **Verify** via dev-loop: enable Chase, set target, scrub — camera sits on
   the sphere behind+level; joystick spins/elevates it 360; radius scales;
   aims at target; damping swoops; roll banks; no competing motion.

## Gotchas / reuse

- Joystick widget: CUSTOMGUI_VECTOR2D is UserData-only in C4D 2026 (.res
  parser rejects it) — reuse the Frame Offset AddUserData + DESC_PARENTGROUP
  reparent recipe. New _BCKEY for the slot index (don't collide with Frame
  Offset's 1010003 or a real param ID). See
  [[feedback_c4d_customgui_vector2d_userdata_only]],
  [[feedback_c4d_bc_marker_key_param_collision]].
- DEGREE params read/return RADIANS in C4D 2026 (the old orbit double-convert
  bug). If lon/lat are stored as the VECTOR2D in fractions, no deg issue; if
  exposed as DEGREE fields, pass straight through.
- Write-back stays SetRelRot/SetRelPos (local); camera usually unparented.
- Per-instance state on self (NodeData), not a global dict.
- This is the camera rig tag (Python dev-loop). Touches shipped feature from
  882c379 — build, user verifies, eyeball, commit on user's word.

## Related memory

- [[project_rig_chase_orbit]] (the system being replaced — update/supersede
  after this lands), [[project_rig_chase_follow]] (the engine being gutted),
  [[feedback_c4d_customgui_vector2d_userdata_only]] (joystick recipe).
