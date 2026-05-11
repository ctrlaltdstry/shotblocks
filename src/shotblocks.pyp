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
from sb_rig_tag import ShotblocksTag


# Plugin IDs (testing range).
#
# The command and the dialog share a single ID. C4D's layout-restore
# tags each docked/floating async dialog slot with the plugin ID we
# passed to GeDialog.Open(); on restart C4D iterates registered command
# plugins by ID looking for the owner of each slot. Different IDs here
# means C4D never matches our command to the saved slot and the user
# sees "Plugin not found" until they reopen via the menu.
PLUGIN_ID_TAG     = 1000001
PLUGIN_ID_COMMAND = 1000003
PLUGIN_ID_DIALOG  = PLUGIN_ID_COMMAND

# Tag parameter IDs are defined in sb_rig_tag.py (and the .res file).
# ShotblocksTag itself is imported from there.

# Dialog widget IDs
ID_CANVAS = 2000


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
            inith=320,  # v7: 240 was too short — audio block (96 px below
                       # track 0) clipped at the default size. 320 fits
                       # the full audio block in.
        )
        self.AttachUserArea(self.canvas, ID_CANVAS)
        # Back-ref so the canvas can ask us to start/stop the playback timer
        # (canvases don't own timers in C4D 2026 — the dialog forwards Timer
        # ticks via _playback_tick).
        self.canvas._playback_owner_dialog = self
        # The plugin id the v9 analysis worker thread fires via
        # `c4d.SpecialEventAdd` to wake the main thread on completion;
        # CoreMessage matches on this id and drains the result.
        self.canvas._analysis_complete_event_id = PLUGIN_ID_COMMAND
        # Separate id for the zoom-driven peak-cache rebuild worker so
        # the CoreMessage handler can tell the two signals apart.
        # PLUGIN_ID_TAG is otherwise unused at runtime (it's only
        # referenced as the BaseTag's id at registration time).
        self.canvas._peak_rebuild_event_id = PLUGIN_ID_TAG
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

    _ANIM_TIMER_MS = 16   # ~60 fps for hover-fade + playback

    def _refresh_timer(self):
        """Set the timer rate based on what's currently active.

        Hover-fade and playback need the 60 fps timer for smooth
        motion. The v9 analysis busy overlay does NOT use the timer
        — every Timer tick in C4D 2026 contends with the worker
        thread for the GIL (testing showed a 60 fps timer made a
        10 s analysis run for 60 s; even 7 fps cost ~2x). The
        analysis worker signals completion via SpecialEventAdd →
        CoreMessage instead, so we keep the timer fully off while
        it runs.
        """
        needs_anim = bool(self.canvas._shot_hover_anim)
        # When playback stops, the right-side dB meter decays toward
        # FLOOR_DBFS over ~1.5s. Keep the timer running until the
        # decay completes so each tick advances the bars; without
        # this the meter would freeze at the last drawn level after
        # a single post-stop redraw. We test against the displayed
        # levels list (populated by `_draw_db_meter`).
        from sb_audio_meter import FLOOR_DBFS as _FLOOR
        meter_decay = any(
            db > _FLOOR for db in self.canvas._meter_displayed_db
        )
        # Pending peak-cache rebuild needs the timer alive until the
        # debounce window elapses and the worker is kicked off. The
        # worker itself signals completion via SpecialEventAdd so the
        # timer can sleep again while it runs.
        peak_rebuild_pending = self.canvas._pending_peak_rebuild_t > 0.0
        if (self.canvas._playing or needs_anim or meter_decay
                or peak_rebuild_pending):
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
            playing = self.canvas._playing
            if playing:
                self.canvas._playback_tick()
            self.canvas._anim_tick()
            # When stopped but the dB meter is still decaying, force
            # a redraw so the meter's per-frame state advance fires
            # and the bars visibly drop toward FLOOR_DBFS. _playback_tick
            # already redraws during playback so this only kicks in
            # during the post-stop decay window.
            if not playing:
                from sb_audio_meter import FLOOR_DBFS as _FLOOR
                if any(db > _FLOOR for db in self.canvas._meter_displayed_db):
                    self.canvas.Redraw()
            # Debounced peak-cache rebuild: if a zoom event posted a
            # `_pending_peak_rebuild_t` and the debounce has elapsed,
            # spawn the worker now. Cheap when nothing is pending.
            self.canvas._maybe_kick_peak_rebuild()
            # Note: analysis-completion polling is NOT done here —
            # the worker fires SpecialEventAdd → CoreMessage which
            # calls `_poll_analysis_thread` directly. Keeping the
            # timer dispatch lean lets the worker have the GIL.
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
                # Suppress redraws while C4D's native playback is
                # running. EVMSG_CHANGE fires on every animation frame,
                # and a full canvas redraw (every shot block + waveform
                # + meter + camera-name resolution) is expensive enough
                # to make C4D's viewport playback visibly stutter. Our
                # playhead is independent of doc.GetTime() during
                # C4D-native playback (Shotblocks's own spacebar uses
                # its own clock), so we don't lose anything by
                # skipping. A redraw on stop catches the canvas back up.
                doc = c4d.documents.GetActiveDocument()
                if (doc is not None
                        and doc.GetPlayMode() != c4d.DOCUMENT_PLAYMODE_INACTIVE):
                    return c4d.gui.GeDialog.CoreMessage(self, id, msg)
                # If the project's total frame range changed (user dialled
                # in a different length in project settings), refit our
                # visible window. The helper only refits on actual length
                # change, so this won't clobber pan/zoom on unrelated edits.
                self.canvas._fit_visible_to_doc()
                self.canvas.Redraw()
            except Exception:
                pass
        elif id == PLUGIN_ID_COMMAND:
            # v9 analysis worker → main-thread completion signal. The
            # worker thread fires `c4d.SpecialEventAdd(PLUGIN_ID_COMMAND)`
            # when done, and that delivers a CoreMessage with `id` set
            # to our plugin id. We use it as a signal to drain the
            # worker's result on the main thread (where the c4d API
            # is safe to call). No timer needed during analysis —
            # the worker had full CPU until this fires.
            try:
                self.canvas._poll_analysis_thread()
            except Exception as e:
                print("[Shotblocks] analysis completion handler raised: {}".format(e))
        elif id == PLUGIN_ID_TAG:
            # Zoom-driven peak-cache rebuild worker → completion signal.
            # The worker built a new PeakCache at a finer
            # samples_per_column matching the current zoom; drain it
            # onto the AudioTrack and redraw so the waveform paints at
            # the new resolution.
            try:
                self.canvas._drain_peak_rebuild()
            except Exception as e:
                print("[Shotblocks] peak-rebuild handler raised: {}".format(e))
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
            c4d.DLG_TYPE_ASYNC, PLUGIN_ID_DIALOG,
            defaultw=600, defaulth=320,
        )

    def RestoreLayout(self, sec_ref):
        try:
            if self.dialog is None:
                self.dialog = ShotblocksTimelineDialog()
            return self.dialog.Restore(PLUGIN_ID_DIALOG, sec_ref)
        except Exception as e:
            print("[Shotblocks] RestoreLayout raised: {}".format(e))
            return False


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
