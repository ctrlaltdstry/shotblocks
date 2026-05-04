CONTAINER Tshotblocks
{
    NAME Tshotblocks;

    INCLUDE Texpression;

    GROUP ID_TAGPROPERTIES
    {
        BOOL SHOTBLOCKS_ENABLED { }
        REAL SHOTBLOCKS_DAMPING { MIN 0.0; MAX 1.0; STEP 0.01; }
    }
}
