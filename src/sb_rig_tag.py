"""The Shotblocks tag.

Applied by the user to a camera via C4D's standard tag application
path (right-click camera -> Tags -> Shotblocks, or via the Tags menu).
The tag's per-frame `Execute` smooths the camera's pose with a
spring-damper. The user's camera stays at the scene root; the tag is
visible directly on the camera in the OM. No rig nulls, no
reparenting, no buried-tag problem.

Two modes:
- Additive: read the user's keyframed pose at frame N, run the
  spring against it, write the smoothed result back. The user's
  keyframes are never modified; disabling the tag immediately
  reveals the original animation.
- Replace (deferred to v11): driven by presets / look-at / etc.,
  none of which exist yet. The mode parameter is selectable in AM
  but the Execute path short-circuits with a one-line warning.

Execution priority: post-animation (TAG_EXPRESSION). In additive
mode that's required so we read the evaluated keyframe value.
"""

import c4d

from sb_rig_spring import (
    make_state, reset_to_target, step_channel,
    k_from_damping, critical_c,
)
from sb_rig_quat import (
    to_hpb, from_basis, slerp as quat_slerp,
)


# Tag parameter IDs (match res/description/tshotblocks.h)
SHOTBLOCKS_ENABLED              = 1000
SHOTBLOCKS_MODE                 = 1001
SHOTBLOCKS_MODE_ADDITIVE        = 0
SHOTBLOCKS_MODE_REPLACE         = 1
SHOTBLOCKS_DAMPING_POS          = 1002
SHOTBLOCKS_DAMPING_ROT          = 1003
SHOTBLOCKS_SUBSTEP_THRESHOLD    = 1006
SHOTBLOCKS_RESET_ON_BOUNDARY    = 1008
SHOTBLOCKS_LOOK_AT_TARGET       = 1020
SHOTBLOCKS_UP_TARGET            = 1021
SHOTBLOCKS_LOOK_AT_STRENGTH     = 1022


# Per-tag mutable state. Keyed by tag.GetUniqueIP() (a persistent
# C4D-side identifier that survives across the multiple Python
# wrappers C4D creates for the same BaseTag). NOT keyed by id(tag) —
# we tried that and discovered C4D produces a fresh Python wrapper
# for almost every Execute call, so id(tag) changes every time and
# every call would get a fresh state dict (no lag accumulation).
# The data is a dict:
#   {
#     "spring":         spring state (from sb_rig_spring.make_state)
#     "overrides":      per-shot overrides pushed in by the canvas at
#                       active-shot transitions. None means "no shot
#                       active / no overrides; use tag's persisted
#                       params."
#     "reset_pending":  bool — set by the canvas at shot-boundary
#                       transitions; consumed on the next Execute,
#                       which snaps the spring to target.
#   }
_RUNTIME = {}


# Container key used to stash a unique per-tag marker. Lives in the
# tag's BaseContainer, which DOES persist across the Python wrapper
# churn that C4D inflicts on Execute calls (we discovered the hard
# way that id(tag), GetUniqueIP() and similar all change every call).
_BCKEY_TAG_MARKER = 1010002

# Module-level counter for generating fresh markers.
_NEXT_MARKER = [1]


def _state_key(tag):
    """Return a stable identity for this tag that survives the
    Python-wrapper churn C4D inflicts on Execute calls. Stamps a
    monotonic integer into the tag's BaseContainer on first use; the
    BC value is what survives.
    """
    try:
        bc = tag.GetDataInstance()
        if bc is not None:
            marker = bc.GetInt32(_BCKEY_TAG_MARKER)
            if not marker:
                marker = _NEXT_MARKER[0]
                _NEXT_MARKER[0] += 1
                bc.SetInt32(_BCKEY_TAG_MARKER, marker)
            return ("bc", marker)
    except Exception:
        pass
    return ("pyid", id(tag))


def _state_for(tag):
    """Lazily allocate per-tag runtime state, keyed on the tag's
    persistent C4D identity (not its Python id)."""
    key = _state_key(tag)
    st = _RUNTIME.get(key)
    if st is None:
        st = {
            "spring": make_state(),
            "overrides": None,
            "reset_pending": True,    # first Execute snaps to target
        }
        _RUNTIME[key] = st
    return st


def request_reset(tag):
    """Public API: the canvas calls this at active-shot transitions
    (a hard cut between two shots) and on scrub jumps. The next
    Execute snaps the spring to its target with zero velocity."""
    if tag is None:
        return
    st = _state_for(tag)
    st["reset_pending"] = True


def push_overrides(tag, overrides):
    """Public API: the canvas calls this when the active shot changes,
    passing the shot's `rig_state` dict (or None for no overrides).
    Override keys (any subset):
      - damping_pos, damping_rot, damping_focal, damping_focus  (float)
      - mode_override: "additive" | "replace" | None
    """
    if tag is None:
        return
    st = _state_for(tag)
    st["overrides"] = overrides or None


def _read_damping(tag, st, key, override_key):
    """Resolve a damping parameter: shot override -> tag persisted."""
    ov = st.get("overrides")
    if ov is not None:
        v = ov.get(override_key)
        if v is not None:
            return float(v)
    return float(tag[key])


def _read_mode(tag, st):
    ov = st.get("overrides")
    if ov is not None:
        mo = ov.get("mode_override")
        if mo == "additive":
            return SHOTBLOCKS_MODE_ADDITIVE
        if mo == "replace":
            return SHOTBLOCKS_MODE_REPLACE
    return int(tag[SHOTBLOCKS_MODE])


def _camera_has_animation(cam):
    """True when the camera carries any animation tracks. Used by the
    mode-on-apply heuristic: animated → additive, fresh → replace.
    """
    if cam is None:
        return False
    return cam.GetFirstCTrack() is not None


class ShotblocksTag(c4d.plugins.TagData):

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def Init(self, node):
        node[SHOTBLOCKS_ENABLED]            = True
        node[SHOTBLOCKS_MODE]               = SHOTBLOCKS_MODE_ADDITIVE
        node[SHOTBLOCKS_DAMPING_POS]        = 0.5
        node[SHOTBLOCKS_DAMPING_ROT]        = 0.5
        node[SHOTBLOCKS_SUBSTEP_THRESHOLD]  = 60.0
        node[SHOTBLOCKS_RESET_ON_BOUNDARY]  = True
        node[SHOTBLOCKS_LOOK_AT_STRENGTH]   = 1.0
        # Target and Up Target start unset (BaseLinks default to None).
        return True

    def Message(self, node, type, data):
        try:
            if type == c4d.MSG_MENUPREPARE:
                # Fired when the tag is applied via the Tags menu.
                self._on_tag_applied(node)
            elif type == c4d.MSG_DESCRIPTION_POSTSETPARAMETER:
                desc_id = data.get("descid") if isinstance(data, dict) else None
                if desc_id is not None:
                    self._on_param_changed(node, desc_id[0].id)
        except Exception as e:
            print("[Shotblocks] Tag.Message raised: {}".format(e))
        return True

    def Free(self, node):
        try:
            _RUNTIME.pop(_state_key(node), None)
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Tag-applied / parameter-changed hooks
    # ------------------------------------------------------------------

    def _on_tag_applied(self, tag):
        cam = tag.GetObject()
        if cam is None:
            return
        # Mode heuristic: animated -> additive, fresh -> replace.
        if _camera_has_animation(cam):
            tag[SHOTBLOCKS_MODE] = SHOTBLOCKS_MODE_ADDITIVE
            print(
                "[Shotblocks] Tag added in ADDITIVE mode "
                "(camera has existing animation). "
                "Switch to REPLACE in the tag parameters when "
                "presets land in v11."
            )
        else:
            tag[SHOTBLOCKS_MODE] = SHOTBLOCKS_MODE_REPLACE

    def _on_param_changed(self, tag, param_id):
        if param_id == SHOTBLOCKS_MODE:
            # Mode flip: snap the spring on the next Execute so the
            # user doesn't see a wind-up artifact.
            st = _state_for(tag)
            st["reset_pending"] = True

    # ------------------------------------------------------------------
    # Per-frame execution
    # ------------------------------------------------------------------

    def Execute(self, tag, doc, op, bt, priority, flags):
        try:
            return self._execute(tag, doc, op)
        except Exception as e:
            print("[Shotblocks] Tag.Execute raised: {}".format(e))
            return c4d.EXECUTIONRESULT_OK

    def _execute(self, tag, doc, op):
        if not tag[SHOTBLOCKS_ENABLED]:
            return c4d.EXECUTIONRESULT_OK
        if op is None:
            return c4d.EXECUTIONRESULT_OK

        cam = tag.GetObject()
        if cam is None:
            return c4d.EXECUTIONRESULT_OK

        st = _state_for(tag)

        fps = doc.GetFps() or 24
        time = doc.GetTime()
        cur_frame = time.GetFrame(fps)

        # Substep threshold (clamped sane).
        threshold_fps = float(tag[SHOTBLOCKS_SUBSTEP_THRESHOLD])
        if threshold_fps < 1.0:
            threshold_fps = 30.0

        dt = 1.0 / max(1, fps)
        spring = st["spring"]

        # Boundary detection. Reset only on:
        # - first execute (last_frame is None)
        # - shot boundary (canvas called request_reset → reset_pending
        #   is already True)
        # - a *backward* frame jump (user scrubbed earlier in the
        #   timeline; the forward-history we accumulated is no longer
        #   relevant).
        last = spring.get("last_frame")
        if last is None or cur_frame < last:
            st["reset_pending"] = True

        # Per-frame idempotency. C4D calls Execute several times per
        # frame (different flag bits — animation pass, draw pass, etc.).
        # We must only step the spring ONCE per frame, otherwise:
        # (1) the spring integrates multiple sub-steps per frame and
        #     races ahead of the user's keyframes (no visible damping
        #     at all);
        # (2) subsequent calls re-read the camera's current pose,
        #     which is now the spring's smoothed value, not the
        #     keyframe → target snaps to the spring itself → it
        #     converges to whatever we just wrote and stops smoothing.
        # Resolve mode and look-at target. Replace mode without a
        # look-at target is idle — there's nothing driving the
        # camera, so we don't write anything and print a one-line
        # warning.
        mode = _read_mode(tag, st)
        look_at_target = tag[SHOTBLOCKS_LOOK_AT_TARGET]
        up_target      = tag[SHOTBLOCKS_UP_TARGET]

        # On repeat calls within the same frame, just re-apply the
        # cached output and return. The reset path runs once per
        # boundary; we don't repeat-apply on reset frames either.
        # When look-at is active, repeat calls re-issue the look-at
        # write fresh below (don't return early here), because AtS
        # may have re-run between our calls and we need to overwrite
        # again. The look-at write is cheap.
        already_stepped_this_frame = (
            last is not None and cur_frame == last
            and not st["reset_pending"]
        )
        if already_stepped_this_frame and look_at_target is None:
            _write_back(cam, spring)
            return c4d.EXECUTIONRESULT_OK
        if mode == SHOTBLOCKS_MODE_REPLACE and look_at_target is None:
            if not st.get("_replace_warned"):
                print(
                    "[Shotblocks] Replace mode with no Target set — "
                    "tag is idle. Set a Target object (or future "
                    "preset) to drive the camera."
                )
                st["_replace_warned"] = True
            spring["last_frame"] = cur_frame
            return c4d.EXECUTIONRESULT_OK
        st["_replace_warned"] = False

        # Position target: always from the camera's own keyframed
        # local pose. Look-at doesn't move the camera, only aims it.
        # Rotation target: starts as the keyframed rotation. If
        # look-at is active, we'll slerp/replace below.
        target_pos, key_rot = _read_keyframed_target(cam, doc, time, fps)
        target_rot = key_rot

        reset_on_boundary = bool(tag[SHOTBLOCKS_RESET_ON_BOUNDARY])
        if st["reset_pending"] and reset_on_boundary:
            # If look-at is active, compute the look-at local rot and
            # use it as the rotation target for reset, so the spring
            # state is primed correctly. The main pipeline below will
            # also call SetRelRot with the look-at rotation, but
            # priming the spring's rot state lets the look-at-OFF
            # transition feel right.
            if look_at_target is not None:
                la_rot = _compute_look_at_local_rot(
                    cam, look_at_target, up_target)
                if la_rot is not None:
                    strength = float(tag[SHOTBLOCKS_LOOK_AT_STRENGTH])
                    s = 1.0 if mode == SHOTBLOCKS_MODE_REPLACE else (
                        max(0.0, min(1.0, strength)))
                    if s >= 1.0:
                        target_rot = la_rot
                    elif s > 0.0:
                        target_rot = _slerp_hpb(key_rot, la_rot, s)
            reset_to_target(spring, target_pos, target_rot)
            st["reset_pending"] = False
            spring["last_frame"] = cur_frame
            _write_back(cam, spring)
            return c4d.EXECUTIONRESULT_OK
        if st["reset_pending"]:
            st["reset_pending"] = False

        # Springs run on both axes regardless of look-at. Look-at
        # only changes WHAT the rotation spring is chasing — the
        # spring smoothing itself still applies. This is what gives
        # the "whip pan with weight" feel: target moves fast, spring
        # lags toward the new aim.
        k_pos = k_from_damping(_read_damping(tag, st,
                                             SHOTBLOCKS_DAMPING_POS,
                                             "damping_pos"))
        k_rot = k_from_damping(_read_damping(tag, st,
                                             SHOTBLOCKS_DAMPING_ROT,
                                             "damping_rot"))
        c_pos = critical_c(k_pos)
        c_rot = critical_c(k_rot)

        # If look-at is active, replace target_rot with the look-at
        # rotation (possibly blended with the keyframed rotation per
        # the strength slider). The spring then chases THAT.
        if look_at_target is not None:
            la_local_rot = _compute_look_at_local_rot(
                cam, look_at_target, up_target)
            if la_local_rot is not None:
                strength = float(tag[SHOTBLOCKS_LOOK_AT_STRENGTH])
                if mode == SHOTBLOCKS_MODE_REPLACE:
                    s = 1.0
                else:
                    s = max(0.0, min(1.0, strength))
                if s >= 1.0:
                    target_rot = la_local_rot
                elif s > 0.0:
                    target_rot = _slerp_hpb(key_rot, la_local_rot, s)
                # s == 0: leave target_rot = key_rot (look-at off)

        # Position spring.
        pos, vel = spring["pos"]
        nx, nvx = step_channel(pos[0], vel[0], target_pos[0], dt,
                               k_pos, c_pos, threshold_fps)
        ny, nvy = step_channel(pos[1], vel[1], target_pos[1], dt,
                               k_pos, c_pos, threshold_fps)
        nz, nvz = step_channel(pos[2], vel[2], target_pos[2], dt,
                               k_pos, c_pos, threshold_fps)
        spring["pos"] = [(nx, ny, nz), (nvx, nvy, nvz)]

        # Unwrap rotation target so each HPB component is the
        # shortest-path delta from the spring's current value.
        # Without this, the spring chases a wraparound (e.g. -π to
        # +π is a full revolution to the spring, but visually
        # identical orientations).
        cur_rot = spring["rot"][0]
        target_rot = (
            _unwrap_angle(target_rot[0], cur_rot[0]),
            _unwrap_angle(target_rot[1], cur_rot[1]),
            _unwrap_angle(target_rot[2], cur_rot[2]),
        )

        # Rotation spring (HPB Euler, look-at OFF case)
        rot, rvel = spring["rot"]
        rhx, rhvx = step_channel(rot[0], rvel[0], target_rot[0], dt,
                                 k_rot, c_rot, threshold_fps)
        rhy, rhvy = step_channel(rot[1], rvel[1], target_rot[1], dt,
                                 k_rot, c_rot, threshold_fps)
        rhz, rhvz = step_channel(rot[2], rvel[2], target_rot[2], dt,
                                 k_rot, c_rot, threshold_fps)
        spring["rot"] = [(rhx, rhy, rhz), (rhvx, rhvy, rhvz)]

        spring["last_frame"] = cur_frame
        _write_back(cam, spring)
        return c4d.EXECUTIONRESULT_OK


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# C4D parameter IDs for the local-position and local-rotation channels.
# Used to identify animation tracks the user has placed on a camera.
_POS_X = c4d.DescID(c4d.DescLevel(c4d.ID_BASEOBJECT_REL_POSITION, c4d.DTYPE_VECTOR, 0),
                    c4d.DescLevel(c4d.VECTOR_X, c4d.DTYPE_REAL, 0))
_POS_Y = c4d.DescID(c4d.DescLevel(c4d.ID_BASEOBJECT_REL_POSITION, c4d.DTYPE_VECTOR, 0),
                    c4d.DescLevel(c4d.VECTOR_Y, c4d.DTYPE_REAL, 0))
_POS_Z = c4d.DescID(c4d.DescLevel(c4d.ID_BASEOBJECT_REL_POSITION, c4d.DTYPE_VECTOR, 0),
                    c4d.DescLevel(c4d.VECTOR_Z, c4d.DTYPE_REAL, 0))
_ROT_H = c4d.DescID(c4d.DescLevel(c4d.ID_BASEOBJECT_REL_ROTATION, c4d.DTYPE_VECTOR, 0),
                    c4d.DescLevel(c4d.VECTOR_X, c4d.DTYPE_REAL, 0))
_ROT_P = c4d.DescID(c4d.DescLevel(c4d.ID_BASEOBJECT_REL_ROTATION, c4d.DTYPE_VECTOR, 0),
                    c4d.DescLevel(c4d.VECTOR_Y, c4d.DTYPE_REAL, 0))
_ROT_B = c4d.DescID(c4d.DescLevel(c4d.ID_BASEOBJECT_REL_ROTATION, c4d.DTYPE_VECTOR, 0),
                    c4d.DescLevel(c4d.VECTOR_Z, c4d.DTYPE_REAL, 0))


def _read_keyframed_target(cam, doc, time, fps):
    """Read the camera's intended local pose at the current time.

    For each of the six transform channels (pos X/Y/Z, rot H/P/B):
    - If a CTrack exists for that channel, read its value at `time`
      (the user's keyframed value, unaffected by our previous writes).
    - Otherwise, fall back to a value derived from the camera's
      current *world* matrix, converted to local via the parent's
      inverse world matrix.

    The world-matrix fallback is what lets us track motion produced
    by Align-to-Spline, constraint tags, Xpresso, or any other system
    that writes the camera's world transform directly without going
    through the local rel channels. If we read `cam.GetRelPos()`
    directly, we'd read our own write from the previous frame
    instead of the new spline-driven position.

    Returns (pos_tuple, rot_tuple). Both are 3-tuples of floats.
    """
    # Fallback: compute local from world via parent's inverse.
    cam_mg = cam.GetMg()
    parent = cam.GetUp()
    if parent is not None:
        local_mg = ~parent.GetMg() * cam_mg
    else:
        local_mg = cam_mg
    px, py, pz = local_mg.off.x, local_mg.off.y, local_mg.off.z
    rot_v = _matrix_to_hpb_safe(local_mg)
    rx, ry, rz = rot_v[0], rot_v[1], rot_v[2]

    # Walk the camera's tracks and replace any value whose DescID
    # matches one of the six channels we care about. Tracks are
    # authoritative when present — they're the user's intent and
    # aren't polluted by our writes.
    track = cam.GetFirstCTrack()
    while track is not None:
        try:
            tid = track.GetDescriptionID()
            val = track.GetValue(doc, time, fps)
            if tid == _POS_X:
                px = val
            elif tid == _POS_Y:
                py = val
            elif tid == _POS_Z:
                pz = val
            elif tid == _ROT_H:
                rx = val
            elif tid == _ROT_P:
                ry = val
            elif tid == _ROT_B:
                rz = val
        except Exception:
            pass
        track = track.GetNext()
    return (px, py, pz), (rx, ry, rz)


def _matrix_to_hpb_safe(mg):
    """Decompose a C4D matrix to HPB radians. Uses c4d.utils.MatrixToHPB
    if available, otherwise extracts manually from the basis vectors.
    Returns a 3-tuple.
    """
    try:
        v = c4d.utils.MatrixToHPB(mg)
        return (v.x, v.y, v.z)
    except Exception:
        pass
    # Manual extraction: build a quaternion from the basis columns,
    # then convert via our quaternion helper.
    v1 = mg.v1  # +X axis
    v2 = mg.v2  # +Y axis
    v3 = mg.v3  # +Z axis
    q = from_basis(
        (v1.x, v1.y, v1.z),
        (v2.x, v2.y, v2.z),
        (v3.x, v3.y, v3.z),
    )
    return to_hpb(q)


def _compute_look_at_local_rot(cam, target_obj, up_obj):
    """Compute the local (relative-to-parent) HPB rotation that aims
    the camera's -Z axis at `target_obj`.

    This mirrors the Maxon SDK lookatcamera.cpp pattern exactly:
        local_dir = (~(cam.GetUpMg() * cam.GetFrozenMln()))
                    * target.GetMg().off - cam.GetRelPos()
        hpb = c4d.utils.VectorToHPB(local_dir)
        hpb.z = cam.GetRelRot().z   # preserve bank

    `up_obj` is currently ignored — the SDK example doesn't use a
    secondary target either. World +Y is implicit in VectorToHPB
    (which assumes Y-up). Up-target support can be added later as a
    bank computation on top of this base aim.
    """
    if target_obj is None:
        return None
    up_mg = cam.GetUpMg()
    frozen_mln = cam.GetFrozenMln()
    parent_frozen = up_mg * frozen_mln
    try:
        local_dir = (~parent_frozen) * target_obj.GetMg().off - cam.GetRelPos()
    except Exception:
        # Defensive: very rare edge case where parent matrix isn't
        # invertible. Fall back to world-only aim.
        return None
    try:
        hpb = c4d.utils.VectorToHPB(local_dir)
    except Exception:
        return None
    # Preserve the camera's current bank (matches SDK behavior).
    cur_rot = cam.GetRelRot()
    return (hpb.x, hpb.y, cur_rot.z)


def _unwrap_angle(target, reference):
    """Return `target` shifted by ±2π so it's within π of `reference`.

    Used to ensure the rotation spring chases the shortest angular
    path. HPB Euler is cyclic, and a naive spring will treat a
    target of -3.0 and a current of +3.0 as 6.0 apart when they're
    really 0.28 apart the other way around. Adjusting the target
    here fixes that without touching the spring math.
    """
    from math import pi
    while target - reference > pi:
        target -= 2.0 * pi
    while reference - target > pi:
        target += 2.0 * pi
    return target


def _slerp_hpb(a, b, t):
    """Slerp between two HPB rotations via quaternion. Returns
    (h, p, b) tuple."""
    from sb_rig_quat import from_hpb as _from_hpb
    if t <= 0.0:
        return a
    if t >= 1.0:
        return b
    q_a = _from_hpb(*a)
    q_b = _from_hpb(*b)
    return to_hpb(quat_slerp(q_a, q_b, t))




def _write_back(cam, spring):
    """Write the smoothed pose back to the camera.

    Writes BOTH the local channels (SetRelPos/SetRelRot) AND the
    world matrix (SetMg). The redundancy is intentional: C4D's
    animation system may overwrite local-channel writes after we
    return, but SetMg bypasses that — it sets the visible world
    transform for this frame regardless of what's on the local
    channels. Whichever path "wins" in C4D's evaluation order, the
    smoothed value ends up at the camera.
    """
    pos, _ = spring["pos"]
    rot, _ = spring["rot"]
    cam.SetRelPos(c4d.Vector(pos[0], pos[1], pos[2]))
    cam.SetRelRot(c4d.Vector(rot[0], rot[1], rot[2]))

    # Build the local matrix from the smoothed pos+rot via HPB, then
    # promote to world by post-multiplying by the parent's world Mg.
    # For an unparented camera, parent_mg is identity and the local
    # matrix IS the world matrix.
    try:
        local_mg = c4d.utils.HPBToMatrix(c4d.Vector(rot[0], rot[1], rot[2]))
        local_mg.off = c4d.Vector(pos[0], pos[1], pos[2])
        parent = cam.GetUp()
        if parent is not None:
            cam.SetMg(parent.GetMg() * local_mg)
        else:
            cam.SetMg(local_mg)
    except Exception as e:
        # If HPBToMatrix isn't available in this SDK build, the
        # SetRelPos/SetRelRot path above is still in effect.
        print("[Shotblocks] _write_back HPBToMatrix failed: {}".format(e))
