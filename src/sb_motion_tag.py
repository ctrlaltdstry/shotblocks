"""The Shotblocks Motion tag.

A sibling of the camera rig tag (sb_rig_tag), but for ANY object. Applied
via C4D's standard tag path (right-click object -> Tags -> Shotblocks
Motion, or via the Tags menu).

It gives an animated object **inertial weight**: the object still follows
its animated path (keyframes, Align-to-Spline, constraints, Xpresso, or a
parent's motion), but carries momentum — it drifts WIDE on corners and
banks into them, like a heavy object with gravity. Tight on straights,
drift on corners, speed-reactive. Plus optional fBm noise.

This is NOT low-pass smoothing (that just makes motion watery and removes
intention). The weight model is in `sb_rig_inertia` — a pure engine that
takes the authored WORLD position each frame and returns a drifted world
position + a banking lean to ADD to the authored orientation. World space
is essential: the motion may come from a parent (Align-to-Spline on a
parent null) while the object's own local channels are static. We read the
authored world matrix, run the engine, and write a local transform back.

The lean is ADDED to the object's authored orientation (spline + any hand-
keyed rotation), so the user's animation is preserved — weight only layers
on top.

Execution priority: post-animation (TAG_EXPRESSION) — so we read the
evaluated authored world pose, and our write lands after the animation pass.

Write-back is LOCAL-CHANNEL ONLY (SetRelPos/SetRelRot). A probe (Phase 0,
see .agent/plans/motion-tag-object.md) proved SetMg corrupts pos/rot for an
object under a non-uniformly-scaled parent.
"""

import c4d
from c4d import utils

import sb_rig_inertia
import sb_rig_noise
from sb_rig_quat import (
    from_hpb as _quat_from_hpb,
    to_hpb as _quat_to_hpb,
    slerp as _quat_slerp,
)


def _look_world_matrix(fwd, bank):
    """Build a WORLD rotation matrix that aims the object's nose (-Z, the C4D
    front axis) down `fwd`, leveled to world Y-up, rolled by `bank` radians
    about the travel axis. Returns a c4d.Matrix (rotation only; off = 0).

    C4D convention: an object's local +Z is its BACK, -Z its front. So the
    matrix's z-column (v3, local +Z) points OPPOSITE travel (-fwd); y-column
    (v2, up) is world up re-orthogonalized; x-column (v1) = up x z. Built with
    c4d.Matrix from basis vectors (C4D's own convention) — no from_basis
    handedness guesswork.
    """
    f = fwd.GetNormalized()
    world_up = c4d.Vector(0.0, 1.0, 0.0)
    # If travel is near-vertical, world-up is degenerate; fall back to +Z up.
    if abs(f.y) > 0.999:
        world_up = c4d.Vector(0.0, 0.0, 1.0)
    z = -f                                  # local +Z = back = -travel
    x = world_up.Cross(z).GetNormalized()   # right
    y = z.Cross(x).GetNormalized()          # true up
    # Apply bank: roll x and y about the travel axis (f) via Rodrigues.
    if bank != 0.0:
        from math import cos, sin
        cosb, sinb = cos(bank), sin(bank)
        # rotate x and y about axis f
        def _rot(v):
            # Rodrigues: v*cos + (axis x v)*sin + axis*(axis.v)*(1-cos)
            axv = f.Cross(v)
            d = f.Dot(v)
            return c4d.Vector(
                v.x * cosb + axv.x * sinb + f.x * d * (1 - cosb),
                v.y * cosb + axv.y * sinb + f.y * d * (1 - cosb),
                v.z * cosb + axv.z * sinb + f.z * d * (1 - cosb))
        x = _rot(x)
        y = _rot(y)
    m = c4d.Matrix()
    m.v1, m.v2, m.v3 = x, y, z
    m.off = c4d.Vector(0.0)
    return m


# Parameter IDs (match res/description/tsbsmooth.h)
SBMOTION_ENABLED            = 1000
SBMOTION_INERTIA_ENABLED    = 1010
SBMOTION_WEIGHT             = 1011   # how heavy / how wide it drifts (0..1)
SBMOTION_DRIFT              = 1012   # overshoot / swing-wide amount (0..1)
SBMOTION_LEAN               = 1013   # banking-into-turns strength (0..1)
SBMOTION_TURN_EASE          = 1014   # rotational inertia: ease nose into turns (0..1)
SBMOTION_NOISE_ENABLED      = 1030
SBMOTION_NOISE_STRENGTH     = 1031   # Amount / intensity
SBMOTION_NOISE_SEED         = 1032
SBMOTION_NOISE_SPEED        = 1035   # fast vs slow
SBMOTION_NOISE_CONTRAST     = 1036   # smooth (low) vs spiky (high), 0..1
SBMOTION_SUBSTEP_THRESHOLD  = 1006
SBMOTION_RESET_ON_BOUNDARY  = 1008


_ZERO3 = (0.0, 0.0, 0.0)

# Object-space reference (cm) for converting the noise module's
# viewport-fraction POSITION output into world units. The camera tag scales
# these by FOV x target-distance, meaningless for a generic object. We treat
# noise position as a fraction of a fixed "typical object travel" scale, so
# Amount reads sensibly at common scene scales. Noise pos peaks are
# ~0.01-0.025, so Amount 1.0 gives ~100-250cm of peak shake; Amount runs
# 0..10 for big moves. The user dials magnitude via Amount.
_NOISE_POS_SCALE = 10000.0

# Sequential default-seed source so two Motion tags get different noise
# without the user setting a seed.
_NEXT_SEED = [1]


def _new_state():
    seed = _NEXT_SEED[0]
    _NEXT_SEED[0] = seed + 1
    return {
        "inertia": sb_rig_inertia.make_state(),
        "reset_pending": True,
        "seed": seed,
        "last_frame": None,
        # Turn Ease: the body's eased orientation as a quaternion (slerps
        # toward the authored orientation each frame). None until first use.
        "eased_quat": None,
        # last full-step output (local pos/rot), replayed on repeat Execute
        # calls within a frame so we don't advance the engine more than once.
        "last_local_pos": None,
        "last_local_rot": None,
    }


def _mat_to_hpb(m):
    try:
        v = utils.MatrixToHPB(m)
        return (v.x, v.y, v.z)
    except Exception:
        return (0.0, 0.0, 0.0)


def _turn_ease_fraction(turn_ease, dt):
    """Per-frame slerp fraction for Turn Ease (0..1). 0 -> 1.0 (snap to the
    authored heading, no easing). Higher -> smaller fraction (slower, heavier
    turn). Frame-rate-normalized via an exponential so the feel is consistent
    across fps. Critically eased (a fraction, never >1), so no overshoot."""
    te = max(0.0, min(1.0, float(turn_ease)))
    if te <= 0.0:
        return 1.0
    # Time constant: te 1.0 -> ~0.5s to close most of the gap; te small ->
    # near-instant. tau in seconds.
    tau = 0.04 + te * 0.5
    # fraction = 1 - exp(-dt/tau): the standard frame-rate-independent EMA.
    from math import exp
    return 1.0 - exp(-dt / tau)


def _sample_noise(tag, st, cur_frame, fps):
    """Sample fBm noise -> (pos_pre, rot_pre, pos_post, rot_post). Position
    converted to world units via a fixed object-space reference; rotation is
    radians. All-zeros when noise is off or Amount is 0."""
    if not bool(tag[SBMOTION_NOISE_ENABLED]):
        return _ZERO3, _ZERO3, _ZERO3, _ZERO3
    strength = float(tag[SBMOTION_NOISE_STRENGTH] or 0.0)
    if strength <= 0.0:
        return _ZERO3, _ZERO3, _ZERO3, _ZERO3
    seed = int(tag[SBMOTION_NOISE_SEED] or 0)
    if seed == 0:
        seed = st.get("seed") or 1
    speed = float(tag[SBMOTION_NOISE_SPEED] or 1.0)
    contrast = max(0.0, min(1.0, float(tag[SBMOTION_NOISE_CONTRAST] or 0.0)))
    gain_scale = 0.5 + contrast * 1.1
    sample = sb_rig_noise.sample_profile(
        sb_rig_noise.PROFILE_HANDHELD, cur_frame, fps, seed,
        speed=speed, gain_scale=gain_scale)
    s = _NOISE_POS_SCALE * strength
    pos_pre = (sample["pos_pre"][0] * s, sample["pos_pre"][1] * s, sample["pos_pre"][2] * s)
    pos_post = (sample["pos_post"][0] * s, sample["pos_post"][1] * s, sample["pos_post"][2] * s)
    rot_pre = (sample["rot_pre"][0] * strength, sample["rot_pre"][1] * strength, sample["rot_pre"][2] * strength)
    rot_post = (sample["rot_post"][0] * strength, sample["rot_post"][1] * strength, sample["rot_post"][2] * strength)
    return pos_pre, rot_pre, pos_post, rot_post


def _write_back_local(obj, world_pos, base_local_hpb,
                      write_pos, write_rot, noise_rot):
    """Place the object given a desired WORLD position + a base LOCAL HPB
    (the full target orientation, aim-down-travel + bank + Turn Ease) + a
    noise HPB delta. Writes the rel channels only (SetMg corrupts under a
    scaled parent — see plan).

    `world_pos` is the inertia-drifted world position (already includes any
    world-space position noise). `base_local_hpb` is the complete orientation
    the caller built from the look-rotation (or the authored orientation when
    rotation is owned only by noise); it may be None if rotation isn't owned.
    `noise_rot` is added on top.
    """
    parent = obj.GetUp()
    pm = parent.GetMg() if parent is not None else None

    if write_pos:
        if pm is not None:
            local = ~pm * c4d.Vector(world_pos[0], world_pos[1], world_pos[2])
        else:
            local = c4d.Vector(world_pos[0], world_pos[1], world_pos[2])
        obj.SetRelPos(local)

    if write_rot and base_local_hpb is not None:
        obj.SetRelRot(c4d.Vector(
            base_local_hpb[0] + noise_rot[0],
            base_local_hpb[1] + noise_rot[1],
            base_local_hpb[2] + noise_rot[2]))


class ShotblocksMotionTag(c4d.plugins.TagData):

    def __init__(self):
        super(ShotblocksMotionTag, self).__init__()
        self._rt = None

    def _state(self):
        if self._rt is None:
            self._rt = _new_state()
        return self._rt

    def Init(self, node, isCloneInit=False):
        if isCloneInit:
            return True
        node[SBMOTION_ENABLED]           = True
        node[SBMOTION_INERTIA_ENABLED]   = False   # off by default
        node[SBMOTION_WEIGHT]            = 0.5
        node[SBMOTION_DRIFT]             = 0.6
        node[SBMOTION_LEAN]              = 0.7
        node[SBMOTION_TURN_EASE]         = 0.0   # off by default (no rotational lag)
        node[SBMOTION_NOISE_ENABLED]     = False
        node[SBMOTION_NOISE_STRENGTH]    = 1.0
        node[SBMOTION_NOISE_SEED]        = 0
        node[SBMOTION_NOISE_SPEED]       = 1.0
        node[SBMOTION_NOISE_CONTRAST]    = 0.5
        node[SBMOTION_SUBSTEP_THRESHOLD] = 60.0
        node[SBMOTION_RESET_ON_BOUNDARY] = True
        return True

    def Free(self, node):
        self._rt = None

    def Execute(self, tag, doc, op, bt, priority, flags):
        try:
            return self._execute(tag, doc, op)
        except Exception as e:
            print("[Shotblocks Motion] Execute raised: {}".format(e))
            return c4d.EXECUTIONRESULT_OK

    def _execute(self, tag, doc, op):
        if not tag[SBMOTION_ENABLED]:
            return c4d.EXECUTIONRESULT_OK
        obj = tag.GetObject()
        if obj is None:
            return c4d.EXECUTIONRESULT_OK

        st = self._state()
        fps = doc.GetFps() or 24
        dt = 1.0 / max(1, fps)
        cur_frame = doc.GetTime().GetFrame(fps)

        inertia_on = bool(tag[SBMOTION_INERTIA_ENABLED])
        weight = float(tag[SBMOTION_WEIGHT] or 0.0)
        drift = float(tag[SBMOTION_DRIFT] or 0.0)
        lean = float(tag[SBMOTION_LEAN] or 0.0)
        turn_ease = float(tag[SBMOTION_TURN_EASE] or 0.0) if inertia_on else 0.0
        noise_on = (bool(tag[SBMOTION_NOISE_ENABLED])
                    and float(tag[SBMOTION_NOISE_STRENGTH] or 0.0) > 0.0)

        # Ownership: write position when inertia or noise is active; write
        # rotation when lean, turn-ease, or noise is active. Nothing active ->
        # pure pass-through (object fully navigable).
        owns_pos = inertia_on or noise_on
        owns_rot = (inertia_on and (lean > 0.0 or turn_ease > 0.0)) or noise_on
        if not owns_pos and not owns_rot:
            return c4d.EXECUTIONRESULT_OK

        # Boundary / backward-jump reset.
        last = st.get("last_frame")
        if last is None or cur_frame < last:
            st["reset_pending"] = True
        first_call_this_frame = (last is None or cur_frame != last)

        # Authored world matrix this frame (includes parent AtS / keys /
        # constraints — everything). GetMg is read at TAG_EXPRESSION time,
        # after the animation pass, so it's the authored pose, not our write.
        mg = obj.GetMg()
        world_pos = (mg.off.x, mg.off.y, mg.off.z)
        # Authored LOCAL matrix (for the rotation baseline). parent^-1 * world.
        parent = obj.GetUp()
        pm = parent.GetMg() if parent is not None else None
        authored_local_m = (~pm * mg) if pm is not None else mg

        # Repeat Execute within a frame: replay last output, don't re-advance
        # the engine (would double-step the momentum integrator).
        if not first_call_this_frame and not st["reset_pending"]:
            lp = st.get("last_local_pos")
            lr = st.get("last_local_rot")
            if lp is not None:
                obj.SetRelPos(c4d.Vector(lp[0], lp[1], lp[2]))
            if lr is not None and owns_rot:
                obj.SetRelRot(c4d.Vector(lr[0], lr[1], lr[2]))
            return c4d.EXECUTIONRESULT_OK

        npre_p, npre_r, npost_p, npost_r = _sample_noise(tag, st, cur_frame, fps)
        noise_pos = (npre_p[0] + npost_p[0], npre_p[1] + npost_p[1], npre_p[2] + npost_p[2])
        noise_rot = (npre_r[0] + npost_r[0], npre_r[1] + npost_r[1], npre_r[2] + npost_r[2])

        # Run the inertia engine: drifted world position + the DRIFTED travel
        # direction (fwd) + bank. The object's orientation is built to AIM
        # DOWN fwd (nose follows where the body actually goes — body and nose
        # in one physics world), leveled to world Y-up, banked into turns.
        # This OWNS the orientation (replaces the rigid spline-tangent aim);
        # there is no authored-rotation baseline to contaminate, so the
        # compounding-bank bug can't occur.
        inertia_state = st["inertia"]
        if st["reset_pending"] and bool(tag[SBMOTION_RESET_ON_BOUNDARY]):
            sb_rig_inertia.reset_state(inertia_state, world_pos)
            st["reset_pending"] = False
            drifted = world_pos
            fwd = None
            bank = 0.0
        else:
            st["reset_pending"] = False
            if inertia_on:
                result = sb_rig_inertia.step(
                    inertia_state, world_pos, (0.0, 1.0, 0.0), dt,
                    weight, drift, lean)
                drifted = result["pos"]
                fwd = result["fwd"]
                bank = result["bank"]
            else:
                drifted = world_pos
                fwd = None
                bank = 0.0

        # Build the target orientation (local HPB) from the look-rotation, and
        # apply Turn Ease as rotational lag (quaternion slerp) on the heading.
        base_local_hpb = None
        if owns_rot and inertia_on and fwd is not None:
            world_rot = _look_world_matrix(c4d.Vector(fwd[0], fwd[1], fwd[2]), bank)
            local_rot = (~pm * world_rot) if pm is not None else world_rot
            target_q = _quat_from_hpb(*_mat_to_hpb(local_rot))
            eased = st.get("eased_quat")
            if turn_ease > 0.0 and eased is not None:
                frac = _turn_ease_fraction(turn_ease, dt)
                eased = _quat_slerp(eased, target_q, frac)
            else:
                eased = target_q
            st["eased_quat"] = eased
            base_local_hpb = _quat_to_hpb(eased)
        elif owns_rot:
            # Rotation owned only by noise (inertia off / not moving): keep the
            # object's authored orientation and add noise on top.
            base_local_hpb = _mat_to_hpb(authored_local_m)
            st["eased_quat"] = _quat_from_hpb(*base_local_hpb)

        # Fold world-space position noise onto the drifted world position.
        final_world = (drifted[0] + noise_pos[0],
                       drifted[1] + noise_pos[1],
                       drifted[2] + noise_pos[2])

        _write_back_local(obj, final_world, base_local_hpb,
                          owns_pos, owns_rot, noise_rot)

        # Cache the local output for within-frame replay.
        rp = obj.GetRelPos()
        rr = obj.GetRelRot()
        st["last_local_pos"] = (rp.x, rp.y, rp.z)
        st["last_local_rot"] = (rr.x, rr.y, rr.z)
        st["last_frame"] = cur_frame
        return c4d.EXECUTIONRESULT_OK
