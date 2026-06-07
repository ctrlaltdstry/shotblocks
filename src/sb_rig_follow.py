"""Chase / Follow-Target placement for the Shotblocks rig.

Pure functions over plain floats and 3-tuples. No `c4d` import — the
caller (the tag's `Execute`) converts to/from `c4d.Vector` and feeds the
follow target's world position every frame.

Design reference: `.agent/plans/rig-chase-sphere.md`.

The model is a **world-anchored sphere** around the target. The camera body
sits ON the sphere's surface, always aiming at the target:

    camera = target_pos + radius * sphere_dir(lon, lat)

`sphere_dir` is a WORLD-anchored unit direction (turntable): longitude
spins around world Y, latitude tilts toward the world poles. (0,0) is
behind + level (world -Z side, equator). Because the sphere is anchored to
world axes — NOT the target's heading — the camera spot stays put in the
world as the target flies through, so there is no heading-driven re-
orientation. This replaced an earlier velocity-relative "trail behind the
heading + orbit on top" model whose placement competed with itself (the
orbit orbited a moving, re-orienting behind-point). See the plan.

This module computes the **desired camera position**; the caller's existing
position spring chases it, so the lag/overshoot (the swoop) is emergent
from spring-lag, not from anything here.

The only stateful part is a low-passed target velocity, kept ONLY for the
**Look-Ahead** aim point (a point ahead of the target along its travel, for
anticipation). Placement uses no velocity — Look-Ahead is aim-only and
never affects the sphere position, so it can't reintroduce the competing
motion. On a scrub-back / shot boundary the caller calls `reset_state`.
"""

from math import sqrt, sin, cos


# ---------------------------------------------------------------------------
# Tunables (Look-Ahead velocity smoothing only).
# ---------------------------------------------------------------------------

# EMA factor for the target-velocity low-pass used by the Look-Ahead aim
# point. Fixed (no knob) — the lead point is forgiving and this just keeps
# the heading from jittering at low speed. Larger = snappier, smaller = lazier.
_LEAD_VEL_ALPHA = 0.25

# Speed (scene units/sec) below which the lead point collapses onto the
# target (no point aiming ahead of a near-stationary subject, and the
# heading is noise at low speed). Smoothstep fade up to this.
_LEAD_MIN_SPEED = 50.0


# ---------------------------------------------------------------------------
# Vector helpers (plain 3-tuples, no c4d).
# ---------------------------------------------------------------------------

def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def _scale(a, s):
    return (a[0] * s, a[1] * s, a[2] * s)


def _length(a):
    return sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2])


def _normalize(a):
    """Return the unit vector, or None if `a` is ~zero length."""
    L = _length(a)
    if L < 1e-9:
        return None
    inv = 1.0 / L
    return (a[0] * inv, a[1] * inv, a[2] * inv)


def _lerp(a, b, t):
    return (a[0] + (b[0] - a[0]) * t,
            a[1] + (b[1] - a[1]) * t,
            a[2] + (b[2] - a[2]) * t)


def _smoothstep(edge0, edge1, x):
    if edge1 <= edge0:
        return 1.0 if x >= edge1 else 0.0
    t = (x - edge0) / (edge1 - edge0)
    if t < 0.0:
        t = 0.0
    elif t > 1.0:
        t = 1.0
    return t * t * (3.0 - 2.0 * t)


def _clamp(x, lo, hi):
    x = float(x)
    return lo if x < lo else (hi if x > hi else x)


# ---------------------------------------------------------------------------
# Sphere placement (the core).
# ---------------------------------------------------------------------------

def sphere_dir(lon, lat):
    """World-anchored unit direction from the target CENTER to the camera.

    lon: azimuth (radians) about world Y. 0 = behind (world -Z side).
    lat: elevation (radians) from the equator. +pi/2 = straight overhead
         (world +Y), -pi/2 = straight underneath (world -Y).

      x = -sin(lon) * cos(lat)
      y =             sin(lat)
      z = -cos(lon) * cos(lat)

    (0,0) -> (0,0,-1) = behind + level. Always unit length; poles are clean
    (no degeneracy at +/-pi/2). Verified by _sphere_probe.py.
    """
    cl = cos(lat)
    return (-sin(lon) * cl, sin(lat), -cos(lon) * cl)


def camera_position(target_pos, radius, lon, lat):
    """Desired camera WORLD position: on the sphere surface around the
    target. = target_pos + radius * sphere_dir(lon, lat)."""
    d = sphere_dir(lon, lat)
    return (target_pos[0] + radius * d[0],
            target_pos[1] + radius * d[1],
            target_pos[2] + radius * d[2])


# ---------------------------------------------------------------------------
# Look-Ahead aim point (the only stateful part).
# ---------------------------------------------------------------------------

def make_state():
    """Per-tag chase runtime state (Look-Ahead velocity only)."""
    return {
        "smoothed_vel": None,     # 3-tuple, scene units/sec (EMA), for lead
        "prev_target_pos": None,  # last frame's target world pos
        "last_frame": None,
    }


def reset_state(state):
    """Clear the Look-Ahead velocity smoothing so the next frame seeds
    clean. Called at shot boundaries / scrub-back."""
    state["smoothed_vel"] = None
    state["prev_target_pos"] = None


def lead_point(state, target_pos, dt, lead_distance):
    """A point AHEAD of the target along its smoothed travel direction, for
    anticipation aim. Returns target_pos itself when lead_distance == 0 or
    the target is ~stationary. Updates the velocity-smoothing state.

    AIM-ONLY: this never affects the camera's sphere position — it just
    gives the caller a point to bias the aim toward (Look-Ahead). So the
    velocity tracking here cannot cause the position-competition the old
    velocity-relative placement did.
    """
    prev = state.get("prev_target_pos")
    if prev is None or dt <= 0.0:
        raw_vel = (0.0, 0.0, 0.0)
    else:
        raw_vel = _scale(_sub(target_pos, prev), 1.0 / dt)
    sm = state.get("smoothed_vel")
    smoothed = raw_vel if sm is None else _lerp(sm, raw_vel, _LEAD_VEL_ALPHA)
    state["smoothed_vel"] = smoothed
    state["prev_target_pos"] = tuple(target_pos)

    if lead_distance == 0.0:
        return tuple(target_pos)
    speed = _length(smoothed)
    heading = _normalize(smoothed)
    if heading is None:
        return tuple(target_pos)
    # Fade the lead in with speed so a near-stationary subject isn't led
    # along a jittery near-zero heading.
    w = _smoothstep(0.0, _LEAD_MIN_SPEED, speed)
    return _add(target_pos, _scale(heading, lead_distance * w))
