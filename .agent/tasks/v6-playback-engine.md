# v6 — Spacebar playback engine

Spacebar plays from playhead → out-point of the play range, advancing the
playhead one frame per `1/fps` seconds, routing the active shot's source
camera to the viewport on each tick. First time the cursor (the playhead)
is the active object during real time.

## Scope

1. **Spacebar = play/pause toggle.** Keyboard handler swallows space (no
   modifiers), flips `_playing` between True/False. Stops auto-resume when
   the user presses any other transport-affecting key (I/O re-enter the
   range without stopping, since that's a non-disruptive intent).
2. **Dialog `Timer()` drives frame advance.** `ShotblocksTimelineDialog`
   gains a `Timer()` method. We call `SetTimer(int(1000 / fps))` when
   playback starts, `SetTimer(0)` when it stops. On each tick: advance
   `canvas.playhead_frame` by 1, push to `doc.SetTime(BaseTime(frame, fps))`,
   redraw the canvas. (The timer is on the dialog because canvases don't
   own timers in C4D 2026; the dialog forwards ticks via a method call.)
3. **Active-shot camera routing.** On each tick, resolve
   `_active_shot_at(shots, frame)`. If non-None and the shot's BaseLink
   resolves, set that camera as the active BaseDraw camera via
   `bd[c4d.BASEDRAW_DATA_CAMERA] = cam`. If the resolution returns None
   (gap between shots) or the shot is orphan, leave the current camera
   untouched — hold last good, keep playing. The dashed-red orphan block
   on the timeline is the signal that this section is broken; switching
   to a black frame mid-playback would be more disruptive than helpful.
4. **Stop at out-point.** When `playhead_frame >= range_out`, stop:
   `_playing = False`, `SetTimer(0)`, leave the playhead at the out frame.
   Second spacebar from there resumes from in-point (cursor outside range
   on play-start → snap to in-point per DAW convention).
5. **Snap-to-range-in when starting outside.** If the user hits spacebar
   while the playhead is outside `[range_in, range_out)`, the first action
   is to set `playhead_frame = range_in`. The second spacebar press would
   then pause as usual.
6. **Pause = stop where you are.** Second spacebar stops; third resumes
   from the same frame.

## Out of scope

- **Loop playback.** Needs a loop-toggle UI button. Defer with that
  control; v6 always stops at out-point.
- **Real-time audio sync.** No audio subsystem yet. v7+.
- **Sub-frame timing.** Integer frames at the doc's FPS. C4D's render is
  per-frame anyway.
- **Backwards play / J-K-L.** Single direction in v6.
- **Shotblocks tag pipeline / rig math.** There is no tag execution yet;
  v6 plays back each camera's own animation directly. Per architecture,
  untagged passthrough.

## Implementation outline

### `sb_canvas.py`

- New instance attrs in `__init__`:
  - `self._playing = False`
  - `self._playback_owner_dialog = None` (back-ref so the canvas can ask
    the dialog to start/stop its timer; set by the dialog after attach).
- New `_toggle_playback()` method:
  - If currently playing → stop: `_playing = False`, ask dialog to stop
    timer.
  - If currently paused: resolve doc, range. If
    `playhead_frame < range_in` or `>= range_out`, snap to `range_in`.
    Set `_playing = True`, ask dialog to start timer at the doc's FPS.
- New `_playback_tick()` method (called from dialog's `Timer()`):
  - Read doc, range, shots.
  - `playhead_frame += 1`. If `playhead_frame >= range_out`, stop.
  - `doc.SetTime(c4d.BaseTime(playhead_frame, fps))`.
  - Resolve active shot at the new frame. If non-None and its camera
    resolves (not orphan), push to active BaseDraw via
    `bd[c4d.BASEDRAW_DATA_CAMERA] = cam`. Else leave camera alone.
  - `c4d.EventAdd()` so the viewport renders.
  - `self.Redraw()` so the timeline UI advances.
- Keyboard handler `_on_keyboard`: handle `channel == ord(' ')` (or
  whatever 2026 reports for space — verify empirically and log on first
  press) with no modifier; call `_toggle_playback()`. Returns True.

### `shotblocks.pyp` (the dialog)

- Override `Timer(self, msg)` — calls `self.canvas._playback_tick()`. C4D
  invokes `Timer` at the cadence set by `SetTimer(ms)`.
- Helper methods on the dialog: `start_playback_timer(fps)` and
  `stop_playback_timer()`. These wrap `self.SetTimer(int(1000 / fps))`
  and `self.SetTimer(0)` so the canvas doesn't need to know about the
  dialog's timer mechanics directly.
- After `AttachUserArea(self.canvas, ID_CANVAS)`, set
  `self.canvas._playback_owner_dialog = self` so the canvas has the back-
  ref for start/stop.

### `sb_shot_model.py`

- The existing `_active_shot_at(shots, frame)` already returns the
  highest-track shot covering `frame` (or None). v6 uses it as-is. Make
  sure it's exported in the `from sb_shot_model import (...)` block in
  `sb_canvas.py`.

## Manual test plan

1. **Single-shot playback.** Create a shot from frame 0 to 48 with a
   camera pointed at the cube. Press Space. Playhead advances at 24 fps,
   the viewport renders that camera's view, playback stops at frame 48
   (or wherever the play-range out is).
2. **Multi-shot playback.** Create three shots from three different
   cameras, end-to-end on track 0. Space. Viewport switches to the
   correct camera at each shot boundary. No flicker mid-shot.
3. **Pause + resume.** Hit Space mid-playback. Playhead stops, viewport
   freezes on current camera. Second Space → continues from same frame.
4. **Outside-range start.** Drag the playhead past the out-point. Hit
   Space. Playhead snaps to range-in and starts there.
5. **Stop at out-point.** Let playback run to the out-point. Verify it
   stops cleanly (no overshoot, `_playing = False`, timer cleared —
   confirmed by spamming Space after and seeing it restart from in).
6. **Orphan-during-playback.** Create three shots; let playback start.
   Mid-playback delete the camera under the second shot. The shot flips
   to dashed-red on the timeline; the viewport keeps showing whatever
   camera was last active and time keeps advancing. When playback enters
   the third shot, it switches to that camera normally.
7. **Cross-track playback.** Stack a shot on track 1 over a shot on
   track 0. Top track wins per the resolver. Space. Viewport shows the
   track-1 camera during the overlap.
8. **No-shots playback.** Empty timeline. Space. Playhead advances; no
   camera switching happens (we never had one to switch from). Stops at
   range-out.

## Architecture notes

- This is the first feature to touch `doc.SetTime` and the active
  BaseDraw's camera. v6 establishes the pattern; v7+ (audio playback
  sync) will hook into the same `_playback_tick` site.
- Shotblocks tags do not run yet. Cameras play back their own animation
  directly per architecture's untagged-passthrough rule. When the rig
  pipeline lands, the tick path will need a per-shot rig-state push
  before C4D evaluates the camera.

## Definition of done

- All eight manual tests pass on C4D 2026.2.0 / Windows.
- `current-task.md` advances to "v6 complete; pick v7."
- `architecture.md` "Data flow per frame" section gets a one-line note
  that v6 implements steps 1, 2, and 4 (untagged passthrough); steps 3,
  5, 6 await the tag pipeline.
