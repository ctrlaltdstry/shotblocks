# Workflow: Adding a New Preset Shot

## 1. Confirm scope

Does this preset belong? Check:
- Is the shot type defined in `domain.md`? If not, define it there first.
- Does it fit the timeline metaphor (i.e., it is a shot block with parameters)?
- Is it distinct enough from existing presets to justify its own entry, or is it a parameter variation of an existing one?

If it's a parameter variation, add it as a saved sub-preset of the parent, not a new top-level entry.

## 2. Define the parameter set

In `presets/<name>.json`:
- Name, category, description
- Parameter list (5–7 max — see constitution principle 6 commentary)
- Default values
- Parameter ranges and units
- Default duration in beats (or seconds if no audio)
- Whether it supports beat-sync
- Default operator personality

## 3. Implement the motion

- If it uses existing rig behaviors (spring-damper, look-at, noise, framing), the preset is just a parameter configuration — no new code.
- If it requires new motion logic, that goes in `src/sequencer/preset_motion/<name>.py`. Behaviors stay in tags; preset motion is the time-varying parameter curve that the sequencer feeds to the rig.

## 4. Generate a thumbnail

Run the thumbnail generator against the preset using the abstracted scene (`scenes/preset_thumb_scene.c4d`). The result is a sprite-strip or animated GIF cached alongside the JSON.

## 5. Test

- Drag the preset onto an empty timeline. Does it produce a usable shot at default settings?
- Stretch the shot block to half and double duration. Does the motion still feel right?
- Toggle beat-sync (if supported). Do the key moments land on beats?
- Bake the shot to a standard camera. Are the curves clean?

## 6. Run the new-preset checklist

`.agent/checklists/new-preset-quality.md`

## 7. Review through the cinematographer or motion designer lens

For story-driven shots: cinematographer lens. For motion-graphics-centric: motion designer.
