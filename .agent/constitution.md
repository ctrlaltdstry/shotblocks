# Constitution

These are the immutable principles of this project. Every feature, every code review, every scope discussion comes back to this document. If a proposed change conflicts with one of these, the change is wrong — not the principle.

## What this plugin is

**Shotblocks** is a Cinema 4D plugin for camera animation centered on a **timeline-based shot sequencer** with physically-grounded camera motion, beat-synced behavior, and a preset shot library. It is a tool for cinematographers, motion designers, and simulation artists who currently fight C4D's native camera and Stage tools.

The product's signature interaction is **slate** — a verb the user performs to commit shots to the rhythm of the music using motion-energy peaks as the alignment signal. On a real film set, slating happens at the start of every take to commit that take to the record. In the plugin, slating commits a shot (or a sequence of shots) to its moment in the timeline.

The product is named after the broader film-craft term **blocking** — the iterative work of figuring out where shots land before they're locked in. Slating is the punctuated commit; blocking is the activity. Users spend most of their time blocking; they slate at the moments that matter.

## What this plugin is not

- It is not a non-linear editor. It does not handle titles, color, multi-track audio mixing, transitions on non-camera content, effects, or anything that belongs in Premiere, Resolve, or After Effects.
- It is not a replacement for C4D's native camera. It produces a bake-down to a standard C4D camera with clean F-curves, and hands off cleanly to the rest of the pipeline.
- It is not a film-school simulator. Cinematography knowledge is encoded as presets and review lenses, not as a tutorial layer.

## Core principles

### 1. The timeline is the spine
Every feature lives inside the shot-block-on-a-timeline metaphor. Rig settings, operator personality, lens choice, audio sync, preset shots — all of these are properties of a shot block or behaviors of the timeline. If a feature does not fit this metaphor, it does not belong in this plugin.

### 2. The user owns the camera; Shotblocks directs it
Cameras live in the C4D Object Manager where the user creates them. Shotblocks does not generate cameras unilaterally. A shot is a reference to one of the user's cameras, observed over a frame range on the timeline. To create a shot, the user drags a camera from the Object Manager onto the timeline.

If the user wants the Shotblocks procedural behaviors (spring-damper smoothing, autofocus, noise profiles, framing rules, preset motion), they apply a Shotblocks tag to their camera. The tag is added through C4D's standard tag application path — right-click the camera in the Object Manager → Tags → Shotblocks, or via the Tags menu in the menu bar. (Existing tags can be moved between cameras by dragging, per standard C4D behavior, but creation is via the menu.)

The Shotblocks tag operates in one of two modes:

- **Additive mode** (default when applied to an animated camera): the user's existing animation — keyframes, splines, constraints — is the baseline. The tag's procedural pipeline produces deltas (small offsets in position, rotation, focal length, focus) that are added to the user's animated values each frame. The user's keyframes are never modified. Disabling the tag immediately reveals the original animation undisturbed. Behaviors that make sense as additive layers are spring damping (smooths transitions in the user's keyframes), noise (organic shake on top), and autofocus (independent focus channel). Look-at and framing rules in additive mode are applied as gentle corrective offsets toward the target, not as full replacements.

- **Replace mode** (default when the camera has no prior animation, or when the user opts in): the procedural pipeline drives the camera entirely. Boom, pan, tilt nulls are computed from presets and behaviors; the camera inherits their transforms. Look-at and framing rules fully replace the camera's rotation.

The mode is a property of the tag (and thus of the camera). Since each shot owns its own camera, mode is effectively per-shot — different shots want different cameras anyway, each with its own tag and mode. This keeps the model simple and predictable.

Without any Shotblocks tag, the camera still works as a shot — Shotblocks plays back its existing animation directly through the shot's frame range. The plugin scales from "sequence cameras I already animated" to "full procedural authoring" and the user picks where they live on that spectrum.

Shot boundaries are hard cuts — the previous shot's camera renders through frame N, the next shot's camera takes over at frame N+1. No interpolation across the boundary, no blending between cameras.

Each shot owns its own camera — one camera, one shot. (The v2 timeline enforces this: video clips can't be split or razored, so a clip never divides into two clips sharing a camera; the razor/split path is audio-only. The earlier "one camera, two appearances in non-overlapping ranges" model was retired with v2.) The active-shot resolution is always exactly one source camera per frame, trivially, since no camera backs more than one shot. A defensive `refCount > 1` guard remains on the keyframe edit paths (move / retime / delete) as cheap insurance against any future path that might re-share a camera, but in practice it never fires.

### 3. Each shot owns its rig state (when there is one)
A shot stores the per-shot configuration of its camera's Shotblocks tag: focal length override, operator personality, damping, target, framing rule, shake profile, autofocus behavior. Each shot has its own camera and tag, so each shot's rig state is wholly its own.

If the camera has no Shotblocks tag, the shot has no rig state to store; the camera plays back its own animation directly. This is a valid configuration, not an error state.

If a user adds a Shotblocks tag to a camera *after* shots already exist for that camera, those existing shots receive default rig state for the tag's mode. Adding a tag never silently changes how an existing shot behaves except through the mode's intended effect: in additive mode, the deltas start at zero (so the shot looks identical until the user dials in noise/damping/etc.); in replace mode, the user is prompted because replace mode would override their existing animation.

### 4. Hard cuts only — transitions live in the NLE
The plugin produces hard cuts between shots and nothing else. No dissolves, no fades, no whip-pan transitions, no morph-cuts, no match-cuts as authored transitions. If a user wants a transition between two shots, they bake the shots, hand them off to a real NLE (Resolve, Premiere, After Effects), and author the transition there with proper color, blur, and compositing tools. The plugin's job is to produce the shots; the NLE's job is to connect them.

This is a scope decision, not an aesthetic one. We could not do transitions as well as a real NLE even if we tried, and trying would compromise the architecture, the UI, and the per-shot rig-state model.

### 5. Direct manipulation is non-negotiable
The timeline must behave like Adobe After Effects' timeline in every way that affects the user's hands. After Effects is the reference because Shotblocks's target users — motion designers and 3D artists who composite their renders downstream — already live there. They have AE muscle memory; the plugin must respect it.

**Drag is primary. Hotkeys are optional accelerators.** Every operation in the plugin must be doable without touching the keyboard. A user should be able to build, arrange, slate, scope, and bake an entire sequence using nothing but the mouse and the visible UI. Hotkeys exist for users who want them but are never the only way to do anything. If a feature requires a hotkey to invoke, it is broken.

This means:
- Drag a camera from the Object Manager onto the timeline to create a shot.
- Apply a Shotblocks tag to a camera through C4D's standard path (right-click → Tags → Shotblocks, or via the Tags menu).
- Click a shot to select it; drag it to move; drag its edges to resize.
- Drag the in-point and out-point handles at the top of the timeline to set the play range.
- Click a transport button to play; click again to pause.
- Right-click a shot for contextual operations (set range to this, slate this, bake this, duplicate, delete).
- Drag a preset from the preset panel onto a shot or onto an empty area of the timeline.

The optional hotkeys for users who want them: `S` for slate, `I` and `O` for in/out, `B` for bake, `M` for marker, `Delete` for remove, `Cmd/Ctrl+D` for duplicate. Spacebar for play/pause is the one near-universal convention worth honoring as a default.

Slate actions, auto-alignment, and any algorithmic features are non-destructive. They modify shot positions and parameters that the user can then drag, retime, or undo freely. A user must never feel that the plugin has locked their work.

Playback follows the After Effects model: a single play range is always defined and always visible at the top of the timeline, with draggable in-point and out-point handles. Spacebar (or the play button) plays the range from the cursor's position to the out-point. There are no modal hotkeys for different playback behaviors. The user changes *what plays* by changing the range, never by holding modifiers on the spacebar.

### 6. Audio must just work
Drag, drop, hear, see waveform, scrub in sync. No sound nodes, no Xpresso, no "why isn't this playing." If the audio subsystem fails any of these, it is broken and blocks release.

### 7. Motion must feel physical, not robotic
Camera motion uses spring-damper physics with configurable stiffness and damping, plus optional noise profiles calibrated to real-world reference (handheld, shoulder-mount, drone, tripod). The default behavior should never feel like linear interpolation.

### 8. Bake-down must produce clean curves
The procedural rig must bake to a standard C4D camera with reduced, editable F-curves — not thousands of per-frame keyframes. If a colorist or another artist cannot pick up the baked camera and work with it, the bake is broken.

### 9. Presets are first-class
Preset shots and operator personalities are not convenience features — they are the primary way users interact with the plugin. The library is browsable with thumbnail previews, user-extensible, and shareable. New presets ship with v1; user-saved presets are core, not bonus.

### 10. Slate is the signature verb
The plugin has one named verb that scales across selection sizes: **slate**. To slate a shot is to commit it to a moment — taking something loose (a shot edge near a beat, a shot whose action peak is near but not on a beat, a sequence of shots that almost falls into rhythm) and aligning it to the rhythm of the music using motion-energy peaks as the alignment signal. The verb is borrowed directly from film-set practice: slating is the act that commits a take to the record. Slating in the plugin is non-destructive — every slate is undoable, and slated shots remain freely draggable, retimable, and editable afterward.

Primary invocation is the right-click menu on a shot or selection ("Slate to nearest beat") and a Slate button visible in the timeline toolbar. The `S` hotkey is offered as an accelerator for users who want it, never as the only path. Slate means *commit-and-align with intent* — never blend, never fade, never approximate.

The action must be instant. Pressing the slate button or hotkey invokes slate, the result is on screen, and the user is immediately free to do the next thing. No animation between intent and result, no mandatory delay, no celebration. Confirmation is a subtle status-line message naming what changed; the visual change to the timeline itself is the primary feedback. Pro tools earn trust by being responsive — every millisecond between intent and result is friction, and friction multiplied by hundreds of invocations per session compounds into a tool that feels slow.

### 11. Stay in scope
When tempted to add a feature, ask: does this fit the timeline metaphor? Does it serve camera animation specifically? Would removing it weaken the product, or just narrow it? Narrowing is fine. The product wins by being the best at one thing.

## Quality bars

- A user new to the plugin should be able to drag a preset onto the timeline, hear their audio, and produce a usable shot inside five minutes.
- Any shot block must be convertible to a baked C4D camera with clean curves in one action.
- Beat detection on a typical music track must place markers within one frame of the actual beat for a 24fps project.
- Spring-damper motion must run in real time on a typical scene without dropping viewport FPS below interactive thresholds.
- Every preset in the library must have a working thumbnail preview before ship.
- Every slate action is fully undoable and leaves shots freely editable afterward — no "shotblocks" lock state.
- Standard timeline manipulation (click, drag, resize, multi-select, copy/paste, undo) must work on every shot at every time, regardless of whether the shot was placed manually or by slate.

## Versioning principle

**Sole target until further notice: C4D 2026.2.0 on Windows.** No support for macOS, no support for older C4D versions. This is deliberate scope narrowing during early development; macOS support is the natural next milestone after v0 ships, and older C4D versions are not on the roadmap at all. See `context/c4d-api.md` for the full reasoning.

When the target expands, the scoping changes here in the constitution. Until then, anything written in the codebase that branches on platform or C4D version without an active need is overengineering, and reviewers should push back.

## Decision-making

When a decision is hard, the order of authority is:
1. This constitution
2. The glossary (definitions of terms)
3. The architecture document (system shape)
4. The relevant workflow document (how we do this kind of change)
5. The relevant team review lens (whose perspective matters)

If a decision is not resolvable from these, it gets written down as a new decision in the appropriate context file once made, so it is resolvable next time.
