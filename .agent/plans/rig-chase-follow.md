# Rig: Chase / Follow Target behavior

A camera that **pursues a moving object with its own momentum** — trails
it, lags, overshoots on turns — rather than being rigidly bolted to it.
The signature use case: a camera chasing a flying mouse-cursor (or any
animated object) as it darts between objects, feeling like an operator
running to keep up, not a parented null.

**Status: concept / design (not started).** Captured from a design
discussion 2026-05-29. Not yet scheduled or specced to implementation
depth.

## Why build it pre-v2 (the foundation argument)

This is ultimately a **v2 motion-layers Targeting "Chase" pill** (see
[motion-layers-roadmap.md](motion-layers-roadmap.md) Plans 2–4, and the
"Lead amount" field in [../motion-layers-inspector.md](../motion-layers-inspector.md),
which is conceptually adjacent). But the *engine* — the chase math — is
worth building now as a rig-tag knob so:
- it's usable before v2 ships, and
- the v2 Targeting Chase pill drives the **same engine** later instead
  of reimplementing it. Build the math once, two front-ends over time.

**Architecture (decided):** chase math lives in a new pure-function
module **`src/sb_rig_follow.py`** — no `c4d` import, like
`sb_rig_spring` / `sb_rig_noise` / `sb_rig_zoom`. It's front-end-agnostic:
given (target pos, target velocity, current camera state, knobs) it
returns the **desired camera position**; the existing position spring
does the lag/overshoot. The tag composes it now (reading AM params); the
v2 Targeting pill composes the same module later (reading pill params).
Nothing in the chase math knows which front-end is driving it.

## What it drives (decided)

**Position only.** Chase computes the camera body's desired position
(velocity-relative trail). **Aim stays on the existing Look-At Target +
angular spring** — the two behaviors compose. So you can chase one object
and look at another, or chase the cursor and look at it (set both targets
to the cursor). Keeps the separation clean and reuses look-at as-is.

## The feel model: velocity-relative pursuit (decided)

The camera wants to sit **behind the target along its direction of
travel**. Per frame:
1. Read the target's velocity vector (its heading).
2. Desired spot = `target_pos − (velocity_dir × follow_distance)` plus a
   small height/side bias for flattering framing.
3. The **position spring chases** that desired spot — lag + overshoot.

The aliveness is emergent from spring-lag + a moving desired-spot:
- **Straight-line travel:** camera settles into a trailing chase, calm
  (noise still breathes on top).
- **Cursor whips around a corner:** the "behind" spot jumps to the new
  heading; the spring can't teleport, so the camera **overshoots past the
  corner and arcs back** to swing in behind — the money shot. A rigid rig
  snaps; the spring gives the swoop for free.
- **Cursor stops suddenly:** velocity → 0, camera carries momentum,
  **drifts in past the stop point and eases back** — like an operator who
  was running and has to settle.

## The two failure modes to engineer around (the real work)

These are why velocity-relative is "more complex," and they're what need
live tuning against a real flying-cursor animation, not theory:

1. **Low-speed / jitter direction-thrash.** At low speed the velocity
   *direction* is noisy and can flip frame-to-frame, making the "behind"
   target thrash. **Fix:** smooth the velocity (low-pass / its own slower
   spring) AND fade the velocity-relative offset out toward a neutral
   world-offset hold as speed drops below a threshold. "Velocity-relative
   when moving, gentle hold when slow."
2. **Reverse whip-around.** Sharp direction reversal flips the "behind"
   point to the opposite side; camera tries to swing all the way around.
   Sometimes dramatic, sometimes nauseating. **Control:** a re-orient
   damping that caps how fast the offset swings to the new behind.

## Implied knobs (tunable, not fixed)

- **Follow Target** — object link to chase (separate from Look-At Target).
- **Follow Distance** — how far behind it trails.
- **Position Damping** (exists) — chase lag / overshoot → the swoop.
- **Velocity Smoothing** — filters the heading direction; kills low-speed jitter.
- **Re-orient Speed** — how eagerly it swings to the new "behind" on a turn.
- **Height / Side Bias** — small fixed offset so it's not dead-behind (better framing).

Composes with: aim (look-at + angular spring keeps subject framed while
the body swoops) and noise (handheld layer on the chasing camera).

## Open questions (resolve before implementation)

- Velocity source: target's frame-to-frame position delta (simple) vs a
  proper CTrack-derived velocity? Delta is enough and matches the
  stateless-sample philosophy, but needs the low-pass to be usable.
- Stateless vs stateful: the chase needs the previous frame's smoothed
  velocity to low-pass it — that's per-tag runtime state (fine, the
  spring already keeps state), but interacts with scrub/reset. Decide how
  chase state resets on a scrub-back / shot boundary (likely: snap to the
  current desired spot on reset, like the spring does).
- World-offset fallback shape when speed is low (the "gentle hold").
- Where it lands in the roadmap: a pre-v2 rig-tag increment (its own
  small release, akin to v1.2 Live Aim?) vs folded into v2 Targeting.
  Leaning pre-v2 foundation per this discussion.

## Reference

- Reuses [../skills/spring-damper.md](../skills/spring-damper.md) (the lag/overshoot engine).
- Future home: [motion-layers-roadmap.md](motion-layers-roadmap.md) Targeting pill (Plans 2–4).
- Sibling pure-function modules: `src/sb_rig_spring.py`, `sb_rig_noise.py`, `sb_rig_zoom.py`.
