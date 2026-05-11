CONTAINER Tshotblocks
{
    NAME Tshotblocks;

    INCLUDE Texpression;

    GROUP ID_TAGPROPERTIES
    {
        BOOL SHOTBLOCKS_ENABLED { }
        LONG SHOTBLOCKS_MODE
        {
            CYCLE
            {
                SHOTBLOCKS_MODE_ADDITIVE;
                SHOTBLOCKS_MODE_REPLACE;
            }
        }

        GROUP SHOTBLOCKS_GRP_DAMPING
        {
            DEFAULT 1;
            REAL SHOTBLOCKS_DAMPING_POS { MIN 0.0; MAX 1.0; STEP 0.01; }
            REAL SHOTBLOCKS_DAMPING_ROT { MIN 0.0; MAX 1.0; STEP 0.01; }
        }

        GROUP SHOTBLOCKS_GRP_LOOK_AT
        {
            DEFAULT 1;
            LINK SHOTBLOCKS_LOOK_AT_TARGET { ACCEPT { Obase; } }
            LINK SHOTBLOCKS_UP_TARGET      { ACCEPT { Obase; } }
            REAL SHOTBLOCKS_LOOK_AT_STRENGTH { MIN 0.0; MAX 1.0; STEP 0.01; }
            REAL SHOTBLOCKS_LOOK_AT_ROLL { UNIT DEGREE; MIN -180.0; MAX 180.0; STEP 1.0; }
            BOOL SHOTBLOCKS_BANK_INTO_TURNS { }
        }

        // Empty group host. The Frame Offset 2D joystick is a
        // programmatic UserData slot reparented into this group at
        // tag-apply time — see _ensure_frame_offset_userdata.
        // CUSTOMGUI_VECTOR2D can't be applied via .res; reparenting
        // the UD slot here is the only path to keep the widget in
        // the main tag interface (not in a separate User Data tab).
        GROUP SHOTBLOCKS_GRP_FRAMING
        {
            DEFAULT 1;
        }

        GROUP SHOTBLOCKS_GRP_ADVANCED
        {
            DEFAULT 0;
            REAL SHOTBLOCKS_SUBSTEP_THRESHOLD { MIN 1.0; MAX 240.0; STEP 1.0; }
            BOOL SHOTBLOCKS_RESET_ON_BOUNDARY { }
        }
    }
}
