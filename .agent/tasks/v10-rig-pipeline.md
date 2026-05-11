# Task: v10 — Rig pipeline (tag + hierarchy + spring-damper)

## Goal

Make the Shotblocks tag do something. When the user applies the tag
to a camera, generate the standard 4-null rig hierarchy under it, and
run a spring-damper behavior every frame in both additive and replace
modes. By the end of v10, an active shot whose camera carries the tag
plays back with physically-smoothed motion in the viewport.

## Why

v6 shipped active-shot → viewport camera routing as untagged
passthrough (architecture.md:100 step 4). Steps 3, 5, 6 — the tag
pipeline itself — have been pending since. Every named v10+ feature
(slate, bake-down, sidechain, presets) sits on top of this missing
layer:

- **Constitution principle 2**: the Shotblocks tag is the contract
  between the user's cameras and the plugin's procedural behavior.
  Until the tag executes, principle 2 is undefined in practice.
- **Constitution principle 7** ("motion must feel physical, not
  robotic"): spring-damper is the foundational physical-motion
  primitive. It belongs in the first behavior shipped.
- **Constitution principle 4** (hard cuts only): v10 must demonstrate
  that the spring-damper state is per-tag/per-camera, isolated across
  cuts. No cross-cut smoothing. The previous shot ends; the next shot
  starts cold.

Shipping the tag pipeline + one behavior end-to-end (vs. just the
shell) is the call because the shell alone proves nothing — we need a
real per-frame transform to know the architecture works. Spring-damper
is the right first behavior: it's well-specified
(`skills/spring-damper.md`), it's per-null (the canonical use case for
the 4-null rig), and it produces visible improvement in both modes
without depending on any subsystem v10 doesn't build (no look-at
target, no autofocus raycast, no noise profile generator).

## Read first

- `.agent/constitution.md` — principles 1, 2, 4, 7
- `.agent/context/architecture.md` — especially "Data flow per frame"
  (lines 86–100) and "C4D plugin object model" (lines 51–84)
- `.agent/skills/rig-hierarchy.md` — full 4-null spec; behavior
  attachment points
- `.agent/skills/spring-damper.md` — math (semi-implicit Euler,
  critical damping, substepping)
- `.agent/workflows/new-rig-feature.md` — the canonical checklist
- `src/shotblocks.pyp` — current tag shell (`ShotblocksTag`,
  `SHOTBLOCKS_ENABLED`, `SHOTBLOCKS_DAMPING`)
- `src/sb_canvas.py` — `_resolve_cam_name`, the playback active-shot
  hook, `_playback_tick` — these are the integration points

## Scope (v10)

**In:**

1. **Tag parameters in the Attribute Manager.** Replace the
   placeholder `SHOTBLOCKS_ENABLED` + `SHOTBLOCKS_DAMPING` with a
   real parameter set:
   - `enabled` (bool, default true)
   - `mode` (enum: additive / replace; default chosen by tag-apply
     heuristic)
   - `damping_pos` (real, 0..1, default 0.5) — translational stiffness
     normalization
   - `damping_rot` (real, 0..1, default 0.5) — rotational stiffness
     normalization
   - `damping_focal` (real, 0..1, default 0.5) — focal-length channel
   - `damping_focus` (real, 0..1, default 0.5) — focus-distance channel
   - `substep_threshold_fps` (real, default 30) — below this fps
     advance with substeps per `skills/spring-damper.md`
   - `show_rig_nulls` (bool, default false) — when true, the
     generated nulls are visible in the Object Manager
   - `reset_on_shot_boundary` (bool, default true) — when true, the
     spring state resets to the target on the first frame of each
     shot. Default true honours constitution #4. Off only for
     experiments / debugging.

   Parameters live on the tag and are edited through C4D's standard
   Attribute Manager (per user pick: "C4D Attribute Manager on the
   tag itself"). The Shotblocks dialog does NOT yet expose a
   shot-side inspector — that's deferred. Each shot block carries a
   per-shot override dict in its persisted state, but v10's only
   route for editing those overrides is via the tag (AM edits the
   tag's "live" values; per-shot state is read-only until v11 ships
   the inspector panel).

   *Why this is OK as an interim*: the constitution says rig state
   is per-shot (principle 3), but it doesn't say per-shot state has
   to be user-editable per shot in v10. We stand up the storage and
   the routing now; the editing UI comes next.

2. **Rig hierarchy generation on tag apply.** When the tag is added
   to a camera:
   - Create four nulls: `world_null`, `boom_null`, `pan_null`,
     `tilt_null` (names suffixed with the camera name for
     disambiguation: e.g. `MainCam.world`).
   - Parent them as `world → boom → pan → tilt`, then move the
     camera under `tilt`.
   - The camera's *world transform* must be preserved across the
     reparent (use C4D's `GetMg` / `SetMg` against the new local).
     Tag-apply must not visibly move the camera.
   - Set `NBIT_OHIDE` on the four nulls by default. Toggling
     `show_rig_nulls` true/false updates the bit.
   - Tag-apply happens via C4D's standard tag menu (constitution
     principle 5: right-click → Tags → Shotblocks). No custom
     button.

3. **Rig hierarchy cleanup on tag remove.** When the tag is removed
   from a camera (delete the tag or delete the camera):
   - Reparent the camera back to whatever was the world_null's
     previous parent. Preserve world transform.
   - Delete the four nulls.
   - Wrap in an undo so a single Cmd+Z restores everything.

4. **Mode heuristic on tag apply.** Per `architecture.md:61-64`:
   - Camera has no animated tracks on position/rotation/focal-length
     → default to `replace` silently.
   - Camera has any animated track → default to `additive` and
     surface a one-line console notification.
   - Switching mode in AM from additive → replace prompts a
     confirmation dialog. Replace → additive is silent.

5. **Spring-damper execution in `Execute` — additive mode only for
   v10.** Per-frame, per-channel semi-implicit Euler integration
   (`skills/spring-damper.md` lines 22–28). State held on the tag
   instance, keyed by channel (`pos_world`, `rot_world`, `focal`,
   `focus`). Critical-damping coefficient default; the `damping_*`
   parameters map to stiffness `k` (the user-friendly "amount of
   smoothing" knob; high damping = soft pursuit, low damping =
   stiff/instant).

   **Additive mode (fully working)**: target = the camera's
   *animated* world matrix at this frame (read via the standard
   animation evaluation on the camera object — `GetMg()`
   post-animation-pass returns the evaluated value). The spring's
   current position becomes the written output via `SetMg`. The
   user's keyframes are never modified; on the next frame the
   animation pass overwrites the camera's matrix from the keys,
   we re-read, smooth, write again — accumulating the lag.
   Disabling the tag immediately reveals the original animation
   because the tag stops writing.

   **Replace mode (deferred to v11)**: parameter is selectable in
   AM and the mode heuristic correctly picks it on apply to an
   un-animated camera, but the Execute path prints a one-line
   console warning ("Shotblocks: replace mode active behaviors land
   in v11") and falls through without writing. The honest
   implementation requires per-null spring smoothing (not per-camera)
   so behaviors like look-at and presets can drive the boom/pan/tilt
   nulls independently. Doing that correctly without the rest of the
   behavior pipeline (look-at, presets) doubles v10's scope for no
   visible demo benefit — replace mode without presets is
   indistinguishable from "no tag at all."

   **Substepping**: if effective `dt > 1/substep_threshold_fps`,
   integrate in `ceil(dt * substep_threshold_fps)` substeps.

6. **Shot-boundary state reset.** The active-shot hook in the
   playback pipeline (or `Execute` itself, by detecting frame jumps)
   detects when playback enters a new shot. On that frame, every
   spring channel's `velocity = 0` and `position = target`. This is
   the constitution-#4 firewall: no smoothing across hard cuts.

   *Detection*: simplest viable rule — if `current_frame !=
   last_executed_frame + 1`, treat it as a shot boundary OR scrub
   jump. Both cases want the same behaviour (snap to target, kill
   velocity). The active-shot module in `sb_canvas` already knows
   shot boundaries; an alternative is for it to call a tag method
   like `reset_state(tag, op)` on transition. v10 picks whichever is
   simpler to wire — probably the frame-delta heuristic, since it
   handles scrub and shot-boundary in one rule.

7. **Per-shot rig state storage.** Extend the shot dict in
   `sb_shot_model.py`:
   ```python
   {
     "id": int, "in_frame": int, "out_frame": int,
     "cam_name": str, "track": int,
     "rig_state": {                                  # NEW (optional)
       "damping_pos":   float | None,                # None = inherit from tag
       "damping_rot":   float | None,
       "damping_focal": float | None,
       "damping_focus": float | None,
       "mode_override": "additive" | "replace" | None,
     }
   }
   ```
   At active-shot transition, the sequencer copies the shot's
   non-None overrides into the tag's runtime parameter cache (NOT
   the tag's persistent BaseContainer — overrides are ephemeral per
   shot). The tag reads from the runtime cache during `Execute`,
   falling back to its persisted BaseContainer values where the
   cache says None.

   v10 ships `rig_state` as an empty dict on every shot by default;
   the editing UI is deferred to v11. Persistence in
   `sb_persistence.py` round-trips it.

8. **First-class plugin restructure: deferred.** v10 keeps the flat
   `src/sb_*.py` convention. The architecture-doc module layout
   (`src/rig/...`, `src/sequencer/...`) is aspirational; touching it
   in v10 would balloon scope. New v10 files use the `sb_rig_*.py`
   prefix to mark them as the rig subsystem.

**Out (deferred):**

- Look-at, autofocus, noise, framing rules. (One behavior at a time —
  v11+.)
- The shot-side inspector panel. v10 edits via AM only.
- Bake-down. The procedural rig must work in viewport playback
  first; baking is v12+ once additive deltas + at least 2 behaviors
  exist.
- Module restructure to `src/rig/`, `src/sequencer/`, etc.
- Rotational smoothing via quaternion. v10 ships with HPB Euler
  smoothing; gimbal cases are documented as a known issue. Quat
  smoothing lands when look-at ships (look-at *requires* quat
  math for correct rotation alignment to a target).
- Preview animation of mode-switch (e.g. fade between additive and
  replace) — modes flip instantly.

## Approach

### New / changed files

| File | Change |
|---|---|
| `src/sb_rig_tag.py` | **New.** The `ShotblocksTag` class. Parameter description (programmatic — `.res` files deferred per `open-questions.md`), `Init`, `Execute`, `Message` for tag-add / tag-remove lifecycle (`MSG_MENUPREPARE`, `MSG_DESCRIPTION_POSTSETPARAMETER` for the mode switch confirmation). |
| `src/sb_rig_hierarchy.py` | **New.** Pure functions. `build_rig(camera, doc) -> RigRefs` creates the 4 nulls and reparents the camera, preserving world transform. `tear_down_rig(refs, doc)` reverses it. `find_rig(camera) -> RigRefs \| None` walks parents. RigRefs is a tiny dataclass-style dict carrying `world`, `boom`, `pan`, `tilt`, `camera`. |
| `src/sb_rig_spring.py` | **New.** Pure functions over float state. `step_channel(state, target, dt, k, c, substep_threshold) -> new_state`. No `c4d` import — testable standalone. Used by `Execute` for every channel. |
| `src/shotblocks.pyp` | Move `ShotblocksTag` shell into `sb_rig_tag.py` and import it. Update parameter ID block. Keep `PLUGIN_ID_TAG` as is. |
| `src/sb_shot_model.py` | Extend `_make_shot` to include `rig_state: dict` (empty by default). |
| `src/sb_persistence.py` | Round-trip `rig_state` in the shot JSON. |
| `src/sb_canvas.py` | At active-shot transition during playback, push the shot's `rig_state` overrides into the tag's runtime cache. Detect shot-boundary frame jumps and call `reset_spring_state` on the active tag. |

### Tag parameter description

Per `open-questions.md`, programmatic parameter description is
acceptable until the parameter count grows past ~10. We're at 9.
Keep it inline in `sb_rig_tag.py` via `GetDDescription` / a `Bc`
container. Lift to a `.res` file in v11+ when we add the inspector
panel and a second behavior.

### Hierarchy: handling existing parents

The user's camera may already be parented to something (a target
null, a constraint rig, etc.). The 4-null insertion preserves that:

```
Before:  parent → camera
After:   parent → world → boom → pan → tilt → camera
```

Implementation:
1. `world.InsertUnder(camera.GetUp())` (or `InsertBefore(camera)` if
   no parent) — world inherits camera's old siblings/parent.
2. Build boom under world, pan under boom, tilt under pan.
3. `camera.InsertUnder(tilt)`.
4. After every InsertUnder, restore world matrix on every moved
   object via `SetMg(old_mg)`. C4D normalises matrices on parent
   change.

The test that catches this: tag-apply on a camera at non-origin
position must not move the camera in the viewport.

### Execute order

Per architecture.md and rig-hierarchy.md, behaviors run in a defined
order. v10 has only spring-damper, but pick the order now:

1. Spring-damper (smooths the inputs the rest of the pipeline will
   consume).
2. Look-at (v11).
3. Framing rule (v11+).
4. Noise (v11+).
5. Autofocus (v11+).

Spring-damper runs first so subsequent behaviors see smoothed
positions. This matches `rig-hierarchy.md:34-43`.

### State storage on the tag

The tag's `Execute` is called on a `BaseTag` instance, but tag
instances in C4D don't easily hold Python state across frames —
`TagData` is the singleton; the per-tag-instance state lives in the
`BaseTag`'s userdata or in a dict keyed by tag-id on the TagData
class.

Approach: maintain a class-level `dict[int, SpringState]` on
`ShotblocksTag` keyed by `id(tag)` (or `tag.GetUniqueIP()` — verify
availability). On Init, allocate an empty state. On Free / removal,
delete the entry. Worst case if the dict leaks (tag freed without
notification): bounded by the number of tags created in the session;
acceptable for v10.

This is the pattern v9's analysis-thread state already uses
(class-level dict keyed by dialog instance). Apply the same shape.

## Open questions

1. **Mode switch on a tagged camera mid-sequence.** If a shot
   references camera C in additive mode, and the user flips C's tag
   to replace, every shot referencing C now plays in replace.
   Constitution principle 2 says "all shots referencing a given
   camera see it in the same mode." So this is the intended
   behaviour — but should the confirmation dialog name the affected
   shots? "Switching to replace mode will override animation on 3
   shots referencing this camera." Probably yes; cheap to add.

2. **Execute priority is mode-dependent.** Decided:
   - **Additive mode** runs *post-animation*. The user has keyframes
     and the tag needs the evaluated value at `doc.GetTime()` to
     smooth-pursue. Register at `EXECUTIONPRIORITY_ANIMATION` + 1
     (or `EXECUTIONPRIORITY_EXPRESSION`) so the standard animation
     pass has already written the camera's transforms by the time
     `Execute` runs.
   - **Replace mode** runs *pre-animation* — there's nothing to read.
     Initially the rig nulls have no drivers; eventually (v11+
     shot presets) the nulls' values come from preset evaluation,
     which the tag itself orchestrates.

   This means the tag effectively swaps its execution priority based
   on mode, OR registers twice (once at each priority) and gates
   internally. Simplest path: register at the animation priority and
   re-evaluate in replace mode by *reading from null userdata /
   preset cache* instead of the animation-driven values. v10 has no
   preset cache yet, so replace mode in v10 reads the nulls' raw
   `GetAbsPos/Rot` (which equals the user's keyframes on the nulls
   if any, or zero otherwise). Acceptable: v10's replace-mode demo
   is "keyframe a step on a rig null, watch the spring chase it,"
   which works fine post-animation too.

   Net: register once at the post-animation priority. Revisit when
   v11 introduces presets — at that point replace mode may need
   the pre-animation slot.

3. **The rig-null show/hide toggle.** When the user toggles
   `show_rig_nulls` true while the tag is active, all four NBIT_OHIDE
   bits flip. But the Object Manager may not redraw without an
   explicit `EventAdd`. Likely fine; flag if not.

4. **Damping range semantics.** UI param is 0..1 ("amount of
   smoothing"). Mapping to physics `k`: at 0 = effectively
   instant (very stiff); at 1 = very soft / lazy pursuit. Concrete
   mapping: `k = 200 * (1 - damping)^2 + 5`, `c = 2 * sqrt(k)`
   (critical). Verify on real motion before locking. Spec a
   reference clip in the manual checklist.

## Done when

- [ ] `sb_rig_tag.py` exists; `ShotblocksTag` has the 9 parameters
      from the scope, registered with `PLUGIN_ID_TAG`. AM shows them
      correctly.
- [ ] `sb_rig_hierarchy.py` exists; `build_rig` / `tear_down_rig` /
      `find_rig` work. Tag-apply on a camera at non-origin position
      generates the 4-null chain *without visibly moving the
      camera*.
- [ ] Tag-remove cleans up the 4 nulls and reparents the camera to
      its pre-tag parent. Camera doesn't visibly move.
- [ ] Tag-apply + tag-remove are a single Cmd+Z each.
- [ ] `sb_rig_spring.py` exists and is pure Python (no `c4d`
      import). Step function is deterministic and tested standalone
      (one tiny smoke script counts).
- [ ] Mode heuristic: applying the tag to an animated camera
      defaults to additive + prints a console note; applying to an
      unanimated camera defaults to replace silently.
- [ ] Mode switch additive → replace prompts confirmation;
      replace → additive is silent.
- [ ] In additive mode, an existing animated camera with snappy
      keyframes plays back with the camera *visibly lagging the
      keyframe* by a tunable amount (the spring's pursuit). Setting
      `enabled` = false on the tag immediately reveals the raw
      keyframed animation.
- [ ] In replace mode, the tag prints a one-line warning that
      replace-mode behaviors land in v11; no error, no crash. The
      mode parameter is still selectable and round-trips through
      save/load. Switching back to additive resumes smoothing.
- [ ] Shot-boundary state reset: scrubbing or hitting a hard cut
      snaps the spring to target on the new shot's first frame. No
      smoothing across the cut. Test with two same-camera shots
      with very different starting framings — the cut is hard, not
      eased.
- [ ] `rig_state` round-trips through save / load. Empty dict is
      the default; the active-shot transition pushes any non-None
      overrides into the runtime cache.
- [ ] Per-shot `mode_override` works: if shot A has
      `mode_override="replace"` and shot B has none, the same
      tagged camera plays under different modes in each shot. (This
      is the per-shot rig state primitive; the editing UI is v11.)
- [ ] Viewport playback frame rate stays interactive on a typical
      scene during tag execution — no obvious drop from v9.
- [ ] Manual checklist (≤ 10 items) appended to this file and
      passes.

## Manual checklist

Run `scripts/dev-loop.ps1` to deploy and relaunch C4D into a fresh
test scene with a camera at position (200, 100, -50), some
keyframed motion on translation Y over 30 frames, and the
Shotblocks dialog open.

- [ ] **Tag-apply preserves world transform.** Right-click camera
      in Object Manager → Tags → Shotblocks. Camera does not jump.
      Object Manager shows world / boom / pan / tilt nulls hidden
      under the camera's slot (NBIT_OHIDE). Toggle
      `show_rig_nulls` true in AM → the four nulls appear.
- [ ] **Mode heuristic correct.** The camera (animated) defaulted to
      additive; console printed a notification. Removing the
      animation tracks and reapplying defaults to replace silently.
- [ ] **Additive smoothing visible.** With damping at default 0.5,
      spacebar plays through frame 30. The camera's Y position
      lags the underlying keyframe noticeably — settling 4-8
      frames behind on hard transitions. Setting `enabled` = false
      in AM removes the lag immediately; setting it back restores.
- [ ] **Damping range works.** With damping = 0.0, the camera
      tracks the keyframe almost instantly (very stiff). With
      damping = 1.0, the camera lags significantly (very soft).
- [ ] **Replace smoothing visible.** Switch the tag to replace
      mode. The camera's own animation is now ignored. Keyframe a
      step change on `pan_null.rotation.h` from 0 to 45° at frame
      20. Playback shows a smooth pursuit from 0 to 45 over
      several frames, not a step.
- [ ] **Shot boundary is a hard cut.** Drag the camera onto the
      timeline twice — create two shots back-to-back referencing
      the same tagged camera. Set shot 1's `rig_state.mode_override`
      = "additive" and shot 2's = "replace" (via a temporary debug
      command or by editing the persisted JSON directly — UI lands
      in v11). Spacebar plays. At the cut between shots, the
      camera snaps to the next shot's target with no spring lag
      carrying across the boundary.
- [ ] **Scrub also resets state.** Scrub the playhead onto frame
      100. The camera's spring state snaps to target — no lag
      "settling" after the scrub.
- [ ] **Tag-remove cleans up.** Delete the tag from the camera.
      The four nulls disappear; the camera is reparented to its
      original parent; world transform preserved (camera doesn't
      jump).
- [ ] **Undo works at every step.** Apply tag → Cmd+Z reverts.
      Remove tag → Cmd+Z restores the rig. Edit a parameter in AM
      → Cmd+Z reverts that single parameter change.
- [ ] **Save / load round-trip.** Save the scene with a tagged
      camera and a shot referencing it. Close and reopen. The tag
      is still attached, the rig nulls are still there, the shot's
      `rig_state` (if non-empty) is preserved.

## Notes

(To be filled in during the work — decisions, surprises, anything
worth promoting to a context file later. Especially:
- Did `Execute` run pre- or post-animation-pass? Pin it in
  `pitfalls.md`.
- Did the per-tag state dict pattern (class-level dict keyed by
  `id(tag)`) hold up across save/load / scene-copy?
- Final damping-knob → physics-`k` mapping.)

## What actually shipped (post-iteration)

The spec above describes a 4-null rig auto-generated under each
tagged camera. **That approach was rejected during implementation.**
Final state:

### No rig nulls

The tag operates directly on the camera's pose. No `world / boom /
pan / tilt` nulls are generated. The user's camera stays where they
put it; the tag is visible directly on the camera in the OM.

Why the change (decided 2026-05-11):
- The first deploy auto-parented the camera under four
  NBIT_OHIDE'd nulls. `NBIT_OHIDE` recursively hides descendants —
  the user looked at the OM and the camera had vanished.
- Removing NBIT_OHIDE solved that but cluttered the OM and buried
  the Shotblocks tag four levels deep, making it tedious to select
  for AM edits.
- Spring-damper (and every planned v11 behavior — look-at,
  framing, noise, autofocus) is math on the camera's pose. The
  null chain is convenient for separated-channel keyframing, not
  required for procedural behavior.
- Constitution principle 2 ("the user owns the camera; Shotblocks
  directs it") felt directly violated by wrapping the user's camera
  in plugin-generated objects.

See `.agent/skills/rig-hierarchy.md` (rewritten as a historical
note) for the full reasoning. The deleted code is in
`sb_rig_hierarchy.py` (now removed — `git log` will surface it if
ever needed).

### Tag execution model

- `Execute` runs at `TAG_EXPRESSION` priority — post-animation.
- Additive mode (working): read `cam.GetMg()` (world matrix of the
  evaluated camera), decompose to (pos, HPB), step the spring,
  write back via `cam.SetMg(...)`.
- Replace mode (deferred): tag prints a one-line warning and
  returns without writing. Mode parameter still selectable and
  persists.

### Parameters that shipped

Final 8 parameters (down from 9 — `SHOTBLOCKS_SHOW_RIG_NULLS` was
removed when the nulls were):

- `enabled`, `mode` (additive/replace), `damping_pos/rot/focal/focus`,
  `substep_threshold_fps`, `reset_on_boundary`.

### Per-shot rig state

Storage and routing shipped. The shot dict carries a `rig_state`
field; the canvas pushes overrides via `sb_rig_tag.push_overrides`
on active-shot transitions. v10 has no UI to edit `rig_state` per
shot — that's a v11 deliverable. Round-trips through save/load
free (it's just another key in the shot JSON).

### Hard-cut isolation

Verified working: the canvas calls `sb_rig_tag.request_reset(tag)`
when the active shot id changes between frames, and `Execute`
auto-resets on any frame jump that isn't +1 from the last
evaluation (covers scrub, jump-to-frame). The spring snaps to
target with zero velocity on those frames. No smoothing across
hard cuts.

### State storage pattern

Class-level `_RUNTIME: dict[id(tag), state]` in `sb_rig_tag.py`.
Cleared on `TagData.Free`. Bounded leak risk if a tag is destroyed
without `Free` firing (haven't observed this in practice). Same
pattern v9's analysis-thread state uses.
