"""Chase / Follow-Target pursuit for the Shotblocks rig.

Pure functions over plain floats and 3-tuples. No `c4d` import — the
caller (the tag's `Execute`, or later the v2 motion-layers Targeting
"Chase" pill) converts to/from `c4d.Vector` and feeds the follow
target's world position every frame.

Design reference: `.agent/plans/rig-chase-follow.md`.

The feel model is **velocity-relative pursuit**: the camera wants to
sit *behind the target along its direction of travel*. Per frame:

    desired = target_pos - heading_dir * follow_distance + biases

This module computes only the **desired camera position**. The caller's
existing position spring chases that desired spot — the lag + overshoot
(the swoop on corners, the drift-past on a sudden stop) is emergent from
spring-lag against a moving desired spot, not from anything in here.

This module is **stateful** (unlike `sb_rig_noise`, which is a pure
stateless sample). It has to be: low-passing the target's velocity and
rate-limiting the re-orient both need the previous frame's smoothed
value. The state is a small dict the caller owns per tag. On a scrub-back
or shot boundary the caller calls `reset_state` so the smoothing snaps
clean and the first post-reset frame seeds the spring at the freshly
computed desired spot (matching how the spring's own `reset_to_target`
behaves).

The two failure modes this module exists to engineer around (see the
spec) are both handled here:

1. **Low-speed direction jitter.** When the target is barely moving, the
   frame-to-frame velocity *direction* is noisy and flips, which would
   thrash the "behind" point. Two defenses: the velocity is low-passed
   (EMA), and below a speed threshold the velocity-relative direction is
   faded out toward a held neutral direction. "Velocity-relative when
   moving, gentle hold when slow."
2. **Reverse whip-around.** A sharp reversal flips the "behind" point to
   the opposite side; left unchecked the camera tries to swing all the
   way around. The held offset direction is slewed toward the new heading
   at a capped angular rate (the Re-orient Speed knob), so a reversal
   eases around instead of snapping.
"""

from math import sqrt, acos, sin, cos


# ---------------------------------------------------------------------------
# Tunable constants. These are the live-tuning targets — calibrated by
# eye against a real flying-target animation, not derived. Adjust here
# (module-wide character) or via the knobs (per-tag).
# ---------------------------------------------------------------------------

# Speed (scene units / second) below which the velocity direction is no
# longer trustworthy and we fade to the held neutral direction. ~50 cm/s
# is "barely drifting" for a typical interior-scale scene. Failure mode #1.
DEFAULT_MIN_SPEED = 50.0

# Width of the fade band below MIN_SPEED, as a fraction of MIN_SPEED.
# Within [MIN_SPEED*(1-band) .. MIN_SPEED] we smoothstep from full hold
# to full velocity-relative, so there's no hard pop at the threshold.
_FADE_BAND = 0.6

# Velocity smoothing: the 0..1 knob maps to an EMA blend factor (alpha)
# applied per frame. alpha = how much of THIS frame's raw velocity we
# fold in (1.0 = no smoothing, instantly follows; small = heavy lag on
# the heading). Knob 0 -> ALPHA_MAX (responsive), knob 1 -> ALPHA_MIN
# (heavily smoothed). The default knob (0.5) lands mid-range.
#
# Note this is frame-rate dependent by design (it's a per-frame EMA);
# the spring already substeps for stability, but the heading low-pass is
# deliberately a cheap per-frame filter — at 24/30/60fps the difference
# is small and gets tuned by eye anyway.
_VEL_ALPHA_MIN = 0.06    # knob = 1.0 (very smooth heading)
_VEL_ALPHA_MAX = 0.60    # knob = 0.0 (snappy heading)

# Re-orient speed: the 0..1 knob maps to the maximum angle (radians) the
# held offset direction may slew per frame toward the new heading. Small
# cap = the "behind" point eases around on a turn (no whip); large cap =
# it tracks the heading almost rigidly. Knob 0 -> REORIENT_MIN (slow,
# dramatic arc), knob 1 -> REORIENT_MAX (near-instant re-orient).
_REORIENT_MIN = 0.015    # rad/frame at knob 0  (~0.9 deg/frame)
_REORIENT_MAX = 0.50     # rad/frame at knob 1  (~29 deg/frame)

# Default held direction when we have no heading history yet (first frame,
# or target stationary from the start): point the camera-behind offset
# straight back along world -Z and slightly up. This is just a sensible
# starting "behind"; once the target moves, the real heading takes over.
_DEFAULT_BEHIND = (0.0, 0.0, 1.0)


# ---------------------------------------------------------------------------
# Small vector helpers (plain 3-tuples, no c4d).
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


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a, b):
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def _lerp(a, b, t):
    return (
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    )


def _smoothstep(edge0, edge1, x):
    """Hermite smoothstep — 0 below edge0, 1 above edge1, eased between."""
    if edge1 <= edge0:
        return 1.0 if x >= edge1 else 0.0
    t = (x - edge0) / (edge1 - edge0)
    if t < 0.0:
        t = 0.0
    elif t > 1.0:
        t = 1.0
    return t * t * (3.0 - 2.0 * t)


def _slerp_unit(a, b, max_angle):
    """Rotate unit vector `a` toward unit vector `b`, but no more than
    `max_angle` radians this step. Returns a unit vector.

    Used to rate-limit the re-orient so a sharp reversal eases around
    instead of snapping (failure mode #2). If the angle between a and b
    is within max_angle, returns b. Otherwise returns the point on the
    arc from a toward b at exactly max_angle.
    """
    d = _dot(a, b)
    # Clamp for acos domain safety.
    if d > 1.0:
        d = 1.0
    elif d < -1.0:
        d = -1.0
    angle = acos(d)
    if angle <= max_angle or angle < 1e-6:
        return b
    # Antiparallel: cross product is degenerate. Nudge with an arbitrary
    # perpendicular so the slew still makes progress (this is the exact
    # hard-reversal case the cap exists for).
    if angle > 3.14159:
        perp = _cross(a, (0.0, 1.0, 0.0))
        if _length(perp) < 1e-6:
            perp = _cross(a, (1.0, 0.0, 0.0))
        b = _normalize(perp) or b
        # Recompute toward the nudged perpendicular at max_angle.
        return _slerp_unit(a, b, max_angle)
    # Standard slerp at fraction (max_angle / angle).
    t = max_angle / angle
    s = sin(angle)
    w0 = sin((1.0 - t) * angle) / s
    w1 = sin(t * angle) / s
    out = (a[0] * w0 + b[0] * w1,
           a[1] * w0 + b[1] * w1,
           a[2] * w0 + b[2] * w1)
    return _normalize(out) or b


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

def make_state():
    """Per-tag chase runtime state. The caller owns one of these per tag
    (stored alongside the spring state) and passes it back every frame."""
    return {
        "smoothed_vel": None,     # 3-tuple, scene units / second (EMA)
        "prev_target_pos": None,  # last frame's follow-target world pos
        "offset_dir": None,       # current 'behind' unit dir (re-orient damped)
        "last_frame": None,       # bookkeeping for the caller if it wants it
    }


def reset_state(state):
    """Clear the smoothing so the next `desired_position` snaps clean.

    Called by the tag at shot boundaries and on scrub-back, mirroring the
    spring's `reset_to_target`. After this, the next frame computes the
    desired spot from a fresh (zero-velocity) start — the held direction
    falls back to whatever heading the first post-reset frame produces,
    or the default behind if the target isn't moving yet.
    """
    state["smoothed_vel"] = None
    state["prev_target_pos"] = None
    state["offset_dir"] = None


# ---------------------------------------------------------------------------
# Core
# ---------------------------------------------------------------------------

def desired_position(state, target_pos, dt,
                     follow_distance,
                     velocity_smoothing,
                     reorient_speed,
                     height_bias,
                     side_bias,
                     lead_distance=0.0):
    """Compute the chase result for this frame.

    Args:
        state:              per-tag dict from `make_state` (mutated).
        target_pos:         3-tuple, follow target's world position now.
        dt:                 seconds per frame.
        follow_distance:    how far behind the target to trail (scene units).
        velocity_smoothing: 0..1 — heading low-pass (failure mode #1).
        reorient_speed:     0..1 — how fast 'behind' swings on a turn
                            (failure mode #2). 0 = slow arc, 1 = near-rigid.
        height_bias:        vertical offset (scene units, world up).
        side_bias:          lateral offset perpendicular to heading.
        lead_distance:      how far AHEAD of the target the aim-lead point
                            sits at full speed (scene units). 0 disables.

    Returns a dict:
        {
          "camera": 3-tuple — desired CAMERA position (behind the target).
          "lead":   3-tuple — a point AHEAD of the target along its
                    smoothed heading, for the caller to aim at (anticipation).
                    Equals target_pos when stationary or lead_distance == 0.
        }

    Position only — the caller decides how to use the lead point for aim.
    """
    prev = state.get("prev_target_pos")

    # --- 1. Raw velocity from frame-to-frame delta. --------------------
    if prev is None or dt <= 0.0:
        raw_vel = (0.0, 0.0, 0.0)
    else:
        raw_vel = _scale(_sub(target_pos, prev), 1.0 / dt)

    # --- 2. Low-pass the velocity (EMA). -------------------------------
    knob_v = _clamp01(velocity_smoothing)
    # knob 0 -> ALPHA_MAX (snappy), knob 1 -> ALPHA_MIN (smooth).
    alpha = _VEL_ALPHA_MAX + (_VEL_ALPHA_MIN - _VEL_ALPHA_MAX) * knob_v
    sm = state.get("smoothed_vel")
    if sm is None:
        smoothed = raw_vel
    else:
        smoothed = _lerp(sm, raw_vel, alpha)
    state["smoothed_vel"] = smoothed

    # --- 3. Speed + heading. -------------------------------------------
    speed = _length(smoothed)
    heading = _normalize(smoothed)   # None if ~stationary

    # The "behind" direction we WANT this frame, before re-orient damping.
    # It's the reverse of the heading (camera sits opposite the travel
    # direction). When stationary, hold the previous behind direction.
    held = state.get("offset_dir")
    if heading is not None:
        want_behind = _scale(heading, -1.0)
    else:
        want_behind = held if held is not None else _DEFAULT_BEHIND

    # --- 4. Low-speed neutral hold (failure mode #1). ------------------
    # Below MIN_SPEED, fade the velocity-relative want toward the held
    # neutral direction so a noisy near-zero velocity doesn't thrash the
    # behind point. smoothstep across the fade band gives a soft handoff.
    if held is None:
        held = _DEFAULT_BEHIND
    lo = DEFAULT_MIN_SPEED * (1.0 - _FADE_BAND)
    vel_weight = _smoothstep(lo, DEFAULT_MIN_SPEED, speed)
    if heading is None:
        vel_weight = 0.0
    # Blend in direction space, then renormalize.
    blended = _lerp(held, want_behind, vel_weight)
    target_behind = _normalize(blended) or held

    # --- 5. Re-orient damping (failure mode #2). -----------------------
    # Slew the held offset direction toward the target_behind, capped at
    # the per-frame max angle from the reorient knob. First frame (no
    # held dir): adopt the target directly so we don't slowly ramp in
    # from the default behind.
    knob_r = _clamp01(reorient_speed)
    max_angle = _REORIENT_MIN + (_REORIENT_MAX - _REORIENT_MIN) * knob_r
    if state.get("offset_dir") is None:
        offset_dir = target_behind
    else:
        offset_dir = _slerp_unit(state["offset_dir"], target_behind, max_angle)
    state["offset_dir"] = offset_dir

    # --- 6. Desired spot. ----------------------------------------------
    desired = _add(target_pos, _scale(offset_dir, follow_distance))

    # Height bias is along world up. Side bias is perpendicular to both
    # the offset direction and world up (a horizontal sidestep), so the
    # camera isn't dead-behind — flatters the framing. Both stay oriented
    # to the horizon regardless of how the target banks.
    if height_bias != 0.0:
        desired = _add(desired, (0.0, height_bias, 0.0))
    if side_bias != 0.0:
        side = _cross(offset_dir, (0.0, 1.0, 0.0))
        side_n = _normalize(side)
        if side_n is not None:
            desired = _add(desired, _scale(side_n, side_bias))

    # --- 6b. Aim-lead point (anticipation). ----------------------------
    # A point AHEAD of the target along its travel direction, so the
    # caller can aim slightly ahead and keep a fast subject from sliding
    # to the trailing edge of frame. The forward direction is -offset_dir
    # (offset_dir is "behind"), which means the lead inherits the SAME
    # re-orient damping as the body — it won't whip on a reversal either.
    #
    # Scaled by vel_weight (the low-speed fade from step 4) so the lead
    # collapses onto the subject when slow/stationary — no point aiming
    # ahead of a target that isn't going anywhere, and it avoids leading
    # along a jittery near-zero heading.
    if lead_distance != 0.0:
        forward = _scale(offset_dir, -1.0)
        lead = _add(target_pos, _scale(forward, lead_distance * vel_weight))
    else:
        lead = target_pos

    # --- 7. Bookkeeping. -----------------------------------------------
    state["prev_target_pos"] = target_pos
    return {"camera": desired, "lead": lead}


def _clamp01(x):
    x = float(x)
    if x < 0.0:
        return 0.0
    if x > 1.0:
        return 1.0
    return x
