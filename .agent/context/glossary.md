# Glossary

Shared vocabulary for this project. When in doubt, use these terms exactly. When a new concept is introduced, add it here before using it elsewhere.

## Core objects

**Rig** — The hierarchy of nulls that the Shotblocks tag generates as children of the user's camera, providing the procedural motion structure: `world → boom → pan → tilt → camera`. Each null has a specific responsibility; do not collapse them. The rig only exists when the user has applied a Shotblocks tag to their camera; cameras without the tag do not have a rig and play back their own animation directly.

**Shot** — A reference to one of the user's cameras observed over a defined frame range on the timeline. The atomic unit of the sequencer. A shot has an in-point, an out-point, a reference to its source camera, and (if the camera has a Shotblocks tag) a per-shot rig state.

**Shot block** — The visual representation of a shot on the timeline. Used interchangeably with "shot" when context makes clear we mean the UI element.

**Source camera** — The C4D camera object that a shot references. Lives in the user's Object Manager; created and managed by the user, not by Shotblocks. A single source camera can be referenced by multiple shots, each with its own in/out range and (if applicable) rig state.

**Shotblocks tag** — An optional tag the user applies to a camera (via right-click → Tags → Shotblocks, or the Tags menu — standard C4D tag application) to enable the Shotblocks procedural behaviors (spring-damper smoothing, autofocus, noise profiles, framing rules, preset motion, slate alignment). The tag exposes per-camera defaults and per-shot overrides. Operates in either additive mode or replace mode; see those entries.

**Additive mode** — Shotblocks tag mode where the user's existing animation is the baseline and the procedural pipeline produces deltas (small offsets in position, rotation, focal length, focus) that are added to the user's animated values each frame. The user's keyframes are never modified. Default mode when applied to a camera with prior animation. Lets users add Shotblocks polish (noise, drift, damping) on top of animation they've already authored.

**Replace mode** — Shotblocks tag mode where the procedural pipeline drives the camera entirely; user keyframes are ignored while in this mode. Default mode when applied to an unanimated camera, or when the user opts in. Used when the user wants presets and procedural motion to fully define the shot.

**Procedural delta** — In additive mode, the per-frame offset a behavior adds to the user's animated value. Spring damping produces a small position/rotation correction; noise produces a position/rotation jitter; autofocus produces a focus-distance offset. Deltas combine additively across behaviors.

**Orphaned shot** — A shot whose source camera has been deleted from the document. Visually distinct on the timeline (dashed outline, muted color). Cannot play back. Resolved by removing the shot, relinking to another camera, or undoing the camera deletion.

**Sequence** — The full ordered set of shots on the timeline. What renders out as the final piece. Shots in a sequence are joined by hard cuts only.

**Cut** — The boundary between two adjacent shots. The previous shot ends at frame N; the next begins at frame N+1. There is no transition object, no overlap, no blend. The plugin authors only hard cuts.

**Preset** — A parameterized shot template (orbit, dolly zoom, crane, etc.) that can be dragged onto the timeline to create a new shot block. Ships with the plugin or is user-saved.

**Operator personality** — A named bundle of rig parameters (damping, noise profile, reaction time, framing tightness) that defines a "feel" for camera motion. Examples: steady veteran, nervous documentarian, music video energetic. Selectable per shot.

## Motion concepts

**Spring-damper** — The physical model used for non-robotic motion. Camera position and rotation are treated as masses on virtual springs anchored to target values, with configurable stiffness and damping.

**Critically damped** — Spring-damper tuning where motion settles smoothly without overshoot. Default for cinematic feel.

**Underdamped** — Spring-damper tuning where motion overshoots and settles. Used sparingly for organic / handheld feel.

**Noise profile** — A calibrated noise pattern (frequency, amplitude, axis weighting) that simulates a specific real-world camera condition. Distinct from generic Perlin noise.

**Sidechain** — Audio amplitude or a specific frequency band driving a rig parameter directly, not via markers. E.g., kick drum amplitude → shake intensity.

## Audio concepts

**Marker** — A timed point on the timeline used as a snap target. Types: beat (auto from audio), manual (user-placed), sim event (auto from cache), scene (from C4D markers).

**Onset** — A detected attack in the audio waveform. Source for beat markers. Onset detection ≠ beat detection — onsets are the raw signal, beats are the inferred grid.

**BPM grid** — The inferred regular beat structure of the audio, used for snap-quantization of shot lengths and preset timing.

## Sequencer concepts

**Bake-down** — The action of converting the procedural rig output to a standard C4D camera with reduced F-curves. The handoff point to the rest of the pipeline.

**Alt take** — A duplicated shot block with modified parameters, stacked on a sub-track for A/B comparison. Editorial-style variant management.

**Active shot** — The shot currently under the timeline cursor, whose camera is rendering to viewport.

**Play range** — The portion of the timeline that spacebar plays. Always defined, always visible. Bounded by an in-point and an out-point. Defaults to the full sequence. Tightened by the user when they want to focus on a section. Playback always plays from the cursor's current position to the out-point, then stops or loops based on a visible toggle. The range affects playback only — shots outside the range remain fully editable.

**In-point / out-point** — The boundaries of the play range. Set by the `I` and `O` hotkeys at the cursor position, or by dragging the handles at the top of the timeline directly. After Effects convention.

**Loop toggle** — A visible button next to the transport controls. When on, playback wraps from the out-point back to the in-point. When off, playback stops at the out-point. Replaces the need for a separate "loop hotkey."

## The slate verb

**Slate** — The signature interaction of the plugin. A non-destructive operation that aligns shots to the rhythm of the music using motion-energy peaks as the alignment signal. Bound to the `S` hotkey. Borrowed directly from film-set practice, where slating is the act that commits a take to the record. Scales by selection:
- *Slate a shot edge* — snap that edge to the nearest beat or marker.
- *Slate a single shot* — snap the shot's peak motion-energy frame to the nearest beat, adjusting in/out points within constraints.
- *Slate multiple shots* — run the alignment algorithm across the selection, optimizing the sequence's rhythmic placement.
- *Slate all* — same as multiple, applied to the entire timeline.

Every slate is undoable. Shotblocks shots remain freely draggable, retimable, and editable. Slating never locks a shot.

**Motion-energy curve** — The per-frame combined value of translational velocity, rotational velocity, and acceleration of the camera over a shot. Computed from the procedural rig's evaluated state. The signal slate uses to identify "action" frames worth aligning to beats.

**Action frame** — A frame at a peak (or significant local maximum) of the motion-energy curve. The frames the audience's eye is most drawn to; the frames slate prefers to land on beats.

**Cut on action** — The cinematographic principle that cuts feel smoother and more deliberate when placed at moments of motion. Slate automates this by aligning action frames to beat markers, then cutting at low-energy moments between them.

## Direct manipulation

**Drag-resize** — Dragging the leading or trailing edge of a shot block to change its in or out point. Standard NLE behavior; must work on every shot at every time.

**Drag-move** — Dragging a shot block along the timeline to change its position. Adjacent shots ripple or roll based on modifier key, matching NLE conventions.

**Ripple edit** — Moving or resizing a shot pushes subsequent shots later or earlier to maintain spacing.

**Roll edit** — Moving a cut point shifts the adjacent shot edges in opposite directions; total sequence length unchanged.

**Slip / slide** — Editorial conventions for adjusting a shot's content vs. its timeline position. Implementation TBD; included here to lock the vocabulary.

## Things to avoid saying

- "Clip" — we say "shot." Clips imply footage; shots imply camera direction.
- "Track" (when meaning the whole timeline) — we say "timeline." Tracks are the rows inside the timeline.
- "Camera move" (when meaning a preset) — we say "preset shot" or "preset." A move is a specific motion; a preset is a reusable parameterized shot.
- "Effect" — we don't have effects. We have rig behaviors and noise profiles.
- "Transition" — we don't author transitions. The boundary between shots is a hard cut, full stop. Users who want dissolves, fades, whip-pans-as-transitions, or morph-cuts do that downstream in their NLE.
- "Snap" (when meaning the slate action) — snap is a generic term for any alignment behavior (drag-snap to grid, etc.). Slate is specifically the named, motion-energy-aware, beat-aligning verb.
- "Quantize" (for what slate does) — quantize is a music-software term for grid-snapping notes. Slate is more than that: it considers motion energy, not just position. Use "slate."
- "Smash" — earlier drafts considered smash as the verb; the project adopted slate instead. Don't reintroduce smash terminology.
