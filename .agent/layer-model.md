# The layer model

How a shot's camera animation is built, evaluated, and edited. This is the core architectural model of Shotblocks — read it before touching anything in the sequencer, the tag's per-frame evaluation, or the inspector UI.

## The central idea

A shot's camera animation is **computed, not stored as keyframes**. Each shot contains a stack of layers. Each layer is a small procedural function — "orbit this target at this radius over these frames with this easing." The camera's state at any frame is the composition of all the layer functions evaluated at that frame. There are no keyframes anywhere in this model.

This is closer to how an audio synthesizer works than to traditional keyframe animation. You don't draw the curve; you set the parameters of the generators and the curve comes out. The easing curve is the envelope. The pill's in/out points are when the envelope is active. The layer type is the oscillator. The user tweaks parameters (in the inspector) and timing (by dragging the pills), and the camera animation regenerates live.

This is the thing that makes Shotblocks *not* a preset-picker bolted on top of C4D keyframes. It's a procedural-generative camera animation system that happens to live inside a C4D tag.

## Why this model

Two reasons it's the right call:

1. **It removes keyframes from the user's mental model entirely.** A motion designer who wants a camera move shouldn't have to think about keyframes, tangents, or F-curves. They drag in a move, drag in a focus pull, set the timing, tweak the feel in the inspector, done. Keyframe animation remains available (see "Coexistence with keyframes" below) but it's not required for procedural results.

2. **It resolves the additive/replace tension cleanly.** Because layers are functions producing deltas, they compose naturally with each other *and* with the camera's existing keyframed animation (in additive mode). The procedural layers sum on top of whatever the camera is already doing.

## Layers are pure functions of frame number

This is a hard requirement, not a style preference. **Each layer must evaluate as a pure function of the frame number**: given frame N, it produces exactly one answer, with no hidden dependence on what was computed at frame N-1.

The reason is rendering. When the user renders, C4D evaluates frames potentially out of order and potentially in parallel. The result must be identical every time, regardless of evaluation order. A layer that depends on prior-frame state (momentum, settling, accumulated drift) breaks this unless its state is derived deterministically from the shot's start frame each time it's evaluated.

Implications by layer type:
- **Naturally deterministic** (trivial): orbit, dolly, pan, tilt, zoom, focus pull. The value at frame N is a direct computation from N. These are the easy majority.
- **Stateful, needs care**: spring-damper smoothing, handheld shake with momentum, anything with "settle" behavior. These inherently reference prior state. They must either be made deterministic (seed the pseudo-random or physics state from the start frame and the frame offset, so frame N always produces the same result) or precomputed/baked from the shot start. Do not implement these as naive frame-to-frame accumulation — it will produce render artifacts.

When implementing any stateful layer, the test is: "if I evaluate frame 100 cold, without having evaluated frames 0-99 first, do I get the same answer as if I'd played straight through?" If not, the layer is not render-safe.

## The four behavior types

Layers aren't only camera *moves*. The full surface of what a camera can do breaks into four behavior types. The gallery and the layer system should cover all four.

**Positional** — moves the camera through space. Push in, pull out, dolly, boom, truck, pan, tilt, orbit, arc, crane, parallax, whip. The bulk of the move presets.

**Optical** — changes the lens without moving the camera body. Zoom (focal length change), rack zoom, lens breathing, snap zoom. Distinct from positional because the camera doesn't translate — the optics change.

**Textural** — adds organic imperfection on top of whatever else is happening. Handheld shake, vibration, impact shake (a hit on a beat), engine rumble, footstep bounce, slow wander. Always low-intensity, always additive, never conflicts with anything. This is the category that makes an otherwise-robotic move feel operated by a human.

**Relational** — defines what the camera attends to. Targets (look at this object), framing rules (rule-of-thirds, centered, headroom), follow behaviors. These reference scene objects and drive the camera's rotation (and sometimes position offset) to maintain a relationship with a subject.

The categories shown in the gallery UI (Basic moves, Orbits, Cinematic, Subject tracking, Beat-driven, Handheld) are an *intent-based* browsing taxonomy that sits on top of these four behavior types. Most browsing categories are Positional; Subject tracking is Relational; Handheld is Textural. The four behavior types are the *architectural* taxonomy; the six categories are the *browsing* taxonomy. Don't conflate them — the user browsing the gallery shouldn't need to know about behavior types, but the evaluator absolutely does, because behavior type determines the combination rule (next section).

## Combination rules: sum vs crossfade

When two layers overlap in time, how do they combine? The answer depends on the behavior type, and it must be explicit in each layer type's definition.

**Additive (sum)** — Positional and Textural layers. Their contributions are deltas from rest, and overlapping deltas simply add. Two dollies overlapping produce a combined translation. A shake layered over an orbit produces an orbit-with-shake. You can stack any number of these and they all sum. The same preset can appear twice in one shot (two handheld-shake layers at different intensities) and they sum fine.

**Crossfade (blend)** — Relational and optical-focus layers. The camera can't look at two targets at once, and it can't be focused at two distances at once. When two relational layers overlap, the camera's attention *crossfades* from the first to the second across the overlap zone, weighted by the easing. This is the mechanism behind the "Target Object 1 hands off to Target Object 2" interaction: their pills overlap, and across that overlap the look-at blends from target 1 to target 2.

So the overlap zone means different things for different layer types:
- Overlap of two positional layers → both active, summed
- Overlap of two target layers → crossfade from one to the other
- Overlap of two focus layers → crossfade focus distance from one to the other

The evaluator must know, per layer type, which rule applies. This is a clean rule but it has to be encoded in the layer-type definitions, not assumed.

## The rest state, gaps, and empty shots

Three states need explicit definitions:

- **Empty shot** (no layers): the camera holds its current static position for the shot's duration. A brand-new shot is a static hold, not an error.
- **Gap between layers** (layer A ends at frame 60, layer B starts at frame 80): during frames 60-80 the camera holds the state it had at the end of layer A. Hold, not snap-to-default.
- **Layer at zero intensity** (envelope at 0, before it starts or after it ends): contributes nothing. For additive layers, a zero contribution is literally zero delta. For crossfade layers, a layer at zero weight is simply not part of the blend.

## The inspector

The right-side panel in the timeline is an inspector. Selecting a pill (layer) shows that layer's settings: its easing curve, and all parameters specific to that layer type. The user tweaks everything there.

- **For a motion layer**: easing curve, plus type-specific parameters (orbit radius, height, speed, direction; dolly distance; etc.).
- **For a target layer**: which object is the target, the target offset, and offset-related parameters (see "Targets" below).
- **For a textural layer**: intensity, frequency, the operator-personality character.

The division of labor: **the inspector controls *what* and *how*; the pill's position and length control *when*.** Timing is edited by dragging the pill (move it, resize it, overlap it with another). Feel and parameters are edited in the inspector. The easing curve is the bridge — it lives in the inspector but governs how the layer animates across the time window defined by the pill.

## Easing curve representation

Each layer has an easing curve mapping normalized time (0-1 across the layer's active window) to normalized progress (0-1 of the effect). The user edits this in the inspector, probably by dragging handles on a curve.

Use **cubic bezier easing** as the representation: the same model as CSS easing and After Effects' graph editor. Reasons:
- Cheap to evaluate per frame
- Familiar to motion-design users — they already think in ease-in/ease-out/custom bezier from AE
- Compact to store (four control values)
- Expressive enough for the full range of feels (linear, ease, overshoot via control points outside 0-1)

The *feel* of every preset depends on getting this right, because the easing is what separates "robotic" from "operated." Ship sensible defaults per preset (an orbit eases in and out; a snap-to overshoots and settles) and let advanced users override.

## Targets

Targets are a relational layer type, and they have some special considerations because they reference scene objects rather than being self-contained presets.

**Shipped presets vs scene references.** A motion preset (orbit, dolly) works in any scene — it ships in the library. A target is a pointer to *this scene's* object — it can't ship in a library because Target Object 1 doesn't exist in another scene. So the gallery needs to distinguish:
- *Shipped library content* — motion/optical/textural presets that work anywhere
- *Scene references* — targets, populated from the current scene's objects (plus defaults like "scene origin" / "world center")

The gallery might present both, but a "Targets" section is populated dynamically from the scene (or the user drags an object from the Object Manager to create a target layer), distinct from the shipped presets.

**Target offset space.** "Look at the target with an offset" — offset in what space? This needs an explicit decision because the options behave very differently:
- *World-space offset* — look at a point N units above/beside the target in world coordinates. Simple to compute.
- *Screen-space offset* — frame the target in the upper-third / left-third of the frame. Most useful for composition (rule-of-thirds), most complex to compute (depends on focal length and camera orientation).
- *Target-local offset* — look at a point relative to the target's own orientation (e.g., always look at a point in front of where a character faces). Useful for follow shots.

Screen-space is the most valuable for composition but the hardest. Decide which space(s) to support and make the choice clear in the inspector.

**Moving targets and execution order.** If the target object is itself animated (a walking character), then "look at the target at frame N" depends on where the target *is* at frame N. This is deterministic (the target's position at frame N is well-defined) but it creates an evaluation-order dependency: the target must be evaluated *before* the camera looks at it.

This is why the Shotblocks tag runs at `EXECUTIONPRIORITY_EXPRESSION` (verify the exact constant in C4D 2026.2.0) — so user/scene animation is evaluated before the camera's procedural pipeline runs. If the priority is wrong, the camera looks at where the target was *last* frame, producing a subtle one-frame lag that's annoying to diagnose. Test this explicitly and early with an animated target.

## Coexistence with keyframes

The procedural model does not replace keyframe animation — it's an alternative path that can also combine with it.

- A user who wants full manual control can keyframe their camera the normal C4D way, with no Shotblocks tag, and drop it on the timeline as a shot. It plays back its keyframes.
- A user who wants speed uses procedural layers via the Shotblocks tag — no keyframes created.
- A user who wants both uses additive mode: they keyframe a base camera path, then layer procedural behaviors (shake, focus, drift) on top. The procedural layers produce deltas added to the keyframed animation.

"Procedural, separate from keyframes" means the *computation* doesn't use keyframes as its data source — it evaluates functions instead. It does *not* mean the computation lives outside C4D. The evaluation runs inside the tag's per-frame `Execute`, reads C4D's scene state (where are the targets?), and writes to C4D's camera. It's a tag that computes procedurally rather than reading stored keyframes — not a separate animation system bolted on.

## Bake-down

Bake-down is what converts the procedural result into standard C4D keyframes. The bake engine evaluates the full layer stack at each frame, producing the camera's state, and writes reduced F-curves (not per-frame keys) to a plain C4D camera with no Shotblocks tag.

This is the handoff point: procedural while you're working (fast, parametric, no keyframes), baked when you're done (standard C4D camera, render-ready, portable, no dependency on the plugin). The baked output is identical to what the procedural evaluation produced — bake doesn't approximate, it records.

## Performance

The layer stack evaluates every frame, per camera, during playback and scrub. A shot with eight layers means eight evaluations on every frame the playhead touches, in real time. The math is individually cheap (trig, vector ops) but it has to be implemented efficiently:

- Cache references in the tag's `Init`; don't look them up in `Execute`
- Vectorize the math (NumPy-first) rather than naive per-frame Python loops
- Avoid scene traversal in the per-frame path
- Cache anything that doesn't change frame-to-frame (the layer parameters, the easing curve evaluation tables)

This is the part most likely to feel sluggish if built carelessly. It's also the part where a NumPy-first kernel architecture pays off most directly.

## Open questions specific to this model

These need decisions; they're tracked in `open-questions.md` as well:

- **Target offset space** — world, screen, or target-local? Which to support, which is default?
- **Whether easing is per-layer only, or whether some layers expose multiple curves** (e.g., a move with separate position and rotation easing).
- **How stateful layers (shake with momentum, spring-damper) achieve determinism** — seed-from-start-frame vs precompute-and-cache.
- **Whether the same target can be referenced by multiple shots** and whether changing a target's offset in one shot affects others (it shouldn't — offset is per-layer, the target object reference is shared).
- **What happens when a layer's referenced target object is deleted** — analogous to the orphaned-shot problem, but at the layer level. Probably: the layer goes into an error state and the inspector prompts to relink or remove.

## Summary for a fresh session

If you're picking this up cold: a shot is a stack of procedural layers. Each layer is a pure function of frame number, evaluated every frame inside the Shotblocks tag, producing a delta or a relational target for the camera. Layers combine by summing (positional, textural) or crossfading (relational, optical-focus) in their overlap zones. The user edits timing by dragging pills and edits feel/parameters in the inspector, where each layer's easing curve (cubic bezier) and type-specific settings live. No keyframes are created until bake-down, which records the procedural result as clean F-curves on a plain C4D camera. The whole thing runs inside C4D's per-frame evaluation at expression priority, reading scene state and writing to the camera — procedural in its data source, native in its execution.
