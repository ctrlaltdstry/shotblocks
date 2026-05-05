"""Shotblocks plugin entry point.

Bootstrap, plugin registration, the Tag/Dialog/Command classes. Everything
else lives in sibling modules:

    sb_shot_model.py  — pure-Python shot model + overlap resolution
    sb_persistence.py — helper-null state (shots + range)
    sb_canvas.py      — ShotblocksTimelineCanvas (the GeUserArea)

Targets C4D 2026.2.0 on Windows. See `.agent/context/version-control.md`,
`.agent/context/architecture.md`, and the v0–v4c task notes for history.
"""

import os
import sys

import c4d


# Ensure the plugin folder is on sys.path so sibling .py files import cleanly,
# regardless of how C4D's plugin loader sets things up.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from sb_canvas import ShotblocksTimelineCanvas


# Plugin IDs (testing range)
PLUGIN_ID_TAG     = 1000001
PLUGIN_ID_DIALOG  = 1000002
PLUGIN_ID_COMMAND = 1000003

# Tag parameter IDs
SHOTBLOCKS_ENABLED = 1000
SHOTBLOCKS_DAMPING = 1001

# Dialog widget IDs
ID_CANVAS      = 2000
ID_SNAP_TOGGLE = 2001


# ---------------------------------------------------------------------------
# Tag
# ---------------------------------------------------------------------------

class ShotblocksTag(c4d.plugins.TagData):
    def Init(self, node):
        node[SHOTBLOCKS_ENABLED] = True
        node[SHOTBLOCKS_DAMPING] = 0.5
        return True

    def Execute(self, tag, doc, op, bt, priority, flags):
        return c4d.EXECUTIONRESULT_OK


# ---------------------------------------------------------------------------
# Dialog
# ---------------------------------------------------------------------------

class ShotblocksTimelineDialog(c4d.gui.GeDialog):
    def __init__(self):
        super().__init__()
        self.canvas = ShotblocksTimelineCanvas()

    def CreateLayout(self):
        self.SetTitle("Shotblocks")
        # Toolbar row
        if self.GroupBegin(id=0, flags=c4d.BFH_SCALEFIT, cols=8, rows=1):
            self.GroupBorderSpace(4, 4, 4, 4)
            self.AddCheckbox(id=ID_SNAP_TOGGLE,
                             flags=c4d.BFH_LEFT,
                             initw=0, inith=0,
                             name="Snap")
            self.SetBool(ID_SNAP_TOGGLE, self.canvas._snap_enabled)
        self.GroupEnd()
        # Canvas row
        self.AddUserArea(
            id=ID_CANVAS,
            flags=c4d.BFH_SCALEFIT | c4d.BFV_SCALEFIT,
            initw=600,
            inith=200,
        )
        self.AttachUserArea(self.canvas, ID_CANVAS)
        return True

    def Command(self, id, msg):
        if id == ID_SNAP_TOGGLE:
            self.canvas._snap_enabled = self.GetBool(ID_SNAP_TOGGLE)
            print("[Shotblocks] snap toggle = {}".format(self.canvas._snap_enabled))
            return True
        return c4d.gui.GeDialog.Command(self, id, msg)

    def CoreMessage(self, id, msg):
        # Refresh the canvas on any document mutation — primarily to pick
        # up camera renames in the Object Manager so timeline labels stay
        # in sync. Cheap: a redraw just re-reads our shot list and resolves
        # the camera names through the cache.
        if id == c4d.EVMSG_CHANGE:
            try:
                self.canvas.Redraw()
            except Exception:
                pass
        return c4d.gui.GeDialog.CoreMessage(self, id, msg)


# ---------------------------------------------------------------------------
# Command (opens the dialog)
# ---------------------------------------------------------------------------

class OpenShotblocksTimelineCommand(c4d.plugins.CommandData):
    dialog = None

    def Execute(self, doc):
        if self.dialog is None:
            self.dialog = ShotblocksTimelineDialog()
        return self.dialog.Open(
            dlgtype=c4d.DLG_TYPE_ASYNC,
            pluginid=PLUGIN_ID_DIALOG,
            defaultw=600,
            defaulth=240,
        )

    def RestoreLayout(self, sec_ref):
        if self.dialog is None:
            self.dialog = ShotblocksTimelineDialog()
        return self.dialog.Restore(pluginid=PLUGIN_ID_DIALOG, secret=sec_ref)


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

def _load_icon():
    icon_path = os.path.join(_HERE, "res", "icons", "tshotblocks.tif")
    bmp = c4d.bitmaps.BaseBitmap()
    bmp.InitWith(icon_path)
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

    c4d.plugins.RegisterCommandPlugin(
        id=PLUGIN_ID_COMMAND,
        str="Open Shotblocks Timeline",
        info=0,
        help="Open the Shotblocks timeline window",
        dat=OpenShotblocksTimelineCommand(),
        icon=icon,
    )

    print("[Shotblocks] loaded (tag={}, command={}, dialog={})".format(
        PLUGIN_ID_TAG, PLUGIN_ID_COMMAND, PLUGIN_ID_DIALOG))
