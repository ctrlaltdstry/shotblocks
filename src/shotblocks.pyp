"""Shotblocks plugin entry point — camera rig tag only.

The v1 Python timeline UI has been retired; v2 (the C++ plugin under
host/shotblocks_v2/ with its WebView2 React UI) owns the timeline now.
This Python plugin's only job is the ShotblocksTag — the per-camera
TagData that runs spring/damper, quat look-at, fBm noise, autofocus,
framing, and zoom every frame. Until the rig math ports to C++, the
tag stays in Python.

Targets C4D 2026.2.0 on Windows.
"""

import os
import sys

import c4d


# Ensure the plugin folder is on sys.path so sibling rig modules import
# cleanly regardless of how C4D's plugin loader sets things up.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from sb_rig_tag import ShotblocksTag
from sb_motion_tag import ShotblocksMotionTag


# Tag plugin ids (testing range).
PLUGIN_ID_TAG = 1000001         # camera rig tag
PLUGIN_ID_MOTION_TAG = 1000002  # object motion tag


def _load_icon(filename):
    icon_path = os.path.join(_HERE, "res", "icons", filename)
    bmp = c4d.bitmaps.BaseBitmap()
    result, _ = bmp.InitWith(icon_path)
    if result != c4d.IMAGERESULT_OK:
        print("[Shotblocks] tag icon failed to load: {}".format(icon_path))
    return bmp


if __name__ == "__main__":
    cam_icon = _load_icon("sb_camera_tag.png")
    motion_icon = _load_icon("sb_motion_tag.png")

    c4d.plugins.RegisterTagPlugin(
        id=PLUGIN_ID_TAG,
        str="Shotblocks",
        info=c4d.TAG_VISIBLE | c4d.TAG_EXPRESSION,
        g=ShotblocksTag,
        description="tshotblocks",
        icon=cam_icon,
    )

    print("[Shotblocks] camera rig tag loaded (id={})".format(PLUGIN_ID_TAG))

    # Object motion tag — applies to ANY object (no object-type filter),
    # smooths animated pos/rot/scale + adds handheld noise. Reuses the
    # same rig engines. See sb_motion_tag.py and
    # .agent/plans/motion-tag-object.md.
    c4d.plugins.RegisterTagPlugin(
        id=PLUGIN_ID_MOTION_TAG,
        str="Shotblocks Motion",
        info=c4d.TAG_VISIBLE | c4d.TAG_EXPRESSION,
        g=ShotblocksMotionTag,
        description="tsbsmooth",
        icon=motion_icon,
    )

    print("[Shotblocks] object motion tag loaded (id={})".format(PLUGIN_ID_MOTION_TAG))
