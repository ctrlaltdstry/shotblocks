# Open questions

Decisions we've explicitly deferred. The purpose of this file is so they don't get lost. When a question is resolved, move it to the relevant context document and remove it from here.

A question earns its place here when it's:
- Real (someone will need to answer it before shipping)
- Specific enough to be answered (not "what should the plugin do")
- Not blocking current work

If a question is blocking, it stops being open and starts being a task.

## Implementation choices not yet made

### Resource files vs. programmatic descriptions
The Shotblocks tag's parameters can be defined declaratively in a `.res` file (with a matching `.h` and `.str`) or programmatically via `GetDDescription`. We've recommended `.res` for stability and localization, but resource files have more boilerplate and require coordinated edits across three files. Programmatic descriptions are more flexible but have to be re-derived on each call. **Decide before parameter set grows beyond ~10 fields.**

### Audio decoder
Bundled C extension, pure Python WAV-only with a bundled MP3/AAC decoder, or a system-codec dependency? Each has tradeoffs: licensing, performance, distribution size. (Cross-platform parity is currently not a concern — we are Windows-only for v0 — but it returns to the table when macOS support starts.) **Decide before audio subsystem implementation begins.** Licensing implications connect to `licensing.md`.

## Architectural questions not yet resolved

### Single tag vs. tag-per-mode
The Shotblocks tag has two modes (additive, replace). One unified tag with a mode parameter is simpler but means the Attribute Manager shows fields irrelevant to the active mode. Two separate tags would be cleaner but complicate the data model and the user's mental model. **Currently committed to single tag with mode parameter; revisit if Attribute Manager becomes unwieldy.**

### Scene-relative vs. absolute audio paths
Currently planning project-relative when possible, absolute fallback. Edge case: documents moved between machines or version control systems. **Decide on the exact behavior when the relative path can't be resolved on load.**

### Bake-down output naming
When a user bakes a shot or sequence, the output is a new C4D camera. Naming convention: append "_baked"? Use the shot name? Use the source camera name + suffix? **Decide before bake-down implementation.**

## Product questions not yet resolved

### Default operator personality
We have a list of personalities (steady veteran, nervous documentarian, music-video energetic, etc.) but no default chosen. The default sets the first-impression character of the plugin. **Decide based on v1 user testing or by editorial choice before ship.**

### Default action-weighting in motion energy
Translational vs. rotational vs. acceleration weights for the motion-energy curve. Currently 0.3/0.5/0.2 favoring rotation. This is a tuning call that affects how slate behaves on real shots. **Validate against a corpus of real shots once those exist.**

### Preset library — first 12
What ships in v1? We have a long list of candidates (orbit, dolly, crane, dolly-zoom, push-in, pull-out, whip pan, reveal, parallax, plus motion-graphics-specific ones). **Pick the v1 set when approaching v1 milestone.**

### Live-performance Phase 1 — record-trigger model
Arm-and-play (capture frame-by-frame against the timeline, beat-grid friendly) vs free real-time (perform in wall-clock, resample after). Recommend prototyping arm-and-play first. **Decide before building the Phase 1 record path.** See the roadmap's Phase 1 open-questions.

## How to use this file

When you encounter one of these questions during work, link to its entry from your task notes. When you make a decision, update the appropriate context doc *and* remove the entry from here. Do not let resolved questions linger — the file's value is that everything in it is currently unanswered.

If you encounter a *new* open question, add it here with enough context that the next person can resume the conversation without having lived through the original discussion.
