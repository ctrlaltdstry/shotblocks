# Plan: "Shotblocks Motion" — object motion tag

Status: **BUILT, user-approved feel (2026-06-07).** Awaiting commit. Exploration mode.

## FINAL DESIGN (what shipped this session — read this first)

A second tag, **Shotblocks Motion** (id 1000002, `tsbsmooth` resource),
applicable to ANY object. Gives an animated object (keyframes / Align-to-
Spline / parent motion) **inertial weight** + optional fBm noise.

The model that landed (after several wrong turns — see history below):

- **Position = drift via spring-on-the-OFFSET.** body = authored world pos +
  spring-smoothed offset; offset target = -path_acceleration * Weight (pushes
  to the outside of a corner); 0 on straights -> dead-on the path. Drift knob
  = overshoot/damping ratio. Engine: `sb_rig_inertia.py` (pure, world-space).
- **Orientation = AIM DOWN DRIFTED TRAVEL.** The tag OWNS orientation: it
  aims the object's nose (-Z) down the object's actual DRIFTED velocity
  (`result["fwd"]`), leveled to world Y-up, banked into turns from lateral
  g-force (`result["bank"]`, Lean knob). This is the key fix: nose follows
  the drift, NOT the rigid spline tangent, so body + nose share one physics
  world (the user's "nose disconnected from the body" complaint). AtS's
  rotation is ignored -> no authored-rotation baseline -> the
  compounding-bank bug is structurally impossible.
- **Turn Ease** = rotational lag (quaternion slerp of the heading), rounds a
  sharp corner so the nose eases in instead of snapping.
- **Noise** = Amount / Speed / Contrast / Seed (fBm; gain_scale = contrast).

Controls (Weight group): Enable Weight, Weight, Drift, Lean, Turn Ease.
Plus Noise group + Advanced (Substep / Reset On Backward Jump).

CONSTRAINT: object nose must point **-Z** (C4D front axis; the aim axis).
Document in the user manual before release.

Files: `sb_motion_tag.py`, `sb_rig_inertia.py`, `tsbsmooth.{h,res,str}`,
`sb_motion_tag.png` icon, +2nd RegisterTagPlugin in `shotblocks.pyp`. Noise:
`sb_rig_noise.sample_profile` gained `gain_scale=1.0` (camera tag unchanged).
`sb_rig_spring.py` left UNTOUCHED (the scale/rot_q lanes were reverted — the
inertia engine replaced them; spring is camera-tag-only again).

Gains are eyeball-tuned (`_DRIFT_OFFSET_GAIN`, `_LEAN_GAIN`, `_K_STIFF/SOFT`,
`_turn_ease_fraction` tau) — adjust against real scenes if feel drifts.

---

## History (how we got here — kept for context, superseded by FINAL above)

## What it is

A *second* TagData, applicable to **any object** (not camera-only), that drives an
object's animated motion through the same procedural engines the camera rig tag
uses: spring-damper **smoothing** + fBm **handheld noise**, across **position,
rotation, and scale**.

Named **Shotblocks Motion** (not "Smooth") because it does more than smoothing —
noise is built in, and it's the natural home for future object-motion behaviors.

It reuses the camera tag's pure engines verbatim (`sb_rig_spring`,
`sb_rig_noise`, `sb_rig_quat`). It is NOT a fork of the 2000-line camera tag — it
is a slim tag that composes the same primitives with a much smaller parameter
surface (no Look-At, Zoom, Chase, or viewport Frame Offset).

## Why this is a legit *second* tag (vs the "single tag" rule)

The constitution's single-tag decision is about *camera behaviors* not
fragmenting into five tags. A tag for *any animated object* is a genuinely
different object type with a smaller, different parameter surface. Folding an
"is this a camera?" branch into the camera tag would make its AM messier, not
simpler — the opposite of what the single-tag rule protects. User signed off on
"ship it as a sibling tag" and expanding scope to acknowledge object motion
smoothing as in-scope.

## Why the camera tag didn't work on a spline-driven object (root cause)

The smoothing *math* is already object-agnostic — `_read_keyframed_target`
explicitly handles the world-matrix fallback for Align-to-Spline / constraints /
Xpresso, and the spring is per-float. The ONLY thing stopping it was tag
registration: the Shotblocks tag is registered camera-only, so C4D refuses to
drop it on a mesh. Nothing in the math rejected the object.

## Decisions locked

- Name: **Shotblocks Motion**
- Feature set: **Damping + Noise** (no Look-At / Zoom / Chase / Frame Offset)
- Channels: **position + rotation + scale**
- Damping default: **OFF** (consistent with camera tag — fully interactive until enabled)
- Icon: generated placeholder for now (swap art later)
- Commits: **3 atomic** (spring scale lane / tag+resources / registration+docs)
- Plugin id: **1000002** (reserved testing range; real id before public release)

## Key engineering facts

1. Pos+rot smoothing is lift-and-adapt — the engines already do it.
2. **Scale is the only genuinely new work.** Nothing in `src/` touches scale.
   - Spring: add a `"scale"` lane (rests at **1**, not 0).
   - Read: animated scale via `ID_BASEOBJECT_REL_SCALE` track + world-matrix fallback.
   - Write: a FULL matrix compose (the camera tag's `HPBToMatrix`+`.off` discards
     scale — wrong for objects). MUST be measured in C4D before coding (Phase 0a).
3. **Noise position units are viewport fractions** — the camera converts via FOV,
   which is meaningless for an object. Objects convert via a fixed scene-scale
   reference (~1000cm, like `_NOISE_FALLBACK_DISTANCE`); Strength is the dial.
   Rotation noise is already radians (units-clean). Feel-tune after first deploy.
4. **Per-instance state on `self`** (NodeData-self convention). Do NOT reintroduce
   the global-dict / BC-marker pattern — that caused the duplicate-camera bug.
5. **Once-per-frame idempotency guard is mandatory** — C4D calls Execute several
   times per frame; stepping the spring more than once erases the damping.
6. **Channel ownership** gates writes: own pos/rot/scale only when (master damping
   on AND that channel is animated) OR (noise on, pos/rot). Parked/un-animated
   object owns nothing → fully navigable, no viewport fight.

## Phases

- **Phase 0 — De-risk (measure first).** Throwaway probes in C4D (gitignored
  `src/_*.py`):
  - 0a. Scale round-trip: decompose/recompose a rotated + non-uniformly-scaled +
    parented object's matrix; confirm `SetMg` round-trips scale. Output: the
    exact write-back recipe.
  - 0b. Animated-scale read: confirm scale-track DescID + `GetValue`; confirm
    world-matrix fallback yields scale for AtS-driven objects.
  No tag code until both return facts.

- **Phase 1 — Spring scale lane** (`sb_rig_spring.py`, purely additive).
  `make_state` adds `"scale"`; `reset_to_target` gets optional `scale=` arg
  (camera tag calls unchanged). Verify camera tag still loads/runs.
  → **Commit 1.**

- **Phase 2 — Resource files.** `tsbsmooth.{h,res,str}` (Damping + Noise +
  Advanced groups only) + `sb_smooth_tag.png` icon.  *(internal resource name
  stays "tsbsmooth"; user-facing name is "Shotblocks Motion")*

- **Phase 3 — The tag class** `src/sb_motion_tag.py`: slim TagData, state on
  self, reset/idempotency/ownership/write-back adapted, full-matrix scale write.

- **Phase 4 — Object noise integration** (scene-scale reference; flag value for
  eyeball after deploy).
  → Phases 2-4 are **Commit 2** (tag + resources, one whole working change).

- **Phase 5 — Registration** in `shotblocks.pyp` (second RegisterTagPlugin, no
  object-type filter, second load line).

- **Phase 6 — Verify** via dev-loop: both load lines; drop on keyframed cube /
  AtS object / pulsing-scale object; smoothing per channel; parked stays
  navigable; boundary reset clean; noise organic. User verifies, I eyeball.

- **Phase 7 — Docs & memory** (constitution scope note, architecture second tag,
  memory entry).
  → Phases 5+7 are **Commit 3** (registration + docs).

## Phase 0 RESULT (measured 2026-06-07)

Probe (`src/_scale_probe.py`, gitignored) tested three write paths on a cube
under a non-uniformly-scaled + rotated + translated parent, reading back
`GetMl()` (pure local) and comparing rotation by basis distance:

- **Q1 `SetMl(composed)`** — round-trips pos/hpb/scale **perfectly**. ✓
- **Q3 `SetRelPos`+`SetRelRot`+`SetRelScale`** — round-trips **perfectly**. ✓
- **Q2 `SetMg(parent_mg * composed)`** (the camera tag's redundancy trick) —
  **corrupts all three** through the scaled parent. ✗

**WRITE-BACK RECIPE (locked): use the local channels `SetRelPos` + `SetRelRot`
+ `SetRelScale`. Do NOT use `SetMg`.**

Why the camera tag gets away with `SetMg`: cameras are typically unparented, so
`parent_mg ≈ identity` and the corruption is zero. A general object can sit under
a scaled/rotated parent, where `SetMg` is actively harmful. The object tag's
`_write_back` must therefore be local-channel-only — a DIFFERENT write-back than
the camera tag's, not a copy.

Caveat to verify in Phase 6 (not a blocker): the camera tag writes `SetMg`
*because* C4D's animation pass can clobber local-channel writes after Execute
returns. We're relying on `TAG_EXPRESSION` priority (post-animation) making our
`SetRel*` writes land last. The camera tag proves this holds for rotation
(SetRelRot survives); confirm scale survives on an animated-scale object when the
real tag is dropped on it. If local writes were clobbered, camera rotation
smoothing wouldn't work either — and it does — so this is expected to pass.

`_read_keyframed_target` for the object must read scale the same way it reads
pos/rot: scale CTrack (`ID_BASEOBJECT_REL_SCALE`) when present, else the
`GetMl()`-derived scale fallback (confirmed `GetMl` reports local scale exactly).

## PIVOT (2026-06-07): low-pass damping -> inertial WEIGHT

User feedback after testing the damping model: low-pass smoothing of
position/orientation just makes motion "watery and floaty with no
intention." What's actually wanted for an object flying a spline is
**inertial weight**: it follows the path but carries momentum — drifts WIDE
on corners and banks into them (g-force), tight on straights, speed-reactive.

Decisions (user-confirmed):
- Effect = **overshoot/drift + lean together**, **speed-reactive**.
- Aim model = **keep authored rotation + ADD g-lean** (user hand-keys pitch;
  must preserve it). NOT "aim down travel" (would discard their keys).
- Straights = **dead-on the spline** (drift is a cornering effect only).
- Controls = **Weight / Drift / Lean** (replace Linear/Angular/Scale damping).
- Must work when the spline/AtS is on a **parent null** and the object is the
  child — so the engine runs in **WORLD space** (GetMg deltas) and writes local.

New engine: `sb_rig_inertia.py` (pure, no c4d). Model that finally worked
(after rejecting velocity-feed-forward spring, which had steady-state phase
lag on straights): **spring the OFFSET from the path, not the absolute
position.** body = authored_world_pos + spring-smoothed offset; offset target
= -path_acceleration * Weight (pushes to the outside of a corner); offset
target = 0 on straights => body exactly on path (zero steady-state error,
verified). Lean = path lateral/vertical accel -> bank/pitch HPB delta added
to authored rotation. Launch-from-rest primed so it doesn't spike.

Standalone-verified (through tag namespace): straight offset 0.000, corner
drift ~690u + 16.8deg bank, weight=0 tracks 0.000.

Tag rewrite: `sb_motion_tag.py` now reads authored world pos (GetMg), runs
the inertia engine, writes local (SetRelPos/SetRelRot; rotation baseline
from the authored world matrix, NOT GetRelRot, to avoid lean accumulating on
un-keyed axes). The old quaternion/Euler damping + scale lane are removed.
Resource params: Weight/Drift/Lean (SBMOTION_WEIGHT/DRIFT/LEAN, ids
1011-1013) + Noise (Amount/Speed/Contrast/Seed). _DEBUG diagnostic removed.

Noise rework (user-requested): removed Walk Cycle + Step Rate; Amount (0..10,
soft cap 5), Speed (0.1..5), new Contrast (0..1 -> fBm gain_scale, smooth vs
spiky). `sb_rig_noise.sample_profile` gained optional `gain_scale=1.0`
(default leaves the camera tag byte-for-byte unchanged).

## Forward-axis convention (constraint, 2026-06-07)

Lean (g-force bank/pitch) and the inertia model assume the object's FORWARD
axis is **-Z** — C4D's standard front (the camera view axis; the axis
Align-to-Spline's Tangential aligns to). With -Z forward, the HPB lean packs
correctly: bank (b, about Z) rolls around the nose, pitch (p, about X) tips
it up/down.

A model whose nose is on a DIFFERENT axis (e.g. +X) banks about the wrong
axis -> the nose/tail bob (user-reported). Decision (user): do NOT build
axis-agnostic auto-detection or a forward-axis picker — instead REQUIRE -Z
forward and document it. The user rotates the model's axis (or parents it to
a null aligned to -Z) so the nose points -Z. This is the C4D-native
convention, so most models already comply.

ACTION: document "model nose must point -Z" as a Motion-tag requirement in
the user manual (host/shotblocks/web manual page) before release.

## Turn Ease (rotational inertia, 2026-06-07)

Added a 4th Weight-group knob, **Turn Ease** (SBMOTION_TURN_EASE id 1014,
default 0). Eases the object's ORIENTATION toward the authored heading via
quaternion slerp (pole-safe; _basis_quat + _quat_slerp in the tag) instead
of snapping, so a sharp corner in the spline rounds off (the nose can't whip
around instantly). Frame-rate-normalized via _turn_ease_fraction (tau 0.04..
0.54s). Independent of Weight/Drift/Lean. Verified standalone: a 90deg/frame
snap becomes ~10deg/frame eased. Turn Ease is axis-agnostic (slerps the whole
orientation), unlike lean — only lean needs the -Z convention.

## Bank-free / compounding-roll fix (2026-06-07)

Symptom: tag on a NULL driven by Align-to-Spline, with the ship parented
under it. Enabling Lean made the object roll over progressively and never
return to Y-up.

Root cause (probe `_atsorder_probe.py`, decisive): **Align-to-Spline sets
the null's heading + pitch from the spline tangent but leaves BANK (roll)
FREE.** Our lean writes a bank into the null's rel channels; nothing
authoritative overwrites it, so next frame GetMg reads our bank back, we add
more -> bank COMPOUNDS (probe: 0->30->60->...->300) -> the flip.

Fix: in the tag, **zero the bank channel of the authored baseline each
frame** (`authored_hpb = (h, p, 0.0)`). That gives a fresh LEVEL (world
Y-up) orientation down the tangent; lean's bank is added from level and
resolves back to level on straights. Heading + pitch come straight from AtS
(it overwrites them each frame, so no compounding there — only bank was the
free channel). User decision: "always level to world Y-up."

Note: this means the baseline is "AtS aim, forced level," NOT the object's
raw authored rotation. For an AtS-on-null setup that's exactly right (the
null's bank is meaningless/free). If a future case needs to RESPECT authored
banking (e.g. spline Banking option, or hand-keyed roll on the object
itself), that'd need a per-source policy — deferred; current behavior is
level-to-Y-up always.

## Open items to confirm during build

- Object noise scene-scale reference value (feel-tune).
- Inertia gains (_DRIFT_OFFSET_GAIN, _LEAN_GAIN, _K_STIFF/_K_SOFT) are
  eyeball-tuned vs a synthetic path; expect to adjust against the real
  spaceship scene after first deploy.
- Spring scale lane in sb_rig_spring.py is now UNUSED by the Motion tag
  (inertia replaced it). It's harmless (camera tag ignores it). Decide
  whether to keep or revert that change before the final commits.
