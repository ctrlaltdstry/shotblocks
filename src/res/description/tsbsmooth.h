#ifndef TSBSMOOTH_H__
#define TSBSMOOTH_H__

// Shotblocks Motion tag. Applies the rig's spring-damper smoothing and
// fBm handheld noise to ANY animated object (keyframes, Align-to-Spline,
// constraints, Xpresso), across position, rotation, AND scale. A slim
// sibling of the camera rig tag (tshotblocks) that reuses the same pure
// engines but exposes only the object-relevant subset.
//
// Internal resource name is "tsbsmooth" (historical: the feature was
// scoped as "Smooth" before noise was folded in). User-facing name is
// "Shotblocks Motion" (set at registration). IDs are this tag's own
// space; they do NOT need to match the camera tag's tshotblocks.h.

enum
{
    SBMOTION_ENABLED            = 1000,

    // Inertial weight. Master off by default — a fresh tag tracks the
    // animation exactly until the user turns weight on. The object follows
    // its animated path (keyframes / Align-to-Spline / parent motion) but
    // carries momentum: it drifts WIDE on corners and banks into them, like
    // a heavy object with gravity. Tight on straights, drift on corners.
    //   Weight = how heavy / how wide it drifts (0..1).
    //   Drift  = overshoot amount, the swing-wide-and-settle (0..1).
    //   Lean   = banking-into-turns strength from g-force (0..1).
    SBMOTION_INERTIA_ENABLED    = 1010,
    SBMOTION_WEIGHT             = 1011,
    SBMOTION_DRIFT              = 1012,
    SBMOTION_LEAN               = 1013,
    // Turn Ease: rotational inertia. Eases the body's orientation toward the
    // authored heading instead of snapping, so a sharp corner in the path
    // rounds off (the object can't whip its nose around instantly).
    SBMOTION_TURN_EASE          = 1014,

    // Noise (fBm). Same engine as the camera tag, but object-tuned:
    // Amount (intensity), Speed (fast/slow), Contrast (smooth vs spiky).
    // No walk cycle / step rate — those are operator-on-foot concepts that
    // don't apply to a generic object.
    SBMOTION_NOISE_ENABLED      = 1030,
    SBMOTION_NOISE_STRENGTH     = 1031,  // Amount / intensity
    SBMOTION_NOISE_SEED         = 1032,
    SBMOTION_NOISE_SPEED        = 1035,  // fast vs slow
    SBMOTION_NOISE_CONTRAST     = 1036,  // smooth/even (low) vs spiky/punchy (high)

    // Advanced.
    SBMOTION_SUBSTEP_THRESHOLD  = 1006,
    SBMOTION_RESET_ON_BOUNDARY  = 1008,

    // Groups.
    SBMOTION_GRP_INERTIA        = 1100,
    SBMOTION_GRP_NOISE          = 1104,
    SBMOTION_GRP_ADVANCED       = 1101,
};

#endif
