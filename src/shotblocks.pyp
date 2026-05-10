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
ID_CANVAS = 2000


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
        # The canvas occupies the entire dialog. It draws its own left
        # rail (Snap/Loop toggles, per-track labels) — no separate
        # dialog-level toolbar group.
        self.AddUserArea(
            id=ID_CANVAS,
            flags=c4d.BFH_SCALEFIT | c4d.BFV_SCALEFIT,
            initw=700,
            inith=240,
        )
        self.AttachUserArea(self.canvas, ID_CANVAS)
        # Back-ref so the canvas can ask us to start/stop the playback timer
        # (canvases don't own timers in C4D 2026 — the dialog forwards Timer
        # ticks via _playback_tick).
        self.canvas._playback_owner_dialog = self
        # Mirror the active doc's project frame range into our visible
        # window on open. Subsequent doc-length changes are picked up via
        # CoreMessage(EVMSG_CHANGE).
        try:
            self.canvas._fit_visible_to_doc(force=True)
        except Exception:
            pass
        return True

    # ------------------------------------------------------------------
    # Timer (drives playback AND hover-fade animation)
    # ------------------------------------------------------------------
    #
    # C4D dialogs only support a single SetTimer rate per dialog. We
    # multiplex playback (24 fps when active) and hover-fade animation
    # (~60 fps when active) by always running at 60 fps when EITHER
    # needs ticks; the canvas's _playback_tick internally rate-limits
    # to its own fps.

    _ANIM_TIMER_MS = 16  # ~60 fps when any reason needs ticks

    def _refresh_timer(self):
        """Set the timer rate based on whether anything needs ticking.
        Called whenever playback or hover-animation state changes."""
        needs_anim = bool(self.canvas._shot_hover_anim)
        if self.canvas._playing or needs_anim:
            self.SetTimer(self._ANIM_TIMER_MS)
        else:
            self.SetTimer(0)

    def start_playback_timer(self, fps):
        # Playback uses the unified 60 fps timer; the canvas rate-limits
        # _playback_tick internally. fps argument kept for compatibility.
        self._refresh_timer()

    def stop_playback_timer(self):
        self._refresh_timer()

    def request_anim_tick(self):
        """Canvas calls this when hover animation starts/changes — make
        sure the timer is running so the next frame ticks."""
        self._refresh_timer()

    def Timer(self, msg):
        try:
            if self.canvas._playing:
                self.canvas._playback_tick()
            self.canvas._anim_tick()
            # Stop the timer once nothing needs it anymore.
            self._refresh_timer()
        except Exception as e:
            print("[Shotblocks] Timer tick raised: {}".format(e))
            self.SetTimer(0)
            self.canvas._playing = False
            self.canvas._shot_hover_anim.clear()

    def Command(self, id, msg):
        return c4d.gui.GeDialog.Command(self, id, msg)

    def CoreMessage(self, id, msg):
        # Refresh the canvas on any document mutation — primarily to pick
        # up camera renames in the Object Manager so timeline labels stay
        # in sync. Cheap: a redraw just re-reads our shot list and resolves
        # the camera names through the cache.
        if id == c4d.EVMSG_CHANGE:
            try:
                # If the project's total frame range changed (user dialled
                # in a different length in project settings), refit our
                # visible window. The helper only refits on actual length
                # change, so this won't clobber pan/zoom on unrelated edits.
                self.canvas._fit_visible_to_doc()
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
