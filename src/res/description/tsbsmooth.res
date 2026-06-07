CONTAINER Tsbsmooth
{
    NAME Tsbsmooth;

    INCLUDE Texpression;

    GROUP ID_TAGPROPERTIES
    {
        BOOL SBMOTION_ENABLED { }

        GROUP SBMOTION_GRP_INERTIA
        {
            DEFAULT 1;
            BOOL SBMOTION_INERTIA_ENABLED { }
            REAL SBMOTION_WEIGHT    { UNIT PERCENT; MIN 0.0; MAX 100.0; MINSLIDER 0.0; MAXSLIDER 100.0; CUSTOMGUI REALSLIDER; }
            REAL SBMOTION_DRIFT     { UNIT PERCENT; MIN 0.0; MAX 100.0; MINSLIDER 0.0; MAXSLIDER 100.0; CUSTOMGUI REALSLIDER; }
            REAL SBMOTION_LEAN      { UNIT PERCENT; MIN 0.0; MAX 100.0; MINSLIDER 0.0; MAXSLIDER 100.0; CUSTOMGUI REALSLIDER; }
            REAL SBMOTION_TURN_EASE { UNIT PERCENT; MIN 0.0; MAX 100.0; MINSLIDER 0.0; MAXSLIDER 100.0; CUSTOMGUI REALSLIDER; }
        }

        GROUP SBMOTION_GRP_NOISE
        {
            DEFAULT 1;
            BOOL SBMOTION_NOISE_ENABLED { }
            // Amount: intensity. Hard cap raised to 10 (was 3) so big shakes
            // are reachable; soft slider tops out at 5 for everyday range.
            REAL SBMOTION_NOISE_STRENGTH { MIN 0.0; MAX 10.0; MINSLIDER 0.0; MAXSLIDER 5.0; STEP 0.01; CUSTOMGUI REALSLIDER; }
            // Speed: how fast the shake moves (slow drift -> fast jitter).
            REAL SBMOTION_NOISE_SPEED { MIN 0.1; MAX 5.0; MINSLIDER 0.1; MAXSLIDER 5.0; STEP 0.05; CUSTOMGUI REALSLIDER; }
            // Contrast: 0% = smooth/even/rounded, 100% = spiky/punchy bursts.
            REAL SBMOTION_NOISE_CONTRAST { UNIT PERCENT; MIN 0.0; MAX 100.0; MINSLIDER 0.0; MAXSLIDER 100.0; STEP 1.0; CUSTOMGUI REALSLIDER; }
            LONG SBMOTION_NOISE_SEED { }
        }

        GROUP SBMOTION_GRP_ADVANCED
        {
            DEFAULT 0;
            REAL SBMOTION_SUBSTEP_THRESHOLD { MIN 1.0; MAX 240.0; STEP 1.0; }
            BOOL SBMOTION_RESET_ON_BOUNDARY { }
        }
    }
}
