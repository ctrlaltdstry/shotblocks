# Pitfalls

Things that have bitten us, or that we know will bite us if we are not careful. Add here when you find one. The next person reading this saves an afternoon.

## Performance

- **Per-frame tag code is hot.** Every line of Python in a `TagData.Execute` runs every frame. Vectorize math, cache references, avoid scene traversal.
- **Don't walk the scene graph in tag execution.** Cache target object references on tag init (`Init` or when the user changes the target). Re-walking the scene every frame tanks viewport performance.
- **Waveform redraws are expensive.** Cache as a bitmap. Only regenerate on audio change or zoom change.

## C4D specifics

- **Directory junctions in the plugins folder don't load reliably.** `mklink /J` from `%APPDATA%\Maxon\...\plugins\` to a source tree does not produce a plugin C4D will consistently load on this dev box, despite junctions being filesystem-level reparse points (not `.lnk` shortcuts) that most apps treat as regular folders. C4D's plugin loader appears to skip them. Use copy-on-deploy via `scripts/deploy.ps1` instead. Verified during v0.
- **C4D 2026 prefs folder name has a build-hash suffix.** The folder is `Maxon Cinema 4D 2026_<hash>` (e.g. `Maxon Cinema 4D 2026_1ABCDC12`), not `Cinema 4D 2026`. The hash is install-specific and may change after a C4D update. If `deploy.ps1` starts failing after a Maxon update, check the path first.
- **`RegisterTagPlugin(description=...)` fails without `res/c4d_symbols.h` and `res/strings_en-US/c4d_strings.str`.** The error reads `RuntimeError: Could not initialize global resource for the plugin.` Even when the per-tag `.res`/`.h`/`.str` files exist, C4D won't load them unless the plugin-wide *global* resource bundle initializes first — and the bundle requires those two stub files to exist. Empty bodies are fine (`enum { _DUMMY_ = 10000 };` and `STRINGTABLE 0 { }`). Caught during v0 — both stubs are now part of the canonical plugin layout in `c4d-plugin-development.md`.
- **Sibling Python modules and `Reinit Plugins`.** Shotblocks splits across `shotblocks.pyp` + `sb_*.py` modules (added in v4c). Sibling imports work because the .pyp inserts its own folder into `sys.path` on load. Caveat: if the user reloads plugins in-process via *Extensions → Reinit Plugins* (or similar), C4D may re-execute the `.pyp` but keep stale references to the cached sibling modules. The dev-loop force-restarts C4D every deploy via `scripts/dev-loop.ps1`, which sidesteps this entirely. If anyone tries reinit-without-restart and hits weird half-old behavior, force-restart C4D and try again.

Likely future candidates:
- Undo stack interactions with procedural rig parameter changes
- Threading model for audio decoding vs main-thread C4D calls
- Document save/load with custom containers
- Viewport refresh timing during scrub

## Math

- **Spring-damper at low framerates.** Naïve Euler integration explodes at large `dt`. Use semi-implicit or substep when `dt > threshold`.
- **Critical damping formula.** `damping = 2 * sqrt(stiffness * mass)`. Forgetting the mass term gives wrong feel when stiffness changes.
- **Onset detection false positives.** Bass-heavy tracks generate onsets that are not beats. Confirm BPM with autocorrelation before placing the grid.

## Architecture

- **Don't mix sequencer logic into the rig generator.** The rig is dumb — it has parameters and behaviors. The sequencer drives the parameters. Keeping these separate is what makes bake-down clean.
- **Shot blocks must be self-contained.** Resist the temptation to let one shot reference state from another. Hard cuts are the only cross-shot mechanism.
- **In additive mode, never modify the user's keyframes.** The Shotblocks tag reads the camera's animated values and produces deltas. Writing back to the camera's keyframes corrupts the user's work and breaks the "disable the tag to see your original animation" guarantee. The tag's outputs go into the rig hierarchy or modifier layer, never onto the camera's animation tracks.
- **Slate in additive mode defaults to position-only.** Time-warping the user's animation by default would feel hostile — they keyframed at specific timing for a reason. Default to position-only (move the shot on the timeline, keep its internal duration); offer time-warp as an explicit opt-in.
- **Look-at and framing rule in additive mode are corrective, not absolute.** They produce small offsets toward the target, not full rotation replacement. Otherwise additive mode silently becomes replace mode for those behaviors and the user's animation gets overridden.
- **Orphaned shots survive save/load.** When a camera is deleted, the shots referencing it become orphaned but persist in the document. The persistence layer must serialize the camera reference (by name/ID) so the orphan can be displayed and resolved across sessions. Silently dropping orphaned shots on save is a data-loss bug.
- **Camera deletion intercepts user action.** Shotblocks must hook into the camera's deletion path to show the "this camera is referenced by N shots" confirmation. If the hook fails or is bypassed, shots become silently orphaned without the user being told. Test that the confirmation appears for: keyboard delete, right-click delete, hierarchy-collapse delete, and undo-then-redo-of-deletion.
