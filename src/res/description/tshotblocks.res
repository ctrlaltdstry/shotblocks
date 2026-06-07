CONTAINER Tshotblocks
{
    NAME Tshotblocks;

    INCLUDE Texpression;

    // Top-level GROUPs render as TABS in the Attribute Manager.
    // General / Chase / Framing / Zoom.

    // ===================== GENERAL =====================
    GROUP SHOTBLOCKS_GRP_GENERAL
    {
        DEFAULT 1;
        BOOL SHOTBLOCKS_ENABLED { }

        // Aim: point the camera at a target.
        GROUP SHOTBLOCKS_GRP_LOOK_AT
        {
            DEFAULT 1;
            LINK SHOTBLOCKS_LOOK_AT_TARGET { ACCEPT { Obase; } }
            LINK SHOTBLOCKS_UP_TARGET      { ACCEPT { Obase; } }
            REAL SHOTBLOCKS_LOOK_AT_STRENGTH { UNIT PERCENT; MIN 0.0; MAXSLIDER 100.0; CUSTOMGUI REALSLIDER; }
            // Aim Lock: how much the aim resists Rotation smoothing (0% = aim
            // lags with the body, 100% = aim stays locked on target). Shared
            // with Chase, which reads the same ID.
            REAL SHOTBLOCKS_FOLLOW_AIM_TRACK { UNIT PERCENT; MIN 0.0; MAXSLIDER 100.0; CUSTOMGUI REALSLIDER; }
            REAL SHOTBLOCKS_LOOK_AT_ROLL { UNIT DEGREE; MIN -180.0; MAX 180.0; MINSLIDER -180.0; MAXSLIDER 180.0; STEP 1.0; CUSTOMGUI REALSLIDER; }
            BOOL SHOTBLOCKS_BANK_INTO_TURNS { }
        }

        // Smoothing: spring-damper on the camera's motion (applies globally).
        GROUP SHOTBLOCKS_GRP_DAMPING
        {
            DEFAULT 1;
            BOOL SHOTBLOCKS_DAMPING_ENABLED { }
            REAL SHOTBLOCKS_DAMPING_POS { UNIT PERCENT; MIN 0.0; MAXSLIDER 100.0; CUSTOMGUI REALSLIDER; }
            REAL SHOTBLOCKS_DAMPING_ROT { UNIT PERCENT; MIN 0.0; MAXSLIDER 100.0; CUSTOMGUI REALSLIDER; }
        }

        GROUP SHOTBLOCKS_GRP_ADVANCED
        {
            DEFAULT 0;
            REAL SHOTBLOCKS_SUBSTEP_THRESHOLD { MIN 1.0; MAX 240.0; STEP 1.0; }
            BOOL SHOTBLOCKS_RESET_ON_BOUNDARY { }
        }
    }

    // ===================== CHASE =====================
    // A world-anchored SPHERE around the target. The camera sits on the
    // sphere surface (Radius = distance) at the Orbit / Height Angle, always
    // aiming at the target. See rig-chase-sphere.md.
    GROUP SHOTBLOCKS_GRP_FOLLOW
    {
        DEFAULT 1;
        BOOL SHOTBLOCKS_FOLLOW_ENABLED { }
        LINK SHOTBLOCKS_FOLLOW_TARGET { ACCEPT { Obase; } }
        REAL SHOTBLOCKS_FOLLOW_DISTANCE { UNIT METER; MIN 0.0; MAXSLIDER 2000.0; STEP 1.0; CUSTOMGUI REALSLIDER; }
        // Strength: how much the camera follows (keyframeable). 100% = full
        // chase; animate to 0% and the camera coasts to a stop and the subject
        // flies out of frame. Aim is separate (Aim Strength).
        REAL SHOTBLOCKS_FOLLOW_STRENGTH { UNIT PERCENT; MIN 0.0; MAX 100.0; MINSLIDER 0.0; MAXSLIDER 100.0; STEP 1.0; CUSTOMGUI REALSLIDER; }
        // Orbit (longitude) spins around world Y; 0 = behind. No hard clamp so
        // it can keyframe multi-turn sweeps. Height Angle (latitude) tilts
        // overhead(+90)/underneath(-90), clamped at the poles.
        REAL SHOTBLOCKS_FOLLOW_LONGITUDE { UNIT DEGREE; MINSLIDER -360.0; MAXSLIDER 360.0; STEP 1.0; CUSTOMGUI REALSLIDER; }
        REAL SHOTBLOCKS_FOLLOW_LATITUDE  { UNIT DEGREE; MIN -90.0; MAX 90.0; MINSLIDER -90.0; MAXSLIDER 90.0; STEP 1.0; CUSTOMGUI REALSLIDER; }
        REAL SHOTBLOCKS_FOLLOW_CAM_ROLL { UNIT DEGREE; MINSLIDER -180.0; MAX 180.0; MIN -180.0; MAXSLIDER 180.0; STEP 1.0; CUSTOMGUI REALSLIDER; }
        // Look-Ahead: aim ahead of the target along its travel (aim-only).
        REAL SHOTBLOCKS_FOLLOW_LEAD_DIST { UNIT METER; MIN 0.0; MAXSLIDER 1000.0; STEP 1.0; CUSTOMGUI REALSLIDER; }
        REAL SHOTBLOCKS_FOLLOW_AIM_LEAD  { UNIT PERCENT; MIN 0.0; MAXSLIDER 100.0; CUSTOMGUI REALSLIDER; }
    }

    // ===================== FRAMING =====================
    GROUP SHOTBLOCKS_GRP_FRAMING_TAB
    {
        DEFAULT 1;

        // Where the subject sits in frame. 0 = centred; +/-100% = frame edge.
        // Hard clamp wider (+/-300%) for keyframed pans from off-screen.
        GROUP SHOTBLOCKS_GRP_FRAMING
        {
            DEFAULT 1;
            REAL SHOTBLOCKS_FRAME_OFFSET_H { UNIT PERCENT; MIN -300.0; MAX 300.0; MINSLIDER -100.0; MAXSLIDER 100.0; STEP 1.0; CUSTOMGUI REALSLIDER; }
            REAL SHOTBLOCKS_FRAME_OFFSET_V { UNIT PERCENT; MIN -300.0; MAX 300.0; MINSLIDER -100.0; MAXSLIDER 100.0; STEP 1.0; CUSTOMGUI REALSLIDER; }
        }

        // Handheld: organic operator shake (fBm noise).
        GROUP SHOTBLOCKS_GRP_NOISE
        {
            DEFAULT 1;
            BOOL SHOTBLOCKS_NOISE_ENABLED { }
            REAL SHOTBLOCKS_NOISE_STRENGTH { MIN 0.0; MAX 3.0; MINSLIDER 0.0; MAXSLIDER 3.0; STEP 0.01; CUSTOMGUI REALSLIDER; }
            REAL SHOTBLOCKS_NOISE_SPEED { MIN 0.25; MAX 3.0; MINSLIDER 0.25; MAXSLIDER 3.0; STEP 0.05; CUSTOMGUI REALSLIDER; }
            // Contrast: 0% = smooth/even drift, 100% = spiky/punchy bursts.
            REAL SHOTBLOCKS_NOISE_CONTRAST { UNIT PERCENT; MIN 0.0; MAX 100.0; MINSLIDER 0.0; MAXSLIDER 100.0; STEP 1.0; CUSTOMGUI REALSLIDER; }
            LONG SHOTBLOCKS_NOISE_SEED { }
            BOOL SHOTBLOCKS_NOISE_WALKING { }
            REAL SHOTBLOCKS_NOISE_STEP_RATE { MIN 0.5; MAX 4.0; MINSLIDER 0.5; MAXSLIDER 4.0; STEP 0.05; CUSTOMGUI REALSLIDER; }
        }
    }

    // ===================== ZOOM =====================
    GROUP SHOTBLOCKS_GRP_ZOOM
    {
        DEFAULT 1;
        BOOL SHOTBLOCKS_ZOOM_ENABLED { }
        REAL SHOTBLOCKS_ZOOM_RATE { MIN 0.05; MAX 3.0; MINSLIDER 0.05; MAXSLIDER 3.0; STEP 0.01; CUSTOMGUI REALSLIDER; }
        REAL SHOTBLOCKS_ZOOM_STRENGTH { MIN 1.0; MAX 4.0; MINSLIDER 1.0; MAXSLIDER 4.0; STEP 0.01; CUSTOMGUI REALSLIDER; }
        REAL SHOTBLOCKS_ZOOM_HOLD { MIN 0.2; MAX 3.0; MINSLIDER 0.2; MAXSLIDER 3.0; STEP 0.05; CUSTOMGUI REALSLIDER; }
        REAL SHOTBLOCKS_ZOOM_RAMP_IN { MIN 0.05; MAX 1.0; MINSLIDER 0.05; MAXSLIDER 1.0; STEP 0.01; CUSTOMGUI REALSLIDER; }
        REAL SHOTBLOCKS_ZOOM_RAMP_OUT { MIN 0.05; MAX 2.0; MINSLIDER 0.05; MAXSLIDER 2.0; STEP 0.01; CUSTOMGUI REALSLIDER; }
        REAL SHOTBLOCKS_ZOOM_RETURN { MIN 0.0; MAX 1.0; MINSLIDER 0.0; MAXSLIDER 1.0; STEP 0.01; CUSTOMGUI REALSLIDER; }
    }
}
