"""Inertial weight for the Shotblocks Motion tag.

Pure functions over plain floats and 3-tuples. No `c4d` import — the
caller (the Motion tag's Execute) feeds the object's authored WORLD
position each frame and gets back a drifted world position plus a
banking lean to add to the authored orientation.

The feel model is **inertia / weight**, NOT low-pass smoothing. Two
effects, both emergent from real momentum, both scaled by how hard the
object is cornering (g-force), so straights stay tight and corners drift:

1. **Positional momentum.** The object has a position + velocity and is
   pulled toward the authored spline point by an UNDER-damped spring. On a
   straight (constant-velocity target) it sits dead-on the path. When the
   path turns, the object's existing velocity carries it WIDE to the
   outside of the corner before the spring reels it back — the drift.
   Heavier Weight = softer spring + lower damping = wider, slower drift.

2. **Banking lean (additive).** The component of the object's acceleration
   PERPENDICULAR to its travel direction is the lateral g-force. We turn
   that into a roll (bank into the turn) and pitch (nose up/down on
   climbs/dives) offset, returned as an HPB delta the caller ADDS to the
   authored orientation. This preserves the user's hand-keyed rotation and
   the spline orientation; the lean only layers on top. Lean is automatic-
   ally speed-reactive: lateral accel scales with speed^2 / corner radius.

Everything is computed in WORLD space, because the motion may come from a
parent (Align-to-Spline on a parent null) — the object's own local
channels can be static while it flies. The caller reads the authored world
position (GetMg().off), runs this, and converts the drifted world position
back to a local write.

State is a small dict the caller owns per tag. On a scrub-back / boundary
the caller calls reset_state so momentum snaps clean.
"""

from math import sqrt


# ---------------------------------------------------------------------------
# Tunables. Calibrated by eye; the knobs scale around these.
# ---------------------------------------------------------------------------

# Position spring stiffness range (k). High k = stiff = tracks the path
# tightly (little drift). Low k = soft = lazy, wide drift. The Weight knob
# (0..1) maps 0 -> K_STIFF (no weight, on the path) to 1 -> K_SOFT (heavy).
_K_STIFF = 120.0
_K_SOFT = 8.0

# Damping ratio for the position spring. <1 is under-damped (overshoots —
# the drift-past on a corner). We want a touch under critical so it swings
# wide and settles with one gentle overshoot, not a wobble. Lower = more
# overshoot. The Drift knob scales this: Drift 0 -> ratio 1.0 (critical, no
# overshoot, pure lag), Drift 1 -> ZETA_MIN (loose, pronounced swing-wide).
_ZETA_CRIT = 1.0
_ZETA_MIN = 0.35

# Lean gain: lateral acceleration (world units / s^2) -> bank radians. The
# Lean knob scales this. Sized so a brisk corner at typical scene scale
# gives a readable bank without flipping the object. Acceleration is large
# in world units, so the gain is small.
_LEAN_GAIN = 4.0e-5

# Max lean magnitude (radians) so a violent direction change can't snap the
# object past ~60 degrees of bank.
_LEAN_MAX = 1.05

# Lean low-pass: the raw per-frame acceleration is noisy (second difference
# of position). EMA-smooth it before turning it into a lean angle, or the
# bank jitters. This is the fraction of the new accel folded in per frame.
_LEAN_ALPHA = 0.25

# Drift offset gain: scales how far (seconds^2) the rest target is pushed to
# the outside of a corner per unit of path acceleration, at Weight 1.0.
# Units: the offset is path_accel (units/s^2) * gain, so gain has units of
# s^2. Sized so a brisk corner at typical scene scale drifts a readable
# fraction of the corner radius without flinging the object off the path.
_DRIFT_OFFSET_GAIN = 0.10


# ---------------------------------------------------------------------------
# Vector helpers (plain 3-tuples).
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
    L = _length(a)
    if L < 1e-9:
        return None
    inv = 1.0 / L
    return (a[0] * inv, a[1] * inv, a[2] * inv)


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def _lerp(a, b, t):
    return (a[0] + (b[0] - a[0]) * t,
            a[1] + (b[1] - a[1]) * t,
            a[2] + (b[2] - a[2]) * t)


def _clamp01(x):
    x = float(x)
    return 0.0 if x < 0.0 else (1.0 if x > 1.0 else x)


def _clamp(x, lo, hi):
    return lo if x < lo else (hi if x > hi else x)


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

def make_state():
    """Per-tag inertia runtime state, owned by the caller."""
    return {
        "pos": None,            # last output world position (3-tuple)
        "offset": (0.0, 0.0, 0.0),      # spring-smoothed drift offset from path
        "offset_vel": (0.0, 0.0, 0.0),  # offset velocity
        "prev_target": None,    # last frame's authored world position
        "target_vel_smooth": (0.0, 0.0, 0.0),  # smoothed path velocity (lean axis)
        "vel_primed": False,    # seed target_vel_smooth on first moving frame
        "lean_accel": (0.0, 0.0, 0.0),  # EMA-smoothed path accel, for bank
        "prev_pos": None,       # last frame's drifted body position (for body_vel)
        "body_vel_smooth": None,  # smoothed drifted travel direction (aim source)
        "last_frame": None,
    }


def reset_state(state, target_pos):
    """Snap the body onto the authored point with zero drift. Called at
    boundaries / scrub-back so drift doesn't carry across a jump."""
    state["pos"] = tuple(target_pos)
    state["offset"] = (0.0, 0.0, 0.0)
    state["offset_vel"] = (0.0, 0.0, 0.0)
    state["prev_target"] = tuple(target_pos)
    state["target_vel_smooth"] = (0.0, 0.0, 0.0)
    state["vel_primed"] = False
    state["lean_accel"] = (0.0, 0.0, 0.0)
    state["prev_pos"] = None
    state["body_vel_smooth"] = None


# ---------------------------------------------------------------------------
# Core
# ---------------------------------------------------------------------------

def _k_from_weight(weight):
    """Weight 0..1 -> spring stiffness. 0 = stiff (on the path), 1 = soft."""
    w = _clamp01(weight)
    # Geometric interp so the soft end has perceptible resolution.
    return _K_STIFF * ((_K_SOFT / _K_STIFF) ** w)


def _zeta_from_drift(drift):
    """Drift 0..1 -> damping ratio. 0 = critical (no overshoot, pure lag),
    1 = loose (pronounced swing-wide overshoot)."""
    d = _clamp01(drift)
    return _ZETA_CRIT + (_ZETA_MIN - _ZETA_CRIT) * d


def step(state, target_pos, up_world, dt, weight, drift, lean, substeps=2):
    """Advance the inertial body one frame.

    Args:
        state:      per-tag dict from make_state (mutated).
        target_pos: authored world position this frame (3-tuple).
        up_world:   world up axis (3-tuple), for resolving bank vs pitch.
        dt:         seconds per frame.
        weight:     0..1 — how heavy (positional drift width).
        drift:      0..1 — overshoot amount (swing wide past the corner).
        lean:       0..1 — banking-into-turns strength (additive lean).
        substeps:   integration substeps for stability at low fps.

    Returns a dict:
        {
          "pos":  3-tuple — drifted world position to place the body at.
          "fwd":  3-tuple — the DRIFTED world travel direction (unit), or None
                  when ~stationary. The tag aims the object's nose down this,
                  so body and nose share one physics world (the nose follows
                  the drift, not the rigid spline tangent).
          "bank": float — roll angle (radians) about the travel axis, from
                  lateral g-force (bank into turns). 0 when lean is off.
        }

    The tag builds the object's orientation from `fwd` + world up + `bank`
    (a level look-rotation), and applies Turn Ease as rotational lag on that
    heading via quaternion slerp (pole-safe).
    """
    if dt <= 0.0:
        p = state.get("pos") or tuple(target_pos)
        return {"pos": p, "fwd": None, "bank": 0.0}

    if state.get("pos") is None:
        reset_state(state, target_pos)
        state["prev_pos"] = tuple(target_pos)
        return {"pos": tuple(target_pos), "fwd": None, "bank": 0.0}

    # --- authored-path velocity + acceleration. -------------------------
    # Model: drift is driven by the path's ACCELERATION (curvature), not a
    # spring chasing a moving point. A simple spring-follow has steady-state
    # lag proportional to velocity, so it offsets even on a straight — wrong.
    # Instead the body's REST TARGET is the authored point pushed toward the
    # OUTSIDE of the corner by an amount proportional to path acceleration:
    #   - straight  (accel = 0) -> rest target == authored point -> dead-on.
    #   - corner    (accel != 0) -> rest target lags to the outside -> drift.
    # A spring eases the body toward that rest target, so the drift builds
    # and releases organically (overshoot on entry/exit) instead of snapping.
    prev_t = state["prev_target"]
    raw_tvel = _scale(_sub(target_pos, prev_t), 1.0 / dt)
    if not state.get("vel_primed"):
        # First frame with a real velocity reading: seed the smoothed
        # velocity to it so the launch-from-rest doesn't register as a giant
        # acceleration spike (which would drift the body sideways at the
        # very start of a moving straight). No accel this frame.
        state["target_vel_smooth"] = raw_tvel
        state["vel_primed"] = True
        path_accel = (0.0, 0.0, 0.0)
        new_sm = raw_tvel
    else:
        prev_sm = state["target_vel_smooth"]
        new_sm = _lerp(prev_sm, raw_tvel, 0.4)
        # Path acceleration = change in (smoothed) path velocity. The
        # cornering vector; magnitude scales with speed^2 / radius, so the
        # effect is automatically speed-reactive.
        path_accel = _scale(_sub(new_sm, prev_sm), 1.0 / dt)
        state["target_vel_smooth"] = new_sm
    state["prev_target"] = tuple(target_pos)

    # Drift offset TARGET: the body wants to slide to the OUTSIDE of a turn,
    # i.e. opposite the path acceleration, scaled by Weight. On a straight
    # path_accel == 0 so the offset target is 0 -> body exactly on the path.
    drift_gain = _DRIFT_OFFSET_GAIN * _clamp01(weight)
    off_target = (-path_accel[0] * drift_gain,
                  -path_accel[1] * drift_gain,
                  -path_accel[2] * drift_gain)

    # --- spring the OFFSET (not the absolute position). -----------------
    # Body = authored path point + a spring-smoothed offset. Because we
    # spring the OFFSET (whose target is 0 on straights, not a moving point),
    # there is NO follow-lag / phase error on straights: the offset simply
    # relaxes to 0 and the body sits on the path. Drift only appears when
    # off_target is nonzero (a corner), and the spring's damping ratio (the
    # Drift knob) governs how much it overshoots/settles. This is the clean
    # decomposition that the absolute-position spring couldn't achieve.
    k = _k_from_weight(weight)
    zeta = _zeta_from_drift(drift)
    c = 2.0 * zeta * sqrt(k)
    off = state["offset"]
    ovel = state["offset_vel"]
    sub_dt = dt / max(1, substeps)
    for _ in range(max(1, substeps)):
        ax = -k * (off[0] - off_target[0]) - c * ovel[0]
        ay = -k * (off[1] - off_target[1]) - c * ovel[1]
        az = -k * (off[2] - off_target[2]) - c * ovel[2]
        ovel = (ovel[0] + ax * sub_dt, ovel[1] + ay * sub_dt, ovel[2] + az * sub_dt)
        off = (off[0] + ovel[0] * sub_dt, off[1] + ovel[1] * sub_dt, off[2] + ovel[2] * sub_dt)
    state["offset"] = off
    state["offset_vel"] = ovel
    pos = _add(target_pos, off)
    state["pos"] = pos

    # --- body velocity (DRIFTED) — the object's actual travel direction. -
    # The orientation is built by the tag to AIM DOWN THIS, so the nose
    # follows where the body really goes (drift included), not the rigid
    # spline tangent — body and nose share one physics world. The drifted
    # velocity = d(pos)/dt. Smooth it lightly so the heading is stable, and
    # so the nose EASES into the drifted heading (rotational momentum) rather
    # than tracking the instantaneous velocity exactly.
    prev_pos = state.get("prev_pos")
    if prev_pos is not None:
        raw_body_vel = _scale(_sub(pos, prev_pos), 1.0 / dt)
    else:
        raw_body_vel = raw_tvel
    state["prev_pos"] = pos
    bsm = state.get("body_vel_smooth")
    body_vel = raw_body_vel if bsm is None else _lerp(bsm, raw_body_vel, 0.5)
    state["body_vel_smooth"] = body_vel

    # --- banking g (for roll into turns). -------------------------------
    # Lateral component of the path acceleration -> bank angle about the
    # travel axis. The tag applies it as a roll on the look-rotation, so it's
    # axis-agnostic at the math level (the tag knows the forward axis).
    state["lean_accel"] = _lerp(state["lean_accel"], path_accel, _LEAN_ALPHA)
    accel = state["lean_accel"]
    lean_k = _clamp01(lean)
    bank_angle = 0.0
    fwd = _normalize(body_vel)
    if fwd is not None and lean_k > 0.0:
        up = _normalize(up_world) or (0.0, 1.0, 0.0)
        right = _normalize(_cross(fwd, up))
        if right is not None:
            lateral = _dot(accel, right)
            bank_angle = _clamp(-lateral * _LEAN_GAIN * lean_k, -_LEAN_MAX, _LEAN_MAX)

    return {
        "pos": pos,            # drifted world position
        "fwd": fwd,            # drifted world travel direction (None if ~still)
        "bank": bank_angle,    # roll about the travel axis (radians)
    }
