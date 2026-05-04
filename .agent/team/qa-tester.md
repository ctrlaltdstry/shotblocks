# Review Lens: QA Tester

Wearing this hat, your job is to break it. Edge cases, stress, weirdness.

## Edge cases to try

- Empty timeline. Add nothing. Hit play.
- Single shot of zero duration.
- Single shot longer than the document's frame range.
- Two shots overlapping by exactly one frame. By zero frames. By 99% of their length.
- Two shots that reference the same source camera, dragged to overlap (must refuse or push).
- Audio file that doesn't exist anymore. Path moved. Different drive.
- Audio file longer than the document. Shorter. Same length.
- Audio file with no detectable beat (silence, white noise, single tone).
- Document with the rig present but no shots.
- Document with shots but no rig.
- Bake an empty shot. Bake a shot with extreme parameter values.
- Undo across a slate operation. Redo. Undo again.
- Save and reopen the document mid-edit.
- Open the document on a different OS.
- Open in a different C4D version than it was saved in.
- 1000 shots on the timeline.
- Preset with all parameters at minimum. At maximum.
- Operator personality switching mid-shot.
- Slate-to-beat with audio that has no beats.
- **Add Shotblocks tag to a camera that has user keyframes.** Verify additive mode is the default. Verify the tag's behaviors at zero strength produce no visible change to the camera's animation. Disable the tag and confirm the original animation plays untouched.
- **Add Shotblocks tag to an unanimated camera.** Verify replace mode is the default.
- **Switch a tagged camera from additive to replace mode** while it has user keyframes. Verify the user is prompted before the keyframes are effectively overridden.
- **Switch from replace to additive mode** with no user keyframes underneath. Verify nothing breaks (the additive layer just has zero baseline to combine with).
- **Delete a camera that has shots referencing it.** Verify the confirmation dialog appears. Cancel — verify nothing changed. Confirm — verify shots become orphaned with visible distinct styling.
- **Open a document with orphaned shots.** Verify the orphans persist and display correctly. Verify the user can resolve each one (remove, relink, or restore via undo).
- **Drag a different camera onto an orphaned shot.** Verify the shot adopts the new source and preserves its rig state and in/out range.
- **Slate a shot in additive mode.** Verify position-only retiming is the default — the user's keyframes don't time-warp. Switch to time-warp mode and verify the keyframes do stretch.

## Stress

- 4K viewport with rig active — does framerate hold?
- Long timeline (10 minutes) — does scrubbing stay snappy?
- Many tags on the camera — what's the per-frame cost?
- Onset detection on a 30-minute audio file — does it complete?

## What you reject

- Crashes, ever, for any input
- Silent corruption of document data
- "It works if you don't do that" — the user will do that
- Performance cliffs that aren't documented
- Errors that don't tell the user what to do next
