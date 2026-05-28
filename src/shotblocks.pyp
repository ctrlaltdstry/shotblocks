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


# Tag plugin id (testing range).
PLUGIN_ID_TAG = 1000001


def _load_icon():
    icon_path = os.path.join(_HERE, "res", "icons", "sb_camera_tag.png")
    bmp = c4d.bitmaps.BaseBitmap()
    result, _ = bmp.InitWith(icon_path)
    if result != c4d.IMAGERESULT_OK:
        print("[Shotblocks] tag icon failed to load: {}".format(icon_path))
    return bmp


if __name__ == "__main__":
    icon = _load_icon()

    c4d.plugins.RegisterTagPlugin(
        id=PLUGIN_ID_TAG,
        str="Shotblocks",
        info=c4d.TAG_VISIBLE | c4d.TAG_EXPRESSION,
        g=ShotblocksTag,
        description="tshotblocks",
        icon=icon,
    )

    print("[Shotblocks] camera rig tag loaded (id={})".format(PLUGIN_ID_TAG))
