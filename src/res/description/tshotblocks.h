#ifndef TSHOTBLOCKS_H__
#define TSHOTBLOCKS_H__

enum
{
    SHOTBLOCKS_ENABLED              = 1000,
    // 1001 was SHOTBLOCKS_MODE (additive/replace cycle). Replace mode
    // was never built; the rig is additive-only. ID retired, not reused.
    SHOTBLOCKS_DAMPING_POS          = 1002,
    SHOTBLOCKS_DAMPING_ROT          = 1003,
    SHOTBLOCKS_DAMPING_ENABLED      = 1004,  // master on/off for spring smoothing; OFF = camera fully interactive
    SHOTBLOCKS_SUBSTEP_THRESHOLD    = 1006,
    SHOTBLOCKS_RESET_ON_BOUNDARY    = 1008,
    SHOTBLOCKS_LOOK_AT_TARGET       = 1020,
    SHOTBLOCKS_UP_TARGET            = 1021,
    SHOTBLOCKS_LOOK_AT_STRENGTH     = 1022,
    SHOTBLOCKS_LOOK_AT_ROLL         = 1023,
    SHOTBLOCKS_BANK_INTO_TURNS      = 1024,
    // Framing Offset as plain sliders (replaced the CUSTOMGUI_VECTOR2D
    // joystick — too sensitive, number fields not editable). Screen-space
    // fractions: 0 = target centred; +/-100% = target at the frame edge.
    // H = horizontal (drag +, target sits right), V = vertical (+ = up).
    SHOTBLOCKS_FRAME_OFFSET_H       = 1025,
    SHOTBLOCKS_FRAME_OFFSET_V       = 1026,
    SHOTBLOCKS_NOISE_ENABLED        = 1030,  // was SHOTBLOCKS_NOISE_PROFILE (off/handheld cycle); only one profile, so it's a bool now
    SHOTBLOCKS_NOISE_STRENGTH       = 1031,
    SHOTBLOCKS_NOISE_SEED           = 1032,
    SHOTBLOCKS_NOISE_WALKING        = 1033,
    SHOTBLOCKS_NOISE_STEP_RATE      = 1034,
    SHOTBLOCKS_NOISE_SPEED          = 1035,
    SHOTBLOCKS_NOISE_CONTRAST       = 1036,  // smooth (low) vs spiky (high), 0..1; feeds fBm gain_scale
    SHOTBLOCKS_ZOOM_ENABLED         = 1040,
    SHOTBLOCKS_ZOOM_RATE            = 1041,
    SHOTBLOCKS_ZOOM_STRENGTH        = 1042,
    SHOTBLOCKS_ZOOM_HOLD            = 1043,
    SHOTBLOCKS_ZOOM_RAMP_IN         = 1044,
    SHOTBLOCKS_ZOOM_RAMP_OUT        = 1045,
    SHOTBLOCKS_ZOOM_RETURN          = 1046,
    // Chase = world-anchored SPHERE around the target (see rig-chase-sphere.md).
    SHOTBLOCKS_FOLLOW_ENABLED       = 1050,
    SHOTBLOCKS_FOLLOW_TARGET        = 1051,
    SHOTBLOCKS_FOLLOW_DISTANCE      = 1052,  // Radius: sphere size = camera distance
    SHOTBLOCKS_FOLLOW_STRENGTH      = 1053,  // Chase influence 0..1 (keyframeable): blends the camera's FOLLOW from full chase (1) to none (0). At 0 it coasts to a stop and the subject flies out of frame. Aim is separate (Look-At Strength). (id reused from the retired VEL_SMOOTH)
    // 1054 SHOTBLOCKS_FOLLOW_REORIENT    — RETIRED (no behind-point to re-orient)
    // 1055 SHOTBLOCKS_FOLLOW_HEIGHT_BIAS — RETIRED (Orbit Position covers it)
    // 1056 SHOTBLOCKS_FOLLOW_SIDE_BIAS   — RETIRED (Orbit Position covers it)
    SHOTBLOCKS_FOLLOW_AIM_TRACK     = 1057,  // Aim Lock (Look-At group; shared)
    SHOTBLOCKS_FOLLOW_LEAD_DIST     = 1058,  // Look-Ahead distance (aim-only)
    SHOTBLOCKS_FOLLOW_AIM_LEAD      = 1059,  // Look-Ahead amount (aim-only)
    SHOTBLOCKS_FOLLOW_LONGITUDE     = 1060,  // Orbit azimuth about world Y (deg); 0 = world -Z; multi-turn ok (was ORBIT)
    SHOTBLOCKS_FOLLOW_LATITUDE      = 1061,  // Height Angle elevation (deg); 0 = equator, +90 overhead, -90 under (was PITCH)
    // 1062 SHOTBLOCKS_FOLLOW_ORBIT_WORLD — RETIRED (sphere always world-anchored)
    // 1063 SHOTBLOCKS_FOLLOW_ORBIT_PLANE — RETIRED (joystick covers full sphere)
    // 1064 SHOTBLOCKS_FOLLOW_ABS_ROLL    — RETIRED (Camera Roll always available)
    SHOTBLOCKS_FOLLOW_CAM_ROLL      = 1065,  // absolute camera roll about the view axis (deg)
    // Top-level tab groups.
    SHOTBLOCKS_GRP_GENERAL          = 1108,  // General tab (Aim + Smoothing + Advanced)
    SHOTBLOCKS_GRP_FOLLOW           = 1106,  // Chase tab
    SHOTBLOCKS_GRP_FRAMING_TAB      = 1109,  // Framing tab (Framing offset + Handheld)
    SHOTBLOCKS_GRP_ZOOM             = 1105,  // Zoom tab
    // Sub-sections inside the tabs.
    SHOTBLOCKS_GRP_LOOK_AT          = 1102,  // "Aim" section
    SHOTBLOCKS_GRP_DAMPING          = 1100,  // "Smoothing" section
    SHOTBLOCKS_GRP_ADVANCED         = 1101,
    SHOTBLOCKS_GRP_FRAMING          = 1103,  // "Framing" offset section
    SHOTBLOCKS_GRP_NOISE            = 1104,  // "Handheld" section
};

#endif
