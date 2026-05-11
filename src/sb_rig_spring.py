"""Spring-damper integration for the Shotblocks rig.

Pure functions over float state. No `c4d` import. Caller (the tag's
`Execute`) holds the per-channel state and feeds the function a
target every frame.

Math reference: `.agent/skills/spring-damper.md`

Semi-implicit Euler:
    a = -k * (x - x_target) - c * v
    v += a * dt
    x += v * dt

Critical damping coefficient:
    c_crit = 2 * sqrt(k * m)        (m = 1 by convention)

User-facing damping knob `d` in [0..1]:
    d = 0    -> very stiff (tracks target almost instantly)
    d = 1    -> very soft  (lazy pursuit, large overshoot risk)
    default  0.5 -> moderate critically-damped pursuit

Mapping from `d` to physics k:
    k = K_MIN + (K_MAX - K_MIN) * (1 - d)^2
    c = 2 * sqrt(k)             (critical)

The squared term makes the slider feel linear at the high-stiffness
end of the range, where small UI changes produce visible motion
changes. Locked-in values are tunable.
"""

from math import sqrt, ceil


K_MIN = 3.0     # at d = 1.0 (very soft, ~2.3s settle at critical)
K_MAX = 400.0   # at d = 0.0 (~0.20s settle — visually instant
                #             without risking integrator instability)


def k_from_damping(damping):
    """Map the 0..1 user knob to physics stiffness `k`.

    Logarithmic mapping: each linear step in damping produces a
    multiplicative step in settle time. This gives meaningful
    perceptual differentiation across the whole 0..1 range.

    K_MAX is capped at 400 not 2000 because semi-implicit Euler
    integration becomes unstable when `dt * sqrt(k) > ~2`. At 24fps,
    dt=42ms and sqrt(2000)≈45 → product 1.9, right at the edge —
    real-world result was the spring overshooting hard and the
    camera shooting backwards. K_MAX=400 gives sqrt=20, product
    0.84, well within the stable region even at lower framerates.
    Visually, k=400 settles in ~200ms (under 5 frames at 24fps) —
    effectively instant to the eye. Substepping below
    1/substep_threshold_fps adds further safety.
    """
    d = max(0.0, min(1.0, float(damping)))
    ratio = K_MIN / K_MAX
    return K_MAX * (ratio ** d)


def critical_c(k):
    """Critical damping coefficient for stiffness `k` (mass = 1)."""
    return 2.0 * sqrt(k)


def step_channel(x, v, x_target, dt, k, c, substep_threshold_fps=30.0):
    """Advance one channel one frame. Returns (new_x, new_v).

    Substeps automatically when dt is large enough to make integration
    unstable. `substep_threshold_fps` is the lowest fps at which one
    integration step is safe; below it we subdivide.

    Substep count: ceil(dt * substep_threshold_fps). At dt = 1/24 and
    threshold = 30, that's ceil(1.25) = 2 substeps. At dt = 1/60 and
    threshold = 30, ceil(0.5) = 1 (no subdivision).
    """
    if dt <= 0.0:
        return x, v
    threshold = max(1.0, float(substep_threshold_fps))
    substeps  = int(ceil(dt * threshold))
    if substeps < 1:
        substeps = 1
    sub_dt = dt / substeps
    for _ in range(substeps):
        a = -k * (x - x_target) - c * v
        v += a * sub_dt
        x += v * sub_dt
    return x, v


def step_vector(state, target, dt, k, c, substep_threshold_fps=30.0):
    """Convenience: step three channels at once. `state` and `target`
    are 3-tuples; returns ((new_x, new_y, new_z), (new_vx, new_vy,
    new_vz)).
    """
    pos, vel = state
    tx, ty, tz = target
    nx, nvx = step_channel(pos[0], vel[0], tx, dt, k, c, substep_threshold_fps)
    ny, nvy = step_channel(pos[1], vel[1], ty, dt, k, c, substep_threshold_fps)
    nz, nvz = step_channel(pos[2], vel[2], tz, dt, k, c, substep_threshold_fps)
    return (nx, ny, nz), (nvx, nvy, nvz)


def make_state():
    """Empty per-tag spring state. Keyed by channel name."""
    return {
        # pos: 3-tuple, vel: 3-tuple
        "pos":  [(0.0, 0.0, 0.0), (0.0, 0.0, 0.0)],
        "rot":  [(0.0, 0.0, 0.0), (0.0, 0.0, 0.0)],
        # Frame the state was last advanced.
        "last_frame": None,
    }


def reset_to_target(state, pos, rot):
    """Snap pos+rot channels to the given targets and zero velocities.
    Called at shot boundaries (constitution principle 4) and on scrub
    jumps. Mutates `state` in place.
    """
    state["pos"] = [tuple(pos), (0.0, 0.0, 0.0)]
    state["rot"] = [tuple(rot), (0.0, 0.0, 0.0)]
