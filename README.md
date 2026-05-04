# Shotblocks

A Cinema 4D plugin for camera animation, built around a timeline-based shot sequencer with physically-grounded motion, beat-synced behavior, and a preset shot library.

The product is named after **blocking** — the film-craft term for the iterative process of figuring out where shots land. Shotblocks lets you block out a sequence of camera shots on a timeline, try different cameras and presets, sync them to music, and bake the result down to a clean C4D camera ready to render.

The signature interaction is **slate** — a non-destructive verb that aligns shots to the rhythm of the music using motion-energy peaks as the alignment signal. Hit `S`, watch shots commit to the beat. The plugin authors hard cuts only; transitions live downstream in your NLE.

See `.agent/constitution.md` for the project principles.
See `.agent/router.md` for navigating the agent context.
See `.agent/context/architecture.md` for the system design.

## Status

Early scaffolding. No code yet — currently establishing the operating context and architecture.

## Repository layout

- `.agent/` — operating context for AI-assisted development
- `presets/` — preset shot definitions (JSON) and thumbnails
- `scenes/` — test scenes and reference C4D files
- `reference/` — inspirational footage, gyro recordings, reference renders
- `src/` — plugin source code (to come)
