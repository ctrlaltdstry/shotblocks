"""The Shotblocks tag.

Applied by the user to a camera via C4D's standard tag application
path (right-click camera -> Tags -> Shotblocks, or via the Tags menu).
The tag's per-frame `Execute` smooths the camera's pose with a
spring-damper. The user's camera stays at the scene root; the tag is
visible directly on the camera in the OM. No rig nulls, no
reparenting, no buried-tag problem.

The rig is **additive**: it reads the user's keyframed pose at
frame N, runs the spring against it, and writes the smoothed
result back. The user's keyframes are never modified; disabling
the tag immediately reveals the original animation. (A "replace"
mode driven by presets was once stubbed in the AM but never built;
it was removed — the rig is additive-only.)

Execution priority: post-animation (TAG_EXPRESSION) — required so
we read the evaluated keyframe value.
"""

import c4d

from sb_rig_spring import (
    make_state, reset_to_target, step_channel,
    k_from_damping, critical_c,
)
from sb_rig_quat import (
    to_hpb, from_basis, slerp as quat_slerp,
)
import sb_rig_noise
import sb_rig_zoom
import sb_rig_follow


# Tag parameter IDs (match res/description/tshotblocks.h)
SHOTBLOCKS_ENABLED              = 1000
# 1001 was SHOTBLOCKS_MODE (additive/replace). Replace was never built;
# the rig is additive-only. ID retired, not reused.
SHOTBLOCKS_DAMPING_POS          = 1002
SHOTBLOCKS_DAMPING_ROT          = 1003
# Master damping on/off. OFF (default) = no spring smoothing anywhere;
# the tag applies targets instantly and only writes the channels it
# owns, so the camera stays fully interactive in the viewport. ON =
# the spring runs (one step per frame) and adds weighted/laggy motion.
SHOTBLOCKS_DAMPING_ENABLED      = 1004
SHOTBLOCKS_SUBSTEP_THRESHOLD    = 1006
SHOTBLOCKS_RESET_ON_BOUNDARY    = 1008
SHOTBLOCKS_LOOK_AT_TARGET       = 1020
SHOTBLOCKS_UP_TARGET            = 1021
SHOTBLOCKS_LOOK_AT_STRENGTH     = 1022
SHOTBLOCKS_LOOK_AT_ROLL         = 1023  # bank offset in radians (param is degrees in .res; C4D converts)
SHOTBLOCKS_BANK_INTO_TURNS      = 1024
SHOTBLOCKS_NOISE_ENABLED        = 1030  # bool; was a profile cycle, now just on/off (single Handheld profile)
SHOTBLOCKS_NOISE_STRENGTH       = 1031
SHOTBLOCKS_NOISE_SEED           = 1032
SHOTBLOCKS_NOISE_WALKING        = 1033
SHOTBLOCKS_NOISE_STEP_RATE      = 1034
SHOTBLOCKS_NOISE_SPEED          = 1035
SHOTBLOCKS_ZOOM_ENABLED         = 1040
SHOTBLOCKS_ZOOM_RATE            = 1041
SHOTBLOCKS_ZOOM_STRENGTH        = 1042
SHOTBLOCKS_ZOOM_HOLD            = 1043
SHOTBLOCKS_ZOOM_RAMP_IN         = 1044
SHOTBLOCKS_ZOOM_RAMP_OUT        = 1045
SHOTBLOCKS_ZOOM_RETURN          = 1046
# Chase / Follow-Target. Chase drives the camera BODY (position only);
# aim stays on the look-at + angular spring. The pursuit math lives in
# sb_rig_follow (pure functions, no c4d), so the v2 Targeting "Chase"
# pill can reuse the same engine. See .agent/plans/rig-chase-follow.md.
SHOTBLOCKS_FOLLOW_ENABLED       = 1050
SHOTBLOCKS_FOLLOW_TARGET        = 1051
SHOTBLOCKS_FOLLOW_DISTANCE      = 1052
SHOTBLOCKS_FOLLOW_VEL_SMOOTH    = 1053
SHOTBLOCKS_FOLLOW_REORIENT      = 1054
SHOTBLOCKS_FOLLOW_HEIGHT_BIAS   = 1055
SHOTBLOCKS_FOLLOW_SIDE_BIAS     = 1056
# Aim Tracking: when Chase is on, lets the AIM (rotation) spring respond
# faster than the body's Angular damping. 0% = aim uses Angular as-is
# (smooth, laggy); 100% = aim snaps to keep the subject framed even when
# the body is heavily smoothed. Decouples "smooth body" from "locked aim".
SHOTBLOCKS_FOLLOW_AIM_TRACK     = 1057
# Aim Lead: aim AHEAD of the subject along its travel (anticipation), so a
# fast subject doesn't ride the trailing edge of frame. LEAD_DIST is how
# far ahead at full speed (scene units); AIM_LEAD is a 0..1 blend from
# aiming dead-on the subject (0) to fully at the lead point (1).
SHOTBLOCKS_FOLLOW_LEAD_DIST     = 1058
SHOTBLOCKS_FOLLOW_AIM_LEAD      = 1059
SHOTBLOCKS_GRP_FRAMING          = 1103  # group host in tshotblocks.res for the UD-injected Frame Offset

# Fallback distance (cm) for converting viewport-fraction noise into
# world units when no look-at target gives us a natural reference.
# ~1000cm = "typical interior scene." If users routinely work at
# very different scales, expose an override; for now this just
# bounds the noise magnitude to something sensible scene-to-scene.
_NOISE_FALLBACK_DISTANCE = 1000.0

# Yaw rate at which Bank-Into-Turns produces full Roll. Calibrated
# so a "moderately fast curve" (about 6° heading change per frame at
# 24fps = 0.1 rad/frame) produces the Roll slider's full bank.
# Tunable — increase to make banking subtler, decrease to make it
# more aggressive.
_BANK_FULL_YAW_RATE = 0.1

# Frame Offset is NOT a .res-defined parameter — C4D's resource-file
# compiler doesn't recognise CUSTOMGUI_VECTOR2D as a keyword (the
# constant exists in Python but isn't accepted in .res syntax, and
# we verified that adding it empties the AM). Instead we add it as
# a UserData slot on the tag at tag-apply time, configured with
# DESC_CUSTOMGUI = CUSTOMGUI_VECTOR2D — the exact widget the User
# Data dialog labels "2D Vector Field." The slot's DescID's index
# is stored in the tag's BaseContainer so we can find it back
# deterministically across reloads.
_BCKEY_FRAME_OFFSET_UD_IDX = 1010003


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
            "prev_heading": None,     # for Bank-Into-Turns yaw rate
            "zoom_schedule": sb_rig_zoom.make_schedule_state(),
            "zoom_focal_baseline": None,
            "follow": sb_rig_follow.make_state(),
            "follow_lead_world": None,   # world aim-lead point, set per-frame
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


def _frame_offset_descid(tag):
    """Return the DescID of the tag's Frame Offset UserData slot,
    or None if it hasn't been added yet. The slot's index is stored
    in the tag's BaseContainer at tag-apply time."""
    try:
        bc = tag.GetDataInstance()
        if bc is None:
            return None
        idx = bc.GetInt32(_BCKEY_FRAME_OFFSET_UD_IDX)
        if idx <= 0:
            return None
        return c4d.DescID(
            c4d.DescLevel(c4d.ID_USERDATA, c4d.DTYPE_SUBCONTAINER, 0),
            c4d.DescLevel(idx, c4d.DTYPE_VECTOR, 0),
        )
    except Exception:
        return None


def _frame_offset_parent_group_descid():
    """The DescID of the Framing group host we declared in
    tshotblocks.res. Reparenting the UD slot into this group keeps
    the joystick inside the main tag interface (instead of in a
    separate User Data tab)."""
    # GROUP IDs from a .res live as single-level DescIDs.
    return c4d.DescID(c4d.DescLevel(SHOTBLOCKS_GRP_FRAMING, c4d.DTYPE_GROUP, 0))


def _frame_offset_ud_container():
    """Build the UserData descriptor BC for the Frame Offset slot.
    Shared by add-new and refresh-existing paths so they can't drift."""
    bc = c4d.GetCustomDataTypeDefault(c4d.DTYPE_VECTOR)
    bc[c4d.DESC_NAME]       = "Frame Offset"
    bc[c4d.DESC_SHORT_NAME] = "Frame Offset"
    bc[c4d.DESC_CUSTOMGUI]  = c4d.CUSTOMGUI_VECTOR2D
    bc[c4d.DESC_ANIMATE]    = c4d.DESC_ANIMATE_ON
    bc[c4d.DESC_DEFAULT]    = c4d.Vector(0.0, 0.0, 0.0)
    # Reparent under our Framing group (declared in tshotblocks.res
    # as an empty group host) so the joystick renders inside the
    # main tag interface, not in a separate "User Data" tab.
    bc[c4d.DESC_PARENTGROUP] = _frame_offset_parent_group_descid()
    # Values are screen-space fractions (0.167 = a rule-of-thirds
    # line, 0.5 = the edge of the frame). Display as percent and
    # step in small increments — without these, the joystick
    # treats each pixel of drag as ~millions of units.
    bc[c4d.DESC_UNIT]       = c4d.DESC_UNIT_PERCENT
    bc[c4d.DESC_STEP]       = 0.001
    # Hard clamp at ±300% = up to three viewports off either edge. The
    # extra range past ±100% (target at frame edge) lets the user
    # keyframe a pan that brings the target from well off-screen to
    # on-screen — animate the offset and the aim swings the subject into
    # frame. The joystick drag-area maps to MIN..MAX, so the everyday
    # ±100% framing range occupies the center third of the pad (coarser
    # drag is the accepted trade for the pan capability); type or
    # keyframe values for the extreme end. Hard clamp (not MINSLIDER/
    # MAXSLIDER soft) because the soft-only path produced a half-working
    # widget in C4D 2026 — empty dragbox, no scrub.
    bc[c4d.DESC_MIN]        = c4d.Vector(-3.0, -3.0, 0.0)
    bc[c4d.DESC_MAX]        = c4d.Vector( 3.0,  3.0, 0.0)
    return bc


def _ensure_frame_offset_userdata(tag):
    """Add the Frame Offset UserData slot to `tag` if missing, or
    refresh its descriptor (unit, step, custom GUI) if it already
    exists. The refresh path lets us roll out sensitivity / display
    changes to tags created by earlier plugin versions without
    forcing the user to delete and re-add the tag.

    Stashes the slot's index in the tag's BaseContainer so reads can
    rebuild the DescID deterministically.
    """
    if tag is None:
        return
    try:
        desc_id = _frame_offset_descid(tag)
        bc = _frame_offset_ud_container()
        if desc_id is not None:
            # Refresh the existing slot's descriptor (preserves the
            # stored value). SetUserDataContainer is the per-slot
            # update; it does not move the slot or change its index.
            try:
                tag.SetUserDataContainer(desc_id, bc)
            except Exception as e:
                print("[Shotblocks] Failed to refresh Frame Offset UD: {}".format(e))
            return
        desc_id = tag.AddUserData(bc)
        if desc_id is None:
            print("[Shotblocks] AddUserData returned None for Frame Offset")
            return
        # Persist the slot's index so future reads can rebuild the
        # DescID. UserData DescIDs are 2-level; the second level's
        # id is the per-tag slot index.
        idx = desc_id[1].id
        tag_bc = tag.GetDataInstance()
        if tag_bc is not None:
            tag_bc.SetInt32(_BCKEY_FRAME_OFFSET_UD_IDX, idx)
        tag[desc_id] = c4d.Vector(0.0, 0.0, 0.0)
    except Exception as e:
        print("[Shotblocks] Failed to add Frame Offset UserData: {}".format(e))


def _read_frame_offset(tag):
    """Return (offset_u, offset_v) from the tag's Frame Offset
    UserData slot. Falls back to (0, 0) if the slot isn't present
    (e.g. tag loaded from an older save before user-data was added).

    The joystick convention is "drag the dot to where you want the
    *subject* to appear in the frame." The vertical axis is inverted
    from the raw slot value to match that intent; the horizontal axis
    is NOT — passing v.x straight through is what makes "drag right ->
    subject sits right." (Previously both axes were negated, which
    compounded with the subtraction in _apply_frame_offset to flip the
    horizontal feel: dragging the dot right pushed the subject left.)
    """
    desc_id = _frame_offset_descid(tag)
    if desc_id is None:
        return 0.0, 0.0
    try:
        v = tag[desc_id]
    except Exception:
        return 0.0, 0.0
    if v is None:
        return 0.0, 0.0
    return float(v.x), -float(v.y)


def _cam_has_pos_rot_tracks(cam):
    """Return (has_pos_track, has_rot_track): whether the camera has any
    keyframed position / rotation channel. Used so a damping-only tag
    still owns (and therefore smooths) a channel the user has ANIMATED —
    those keyframes are a moving target the spring should ease. Walks the
    CTracks once and matches the six rel-pos/rel-rot DescIDs."""
    has_pos = False
    has_rot = False
    if cam is None:
        return False, False
    track = cam.GetFirstCTrack()
    while track is not None:
        try:
            tid = track.GetDescriptionID()
            if tid == _POS_X or tid == _POS_Y or tid == _POS_Z:
                has_pos = True
            elif tid == _ROT_H or tid == _ROT_P or tid == _ROT_B:
                has_rot = True
        except Exception:
            pass
        if has_pos and has_rot:
            break
        track = track.GetNext()
    return has_pos, has_rot


def _channel_ownership(tag, cam=None):
    """Decide which transform channels the tag actually drives this
    frame, given its parameters. A channel the tag does NOT own is left
    untouched so the user can navigate / keyframe it freely.

    Returns (owns_pos, owns_rot) bools.

    - Rotation is owned when look-at aims the camera (strength > 0 and a
      target is set), or Roll is non-zero, or Bank-Into-Turns is on, or
      Handheld Noise is on (it shakes rotation).
    - Position is owned when Chase drives the body, or Handheld Noise is
      on (it shakes position).
    - With Damping ENABLED, a channel is ALSO owned when the camera has
      keyframes on it: those keyframes are a moving target the spring
      should smooth. Without this, a purely-keyframed camera with damping
      on owned nothing, so the spring ran but its output was discarded and
      the motion stayed hard (the user-reported bug). A PARKED camera with
      damping on and no keys still owns nothing — there's nothing to
      smooth, so the viewport stays free.

    Damping alone (no keys, nothing else active) is still NOT a reason to
    own a channel — it only changes HOW an owned channel is written
    (spring vs instant), not WHETHER, so an un-animated camera stays
    pass-through and navigable.
    """
    look_at_target = tag[SHOTBLOCKS_LOOK_AT_TARGET]
    look_at_on = (look_at_target is not None
                  and float(tag[SHOTBLOCKS_LOOK_AT_STRENGTH] or 0.0) > 0.0)
    roll_on = float(tag[SHOTBLOCKS_LOOK_AT_ROLL] or 0.0) != 0.0
    bank_on = bool(tag[SHOTBLOCKS_BANK_INTO_TURNS])
    noise_on = (bool(tag[SHOTBLOCKS_NOISE_ENABLED])
                and float(tag[SHOTBLOCKS_NOISE_STRENGTH] or 0.0) > 0.0)
    chase_on = (bool(tag[SHOTBLOCKS_FOLLOW_ENABLED])
                and tag[SHOTBLOCKS_FOLLOW_TARGET] is not None)
    # Frame Offset rotates the camera (re-frames via look-at when a target
    # is set, or a rotational pan on the keyframed rotation when it isn't).
    # Either way a non-zero offset drives rotation, so it must own that
    # channel — otherwise the offset write is discarded (same class of bug
    # as damping owning nothing). Zero offset owns nothing → pass-through.
    fou, fov = _read_frame_offset(tag)
    frame_offset_on = (fou != 0.0 or fov != 0.0)

    owns_rot = look_at_on or roll_on or bank_on or noise_on or frame_offset_on
    owns_pos = chase_on or noise_on

    # Damping smooths animated channels: own any channel the user has
    # keyframed so the spring's eased output actually reaches the camera.
    if bool(tag[SHOTBLOCKS_DAMPING_ENABLED]):
        has_pos_key, has_rot_key = _cam_has_pos_rot_tracks(cam)
        owns_pos = owns_pos or has_pos_key
        owns_rot = owns_rot or has_rot_key

    return owns_pos, owns_rot


class ShotblocksTag(c4d.plugins.TagData):

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def Init(self, node):
        node[SHOTBLOCKS_ENABLED]            = True
        # Damping master switch defaults OFF — a freshly applied tag is
        # fully interactive (no spring fighting viewport navigation). The
        # user turns it on when they want smoothing.
        node[SHOTBLOCKS_DAMPING_ENABLED]    = False
        # Damping is a 0..1 fraction stored behind a PERCENT slider
        # (0..100% display). Default 0% = stiff, tracks keyframes 1:1;
        # higher % = more smoothing/lag. Linear = position, Angular = rotation.
        node[SHOTBLOCKS_DAMPING_POS]        = 0.0
        node[SHOTBLOCKS_DAMPING_ROT]        = 0.0
        node[SHOTBLOCKS_SUBSTEP_THRESHOLD]  = 60.0
        node[SHOTBLOCKS_RESET_ON_BOUNDARY]  = True
        node[SHOTBLOCKS_LOOK_AT_STRENGTH]   = 1.0
        node[SHOTBLOCKS_LOOK_AT_ROLL]       = 0.0
        node[SHOTBLOCKS_BANK_INTO_TURNS]    = False
        node[SHOTBLOCKS_NOISE_ENABLED]      = False
        node[SHOTBLOCKS_NOISE_STRENGTH]     = 0.5
        node[SHOTBLOCKS_NOISE_SEED]         = 0
        node[SHOTBLOCKS_NOISE_WALKING]      = False
        node[SHOTBLOCKS_NOISE_STEP_RATE]    = 1.8
        node[SHOTBLOCKS_NOISE_SPEED]        = 1.0
        node[SHOTBLOCKS_ZOOM_ENABLED]       = False
        node[SHOTBLOCKS_ZOOM_RATE]          = 0.2
        node[SHOTBLOCKS_ZOOM_STRENGTH]      = 1.5
        node[SHOTBLOCKS_ZOOM_HOLD]          = 1.0
        node[SHOTBLOCKS_ZOOM_RAMP_IN]       = 0.25
        node[SHOTBLOCKS_ZOOM_RAMP_OUT]      = 0.6
        node[SHOTBLOCKS_ZOOM_RETURN]        = 0.7
        node[SHOTBLOCKS_FOLLOW_ENABLED]     = False
        node[SHOTBLOCKS_FOLLOW_DISTANCE]    = 300.0
        node[SHOTBLOCKS_FOLLOW_VEL_SMOOTH]  = 0.5
        node[SHOTBLOCKS_FOLLOW_REORIENT]    = 0.5
        node[SHOTBLOCKS_FOLLOW_HEIGHT_BIAS] = 50.0
        node[SHOTBLOCKS_FOLLOW_SIDE_BIAS]   = 0.0
        node[SHOTBLOCKS_FOLLOW_AIM_TRACK]   = 0.7   # aim tracks tighter than body by default
        node[SHOTBLOCKS_FOLLOW_LEAD_DIST]   = 0.0   # lead off until dialed in
        node[SHOTBLOCKS_FOLLOW_AIM_LEAD]    = 0.0
        # Follow Target starts unset (BaseLink defaults to None).
        # Target and Up Target start unset (BaseLinks default to None).
        # Frame Offset is a UserData slot — added in _on_tag_applied
        # (Init is called for fresh tags before they're attached to
        # an object, and AddUserData is safer once the tag is on a
        # node). _ensure_frame_offset_userdata is also called
        # defensively in Execute so old/loaded tags get fixed up.
        return True

    def Message(self, node, type, data):
        try:
            if type == c4d.MSG_MENUPREPARE:
                # Fired when the tag is applied via the Tags menu.
                self._on_tag_applied(node)
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
        # Add the Frame Offset UserData slot (2D Vector Field).
        _ensure_frame_offset_userdata(tag)

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
        # Re-entry guard: during the reset-time ExecutePasses below
        # we deliberately short-circuit so C4D's animation pass can
        # restore the camera's authored pose without us writing back
        # on top of it.
        if getattr(ShotblocksTag, "_in_reset_eval", False):
            return c4d.EXECUTIONRESULT_OK

        cam = tag.GetObject()
        if cam is None:
            return c4d.EXECUTIONRESULT_OK

        # Backstop: tag-apply is supposed to add the Frame Offset
        # UserData slot, but a tag loaded from a scene saved before
        # the UD slot existed will be missing it. Add it on first
        # Execute (no-op if already present).
        _ensure_frame_offset_userdata(tag)

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
        look_at_target = tag[SHOTBLOCKS_LOOK_AT_TARGET]
        up_target      = tag[SHOTBLOCKS_UP_TARGET]

        owns_pos, owns_rot = _channel_ownership(tag, cam)
        bank_into_turns = bool(tag[SHOTBLOCKS_BANK_INTO_TURNS])

        # ---- Damping OFF: instant, fully-interactive path. -----------
        # No spring, no per-frame idempotency guard, no boundary reset
        # machinery — none of that is needed without smoothing. We solve
        # the target pose live every Execute (so look-at / frame offset
        # track the target even while parked, like the native Target tag)
        # and write ONLY the channels the tag owns, leaving the rest for
        # the user to navigate. If the tag owns nothing, it writes
        # nothing — pure pass-through, camera fully free.
        if not bool(tag[SHOTBLOCKS_DAMPING_ENABLED]):
            if not owns_pos and not owns_rot:
                _apply_quick_zoom(tag, st, cam, doc, time, fps)
                return c4d.EXECUTIONRESULT_OK
            tp, tr, heading, npost_pos, npost_rot = _compute_target_pose(
                tag, st, cam, doc, time, fps, dt, cur_frame,
                look_at_target, up_target,
                is_reset=False, bank_into_turns=bank_into_turns)
            st["prev_heading"] = heading
            final_pos = (tp[0] + npost_pos[0], tp[1] + npost_pos[1],
                         tp[2] + npost_pos[2])
            final_rot = (tr[0] + npost_rot[0], tr[1] + npost_rot[1],
                         tr[2] + npost_rot[2])
            # Keep the spring primed at the instant pose so flipping
            # damping ON mid-session doesn't jolt — it starts settled.
            reset_to_target(spring, final_pos, final_rot)
            spring["last_frame"] = cur_frame
            st["reset_pending"] = True   # re-prime if damping is turned on
            st["last_output_pos"] = final_pos
            st["last_output_rot"] = final_rot
            _write_back(cam, final_pos, final_rot,
                        write_pos=owns_pos, write_rot=owns_rot)
            _apply_quick_zoom(tag, st, cam, doc, time, fps)
            return c4d.EXECUTIONRESULT_OK

        # On repeat calls within the same frame, just re-apply the
        # cached output and return. The reset path runs once per
        # boundary; we don't repeat-apply on reset frames either.
        # Re-applying the spring's stored pose is cheap (two
        # SetRel*/SetMg calls); doing the full spring integration
        # again would (1) over-step the integrator and erase the
        # visible damping, (2) make playback heavy enough to stutter
        # the C4D viewport. The earlier version only short-circuited
        # when look-at was off because we worried about Align-to-Spline
        # re-writing the rotation between Execute calls — but
        # re-running the look-at math ALSO re-steps the spring, which
        # is the bigger problem. AtS interplay still works because
        # _write_back issues a fresh SetRelRot from the cached
        # spring pose.
        already_stepped_this_frame = (
            last is not None and cur_frame == last
            and not st["reset_pending"]
        )
        if already_stepped_this_frame:
            # Replay the spring's frozen output for POSITION (we must not
            # re-step the integrator — that erases the damping). But the
            # look-at AIM is a live geometric solve, not spring output:
            # while parked, C4D fires Execute several times per frame and
            # only the FIRST took the full path. If we replayed the cached
            # rotation, the aim would freeze and the camera would stop
            # tracking the target (and stop honoring a dragged Frame
            # Offset) while stopped. The native Target tag stays live, so
            # we re-solve the aim here — without touching the spring.
            cached_pos = st.get("last_output_pos")
            cached_rot = st.get("last_output_rot")
            if cached_pos is None or cached_rot is None:
                pos, _ = spring["pos"]
                rot, _ = spring["rot"]
                cached_pos = cached_pos or pos
                cached_rot = cached_rot or rot

            live_rot = cached_rot
            if owns_rot and look_at_target is not None:
                ou, ov = _read_frame_offset(tag)
                aim_pt = _chase_aim_point_world(tag, st, look_at_target)
                la_hpb = _compute_look_at_local_rot(
                    cam, look_at_target, up_target,
                    offset_u=ou, offset_v=ov, doc=doc,
                    aim_point_world=aim_pt)
                if la_hpb is not None:
                    s = max(0.0, min(1.0, float(tag[SHOTBLOCKS_LOOK_AT_STRENGTH])))
                    if s >= 1.0:
                        live_rot = la_hpb
                    elif s > 0.0:
                        live_rot = _slerp_hpb(cached_rot, la_hpb, s)
                    roll = float(tag[SHOTBLOCKS_LOOK_AT_ROLL] or 0.0)
                    live_rot, _ = _apply_roll_and_bank_into_turns(
                        live_rot, prev_heading=st.get("prev_heading"),
                        roll_rad=roll, bank_into_turns=bank_into_turns,
                        has_explicit_source=(up_target is not None))

            _write_back(cam, cached_pos, live_rot,
                        write_pos=owns_pos, write_rot=owns_rot)
            _apply_quick_zoom(tag, st, cam, doc, time, fps)
            return c4d.EXECUTIONRESULT_OK

        # On reset, the camera's current world matrix (and local
        # channels) still hold the spring's last write — typically a
        # banked / offset pose from end-of-range. If we read that as
        # "the keyframed target," reset_to_target snaps the spring's
        # position to that banked pose, and the user sees the camera
        # land non-level on the rewind/loop boundary.
        #
        # Force-evaluate the camera at the current time before reading
        # its pose. ExecutePasses runs the animation pass which
        # overwrites the world matrix from the keyframes (or absence
        # of them). For purely keyframed cameras that overwrites our
        # stale write; for AtS-driven cameras the spline-driven pose
        # is what wins. Either way the read in
        # _read_keyframed_target now reflects what the camera SHOULD
        # look like at this frame, not what we last wrote.
        #
        # We use a class flag (`_in_reset_eval`) to short-circuit
        # ourselves during this nested evaluation — otherwise the
        # ExecutePasses call would re-enter this very method and
        # write our spring's pose right back on top of the keyframe.
        reset_on_boundary = bool(tag[SHOTBLOCKS_RESET_ON_BOUNDARY])
        if (st["reset_pending"] and reset_on_boundary
                and not getattr(ShotblocksTag, "_in_reset_eval", False)):
            ShotblocksTag._in_reset_eval = True
            try:
                doc.ExecutePasses(
                    None,
                    animation=True,
                    expressions=True,
                    caches=False,
                    flags=c4d.BUILDFLAGS_NONE,
                )
            except Exception as e:
                if not getattr(ShotblocksTag, "_reset_eval_warned", False):
                    ShotblocksTag._reset_eval_warned = True
                    print("[Shotblocks] reset re-eval failed: {}".format(e))
            finally:
                ShotblocksTag._in_reset_eval = False

        # Position target: from the camera's own keyframed local pose,
        # UNLESS Chase is driving the body — then the desired position
        # is "behind the follow target along its heading" (the chase
        # engine replaces the keyframed pos; aim/rotation untouched).
        # Look-at doesn't move the camera, only aims it. Rotation target
        # starts as the keyframed rotation; look-at may slerp/replace it
        # below.
        target_pos, key_rot = _read_keyframed_target(cam, doc, time, fps)
        chase_pos = _chase_local_target_pos(
            tag, st, doc, time, fps, dt,
            is_reset=bool(st["reset_pending"]))
        if chase_pos is not None:
            target_pos = chase_pos
        target_rot = key_rot

        if st["reset_pending"] and reset_on_boundary:
            # If look-at is active, compute the look-at local rot and
            # use it as the rotation target for reset, so the spring
            # state is primed correctly. The main pipeline below will
            # also call SetRelRot with the look-at rotation, but
            # priming the spring's rot state lets the look-at-OFF
            # transition feel right.
            has_explicit_bank_source = False
            if look_at_target is not None:
                ou, ov = _read_frame_offset(tag)
                la_hpb = _compute_look_at_local_rot(
                    cam, look_at_target, up_target,
                    offset_u=ou, offset_v=ov, doc=doc)
                if la_hpb is not None:
                    strength = float(tag[SHOTBLOCKS_LOOK_AT_STRENGTH])
                    s = max(0.0, min(1.0, strength))
                    if s >= 1.0:
                        target_rot = la_hpb
                    elif s > 0.0:
                        target_rot = _slerp_hpb(key_rot, la_hpb, s)
                    # Look-at (especially with up_target) gives a
                    # meaningful bank channel. Without up_target it's
                    # the camera's preserved bank, but either way
                    # bank ∈ target_rot is intentional, not stale.
                    has_explicit_bank_source = (up_target is not None)
            # Apply Roll + Bank-Into-Turns to whatever target_rot
            # we ended up with. Reset always starts with no prior
            # heading so Bank-Into-Turns doesn't yaw on the first
            # frame after a cut.
            roll = float(tag[SHOTBLOCKS_LOOK_AT_ROLL] or 0.0)
            target_rot, heading = _apply_roll_and_bank_into_turns(
                target_rot, prev_heading=None,
                roll_rad=roll, bank_into_turns=False,
                has_explicit_source=has_explicit_bank_source)
            st["prev_heading"] = heading
            reset_to_target(spring, target_pos, target_rot)
            st["reset_pending"] = False
            spring["last_frame"] = cur_frame
            # Reset frame lands on the clean target — no noise
            # applied, so the camera doesn't pop to an offset value
            # on shot boundaries. Next frame's full pipeline takes
            # over.
            pos, _ = spring["pos"]
            rot, _ = spring["rot"]
            st["last_output_pos"] = pos
            st["last_output_rot"] = rot
            _write_back(cam, pos, rot, write_pos=owns_pos, write_rot=owns_rot)
            _apply_quick_zoom(tag, st, cam, doc, time, fps)
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
        # Aim Lock: blend the rotation stiffness UP toward the stiffest
        # response so the AIM can stay locked on the target even when the
        # body is heavily damped. Decouples "smooth body" (Angular) from
        # "locked aim" — e.g. 100% Angular for glassy body motion, high
        # Aim Lock to keep the subject framed. k_from_damping(0.0) is the
        # stiff end (K_MAX). Applies whenever the rotation is aim-driven:
        # an active look-at target OR Chase (whose aim is also look-at).
        # Gated on aim being active so a plain damped camera (no target)
        # isn't silently stiffened by a stale Aim Lock value.
        aim_active = (
            (look_at_target is not None
             and float(tag[SHOTBLOCKS_LOOK_AT_STRENGTH] or 0.0) > 0.0)
            or bool(tag[SHOTBLOCKS_FOLLOW_ENABLED])
        )
        if aim_active:
            aim_track = max(0.0, min(1.0, float(tag[SHOTBLOCKS_FOLLOW_AIM_TRACK] or 0.0)))
            if aim_track > 0.0:
                k_stiff = k_from_damping(0.0)
                k_rot = k_rot + (k_stiff - k_rot) * aim_track
        c_pos = critical_c(k_pos)
        c_rot = critical_c(k_rot)

        # If look-at is active, replace target_rot with the look-at
        # rotation (possibly blended with the keyframed rotation per
        # the strength slider). The spring then chases THAT.
        has_explicit_bank_source = False
        if look_at_target is not None:
            ou, ov = _read_frame_offset(tag)
            aim_pt = _chase_aim_point_world(tag, st, look_at_target)
            la_hpb = _compute_look_at_local_rot(
                cam, look_at_target, up_target,
                offset_u=ou, offset_v=ov, doc=doc,
                aim_point_world=aim_pt)
            if la_hpb is not None:
                strength = float(tag[SHOTBLOCKS_LOOK_AT_STRENGTH])
                s = max(0.0, min(1.0, strength))
                if s >= 1.0:
                    target_rot = la_hpb
                elif s > 0.0:
                    target_rot = _slerp_hpb(key_rot, la_hpb, s)
                # s == 0: leave target_rot = key_rot (look-at off)
                has_explicit_bank_source = (up_target is not None)
        else:
            # No look-at target → Frame Offset becomes a rotational pan
            # on the keyframed rotation (look-at consumes the offset via
            # _apply_frame_offset when a target IS set, so only do this
            # when it isn't — never both).
            ou, ov = _read_frame_offset(tag)
            if ou != 0.0 or ov != 0.0:
                try:
                    target_rot = _apply_frame_offset_rotation(
                        target_rot, cam, doc, ou, ov)
                except Exception:
                    pass

        # Roll + Bank-Into-Turns are a post-step on whatever
        # target_rot the previous stage produced — keyframed, AtS,
        # or look-at. Yaw rate is derived from heading delta since
        # the previous frame, so this works regardless of whether
        # look-at is active.
        roll = float(tag[SHOTBLOCKS_LOOK_AT_ROLL] or 0.0)
        bank_into_turns = bool(tag[SHOTBLOCKS_BANK_INTO_TURNS])
        target_rot, heading = _apply_roll_and_bank_into_turns(
            target_rot, prev_heading=st.get("prev_heading"),
            roll_rad=roll, bank_into_turns=bank_into_turns,
            has_explicit_source=has_explicit_bank_source)
        st["prev_heading"] = heading

        # Noise: stateless sample at the current frame. `*_pre` adds
        # to the target before the spring step (low-frequency drift
        # gets shaped by spring); `*_post` adds to the spring's
        # output (high-frequency tremor survives the low-pass).
        noise_pre_pos, noise_pre_rot, noise_post_pos, noise_post_rot = \
            _sample_noise_world(tag, st, cur_frame, fps,
                                cam, look_at_target, doc)
        target_pos = (target_pos[0] + noise_pre_pos[0],
                      target_pos[1] + noise_pre_pos[1],
                      target_pos[2] + noise_pre_pos[2])
        target_rot = (target_rot[0] + noise_pre_rot[0],
                      target_rot[1] + noise_pre_rot[1],
                      target_rot[2] + noise_pre_rot[2])

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

        # Post-spring noise: tremor (high-freq) added after the
        # spring so the spring's low-pass doesn't eat it. The
        # camera ends up at (spring_output + post_noise).
        final_pos = (nx  + noise_post_pos[0],
                     ny  + noise_post_pos[1],
                     nz  + noise_post_pos[2])
        final_rot = (rhx + noise_post_rot[0],
                     rhy + noise_post_rot[1],
                     rhz + noise_post_rot[2])
        st["last_output_pos"] = final_pos
        st["last_output_rot"] = final_rot
        _write_back(cam, final_pos, final_rot,
                    write_pos=owns_pos, write_rot=owns_rot)
        _apply_quick_zoom(tag, st, cam, doc, time, fps)
        return c4d.EXECUTIONRESULT_OK


def _compute_target_pose(tag, st, cam, doc, time, fps, dt, cur_frame,
                         look_at_target, up_target, is_reset,
                         bank_into_turns):
    """Compute the camera's target pose for this frame — everything the
    spring would chase, plus the post-spring noise to add afterward.

    This is the shared front half of the pipeline, used by BOTH the
    damping-on (spring) path and the damping-off (instant) path so the
    two can never drift. It does NOT touch the spring or write to the
    camera; it only reads parameters + scene state and returns numbers.

    Returns:
        target_pos   (3-tuple) — desired local position incl. pre-noise
        target_rot   (3-tuple) — desired local HPB incl. roll/bank + pre-noise
        heading      (float)   — this frame's heading, for prev_heading bookkeeping
        noise_post_pos (3-tuple) — high-freq position tremor to add post-spring
        noise_post_rot (3-tuple) — high-freq rotation tremor to add post-spring

    `is_reset` suppresses Bank-Into-Turns' yaw (no prior heading on a
    boundary) and clears the chase smoothing.
    """
    target_pos, key_rot = _read_keyframed_target(cam, doc, time, fps)
    chase_pos = _chase_local_target_pos(
        tag, st, doc, time, fps, dt, is_reset=is_reset)
    if chase_pos is not None:
        target_pos = chase_pos
    target_rot = key_rot

    has_explicit_bank_source = False
    if look_at_target is not None:
        ou, ov = _read_frame_offset(tag)
        aim_pt = _chase_aim_point_world(tag, st, look_at_target)
        la_hpb = _compute_look_at_local_rot(
            cam, look_at_target, up_target,
            offset_u=ou, offset_v=ov, doc=doc,
            aim_point_world=aim_pt)
        if la_hpb is not None:
            s = max(0.0, min(1.0, float(tag[SHOTBLOCKS_LOOK_AT_STRENGTH])))
            if s >= 1.0:
                target_rot = la_hpb
            elif s > 0.0:
                target_rot = _slerp_hpb(key_rot, la_hpb, s)
            has_explicit_bank_source = (up_target is not None)
    else:
        # No look-at target → Frame Offset is a rotational pan on the
        # keyframed rotation (mirrors the damping-on path).
        ou, ov = _read_frame_offset(tag)
        if ou != 0.0 or ov != 0.0:
            try:
                target_rot = _apply_frame_offset_rotation(
                    target_rot, cam, doc, ou, ov)
            except Exception:
                pass

    roll = float(tag[SHOTBLOCKS_LOOK_AT_ROLL] or 0.0)
    target_rot, heading = _apply_roll_and_bank_into_turns(
        target_rot,
        prev_heading=None if is_reset else st.get("prev_heading"),
        roll_rad=roll,
        bank_into_turns=False if is_reset else bank_into_turns,
        has_explicit_source=has_explicit_bank_source)

    noise_pre_pos, noise_pre_rot, noise_post_pos, noise_post_rot = \
        _sample_noise_world(tag, st, cur_frame, fps, cam, look_at_target, doc)
    target_pos = (target_pos[0] + noise_pre_pos[0],
                  target_pos[1] + noise_pre_pos[1],
                  target_pos[2] + noise_pre_pos[2])
    target_rot = (target_rot[0] + noise_pre_rot[0],
                  target_rot[1] + noise_pre_rot[1],
                  target_rot[2] + noise_pre_rot[2])
    return target_pos, target_rot, heading, noise_post_pos, noise_post_rot


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


def _chase_local_target_pos(tag, st, doc, time, fps, dt, is_reset):
    """If Chase is enabled and a Follow Target is set, return the camera's
    desired LOCAL position (parent-relative 3-tuple) for this frame —
    the position the existing position spring should chase. Returns None
    when Chase is off or unset, so the caller falls back to the camera's
    own keyframed position.

    The chase math (sb_rig_follow) runs in WORLD space: it reads the
    follow target's world position, low-passes its velocity, and places
    the camera behind the target's heading. We then convert the single
    resulting world point to the camera's parent-local frame — the same
    frame the spring and _write_back use (so they compose cleanly).

    `is_reset` is True on a boundary / scrub reset; we clear the chase
    smoothing first so the seed equals the freshly computed desired spot
    (mirroring the spring's reset_to_target), and so the heading low-pass
    doesn't carry stale velocity across the cut.
    """
    if not bool(tag[SHOTBLOCKS_FOLLOW_ENABLED]):
        return None
    follow_obj = tag[SHOTBLOCKS_FOLLOW_TARGET]
    if follow_obj is None:
        return None

    cam = tag.GetObject()
    if cam is None:
        return None

    follow_state = st["follow"]
    if is_reset:
        sb_rig_follow.reset_state(follow_state)

    # Follow target's world position this frame.
    try:
        tgt_w = follow_obj.GetMg().off
    except Exception:
        return None
    target_world = (tgt_w.x, tgt_w.y, tgt_w.z)

    lead_dist = float(tag[SHOTBLOCKS_FOLLOW_LEAD_DIST] or 0.0)
    result = sb_rig_follow.desired_position(
        follow_state, target_world, dt,
        follow_distance=float(tag[SHOTBLOCKS_FOLLOW_DISTANCE]   or 0.0),
        velocity_smoothing=float(tag[SHOTBLOCKS_FOLLOW_VEL_SMOOTH] or 0.0),
        reorient_speed=float(tag[SHOTBLOCKS_FOLLOW_REORIENT]    or 0.0),
        height_bias=float(tag[SHOTBLOCKS_FOLLOW_HEIGHT_BIAS]    or 0.0),
        side_bias=float(tag[SHOTBLOCKS_FOLLOW_SIDE_BIAS]        or 0.0),
        lead_distance=lead_dist,
    )
    desired_world = result["camera"]
    # Stash the world-space aim-lead point so the look-at path can blend
    # the aim toward it (anticipation). Cleared to None when lead is off
    # so the look-at path knows to aim dead-on the subject.
    st["follow_lead_world"] = result["lead"] if lead_dist != 0.0 else None
    follow_state["last_frame"] = time.GetFrame(fps)

    # Convert the world desired point to the camera's parent-local frame,
    # matching _read_keyframed_target's local convention.
    desired_v = c4d.Vector(desired_world[0], desired_world[1], desired_world[2])
    parent = cam.GetUp()
    if parent is not None:
        try:
            desired_v = ~parent.GetMg() * desired_v
        except Exception:
            pass
    return (desired_v.x, desired_v.y, desired_v.z)


def _chase_aim_point_world(tag, st, look_at_target):
    """Return the world-space point the camera should AIM at when Chase's
    aim-lead is active — a blend from the look-at target's origin (Aim
    Lead = 0) toward the chase lead point ahead of the subject (Aim Lead
    = 1). Returns None when lead is off / unavailable, so the caller aims
    dead-on the target as before.

    The lead point itself is computed in the chase engine (it already
    has the smoothed heading) and stashed on `st` by
    `_chase_local_target_pos`, which runs earlier this frame.
    """
    if not bool(tag[SHOTBLOCKS_FOLLOW_ENABLED]):
        return None
    lead_world = st.get("follow_lead_world")
    if lead_world is None or look_at_target is None:
        return None
    amount = max(0.0, min(1.0, float(tag[SHOTBLOCKS_FOLLOW_AIM_LEAD] or 0.0)))
    if amount <= 0.0:
        return None
    try:
        subj = look_at_target.GetMg().off
    except Exception:
        return None
    return (subj.x + (lead_world[0] - subj.x) * amount,
            subj.y + (lead_world[1] - subj.y) * amount,
            subj.z + (lead_world[2] - subj.z) * amount)


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


def _compute_look_at_local_rot(cam, target_obj, up_obj,
                               offset_u=0.0, offset_v=0.0, doc=None,
                               aim_point_world=None):
    """Compute the local (relative-to-parent) HPB rotation that aims
    the camera's -Z axis at `target_obj`, optionally framing the
    target at a screen-space offset.

    If `aim_point_world` (a 3-tuple world position) is given, the camera
    aims at THAT point instead of `target_obj`'s origin — used by Chase's
    aim-lead so the camera can look slightly ahead of the subject. The
    up-target / bank handling is unaffected. `target_obj` is still
    required (non-None) as the "is look-at active" gate.

    Base aim mirrors the Maxon SDK lookatcamera.cpp pattern:
        local_dir = (~(cam.GetUpMg() * cam.GetFrozenMln()))
                    * target.GetMg().off - cam.GetRelPos()
        hpb = c4d.utils.VectorToHPB(local_dir)
        hpb.z = cam.GetRelRot().z   # preserve bank

    With `offset_u` / `offset_v` non-zero, the aim is nudged so that
    the target lands at the given screen-space fraction instead of
    the optical center. Offsets are fractions of the viewport:
    +0.167 = the rule-of-thirds line. The math:

        distance   = |local_dir|
        half_w     = distance * tan(fov_h / 2)
        half_h     = distance * tan(fov_v / 2)
        offset_lp  = world_right * (u * half_w)
                   + world_up    * (v * half_h)
        local_dir' = local_dir - offset_lp

    Subtracting (not adding) because moving the AIM up-right is the
    same as moving the TARGET down-left in screen space — the camera
    rotates to put the now-offset target back on the optical axis,
    which puts the *real* target off-axis by the desired fraction.

    World right/up are (1,0,0) / (0,1,0) in parent-frozen local
    space, so the offset stays oriented to the horizon regardless of
    camera bank. For a non-banked camera this is identical to
    camera-relative; for a banked camera the rule-of-thirds line
    stays horizontal in world.

    With `up_obj` set, applies a Maya-style "up hint" bank
    correction: VectorToHPB's default aim uses world +Y as up
    (resulting in bank = 0 in level cases); we then twist the
    camera around its aim axis until its +Y is as close as
    possible to the direction from the camera toward `up_obj`.
    This is the standard cinematography rig behavior — soft
    constraint, keeps the up-target generally above the frame.

    Roll and Bank-Into-Turns are applied as a separate post-step
    (`_apply_roll_and_bank_into_turns`) so they work regardless of
    whether look-at is the rotation source. Returns the rotation
    `(h, p, b)` produced purely by the look-at math (no roll
    applied) or None when there's no target.

    `doc` is needed to read render-aspect for vertical FOV; if
    None or unavailable, falls back to 16:9.
    """
    if target_obj is None:
        return None
    up_mg = cam.GetUpMg()
    frozen_mln = cam.GetFrozenMln()
    parent_frozen = up_mg * frozen_mln
    if aim_point_world is not None:
        aim_off = c4d.Vector(aim_point_world[0], aim_point_world[1],
                             aim_point_world[2])
    else:
        aim_off = target_obj.GetMg().off
    try:
        inv_parent_frozen = ~parent_frozen
        local_dir = inv_parent_frozen * aim_off - cam.GetRelPos()
    except Exception:
        # Defensive: very rare edge case where parent matrix isn't
        # invertible. Fall back to world-only aim.
        return None

    # Screen-space framing offset.
    if offset_u != 0.0 or offset_v != 0.0:
        try:
            local_dir = _apply_frame_offset(
                local_dir, cam, doc, offset_u, offset_v)
        except Exception as e:
            # Framing-math failure must not break the base aim.
            if not getattr(_compute_look_at_local_rot, "_warned", False):
                print("[Shotblocks] Frame offset math failed, "
                      "falling back to centered aim: {}".format(e))
                _compute_look_at_local_rot._warned = True

    try:
        hpb = c4d.utils.VectorToHPB(local_dir)
    except Exception:
        return None

    # Bank: either preserve camera's current bank (no up-target) or
    # compute a Maya-style up-hint correction. Roll and
    # Bank-Into-Turns are applied later, in
    # _apply_roll_and_bank_into_turns, so they work whether or not
    # look-at is active.
    cur_rot = cam.GetRelRot()
    bank = cur_rot.z
    if up_obj is not None:
        try:
            up_local = (inv_parent_frozen * up_obj.GetMg().off
                        - cam.GetRelPos())
            bank = _bank_from_up_hint(local_dir, up_local)
        except Exception as e:
            if not getattr(_compute_look_at_local_rot, "_up_warned", False):
                print("[Shotblocks] Up-target math failed, "
                      "falling back to preserved bank: {}".format(e))
                _compute_look_at_local_rot._up_warned = True

    return (hpb.x, hpb.y, bank)


def _apply_roll_and_bank_into_turns(target_rot, prev_heading,
                                    roll_rad, bank_into_turns,
                                    has_explicit_source):
    """Add the Roll slider's contribution to `target_rot`'s bank
    channel, optionally scaled by yaw rate for Bank-Into-Turns.

    `target_rot` is a `(h, p, b)` 3-tuple — typically the keyframed
    or look-at-resolved rotation we're about to feed into the
    spring. `prev_heading` is the previous frame's heading (radians)
    or None on the first frame after a reset.

    `has_explicit_source` tells us whether the bank channel of
    `target_rot` carries meaningful prior bank (e.g. from an
    up-target or from keyframes). When False (the typical Shotblocks
    case: AtS-driven heading with no keyed bank), Roll drives bank
    from zero rather than compounding on top of stale prior bank.

    Returns `(new_target_rot, current_heading)`. Caller stashes the
    heading so the next frame can compute the yaw delta.
    """
    h, p, b = target_rot
    new_bank = b if has_explicit_source else 0.0

    if bank_into_turns and prev_heading is not None and roll_rad != 0.0:
        # Yaw rate: shortest-arc heading delta this frame (radians).
        # Positive = yawing left (heading increasing). Bike physics:
        # leaning into the turn means rolling AWAY from the yaw
        # direction, so yaw left → negative bank (roll right, +Y
        # tilts right).
        yaw_delta = _shortest_angle(h - prev_heading)
        # Scale: 1.0 at _BANK_FULL_YAW_RATE; proportional below
        # (and above — no clamp, so a very sharp turn produces a
        # larger lean than the slider's nominal max). The spring
        # damping smooths anything extreme.
        scale = yaw_delta / _BANK_FULL_YAW_RATE
        new_bank += -scale * roll_rad
    else:
        new_bank += roll_rad

    return (h, p, new_bank), h


def _shortest_angle(delta):
    """Wrap `delta` into (-π, +π] — the shortest signed angular
    distance. Used to keep yaw-rate computations stable across the
    ±π heading wraparound."""
    from math import pi
    while delta > pi:
        delta -= 2.0 * pi
    while delta <= -pi:
        delta += 2.0 * pi
    return delta


def _bank_from_up_hint(aim_dir, up_dir):
    """Maya-style up-hint bank correction.

    Given an aim direction (from camera toward target) and an
    up-hint direction (from camera toward up-target), both in the
    same coordinate frame, return the bank angle (radians) that
    twists the camera around the aim axis so its +Y is as close as
    possible to up_dir.

    Algorithm:
    1. The aim is camera -Z, so the camera's forward = -aim_dir
       (normalized).
    2. VectorToHPB's heading + pitch give the camera an orientation
       with bank = 0, which produces a "default +Y" lying in the
       (world +Y, forward) plane.
    3. The "desired +Y" is up_dir projected perpendicular to
       forward, normalized.
    4. Bank = signed angle between default-+Y and desired-+Y
       around the forward axis.

    Degenerate cases (up_dir parallel to forward, or zero-length
    inputs) return 0.0 — the camera stays level.
    """
    forward = -aim_dir   # camera looks along -Z
    fL = forward.GetLength()
    uL = up_dir.GetLength()
    if fL < 1e-9 or uL < 1e-9:
        return 0.0
    forward = forward * (1.0 / fL)

    # Project up_dir perpendicular to forward; that's the camera's
    # desired +Y (in the plane perpendicular to its aim).
    f_dot_u = forward.Dot(up_dir)
    desired_up = up_dir - forward * f_dot_u
    dL = desired_up.GetLength()
    if dL < 1e-9:
        # up_dir is parallel to forward — no projection plane.
        return 0.0
    desired_up = desired_up * (1.0 / dL)

    # The "default +Y" VectorToHPB produces is world +Y projected
    # perpendicular to forward.
    world_y = c4d.Vector(0.0, 1.0, 0.0)
    f_dot_wy = forward.Dot(world_y)
    default_up = world_y - forward * f_dot_wy
    eL = default_up.GetLength()
    if eL < 1e-9:
        # Aim is exactly along world Y (looking straight up/down).
        # VectorToHPB's behavior near this pole is ambiguous; skip
        # the bank correction this frame.
        return 0.0
    default_up = default_up * (1.0 / eL)

    # Signed angle from default_up to desired_up around forward.
    # cos(theta) = default_up . desired_up
    # sin(theta) = (default_up x desired_up) . forward
    from math import atan2
    cos_t = default_up.Dot(desired_up)
    sin_t = default_up.Cross(desired_up).Dot(forward)
    return atan2(sin_t, cos_t)


def _apply_frame_offset(local_dir, cam, doc, offset_u, offset_v):
    """Nudge `local_dir` (a parent-frozen-local aim direction) so the
    target lands at screen-space fraction (offset_u, offset_v)
    instead of dead center.

    Returns the adjusted local_dir vector. Raises on missing FOV
    data — caller catches.
    """
    distance = local_dir.GetLength()
    if distance < 1e-6:
        # Target is essentially on top of the camera; offset is
        # meaningless. Leave aim alone.
        return local_dir
    fov_h, fov_v = _camera_fov_radians(cam, doc)
    from math import tan
    half_w = distance * tan(fov_h * 0.5)
    half_h = distance * tan(fov_v * 0.5)
    dx = offset_u * half_w
    dy = offset_v * half_h

    # Screen right/up for THIS aim direction. The earlier version
    # assumed world X = screen-right and world Y = screen-up, which is
    # only true when the camera looks straight down -Z. For an off-axis
    # aim (camera pointed at a target) those world axes are NOT the
    # screen axes: subtracting dx from local_dir.x then mostly changes
    # distance-along-view, not horizontal screen position, so the
    # horizontal offset visually collapsed while the vertical (which
    # stayed near-perpendicular) survived. Build the screen basis from
    # the aim instead: right = forward × world-up, up = right × forward.
    forward = local_dir
    world_up = c4d.Vector(0.0, 1.0, 0.0)
    right = forward.Cross(world_up)
    if right.GetLength() < 1e-6:
        # Aim is straight up/down — world-up is degenerate as a hint.
        # Use world +X so the offset still has a stable horizontal axis.
        right = forward.Cross(c4d.Vector(1.0, 0.0, 0.0))
    right.Normalize()
    up = right.Cross(forward)
    up.Normalize()

    # Move the aim by +right*dx and +up*dy. (Sign matches the old
    # behaviour: moving the AIM toward the offset puts the target at the
    # opposite screen fraction, which is the "drag the dot to where the
    # subject sits" convention _read_frame_offset documents.)
    return c4d.Vector(
        forward.x - right.x * dx - up.x * dy,
        forward.y - right.y * dx - up.y * dy,
        forward.z - right.z * dx - up.z * dy,
    )


def _apply_frame_offset_rotation(rot_hpb, cam, doc, offset_u, offset_v):
    """Frame Offset for a camera with NO look-at target: a rotational pan.

    Adds a small heading/pitch rotation to the keyframed rotation so the
    world shifts in frame by the screen-space fraction (offset_u,
    offset_v) — the target-less counterpart to the look-at re-framing.
    The shift fraction maps to the angle that subtends that fraction of
    the FOV: a fraction `f` of the half-frame is `f * (fov/2)` radians.

    Sign is the "pan toward the dot" convention — with no target there's
    no subject to re-frame, so the natural feel is "drag the dot the way
    you want the camera to look." Drag right (+u) → camera pans right →
    the framing shifts right; drag up (+v) → camera tilts up. (This is the
    OPPOSITE of the look-at re-framing, where +u puts the SUBJECT right by
    panning the aim left — correct there because there's a subject to
    place, wrong here where the dot just steers the camera.) Heading is
    HPB index 0, pitch index 1. Returns the adjusted (h, p, b) tuple.

    Composes with the spring naturally — it only shifts the rotation
    TARGET; the angular damping still eases the camera onto it. Raises on
    missing FOV data — caller catches.
    """
    if offset_u == 0.0 and offset_v == 0.0:
        return rot_hpb
    fov_h, fov_v = _camera_fov_radians(cam, doc)
    # Pan toward the dot: drag right → look right (−heading in C4D's HPB,
    # which is what swings the view right), drag up → tilt up. _read_frame_
    # offset already inverted v's raw sign so +v means "up" here.
    h = rot_hpb[0] - offset_u * (fov_h * 0.5)
    p = rot_hpb[1] - offset_v * (fov_v * 0.5)
    return (h, p, rot_hpb[2])


def _camera_fov_radians(cam, doc):
    """Return (fov_h, fov_v) in radians for `cam` at its current
    focal length and aperture, accounting for render aspect.

    Computes from first principles rather than relying on a c4d
    helper, since FocalLengthToFOV's exact signature varies across
    SDK builds.
    """
    from math import atan, pi
    focal = float(cam[c4d.CAMERAOBJECT_FOCUS])     # mm
    aperture = float(cam[c4d.CAMERAOBJECT_APERTURE])  # mm (horizontal)
    if focal <= 0.0 or aperture <= 0.0:
        # Fall back to a reasonable 50mm-on-35mm-equivalent FOV.
        focal = 36.0
        aperture = 36.0
    fov_h = 2.0 * atan(aperture / (2.0 * focal))
    # Vertical FOV depends on aspect ratio. Read from render data.
    aspect = _render_aspect(doc)
    # tan(fov_v/2) = tan(fov_h/2) / aspect  (aspect = width / height)
    from math import tan
    fov_v = 2.0 * atan(tan(fov_h * 0.5) / aspect)
    return fov_h, fov_v


def _render_aspect(doc):
    """Width / height of the active render. Defaults to 16/9 if
    unavailable."""
    try:
        if doc is None:
            return 16.0 / 9.0
        rd = doc.GetActiveRenderData()
        if rd is None:
            return 16.0 / 9.0
        w = float(rd[c4d.RDATA_XRES])
        h = float(rd[c4d.RDATA_YRES])
        if w > 0.0 and h > 0.0:
            return w / h
    except Exception:
        pass
    return 16.0 / 9.0


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


def _apply_quick_zoom(tag, st, cam, doc, time, fps):
    """If the Quick Zoom behavior is enabled, sample the schedule
    at the current time and multiply the camera's focal length by
    the result. Idle = 1.0 = no change.

    Baseline focal length: the keyframed value if the camera has a
    FOCUS CTrack; otherwise the camera's persisted focal length
    (snapshotted on first sample when the multiplier is 1.0, so we
    don't compound across frames).

    When zoom is disabled, restore the baseline if we have one
    cached (so disabling cleanly reverts the focal length).
    """
    if cam is None:
        return
    if not bool(tag[SHOTBLOCKS_ZOOM_ENABLED]):
        # Restore baseline if we'd modified it before.
        baseline = st.get("zoom_focal_baseline")
        if baseline is not None:
            try:
                cam[c4d.CAMERAOBJECT_FOCUS] = baseline
            except Exception:
                pass
            st["zoom_focal_baseline"] = None
        return

    # Resolve baseline. Always prefer the keyframed value if present;
    # only fall back to the cached baseline (or current focus) when
    # there's no track.
    base_focal = _baseline_focal(cam, doc, time, fps, st)
    if base_focal is None or base_focal <= 0.0:
        return

    rate         = float(tag[SHOTBLOCKS_ZOOM_RATE]     or 0.2)
    strength     = float(tag[SHOTBLOCKS_ZOOM_STRENGTH] or 1.5)
    hold         = float(tag[SHOTBLOCKS_ZOOM_HOLD]     or 1.0)
    ramp_in      = float(tag[SHOTBLOCKS_ZOOM_RAMP_IN]  or 0.25)
    ramp_out     = float(tag[SHOTBLOCKS_ZOOM_RAMP_OUT] or 0.6)
    return_prob  = float(tag[SHOTBLOCKS_ZOOM_RETURN]   or 0.7)

    # Reuse the noise seed so zoom and noise stay coordinated per
    # tag (different tags get different zoom schedules without any
    # additional storage).
    seed = int(tag[SHOTBLOCKS_NOISE_SEED] or 0)
    if seed == 0:
        key = _state_key(tag)
        seed = key[1] if isinstance(key, tuple) and len(key) >= 2 else 1
        if seed == 0:
            seed = 1

    t_now = time.Get() if hasattr(time, "Get") else (
        time.GetFrame(fps) / float(fps))

    mult = sb_rig_zoom.sample_zoom_multiplier(
        st["zoom_schedule"], t_now,
        rate, strength, hold, ramp_in, ramp_out, return_prob, seed)

    try:
        cam[c4d.CAMERAOBJECT_FOCUS] = base_focal * mult
    except Exception as e:
        if not getattr(_apply_quick_zoom, "_warned", False):
            print("[Shotblocks] Quick zoom focal write failed: {}".format(e))
            _apply_quick_zoom._warned = True


# Cache-resolve the FOCUS CTrack DescID once. It's the focal length
# parameter of a CAMERAOBJECT.
_FOCAL_DESC = c4d.DescID(
    c4d.DescLevel(c4d.CAMERAOBJECT_FOCUS, c4d.DTYPE_REAL, 0))


def _baseline_focal(cam, doc, time, fps, st):
    """Return the camera's UN-zoomed focal length (mm). Prefer the
    keyframed value when a FOCUS CTrack exists — that's the user's
    intent and isn't polluted by our own writes. Otherwise return
    a cached snapshot taken when zoom was idle so we don't compound
    across frames.
    """
    track = cam.GetFirstCTrack()
    while track is not None:
        try:
            if track.GetDescriptionID() == _FOCAL_DESC:
                return float(track.GetValue(doc, time, fps))
        except Exception:
            pass
        track = track.GetNext()

    # No track. Snapshot the current value on first call so the
    # baseline doesn't drift when we start writing.
    cached = st.get("zoom_focal_baseline")
    if cached is None:
        try:
            cached = float(cam[c4d.CAMERAOBJECT_FOCUS])
        except Exception:
            return None
        if cached <= 0.0:
            return None
        st["zoom_focal_baseline"] = cached
    return cached


def _sample_noise_world(tag, st, cur_frame, fps, cam, look_at_target, doc):
    """Sample the tag's noise profile at the current frame and
    return four world-space 3-tuples:
        (pos_pre, rot_pre, pos_post, rot_post)

    `pos_*` are converted from viewport-fraction (the units the
    noise module emits) to world units via the camera's FOV and a
    reference distance — the look-at target distance when one is
    set, else _NOISE_FALLBACK_DISTANCE. Same self-scaling logic as
    v12 Frame Offset.

    `rot_*` are already in radians.

    Short-circuits to all-zeros when noise is disabled or strength=0 —
    that's the "byte-for-byte identical to current behavior" guarantee
    when Handheld Noise is off.
    """
    if not bool(tag[SHOTBLOCKS_NOISE_ENABLED]):
        return _ZERO3, _ZERO3, _ZERO3, _ZERO3
    strength = float(tag[SHOTBLOCKS_NOISE_STRENGTH] or 0.0)
    if strength <= 0.0:
        return _ZERO3, _ZERO3, _ZERO3, _ZERO3

    # Seed: an explicit non-zero seed wins; otherwise fall back to
    # the tag's stable BC marker so every tag's "default seed"
    # differs without the user touching anything.
    seed = int(tag[SHOTBLOCKS_NOISE_SEED] or 0)
    if seed == 0:
        key = _state_key(tag)
        # key is ("bc", marker) or ("pyid", id(tag))
        seed = key[1] if isinstance(key, tuple) and len(key) >= 2 else 1
        if seed == 0:
            seed = 1

    walking = bool(tag[SHOTBLOCKS_NOISE_WALKING])
    step_rate = float(tag[SHOTBLOCKS_NOISE_STEP_RATE] or 1.8)
    speed = float(tag[SHOTBLOCKS_NOISE_SPEED] or 1.0)
    sample = sb_rig_noise.sample_profile(
        sb_rig_noise.PROFILE_HANDHELD, cur_frame, fps, seed,
        walking=walking, step_rate_hz=step_rate, speed=speed)

    # Convert position-fraction → world units.
    distance = _noise_reference_distance(cam, look_at_target)
    try:
        fov_h, fov_v = _camera_fov_radians(cam, doc)
    except Exception:
        fov_h, fov_v = 0.5, 0.3   # ~28°/17°, safe fallback
    from math import tan
    half_w = distance * tan(fov_h * 0.5)
    half_h = distance * tan(fov_v * 0.5)
    # x/z scale to half_w (lateral), y to half_h (vertical). Factor
    # of 2 because the viewport fraction is in [-0.5, +0.5] range
    # and half_w is the half-width — one unit of fraction = full
    # width = 2 * half_w.
    sx = 2.0 * half_w * strength
    sy = 2.0 * half_h * strength
    sz = 2.0 * half_w * strength
    pos_pre  = (sample["pos_pre"][0]  * sx,
                sample["pos_pre"][1]  * sy,
                sample["pos_pre"][2]  * sz)
    pos_post = (sample["pos_post"][0] * sx,
                sample["pos_post"][1] * sy,
                sample["pos_post"][2] * sz)
    rot_pre  = (sample["rot_pre"][0]  * strength,
                sample["rot_pre"][1]  * strength,
                sample["rot_pre"][2]  * strength)
    rot_post = (sample["rot_post"][0] * strength,
                sample["rot_post"][1] * strength,
                sample["rot_post"][2] * strength)
    return pos_pre, rot_pre, pos_post, rot_post


_ZERO3 = (0.0, 0.0, 0.0)


def _noise_reference_distance(cam, look_at_target):
    """Pick a sensible distance (cm) for converting viewport-fraction
    noise into world units. Prefer the look-at target's distance from
    the camera; fall back to a fixed value if no target is set."""
    if look_at_target is not None and cam is not None:
        try:
            d = (look_at_target.GetMg().off - cam.GetMg().off).GetLength()
            if d > 1.0:
                return d
        except Exception:
            pass
    return _NOISE_FALLBACK_DISTANCE


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




def _write_back(cam, pos, rot, write_pos=True, write_rot=True):
    """Write a pose back to the camera, but only the channels the tag
    actually owns this frame.

    `pos` and `rot` are 3-tuples of floats (local position and HPB
    radians). The caller decides what they are — spring output
    alone, or spring output plus post-spring noise, or an instant
    target pose — so this function stays oblivious to the composition.

    `write_pos` / `write_rot` gate whether the tag owns that channel.
    A channel the tag does NOT own is left as the camera's OWN current
    local value. This matters because we also write the world matrix
    (SetMg), which would otherwise clobber the user's own value on the
    un-owned axis: if look-at owns rotation but not position, we must
    rebuild SetMg from (our rotation + the camera's live position), or
    SetMg would freeze the position the user is trying to navigate.

    When the tag owns NEITHER channel the caller skips us entirely —
    a no-op tag must not touch the camera at all (full pass-through),
    or it fights viewport navigation.

    Writes BOTH the local channels (SetRelPos/SetRelRot) AND the
    world matrix (SetMg) for owned channels. The redundancy is
    intentional: C4D's animation system may overwrite local-channel
    writes after we return, but SetMg bypasses that — it sets the
    visible world transform for this frame regardless of what's on
    the local channels.
    """
    if not write_pos and not write_rot:
        return

    # Resolve the effective local pos/rot: our value for owned
    # channels, the camera's own current local value for un-owned ones
    # (so SetMg below doesn't clobber what the user is manipulating).
    if write_pos:
        eff_pos = (pos[0], pos[1], pos[2])
        cam.SetRelPos(c4d.Vector(pos[0], pos[1], pos[2]))
    else:
        cur = cam.GetRelPos()
        eff_pos = (cur.x, cur.y, cur.z)

    if write_rot:
        eff_rot = (rot[0], rot[1], rot[2])
        cam.SetRelRot(c4d.Vector(rot[0], rot[1], rot[2]))
    else:
        cur = cam.GetRelRot()
        eff_rot = (cur.x, cur.y, cur.z)

    # Build the local matrix from the effective pos+rot via HPB, then
    # promote to world by post-multiplying by the parent's world Mg.
    # For an unparented camera, parent_mg is identity and the local
    # matrix IS the world matrix.
    try:
        local_mg = c4d.utils.HPBToMatrix(c4d.Vector(eff_rot[0], eff_rot[1], eff_rot[2]))
        local_mg.off = c4d.Vector(eff_pos[0], eff_pos[1], eff_pos[2])
        parent = cam.GetUp()
        if parent is not None:
            cam.SetMg(parent.GetMg() * local_mg)
        else:
            cam.SetMg(local_mg)
    except Exception as e:
        # If HPBToMatrix isn't available in this SDK build, the
        # SetRelPos/SetRelRot path above is still in effect.
        print("[Shotblocks] _write_back HPBToMatrix failed: {}".format(e))
