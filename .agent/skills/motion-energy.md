# Motion-Energy Curve

The signal that drives slate. A per-frame scalar value representing how much the camera is "doing" at each frame.

## Definition

```
motion_energy(frame) = w_t * |translational_velocity(frame)|
                     + w_r * |rotational_velocity(frame)|
                     + w_a * |acceleration(frame)|
```

Where weights are user-configurable (defaults: `w_t = 0.3`, `w_r = 0.5`, `w_a = 0.2`).

## Computing the components

For a shot covering frames `[start, end]`:

1. Evaluate the rig at each frame in the range, recording position `p(frame)` and rotation quaternion `q(frame)`.
2. Translational velocity: `|p(frame) - p(frame-1)| / dt`. Magnitude of the position delta.
3. Rotational velocity: angular distance between `q(frame)` and `q(frame-1)`, divided by `dt`. Use quaternion dot product to compute angle: `angle = 2 * acos(|q1 · q2|)`.
4. Acceleration: `|v(frame) - v(frame-1)| / dt`, where `v` is the translational velocity vector.
5. Boundary frames: replicate the second-to-last/first values, or use one-sided differences.

## Normalization

Raw motion energy values vary wildly between shots (a slow drift vs. a fast whip). Normalize per-shot so the max is 1.0 and the min is 0.0:

```
e_normalized(frame) = (e_raw(frame) - min) / (max - min)
```

This makes peak-detection thresholds meaningful across shots and gives the user a consistent scale in any UI display.

## Peak detection

Action frames are local maxima of the normalized curve. Algorithm:

1. Find all frames where the curve is greater than both neighbors.
2. Filter: discard peaks below a configurable threshold (default 0.4 normalized) — these are noise.
3. If multiple peaks are within a minimum spacing (default: 0.2 seconds), keep only the highest in that window.
4. Sort by descending energy; the first is the *primary* action frame, the rest are secondary peaks.

## Low-energy detection

Local minima, same algorithm flipped. Used as candidate cut points when "at_calm" cut placement is selected.

## Caching

Computing the motion-energy curve requires evaluating the rig at every frame in the shot — expensive enough that we cache:

- Per-shot, keyed by shot ID
- Invalidated when any rig parameter on the shot changes (focal length, target, damping, noise profile, etc.)
- Invalidated when the shot's in/out points change
- Persisted in memory only — recompute on document open

For a typical 5-second shot at 24fps, computation should take well under 100ms after the rig is warm.

## Edge cases

- **Shot too short** (< 4 frames): can't compute meaningful velocity or acceleration. Return a flat curve at 0; primary action frame is the midpoint.
- **Static shot** (no rig motion): flat curve at 0. Treat midpoint as primary action frame; warn in slate status message.
- **Shot with extreme spike** (e.g., a noise profile burst): the spike will dominate normalization and flatten everything else. Optionally apply a percentile-based clip (e.g., clip to 99th percentile) before normalizing.

## Why these three components

- **Translational velocity** captures dolly speed, push-in/pull-out intensity, parallax energy.
- **Rotational velocity** captures pan and tilt speed, and is heavily weighted because rotation reads more strongly to the eye at typical scene distances.
- **Acceleration** captures *changes* in motion — the moment a smooth move turns into something else, or impacts and direction changes. Lower weighted because it tends to spike noisily on noise-profile-induced shake.

The weights are exposed because users in different contexts want different emphasis. A motion designer doing whips wants rotation maxed out. A sim artist filming an explosion wants acceleration up. Don't hard-code; expose.
