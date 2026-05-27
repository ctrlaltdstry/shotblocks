# Procedural camera animation: prior art survey

Verified-with-sources research pass to locate Shotblocks against existing tools. Goal: know what to borrow, what to refine, what is genuinely new ground. All factual claims here were re-checked against live sources during this pass (accessed 2026-05-23). Where a source disagrees with the prior draft, the source wins.

---

## Gap analysis — what is novel about Shotblocks

Shotblocks proposes a **per-shot stack of "pills,"** where each pill is one of four behavior types (Movement, Lens, Texture, Targeting), and **composition rules are determined by type, not by user setting**: Movement and Texture SUM in overlaps, Lens and Targeting CROSSFADE. Pills have stateful end-holds. After surveying the field, the picture is:

**Borrowable (do not re-invent).** Pill-on-timeline visual metaphor; per-pill ease curves; procedural noise schema (amplitude/frequency/seed/octaves); look-at with screen-space framing; shot-local state reset at cuts; named preset libraries.

**Refined synthesis (small but meaningful).** Multi-instance procedural Movement on a timeline is a refinement of Cinemachine's single-slot Body (Cinemachine lets only one Position Control component drive a virtual camera at a time) and a refinement of Cavalry's property-scoped Behaviors stack (which is not timeline-scoped per-shot).

**Genuine novelty.** Three things have no clear prior art in any surveyed tool:

1. **Type-determined composition rule as an architectural law** — SUM-for-Movement-and-Texture, CROSSFADE-for-Lens-and-Targeting, not a per-layer setting. Houdini CHOPs leaves combination to the user's node graph. C4D MoGraph Effectors expose blending modes per-effector. Unreal Camera Shake is uniformly additive across patterns. No surveyed tool elevates this to a type-determined system rule.
2. **Stateful end-of-pill holds composing cleanly with the typed rules** — "Push pill ends at frame 60, camera holds +100 forever; second Push starts at frame 50, sums onto +100 across the overlap." Unreal shakes always return to rest. Cinemachine v-cams blend out. Cavalry behaviors are mostly stateless. No documented analog for end-hold + delta-contribution + typed-overlap as one composition algebra.
3. **The slate verb** — non-destructively aligning shot positions to audio motion-energy peaks. Trapcode Sound Keys drives parameters from audio; slate moves whole shots in time. Different verb.

---

## Per-tool verification

### Unity Cinemachine 3

Unity's official Cinemachine 3 documents the camera as a controller with a procedural pipeline of three slots: **Position Control, Rotation Control, and Noise**. (Cinemachine 3 renamed the v2 "Body/Aim/Noise" labels.) The CinemachineBrain reads the highest-priority active CinemachineCamera each frame and copies its state into the real Unity camera.

- The Noise stage is implemented by `CinemachineBasicMultiChannelPerlin`, which loads a noise profile asset defining the noise shape; the live noise is added to the camera state in a Correction channel. Documentation describes it as a **singular pipeline stage**, not stackable noise layers on one virtual camera.
- Multiple CinemachineCameras blend at the brain level, not within one camera. The blend takes both cameras live during the transition; per-pair blend curves are configurable.
- **Cinemachine Impulse** is a separate event-driven shake system: Impulse Sources emit signals, Impulse Listeners on virtual cameras react. The Listener's Secondary Noise option mixes additional noise into the impulse response, which is the closest Cinemachine gets to per-camera shake layering. It is still event-driven, not timeline-pill driven.
- **Cinemachine Recomposer** extension is documented as a final-tweak overlay specifically for Timeline use cases — hand-adjusting the output of procedural aiming.

Map to Shotblocks: Position Control ↔ Movement (but single-slot in Cinemachine), Rotation Control ↔ Targeting, Noise ↔ Texture. Lens is exposed as plain v-cam fields.

Sources:
- https://docs.unity3d.com/Packages/com.unity.cinemachine@3.0/manual/CinemachineCamera.html (accessed 2026-05-23)
- https://docs.unity3d.com/Packages/com.unity.cinemachine@3.1/manual/CinemachineBasicMultiChannelPerlin.html (accessed 2026-05-23)
- https://docs.unity3d.com/Packages/com.unity.cinemachine@3.1/manual/concept-procedural-motion.html (accessed 2026-05-23)
- https://docs.unity3d.com/Packages/com.unity.cinemachine@3.1/manual/CinemachineImpulse.html (accessed 2026-05-23)
- https://docs.unity3d.com/Packages/com.unity.cinemachine@2.9/manual/CinemachineRecomposer.html (accessed 2026-05-23)

### Unreal Engine — Camera Shake

`UCameraShakeBase` accepts one of four shake patterns: **Perlin Noise, Sinusoidal Wave, Sequence (Camera Animation Sequences), and Composite** (which combines Perlin + Wave + Sequence in a layer array inside one shake).

- Multiple shakes on one camera are **layered additively by default**. The "Single Instance" flag is documented as the opt-out: enabling it restarts the shake on retrigger "instead of layering it additively." So additive stacking is the default behavior.
- Every shake has a **Blend In / Blend Out time** producing a linear blend at the start and end. Direct analog to Shotblocks' per-pill in/out ease, though Unreal's is linear-only.
- Unreal Sequencer (the keyframe timeline) is keyframe-first; it owns shot cuts and overall cinematics but is not a procedural-layer system itself. Camera shake is the only procedural surface.

Map to Shotblocks: this is the strongest prior art for the **Texture** layer specifically. The contract (duration, blend-in, blend-out, additive stack of patterns) is what to port.

Sources:
- https://dev.epicgames.com/documentation/en-us/unreal-engine/camera-shakes-in-unreal-engine (accessed 2026-05-23)
- https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Engine/UCameraShakeBase (accessed 2026-05-23)

### Houdini CHOPs

CHOPs (Channel Operators) are a node-graph context for channel-rate signal generation and processing. Verified node names relevant to camera work: **Noise CHOP, Wave CHOP, Spring CHOP, Filter CHOP, Lookat (constraint) CHOP**, plus Export CHOP to route results back to a camera's tx/ty/tz/rx/ry/rz. The Spring CHOP is documented as a per-channel mass-spring vibration driven by the input channel.

- Composition is **dataflow** — any combination rule (add, multiply, mix, filter, envelope) must be authored by the user as nodes. There is no built-in typed composition rule.
- Used in production for camera shake and micro-jitter on cinematic cameras, but as a TD-level toolkit, not a motion-designer preset library.

Map to Shotblocks: confirms node-graph generality is exactly what motion designers don't want; pills-on-timeline is the right answer for the target audience.

Sources:
- https://www.sidefx.com/docs/houdini/nodes/chop/spring.html (accessed 2026-05-23)
- https://www.artivoxa.com/understanding-houdinis-chops-for-motion-design/ (accessed 2026-05-23)
- https://www.artivoxa.com/how-to-rig-a-camera-in-houdini-for-cinematic-motion-design-shots/ (accessed 2026-05-23)

### Cavalry (Scene Group)

Cavalry markets itself as a procedural motion-graphics app where animation comes from Behaviors stacked on a layer's property, not keyframes. Verified from current docs:

- Cameras in Cavalry are documented as **2.5D**: layers can be set to 2.5D to gain a Z axis. Two camera types exist (Freeform and LookAt). Cameras live in a Composition.
- **Camera Guides** represent a camera's view-box and can drive its animation; multiple Camera Guides can be added to a Camera and sequenced in the Time Editor to create a "multi-camera edit." This is closer to NLE-style cuts than to a per-shot procedural-layer stack.
- The Behaviors model itself is real but the camera-specific story is more 2.5D-parallax than full-3D procedural cinematography. The prior draft overstated Cavalry's 3D camera position; it is 2.5D in current docs.

Map to Shotblocks: Behaviors-on-layer remains the strongest design-language proof that a procedural stack reads as a primary authoring metaphor. The Camera Guide + Time Editor sequencing pattern is a real precedent for "lay out shots on a timeline" but does not stack typed procedural layers under each shot.

Sources:
- https://docs.cavalry.scenegroup.co/nodes/utilities/camera/ (accessed 2026-05-23)
- https://docs.cavalry.scenegroup.co/nodes/utilities/camera-guide/ (accessed 2026-05-23)

### After Effects — wiggle, Sound Keys, shake plugins

After Effects is the userbase Shotblocks targets; the vocabulary matters.

- The **`wiggle()` expression** signature is `wiggle(freq, amp, octaves = 1, amp_mult = 0.5, t = time)`. The freq/amp parameter order is the canonical motion-designer vocabulary. Shotblocks' Texture pill should mirror this naming.
- **Trapcode Sound Keys** (now Maxon/Red Giant) analyzes audio and generates keyframe streams that can be expression-linked to any keyframable parameter. Precedent for "audio drives parameters," not for "audio aligns shots in time."
- **Camera shake plugins** in the AE ecosystem are pattern-based add-ons (Crates Camera Shake, Camera Shake Pro, plus dozens of free preset packs); they apply 2D post-shake to footage, not procedural 3D camera animation. The prior draft named "Camera Shake Deluxe" and "RSMB camera-shake tools" — neither verified. RSMB is a motion-blur tool (ReelSmart Motion Blur), not a shake tool. "Camera Shake Deluxe" did not surface; replaced with the verified plugins.

Map to Shotblocks: align Texture parameter naming with `wiggle()`. Treat Sound Keys as the audio-driven-parameter precedent; slate is a different verb.

Sources:
- https://www.schoolofmotion.com/blog/wiggle-expression (accessed 2026-05-23)
- https://helpx.adobe.com/in/after-effects/using/expression-examples.html (accessed 2026-05-23)
- https://www.maxon.net/en/product-detail/red-giant/utilities/sound-keys (accessed 2026-05-23)
- https://www.productioncrate.com/plugins/crates-camera-shake (accessed 2026-05-23)
- https://videoeff.com/product/camera-shake-pro/ (accessed 2026-05-23)
- https://revisionfx.com/products/rsmb/ (accessed 2026-05-23)

### Cinema 4D MoGraph Effectors

MoGraph Effectors (Plain, Random, Shader, Delay, Spline, Inheritance, Step, Formula, Push Apart, etc.) drive clones via a falloff; multiple Effectors layer on a Cloner in evaluation order. Each Effector has per-parameter strength sliders, and blending behavior is configurable per Effector. Fields (the Fields system that replaced legacy falloff in R20) support **layered fields with blending modes** (add, subtract, multiply, etc.) per layer.

The Maxon documentation pages I could fetch confirm that the order of Effectors on a Cloner affects the result and that strength and falloff are per-Effector, but the precise built-in composition default (add vs. blend) is not stated in one canonical sentence — secondary sources describe it as additive by default within the strength-weighted falloff. Treat this as the closest C4D-native precedent and frame Shotblocks as "MoGraph for cameras" in user-facing docs.

Sources:
- https://help.maxon.net/c4d/en-us/Content/html/7443.html (accessed 2026-05-23)
- https://help.maxon.net/c4d/en-us/Content/html/7439.html (accessed 2026-05-23)
- https://novedge.com/blogs/design-news/cinema-4d-tip-mastering-mograph-effectors-in-cinema-4d-for-dynamic-motion-graphics (accessed 2026-05-23)

### Cinema 4D — native and third-party camera tools

- **Vibrate Tag** (built-in). Per-axis amplitude + frequency on position, scale, and rotation. Choice of random-noise or sine waveform. The simplest C4D-native procedural shake; lacks duration, blend, and stacking semantics.
- **Greyscalegorilla Signal** (subscription plugin). Procedural animation without keyframes: drag-and-drop modulation, BPM-timing, preset moves (flicker, bounce, vibration, spin), Fields-gated triggers, Looper for variation across multiple parameters in one tag. Property-scoped, not shot-scoped — the closest existing C4D-shipped analog to a procedural layer.
- **GorillaCam** (Greyscalegorilla, *this is the camera plugin the prior draft missed*). Procedural hand-held camera plugin with smoothing, overshoot, jolt, three speeds of position/rotation/zoom shake, target-follow, focal drift, **60 pre-built camera presets** (product shots, architectural walk-throughs, film/TV moves), a "Feeling Lucky" random generator, and bake-out. This is the most direct commercial peer to Shotblocks in the C4D ecosystem and should be studied closely.
- **Camera GripTools** (third-party). A desktop motion-capture rig that simulates real-world camera grip systems.

Sources:
- https://greyscalegorilla.com/plugins/signal (accessed 2026-05-23)
- https://greyscalegorilla.com/plugins/gorillacam (accessed 2026-05-23)
- https://cgshortcuts.com/library/vibrate-tag/ (accessed 2026-05-23)
- https://creativecow.net/forums/thread/camera-griptools-plugin-released/ (accessed 2026-05-23)

### Maya — camera tooling

- **Camera Sequencer** (built-in Maya). Lays out and manages camera shots into a final scene; NLE-style sequencing of cameras. Keyframe-driven inside each shot.
- **jSequencer** (community). Quality-of-life improvements over Camera Sequencer.
- **cineCam** (Nando Penafiel). Procedural camera rig for cinematography in Maya — control-based, not procedural-layer-based.
- **Camera Controller / Shaker Maker** (community). Adds a procedural camera shake rig to an existing camera.

No Maya tool surfaced that combines a per-shot stack of typed procedural behaviors the way Shotblocks proposes. Maya cinematography in practice is shot list + Camera Sequencer + keyframe animation, with shake as a bolt-on rig.

Sources:
- https://help.autodesk.com/view/MAYAUL/2024/ENU/?guid=GUID-FDCA1426-D7FE-41A5-9563-5628C736BCCC (accessed 2026-05-23)
- https://nandopenafiel.gumroad.com/l/cineCam (accessed 2026-05-23)
- https://www.highend3d.com/maya/script/camera-controller-shaker-maker-for-maya (accessed 2026-05-23)

---

## Academic prior art

### Drucker & Zeltzer — CamDroid (1995)

CamDroid (Drucker & Zeltzer, I3D 1995) introduces the **"camera module"** as the unit of encapsulation — well-defined units that can be programmed and sequenced as the underlying framework for camera control across disparate environments. The paper demonstrates two examples: an agent filming a conversation between virtual actors, and a visual programming language for filming a virtual football game.

This is correctly cited as foundational for "layered camera behaviors." However, CamDroid frames composition primarily as **task sequencing and constraint solving**, not as a per-frame typed-overlap algebra. Drucker's lineage is the constraint-based / autonomous-camera tradition, which has repeatedly failed to ship as a primary authoring metaphor in commercial tools — too unpredictable for direct manipulation.

Sources:
- https://www.microsoft.com/en-us/research/publication/camdroid-a-system-for-implementing-intelligent-camera-control/ (accessed 2026-05-23)
- https://dl.acm.org/doi/10.1145/199404.199428 (accessed 2026-05-23)

### Christie, Olivier & Normand — "Camera Control in Computer Graphics" (CGF 2008)

Confirmed: Marc Christie, Patrick Olivier, Jean-Marie Normand, *Computer Graphics Forum* vol. 27 issue 8 (2008), pp. 2197–2218, DOI 10.1111/j.1467-8659.2008.01181.x. The canonical state-of-the-art review. Catalogues the field by approach (reactive, deliberative, optimization-based, constraint-based) and is the right entry point to the literature bibliography.

Important caveat for Shotblocks: this body of work is dominated by **autonomous / constraint-solving** camera systems, not by **authored, layered, procedurally-composed** systems. Drucker, Christie, Olivier and the downstream papers address "compute the camera that satisfies these constraints," which is a different problem from Shotblocks' "stack these behaviors in this order, evaluate per frame, render." Cite them for grounding, not for direct architectural precedent.

Sources:
- https://onlinelibrary.wiley.com/doi/abs/10.1111/j.1467-8659.2008.01181.x (accessed 2026-05-23)
- https://people.irisa.fr/Marc.Christie/Publications/2008/CON08.html (accessed 2026-05-23)

---

## What changed vs the prior draft — quick read

- **RSMB was wrong.** ReelSmart Motion Blur is a motion-blur plugin, not a shake plugin. Removed and replaced with verified AE shake tools (Crates Camera Shake, Camera Shake Pro).
- **"Camera Shake Deluxe" did not surface** in any current source. Removed.
- **GorillaCam is the missed peer.** Greyscalegorilla ships a dedicated camera plugin (not just Signal) with 60 presets, shake, focal drift, and bake-out — the most direct commercial peer in the C4D ecosystem. The prior draft only named Signal.
- **Cinemachine Impulse + Recomposer** are real and relevant — separately documented event-driven shake and Timeline-tweak extensions that the prior draft did not name.
- **Cavalry's 3D camera claim was overstated.** Current Cavalry docs frame cameras as 2.5D with Camera Guides for sequencing, not a full 3D procedural camera with stacked behaviors. Corrected.
- **Christie/Olivier survey verified** with exact citation (CGF 27:8, 2008, pp. 2197–2218); the lineage is autonomous/constraint-based, not authored-layered — that distinction is now explicit.
- **CamDroid frames composition as task sequencing**, which is a weaker precedent for typed-overlap composition than the prior draft implied.
- **`wiggle(freq, amp, octaves, amp_mult, t)`** signature confirmed verbatim from Adobe docs — Texture pill parameter naming should match.
