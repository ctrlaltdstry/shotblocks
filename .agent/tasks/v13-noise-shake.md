# Task: v13 — Noise / shake (handheld profile)

## Goal

A `Noise` parameter group on the Shotblocks tag that adds an
**organic, time-varying perturbation** to the camera's pose. Ships
the first profile — **Handheld** — as the v13 deliverable. Drone,
shoulder-mount, tripod, and motion-energy-coupled noise are
deferred. The noise composes cleanly with the existing pipeline:
when Profile = Off the camera behaves exactly as it does today
(byte-for-byte); when set to Handheld it adds believable operator
microtremor + slow drift on top of whatever rotation/position
target the upstream stages produced.

## Why

- **Constitution principle 7.** "Camera motion uses spring-damper
  physics with configurable stiffness and damping, plus optional
  noise profiles calibrated to real-world reference (handheld,
  shoulder-mount, drone, tripod). The default behavior should
  never feel like linear interpolation." v10/v11/v12 shipped the
  spring + look-at + framing; the calibrated noise profiles are
  the last piece of the principle still missing from the rig.
- **Unblocks the preset library.** A "handheld over-the-shoulder
  three-quarter" preset is meaningless without a handheld profile
  to attach to it. Same as Frame Offset in v12: ship the
  primitive, the preset library composes it.
- **Distinguishes Shotblocks from native C4D.** Native cameras
  shake by way of vibration tags, noise effectors driving a Null,
  or hand-keyed bobbles — all of which require setup and none of
  which compose with a spring-damper. A single "Profile: Handheld"
  on the tag is the entire pitch.

## Read first

- `.agent/constitution.md` — principle 7 (noise profiles),
  principle 2 (additive vs replace — noise applies in both).
- `.agent/tasks/v12-framing-rule.md` "What actually shipped" — the
  pattern for "math primitive in a pure-Python module + tag-side
  integration."
- `src/sb_rig_tag.py` `_execute` — where the noise integration
  lands, specifically the section between target resolution and
  the spring step. The pattern noise should mirror is
  `_apply_roll_and_bank_into_turns`: a post-resolution, pre-spring
  function that takes the current target rotation/position and
  returns a perturbed target.
- `src/sb_rig_spring.py` — to understand what the spring will and
  won't damp. Default damping = 0.5 gives a settle of ~0.6s; that
  acts as a low-pass with corner ~1.5 Hz, which is why
  high-frequency tremor (~6-10 Hz) needs to be applied
  **post-spring**, not pre.

## Scope (v13)

**In:**

1. **New parameter group "Noise" on the tag.** Three parameters:
   - `Noise Profile` (cycle: Off / Handheld, default Off) — only
     Off and Handheld are in v13. Drone / Shoulder / Tripod entries
     are NOT added to the cycle in v13 (don't ship inactive UI
     entries; they will get added in v14+ when implemented).
   - `Noise Strength` (real, 0..1, default 0.5) — global amplitude
     scalar applied uniformly across all noise channels. 0 = no
     noise even with Profile = Handheld (lets the user A/B
     instantly without changing the profile).
   - `Noise Seed` (long int, default 0) — controls the phase
     offsets so two adjacent shots using the same profile don't
     produce identical shake. Stored as a tag parameter rather
     than a BC marker so it's keyframable / per-shot overridable
     in the same way damping is. Default 0 means "use the tag's
     stable hash seed" (computed once from the tag's BC marker)
     so users who never touch the parameter still get
     non-identical shake across multiple tags.

2. **Noise math module: `src/sb_rig_noise.py`.** Pure Python,
   no `c4d` import. Pattern after `sb_rig_quat.py` and
   `sb_rig_spring.py` — testable in isolation.

   Single sample function:
   ```
   sample_profile(profile_id, frame, fps, seed) -> NoiseSample
   ```
   where `NoiseSample` is a small dataclass-like dict:
   ```
   {
     "pos_pre":  (dx, dy, dz)   # pre-spring position delta, scene units
     "rot_pre":  (dh, dp, db)   # pre-spring rotation delta, radians
     "pos_post": (dx, dy, dz)   # post-spring position delta, scene units
     "rot_post": (dh, dp, db)   # post-spring rotation delta, radians
   }
   ```
   The pre/post split is the **two-band architecture** (decision 2
   below). Low-frequency drift (≤ ~2 Hz) lives in `*_pre` so the
   spring shapes it into believable handheld weight. High-frequency
   tremor (≥ ~4 Hz) lives in `*_post` so it survives the spring's
   low-pass.

   The function is **stateless** — each call samples the
   underlying time-domain noise function at `frame / fps` seconds.
   No "previous + delta" accumulation, ever. This is the
   "must not accumulate" property from the task brief: each
   frame samples at the current frame index, not "previous noise
   + delta." A scrubbed timeline always produces the same noise
   at the same frame; a loop point is seamless.

3. **Handheld profile math: sum of sines.**

   For each of the six noise channels (rotation H/P/B and
   position X/Y/Z), the profile defines a list of `(freq_hz,
   amplitude, band)` triples. The sample at time `t` is:
   ```
   value = sum( amp * sin(2π * freq * t + phase(channel, freq, seed))
                for (freq, amp, _) in channel_components )
   ```
   `phase()` is a deterministic function of channel id, frequency,
   and seed — typically a hash of the triple mapped into [0, 2π).
   This ensures two different channels (and two different tags
   with different seeds) don't peak together and produce a
   "monolithic shudder."

   The handheld profile values (calibration-grounded — see
   "Calibration sources" below):

   ```
   # Rotation (radians). 0.005 rad ≈ 0.29° tremor / drift.
   HANDHELD_ROT = {
       "h": [(0.7, 0.0060, "pre"), (1.3, 0.0040, "pre"),
             (5.5, 0.0018, "post"), (8.5, 0.0010, "post")],
       "p": [(0.9, 0.0055, "pre"), (1.7, 0.0035, "pre"),
             (6.0, 0.0022, "post"), (9.5, 0.0011, "post")],
       "b": [(0.6, 0.0030, "pre"),
             (4.5, 0.0008, "post")],   # bank tremor very subtle
   }
   # Position (in viewport-fraction units; converted to world
   # via target distance at apply time — see point 4).
   HANDHELD_POS = {
       "x": [(0.8, 0.0040, "pre"), (1.5, 0.0025, "pre"),
             (6.5, 0.0008, "post")],
       "y": [(1.0, 0.0050, "pre"), (1.8, 0.0030, "pre"),
             (7.0, 0.0010, "post")],
       "z": [(0.5, 0.0020, "pre")],     # forward/back drift only
   }
   ```

   These are starting calibration values; final-tune during impl
   to match reference footage (see "Calibration sources").

4. **Position units: viewport-fraction, like Frame Offset.**

   Raw position-noise amplitudes are unitless screen-fractions
   (0.005 = a half-percent of viewport). At sample time, convert
   to scene units via the camera's FOV and a reference distance.
   For a camera with a look-at target, use the target distance.
   For a camera without one, use a fallback (e.g. 1000cm — same
   ballpark as a typical interior scene).

   Conversion (mirror of `_apply_frame_offset`):
   ```
   half_w = distance * tan(fov_h / 2)
   half_h = distance * tan(fov_v / 2)
   dx_world = dx_fraction * half_w * 2.0   # 2.0 because half-width
   dy_world = dy_fraction * half_h * 2.0   # is half of viewport
   dz_world = dz_fraction * half_w * 2.0   # use horizontal scale
   ```
   This makes Strength = 0.5 on Handheld feel the same across
   wide-angle and telephoto, and across small props vs. large
   architecture. Same self-scaling logic as Frame Offset.

5. **Integration in `sb_rig_tag.py`.**

   The integration is two function calls bracketing the spring
   step. After target resolution (post-look-at, post-roll,
   post-bank-into-turns):
   ```
   noise = _sample_noise(tag, st, cur_frame, fps, cam, look_at_target)
   target_pos = (target_pos[0] + noise["pos_pre"][0], ...)
   target_rot = (target_rot[0] + noise["rot_pre"][0], ...)
   # ... spring step on target_pos and target_rot ...
   # After spring writes its smoothed values:
   final_pos = (spring["pos"][0] + noise["pos_post"][0], ...)
   final_rot = (spring["rot"][0] + noise["rot_post"][0], ...)
   _write_back(cam, final_pos, final_rot)
   ```
   Note that `_write_back` needs to take pos+rot tuples rather
   than reading from the spring directly. Small refactor — pull
   the two `spring["pos"][0]` / `spring["rot"][0]` reads out of
   `_write_back` and have the caller pass them in.

   Reset path (`reset_to_target`) **must not apply post-noise** —
   the reset frame should land on the clean target so the camera
   doesn't pop to an offset value on shot boundaries. Pre-noise
   is also skipped on reset frames: the spring primes to the
   clean target, then the next frame's full pipeline (pre +
   spring + post) takes over. This matches how the current code
   already special-cases the reset frame.

6. **Profile = Off short-circuit.**

   If `Noise Profile == Off` OR `Noise Strength == 0.0`, skip the
   sample call entirely and write the spring's output unchanged.
   This is the "byte-for-byte identical to today" guarantee. No
   conditional inside the sample function — the short-circuit is
   at the integration point.

7. **Strength scales linearly across all channels.** `Strength
   = 0.5` halves every amplitude; `Strength = 0` zeroes. No
   per-channel strength sliders in v13 (would be 6 more
   parameters and authorial overhead the profile abstraction is
   supposed to remove).

**Out (deferred):**

- **Other profiles** (Drone, Shoulder-mount, Tripod-on-tripod-head,
  Steadicam). The cycle has only Off / Handheld in v13. Add
  entries as each profile is implemented and calibrated.
- **Motion-energy-coupled noise** (handheld gets shakier on action
  peaks). Interesting future work, but requires the audio
  analysis output to be available at tag-execute time — there's
  no plumbing for that yet, and the v9 onset detection runs on
  the canvas side. Defer.
- **Per-channel strength** (e.g. "rotation only, no position
  shake"). Six more sliders for marginal authorial benefit.
- **Per-shot Noise overrides** in the shot's `rig_state` dict.
  The override pipeline already exists for damping; v13 wires
  the tag-level params only. The per-shot inspector panel where
  this would live doesn't exist yet (same constraint v12 had
  with framing offset).
- **Re-roll button.** Just change the seed parameter; the AM lets
  you scrub the int.
- **Save/load of the noise sample state.** Stateless by design —
  the sample function is deterministic in `(profile, frame, fps,
  seed)`, so there's nothing to persist beyond the params.
- **Noise visualization** in the canvas (e.g. drawing the noise
  envelope as an overlay on the timeline). Speculative; defer
  until users ask for it.

## Approach

### Files

| File | Change |
|---|---|
| `src/sb_rig_noise.py` | **NEW.** Pure-Python sum-of-sines noise. Profile registry, `sample_profile`, `_phase_for_channel`. ~120 lines. |
| `src/sb_rig_tag.py` | Add 3 parameter ID constants. Read profile/strength/seed in `_execute`. Sample noise once per frame, apply `*_pre` before spring step, `*_post` after. Refactor `_write_back` to take pos+rot args. |
| `src/res/description/tshotblocks.h` | Add `SHOTBLOCKS_NOISE_PROFILE`, `SHOTBLOCKS_NOISE_STRENGTH`, `SHOTBLOCKS_NOISE_SEED`, `SHOTBLOCKS_GRP_NOISE`, plus cycle constants `SHOTBLOCKS_NOISE_PROFILE_OFF = 0` and `SHOTBLOCKS_NOISE_PROFILE_HANDHELD = 1`. |
| `src/res/description/tshotblocks.res` | New `GROUP SHOTBLOCKS_GRP_NOISE` containing the three params. Profile is `LONG ... CYCLE { OFF; HANDHELD; }`, Strength is `REAL` 0..1, Seed is `LONG` (no range — any int valid). |
| `src/res/strings_en-US/description/tshotblocks.str` | Display strings for the four new symbols + two cycle entries. |

### Sample-function shape

```python
# sb_rig_noise.py

PROFILE_OFF      = 0
PROFILE_HANDHELD = 1

# Channel ids used for phase derivation
_CHAN_RH, _CHAN_RP, _CHAN_RB = 0, 1, 2
_CHAN_PX, _CHAN_PY, _CHAN_PZ = 3, 4, 5

# (freq_hz, amplitude, band) triples per channel — see spec body.
_HANDHELD_ROT = { ... }
_HANDHELD_POS = { ... }

def sample_profile(profile_id, frame, fps, seed):
    if profile_id == PROFILE_OFF:
        return _ZERO_SAMPLE
    if profile_id == PROFILE_HANDHELD:
        return _sample_handheld(frame, fps, seed)
    return _ZERO_SAMPLE

def _sample_handheld(frame, fps, seed):
    t = frame / float(fps)
    rot_pre, rot_post = _eval_channels(_HANDHELD_ROT, t, seed, "rot")
    pos_pre, pos_post = _eval_channels(_HANDHELD_POS, t, seed, "pos")
    return {
        "rot_pre":  rot_pre,
        "rot_post": rot_post,
        "pos_pre":  pos_pre,   # still in viewport-fraction units
        "pos_post": pos_post,
    }

def _eval_channels(channel_table, t, seed, kind):
    # Returns ((pre_x, pre_y, pre_z), (post_x, post_y, post_z))
    # Sum each channel's components, splitting by band.
    ...

def _phase_for(channel_id, freq_hz, seed):
    # Deterministic phase in [0, 2π). Hash of the triple.
    import math
    h = hash((channel_id, int(freq_hz * 1000), seed)) & 0xFFFFFFFF
    return (h / 0xFFFFFFFF) * 2.0 * math.pi
```

The tag-side integration converts `pos_pre` / `pos_post` from
viewport-fraction to world units using the camera's FOV and the
look-at target distance (or a 1000cm fallback).

### Seed handling

- Param default = 0 means "use the tag's stable hash seed."
- Tag's stable hash seed = the existing BC marker
  (`_BCKEY_TAG_MARKER`) we already stamp for state-key purposes.
  That value is monotonic per tag, persists across reload, so it
  gives every tag a different default seed without any new
  storage.
- When the user sets a non-zero seed value, it wins over the BC
  marker. Lets two shots with two tags share an intentional seed
  if needed.

### Calibration sources

Starting values above are educated guesses based on these
reference characteristics of real handheld:

- **Dominant rotation drift: 0.8-1.8 Hz.** Operator's slow
  postural sway, breathing-coupled tilt.
- **Tremor: 6-10 Hz.** Physiological muscle tremor (~8 Hz
  central frequency, well-documented in motor-control
  literature).
- **Amplitudes: ±0.3° to ±0.5° rotation typical.** Larger on
  pitch than heading (operator nods more than they pan-drift).
  Bank very small unless explicitly leaning.
- **Position translation: dominated by Y (vertical bob) and X
  (lateral sway); Z (forward/back) is mostly slow drift, no
  tremor.**

During impl, do an A/B against a reference shot (find one in the
existing dev-test assets or grab a snippet from a known-handheld
reference) and tune the triples until "Profile = Handheld,
Strength = 0.5" reads as believable handheld, not "noisy
keyframes" and not "earthquake."

### Edge cases

- **Profile = Off, Strength = 1.0.** Strength is irrelevant —
  short-circuit on profile takes precedence. No noise.
- **Profile = Handheld, Strength = 0.0.** Short-circuit on
  strength. No noise.
- **No look-at target for distance reference.** Fall back to
  1000cm. Document the fallback; if it produces visibly wrong
  position-noise scale in a scene, the user can dial Strength
  or wait for "Noise Distance Override" param (which we are NOT
  adding in v13 unless impl reveals it's necessary).
- **Very low fps (e.g. 12fps stop-motion).** Sample frequencies
  above Nyquist (fps/2 = 6 Hz) alias. Acceptable in v13 — handheld
  isn't realistic at 12fps anyway. Document.
- **Looping playback.** Sample at frame index, so loop point is
  seamless if the frame ranges' noise samples happen to match.
  They won't, in general — there's no "perfect loop" frequency
  in the sum-of-sines. Acceptable; not a real-world workflow
  to loop a 5-second handheld take and expect a perfect cycle.

## Open questions

1. **Handheld profile values.** The starting calibration above
   needs A/B-ing against reference footage. Resolve during impl.
2. **Position-noise fallback distance.** 1000cm picked from
   "typical interior scene." If users routinely work at
   architectural scale or tabletop scale, may need an explicit
   override. Don't pre-solve — see if the issue surfaces.
3. **Should `_apply_roll_and_bank_into_turns` be aware of noise?**
   No — Roll and Bank-Into-Turns operate on the deterministic
   target, noise is overlaid afterward. This keeps the bank logic
   testable and the noise composition clean. Document explicitly
   in case future-us forgets.
4. **Per-shot override via `rig_state` overrides dict.** The
   override pipeline supports adding `noise_profile`,
   `noise_strength`, `noise_seed` keys. Wire it up in v13?
   Lean YES — it's three lines in `_read_*` helpers and the
   inspector panel will need it whenever it lands. Decide
   during impl; if it adds non-trivial scope, defer.

## Done when

- [ ] Three new params (`Noise Profile`, `Noise Strength`,
      `Noise Seed`) visible in the tag's AM under a "Noise" group.
- [ ] Profile = Off → camera identical to current behavior (byte
      for byte; no visible noise).
- [ ] Profile = Handheld, Strength = 0.5 → camera reads as
      believable handheld shake on a stationary keyframed camera.
- [ ] Profile = Handheld with the spring damping set high
      (damping = 0.8+) → low-frequency drift is visibly smoothed
      by the spring; high-frequency tremor is still present
      (two-band architecture working).
- [ ] Strength = 0 with Profile = Handheld → no noise (strength
      short-circuit works).
- [ ] Different `Noise Seed` values → visibly different shake
      patterns at the same frame.
- [ ] Looping playback → noise pattern is deterministic, the
      same frame produces the same shake on each loop.
- [ ] Scrubbing the timeline backward / jumping to a frame →
      shake at that frame matches what it was on the forward
      pass (stateless sampling working).
- [ ] Profile = Handheld + a look-at target → camera shakes
      around the framed aim; the spring's whip-pan-with-weight
      feel is preserved.
- [ ] Profile = Handheld + Bank-Into-Turns → bank shake composes
      with bank-into-turns (additive on the bank channel, not
      replacing it).
- [ ] Frame Offset (v12 joystick) + Noise = Handheld → off-center
      framing is preserved, noise adds shake on top of it.
- [ ] Replace mode → noise applies the same as in additive.
- [ ] Save / reopen the scene → params persist, noise plays back
      identically.
- [ ] Reset path (shot boundary) → no pop; first frame after the
      cut lands on the clean target, noise builds in over the
      next several frames (or doesn't, but never as a pop).
- [ ] Manual checklist (≤ 10 items) appended to this file and
      passes.

## Manual checklist

Setup: dev-test scene with a tagged camera + target cube.

- [ ] **Baseline.** Profile = Off. Camera matches pre-v13
      behavior (compare against a saved screenshot from main).
- [ ] **Handheld on a static camera.** No keyframes, no
      look-at. Profile = Handheld, Strength = 0.5. Camera shakes
      with low-frequency drift + high-frequency tremor. Reads as
      handheld, not as noise.
- [ ] **Strength sweep.** 0.0 → no shake. 1.0 → roughly 2× the
      0.5 case. Strength scales linearly.
- [ ] **Spring damping interaction.** Damping = 0.95 +
      Handheld @ 0.5 → drift visibly damped, tremor intact.
      Confirms two-band architecture.
- [ ] **Seed variation.** Apply two Shotblocks tags to two
      cameras; set both Profile = Handheld, Strength = 0.5,
      and either both Seed = 0 (defaults differ via BC marker)
      or different explicit seeds. Side-by-side: visibly
      different shake.
- [ ] **Loop seamlessness.** Set Profile = Handheld; loop
      playback over a range. Each pass produces identical
      shake (deterministic sampling).
- [ ] **Look-at + noise.** Add a look-at target and animate it.
      Camera tracks the target with the spring whip + handheld
      shake overlaid. Believable.
- [ ] **Frame Offset + noise.** Set Frame Offset to (0.167,
      0.167) and Profile = Handheld. Target stays off-center;
      noise shakes around the off-center aim.
- [ ] **Bank-Into-Turns + noise.** Animate target across a curve
      so heading changes fast; enable Bank-Into-Turns with Roll
      = 15°. The yaw-driven bank composes with bank tremor from
      handheld noise.
- [ ] **Save / reopen.** Params persist; first playback after
      reopen produces the same shake as before save.

## Notes

(Filled in during impl — final calibration triples, anything
surprising about the two-band split or the BC-marker-as-seed
fallback.)

## What actually shipped (post-iteration)

Spec called for sum-of-sines and a single Strength slider. What
actually landed is materially different in five places — preserving
here so the next session doesn't re-derive the dead ends.

### Value-noise (fBm), not sum-of-sines

Sum-of-2-3-sines was the first attempt. Result felt like "a
mechanical shake" — periodic, even-amplitude, no asymmetry. A
small sum of pure sines can't produce bursty "big random move
here, calm moment there" — that's what value-noise summed across
octaves (fractal Brownian motion) is for.

Final implementation: 1D cosine-interpolated value-noise summed
across 4-5 octaves per channel, lacunarity ~1.65, gain ~0.6. The
output has peak/RMS ratio ~2.3-2.5 — exactly the asymmetric
character we couldn't get from sines. fBm tuning notes embedded
in `sb_rig_noise.py`'s `_HANDHELD` table.

The two-band split (`*_pre` for spring-damped drift, `*_post` for
spring-bypassing tremor) survives from the original spec.

### Walking layer is post-spring, not pre-spring

Spec said walking goes pre-spring "so the spring damps it into
weighty bounce." Tried that — the spring's low-pass at default
damping eats the 2× footstrike frequency (3.6 Hz at 1.8 Hz step
rate) and the gait signature was invisible.

Moved walking to `*_post` so the bob and sway read cleanly. The
"weighty bounce" feel comes from the easing functions in the walk
math itself, not from spring damping. Walk amplitudes nearly
doubled (bob 0.013 → 0.025 viewport fraction, pitch nod 0.012 →
0.025 rad) since they no longer get attenuated.

### Noise Speed parameter added during tuning

Spec didn't include Speed — Strength was the only magnitude
control. In playback the noise read as "too fast." Rather than
hardcode slower frequencies (which would still leave the user
without a control), exposed `Noise Speed` (0.25..3.0, default 1.0)
as a multiplier on the noise function's time input. The fBm base
frequencies also got reduced (e.g. heading drift 0.55 → 0.30 Hz)
and lacunarity reduced from ~2.1 to ~1.65 so high octaves
contribute less amplitude.

### Strength range widened to 0..3.0

Spec said 0..1.0. User feedback was "I want to push it harder."
Capped at 3.0 with no change to internal math (just a multiplier).

### Quick Zoom added in same session

Not in the original spec at all — surfaced as a feature request
during noise tuning ("can we have snap-zooms like documentary
cameras do?"). Worth its own task spec retroactively if it grows.

Architecture: separate module `sb_rig_zoom.py`, separate parameter
group "Quick Zoom" on the tag. Deterministic Poisson schedule
seeded by the existing Noise Seed (zoom and noise are coordinated
per-tag but not entangled). 7 parameters:

- `Quick Zoom` (bool)
- `Zoom Rate` (zooms/sec, 0.05..3.0, default 0.2)
- `Zoom Strength` (peak focal multiplier, 1.0..4.0, default 1.5)
- `Zoom Hold` (sec, default 1.0)
- `Zoom Ramp In` (sec, default 0.25)
- `Zoom Ramp Out` (sec, default 0.6)
- `Zoom Return Probability` (0..1, default 0.7)

Output is a multiplier on `c4d.CAMERAOBJECT_FOCUS`. Baseline is
the keyframed FOCUS CTrack value if present, else a cached
snapshot taken when zoom was idle. When Quick Zoom is disabled,
the baseline gets restored on the next Execute (clean revert).

Schedule events have ±20-40% jitter on every duration so the
rhythm doesn't feel mechanical. Smoothstep easing on each
ramp. Schedule rebuilds when any param changes (hashable
`cache_key` tuple).

### Final parameter inventory (Noise + Zoom groups)

```
Noise:
  Noise Profile         cycle  [Off, Handheld]    default Off
  Noise Strength        real   0.0 .. 3.0          default 0.5
  Noise Speed           real   0.25 .. 3.0         default 1.0
  Noise Seed            int    any                 default 0 (uses BC marker)
  Walking               bool                       default off
  Step Rate (Hz)        real   0.5 .. 4.0          default 1.8

Quick Zoom:
  Quick Zoom            bool                       default off
  Zoom Rate             real   0.05 .. 3.0         default 0.2
  Zoom Strength         real   1.0 .. 4.0          default 1.5
  Zoom Hold             real   0.2 .. 3.0          default 1.0
  Zoom Ramp In          real   0.05 .. 1.0         default 0.25
  Zoom Ramp Out         real   0.05 .. 2.0         default 0.6
  Zoom Return           real   0.0 .. 1.0          default 0.7
```

### Known small issues / next-session candidates

- **Zoom focal drift across many partial-pullbacks.** If Zoom
  Return is very low and Zoom Rate is high, sequential events
  chain (each starts from the previous settle), so focal can
  drift upward over time. Schedule logic is correct (intentional
  — that's how documentary operators work the lens), but if it
  reads as a bug we may want a "max effective multiplier" clamp
  or a decay-back-to-baseline between events.
- **Pitch nod sign convention.** `_walk_cycle` uses `-0.025 * cos(fs)`
  for the nod, intent "forward dip on footstrike." If playback
  reveals the camera nodding backward on each step, flip the sign.
- **Step Rate doesn't affect noise speed.** This is intentional
  (walking has its own tempo control), but if users want to sync
  noise speed to walking they currently have to dial Noise Speed
  separately. Probably correct as-is.
- **Future profiles not wired into the cycle yet.** Drone,
  Shoulder-mount, Tripod, Steadicam are deferred. When adding
  one, extend the `SHOTBLOCKS_NOISE_PROFILE` cycle in
  tshotblocks.h/.res/.str and add an `_HANDHELD`-shaped table
  in `sb_rig_noise.py`. The dispatch in `sample_profile` already
  has the shape.
