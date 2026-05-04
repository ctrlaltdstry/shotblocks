# Architecture

The system shape. Read this before adding any feature so it lands in the right place.

## High-level layers

```
┌─────────────────────────────────────────────────────────────┐
│  User's scene (in Object Manager)                           │
│  - cameras the user created                                 │
│  - optional Shotblocks tag on a camera unlocks procedural rig   │
└─────────────────────────────────────────────────────────────┘
                            │
                drag camera onto timeline
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Timeline UI (custom dialog)                                │
│  - shot blocks (hard cuts only), audio waveform, markers    │
│  - play range (draggable handles, always visible)           │
│  - direct manipulation: drag is primary, hotkeys optional   │
│  - preset library panel                                     │
│  - inspector panel (per-shot properties)                    │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Sequencer core                                             │
│  - shot list, active-shot lookup at frame N                 │
│  - routes camera output for the active shot                 │
│  - bake-down to standard C4D camera                         │
│  - slate engine: motion-energy + audio → alignment          │
└─────────────────────────────────────────────────────────────┘
                            │
        ┌──────────┬────────┼────────┬──────────┐
        ▼          ▼        ▼        ▼          ▼
┌─────────────┐ ┌──────┐ ┌──────┐ ┌────────┐ ┌────────┐
│ Shotblocks tag  │ │Audio │ │Motion│ │Preset  │ │Bake    │
│ (TagData on │ │subsys│ │energy│ │library │ │engine  │
│ user camera)│ │      │ │      │ │        │ │        │
│ generates   │ │decode│ │peak  │ │JSON +  │ │curve   │
│ rig + runs  │ │wave  │ │detect│ │thumbs  │ │reduce  │
│ behaviors:  │ │onset │ └──────┘ └────────┘ └────────┘
│ springs,    │ │play  │
│ look-at,    │ └──────┘
│ autofocus,  │
│ noise,      │
│ framing     │
└─────────────┘
```

## C4D plugin object model

**Shotblocks tag** — `TagData` subclass. Applied by the user to a camera object through C4D's standard tag application path: right-click the camera in the Object Manager → Tags → Shotblocks, or via the Tags menu in the menu bar. (Existing tags can be moved between cameras by dragging — standard C4D behavior — but creation is via the menu.) The tag acts as both the configuration surface (parameters exposed on the Attribute Manager) and the host of the procedural rig hierarchy. On apply, the tag generates child nulls under the camera (`world → boom → pan → tilt → camera`) and inserts the camera into the appropriate position in the hierarchy. On remove, it cleans up the nulls and returns the camera to its previous parent.

The tag operates in one of two modes:

- **Additive mode** (default for cameras with prior animation): the user's existing animation is the baseline. Each frame, the tag's procedural pipeline produces *deltas* — small offsets in position, rotation, focal length, focus — that are added to the user's animated values. The user's keyframes/splines/constraints are never modified; the camera's animated transforms are read at each frame and combined with the procedural deltas at output. Disabling the tag immediately reveals the original animation undisturbed.

- **Replace mode** (default for unanimated cameras, or opt-in): the procedural pipeline drives the camera entirely. Boom, pan, tilt nulls produce the camera's transforms directly; any user keyframes on the camera are ignored while the tag is in this mode.

Mode selection logic on tag application:
- Camera has no animated transforms → default to replace mode silently.
- Camera has animated transforms → default to additive mode and prompt the user with a brief notification ("Shotblocks added in additive mode. Switch to replace mode if you want presets to override your animation.")
- The user can flip modes at any time via the tag's Attribute Manager. Switching from additive to replace prompts a confirmation, since it disables the user's existing animation.

The tag is opt-in. A camera without a Shotblocks tag is still draggable into the timeline as a shot — the plugin simply renders that camera's existing animation during the shot's frame range. This is the architectural distinction that lets Shotblocks meet users where they already are: cameras the user already authored work as shots; the procedural goodies are unlocked by adding the tag.

**Rig behaviors** — internal to the Shotblocks tag. When the tag is present and active, it runs the procedural pipeline each frame: spring-damper, look-at, autofocus, noise, framing. These are not separate user-visible tags; they are subsystems of the Shotblocks tag, exposed in its Attribute Manager. Earlier drafts of this architecture had each behavior as its own tag — that's been consolidated because users should not have to wrangle five tags to get a rig working. One tag, multiple behaviors inside.

In additive mode, behaviors that are inherently replacement operations (look-at, framing rule) are applied as gentle corrective offsets toward the target rather than full rotation replacement. The user can dial the strength of those offsets from 0% (no effect) to 100% (full look-at, equivalent to replace mode for that channel). Behaviors that are naturally additive (spring damping, noise, autofocus on its own focus channel) work the same in both modes.

**Sequencer core** — pure Python module, not a C4D object. Holds the shot list as an in-memory model, persists to the document via a `BaseList2D` container or scene hook. Resolves which shot is active at frame N (always exactly one — shots do not overlap; boundaries are hard cuts), and routes camera output: the active shot's source camera is what renders to the viewport. If that camera has a Shotblocks tag, the tag's procedural pipeline runs and applies the shot's per-shot rig state. If not, the camera's own animation plays through. Hosts the slate engine.

**Slate engine** — the algorithm that aligns shots to the music using motion-energy peaks. Lives inside the sequencer core because it operates on shot positions and reads the audio's beat grid plus the camera's evaluated motion. See "The slate engine" section below.

**Motion-energy module** — given a shot, evaluates the shot's source camera over the shot's frame range and produces a per-frame motion-energy curve (combined translational velocity, rotational velocity, and acceleration). Works whether the camera has a Shotblocks tag or not — for tagged cameras, the rig's evaluated motion is the source; for untagged cameras, the camera's own animated transforms are the source. Identifies action frames (peaks). Cached per-shot, invalidated when the shot's parameters or the source camera's animation changes.

**Timeline dialog** — `GeDialog` subclass with a custom-drawn area (`GeUserArea`) for the timeline itself, plus standard widgets for the inspector and preset panels. Uses C4D's draw API for the waveform, shot blocks, markers, and play-range bar. Implements direct-manipulation behavior (drag-move, drag-resize, multi-select, ripple/roll edits) following After Effects conventions, since AE is where Shotblocks's target users live. Accepts drag-and-drop of cameras from the Object Manager onto the timeline area to create shots; accepts drag-and-drop of presets from the preset panel onto shots or onto empty timeline space.

**Play range** — a first-class element of the timeline, owned by the timeline dialog. A draggable in/out range, always defined and always visible, displayed at the top of the timeline area. The play button (or spacebar) plays from cursor position to the out-point of the range; on reaching the out-point, playback either stops or wraps to the in-point depending on a visible loop toggle. The range affects playback behavior only — shots outside the range remain fully selectable and editable. The user adjusts the range by dragging the range handles directly, by right-clicking a selection ("set range to selection," "set range to this shot," "range to all"), or via the optional `I` and `O` hotkeys.

**Audio subsystem** — Python module wrapping a bundled audio decoder (likely a small C extension or pure-Python decoder for WAV; MP3/AAC via a bundled lightweight library). Provides decoded samples for waveform display, sync playback during scrubbing, and onset detection. Cached per-document so reload is instant. Audio is added to the document by dragging an audio file onto the timeline area.

**Preset library** — JSON files on disk under `presets/` for shipped presets and a user directory for saved ones. Each preset references a thumbnail (animated GIF or sprite-strip) generated on save against an abstracted scene. Presets are dragged from the panel onto shots (applies the preset to that shot) or onto empty timeline space (creates a new shot using a newly-spawned tagged camera).

## Data flow per frame

When the document advances to frame N:

1. Sequencer core looks up the active shot. There is always exactly one active shot (or none, in gaps between shots). No interpolation across boundaries — boundaries are hard cuts.
2. The active shot's source camera is what renders to the viewport. Sequencer ensures any other Shotblocks-managed cameras are inactive.
3. Sequencer applies the shot's per-shot rig state (if any) to the camera's Shotblocks tag (if present).
4. **If the source camera has no Shotblocks tag:** the camera renders its own animation directly. Position, rotation, focal length all come from the camera's own keyframes, splines, or constraints. The shot has no rig state.
5. **If the source camera has a Shotblocks tag in replace mode:** the tag's procedural pipeline runs (spring-damper, look-at, noise, framing, autofocus, in priority order). The rig nulls produce the camera's transforms; user keyframes on the camera are ignored. On the first frame of a shot, the previous shot's residual physics state is reset.
6. **If the source camera has a Shotblocks tag in additive mode:** the tag reads the camera's animated transforms at frame N (from the user's keyframes, splines, or constraints). The procedural pipeline computes deltas — offsets in position, rotation, focal length, focus — based on the rig state and the inputs (target position, motion velocity, etc.). The output is `user_animation(N) + procedural_deltas(N)`. The user's keyframes are never written to.
7. Camera object is now positioned and oriented for frame N. Render proceeds.

This flow runs every frame during playback. Performance discipline lives in the Shotblocks tag's behavior code, not the sequencer core — the sequencer just routes; the tag does the per-frame math (when active).

### Slate in additive mode

A subtle point: when the slate engine re-times a shot (adjusting in/out points to align action frames to beats), the user's keyframed animation effectively gets time-warped to fit the new duration. Some users will not want this — they crafted their animation to specific timing and don't want it stretched.

For shots whose source camera has user animation, the slate engine offers two re-timing strategies:
- *Position only* — the shot is moved on the timeline but its internal duration and the user's animation play at original speed. Action frames may not land exactly on beats; the engine aligns as closely as possible without changing duration.
- *Time-warp* — the shot's duration changes; the user's animation stretches/compresses with it. Action frames land precisely on beats but the original timing is altered.

The default is *position only* in additive mode (respect the user's intent). The user can opt into time-warp per shot or globally for a slate operation.

## Camera lifecycle and orphaned shots

When the user attempts to delete a camera that is referenced by one or more shots, Shotblocks intercepts the deletion attempt:

1. A confirmation dialog appears: "This camera is referenced by N shot(s) in the Shotblocks timeline. Delete anyway?"
2. If the user cancels, no deletion happens; nothing changes.
3. If the user confirms, the camera is deleted *and* the affected shots become orphaned.

Orphaned shots remain on the timeline as visible blocks but are rendered in a clearly distinct visual state (e.g., dashed outline, muted color, "missing camera" label). They cannot play back — when the cursor enters an orphaned shot, the viewport shows a placeholder frame and the status line names the missing camera.

The user has three resolution paths for an orphaned shot:
- **Remove the shot** — context menu option; cleanly deletes the orphaned block
- **Relink to another camera** — drag a different camera from the Object Manager onto the orphaned shot block; the shot adopts the new camera as its source while preserving its in/out range and rig state (if compatible)
- **Restore via undo** — the standard C4D undo stack reverses the deletion and the shot is reattached

Orphaned shots persist across save/load — the document remembers that the shot referenced a camera by name/ID and continues to display the placeholder until resolved. This is intentional. A user might delete a camera by accident, save the document, reopen it, and still have the option to restore via reimporting or relinking. Silently dropping orphaned shots on save would be hostile.

## A single camera in multiple shots

Multiple shots can reference the same source camera, but never at the same frame. The active-shot resolution is always exactly one source camera per frame. Two shots that share a source camera must occupy non-overlapping frame ranges (across *all* tracks — the same-camera-twice rule is global, not per-track). The sequencer enforces this — attempting to drag a shot to overlap another shot of the same source camera triggers the overlap policy below.

Per-shot rig state is independent: shot A and shot B can both reference camera C, and each can have its own focal length override, operator personality, framing rule, etc. The shared camera is the source; the per-shot state is the per-appearance configuration.

## Multi-track timeline

The timeline has multiple stacked tracks. A shot lives on a specific track (`track: int`, 0 = bottom). Tracks exist for arrangement flexibility — the user can stack alternates, shift one shot up to compare timing, or park ideas above the active stack — not for layered rendering.

**Active-shot resolution across tracks:** at frame N, the active shot is the shot covering N on the *highest* occupied track. Top wins. This is the standard NLE convention (Premiere V2 overrides V1, Resolve same). The result is always exactly one active shot at frame N (or none, in gaps), satisfying constitution principle 2.

**Track lifecycle:** lanes auto-grow on demand up to a hard cap of 4. Fresh document opens with 1 visible lane; lanes appear as the user drags or drops shots into them. Empty top lanes do not collapse mid-session — that would destabilize the canvas while the user is mid-arrange.

**Cross-track overlap is legal.** Two shots on different tracks may cover the same frames; the resolver picks the top-track shot. Same-track overlap is illegal and resolved by the overlap policy below. The same-camera-in-two-shots-at-the-same-frame rule still applies *across all tracks*, regardless of which is on top.

## Overlap policy

When the user drags a shot, drops a new shot, or resizes an edge into a frame range that's already occupied **on the same track**, resolution is selected as follows:

- **Default (no modifier, snap toggle off): replace.** The moved/dropped/resized shot trims any same-track collider at its incoming edge, or removes the collider entirely if it's fully covered. Edge-drag resize trims the neighbor's near edge.
- **Shift held: ripple.** Subsequent same-track shots are pushed later (or earlier, depending on drag direction) to make room. Edge-drag resize ripples the neighbor. Shift overrides the snap toggle.
- **Snap toggle on (toolbar checkbox), no Shift: cross-track magnetic snap.** While dragging, the shot magnetically pulls toward any edit point on any track once within ~8 pixels of it. Edit points are every other shot's `in_frame` and `out_frame + 1` (the cut-after frame). Outside the magnetism radius the shot drags freely. If the user drags past the snap zone hard enough to land on a same-track collision, the residual overlap is resolved with replace (the collider is trimmed). This matches Resolve / Premiere snap semantics, not the older "blocking" snap-to-edge behavior.

Cross-track moves bypass collision resolution entirely — the resolver picks a winner at render time.

Replace is the default because dragging or dropping a shot into occupied space is most often the user telling Shotblocks "I want this shot here, not that other one." Snap-to-edge is exposed as a toolbar toggle (rather than a modifier) so users who need precision placement can lock it on for a session and forget about it; the modifier slot for snap was needed for Alt = zoom (see "Direct manipulation" below).

Ripple stays a held-modifier action because it's a one-off "make room here" gesture, not a session mode.

## The slate engine

The slate engine is the heart of the plugin's signature interaction. It takes a selection (one shot edge, one shot, multiple shots, or all shots) and aligns them to the audio's beat grid using motion-energy peaks as the alignment signal.

### Inputs
- The selection (edge, shot, set of shots)
- The audio's beat markers (from the audio subsystem)
- The motion-energy curve for each shot (from the motion-energy module)
- User-configurable parameters: beat target (every beat / downbeat / bar), rigidity (loose / tight), shot duration constraints (min, max, preferred deviation), action-frame weighting (translational vs. rotational vs. acceleration)

### Algorithm by selection size

**Edge slate:** snap the selected shot edge to the nearest beat or marker within a configurable threshold. Adjacent shots' edges adjust per ripple/roll setting.

**Single-shot slate:** find the shot's primary action frame. Identify the nearest beat that allows aligning the action frame within the shot's duration constraints. Re-time the shot (adjust in/out points) so the action frame falls on that beat. Cut points (the in/out frames themselves) are placed at low-energy moments where possible.

**Multi-shot slate (v1):** run single-shot slate on each selected shot independently. Simple, ships first, produces usable results.

**Multi-shot slate (v2):** sequence-aware. Treat as an optimization problem — assign action frames to beats such that shot order is preserved, no shots overlap, all duration constraints are respected, and total alignment error is minimized. Dynamic programming over the beat grid is the candidate approach. Not required for v1.

### Non-destructive contract

Every slate produces a new arrangement of shots that the user can immediately edit by hand. There is no "shotblocks" state on a shot. There is no lock. Undo reverts the slate. Drag overrides any alignment. The user is always in control of the final arrangement; slate is a starting point, not a verdict.

### Confirmation, not animation

The slate action is instant. There is no animation between keypress and result — the shots simply move to their new positions, and the user is immediately free to drag, undo, or invoke slate again.

Confirmation is delivered by:
- The visible change in shot positions on the timeline (the primary feedback — the user can see what happened)
- A status-line message naming what changed ("aligned 1 edge to nearest beat", "slated 4 shots to downbeats", "slated sequence")

There is no clap animation, no flash, no shake, no sound by default. Pro tools earn trust by being responsive; every animation between intent and result is friction. The user invokes slate dozens of times per session and never waits.

If a slate produces no visible change (the selection was already aligned, or no valid alignment exists), the status message says so explicitly. That is the only case where confirmation needs to do additional work, because the user cannot otherwise tell the action ran.

## Persistence

**Per document:** the shot list, audio file reference, marker set, and rig generator instance live in the C4D document. The carrier is a hidden helper `BaseObject` (a null with `NBIT_OHIDE`) inserted into the document; shot data serializes as JSON in the helper's `BaseContainer`. The helper is found by a marker container key on first access and created if absent. Mutations are wrapped in `doc.StartUndo() / AddUndo(UNDOTYPE_CHANGE_SMALL, helper) / EndUndo()` so create / move / resize / delete are all undoable.

Why the hidden null instead of `SceneHookData` or a `BaseList2D` attachment: `c4d.plugins.SceneHookData` is not exposed in the C4D 2026.2.0 Python SDK (verified empirically — `getattr(c4d.plugins, "SceneHookData", None)` returns None). A bare `BaseList2D` attachment to the document is invisible but its lifecycle is surprising on undo and copy/paste. A hidden null is a real document object: invisible to the Object Manager (`NBIT_OHIDE`), survives save/load, and integrates with the standard undo system. The cost is one document-internal object the user never sees.

**Global:** preset library lives on disk under the plugin's data directory. User-saved presets go to a user directory (platform-specific). Thumbnails cached alongside.

**Project-relative:** the audio file path stored as project-relative when possible, absolute as fallback.

## Bake-down

The bake-down operation:

1. User selects a shot (or the whole sequence) and triggers bake.
2. Plugin steps through every frame in range, evaluating the rig fully (including all tags).
3. Records position, rotation, focal length, focus distance per frame.
4. Runs F-curve reduction — fits a smaller set of keyframes to the recorded data within a tolerance.
5. Creates a new standard C4D camera with those reduced curves.
6. Optionally hides the procedural rig.

Curve reduction is critical. A naive bake produces unusable per-frame keys. Use a Ramer-Douglas-Peucker-style algorithm or fit cubic Beziers with controllable tolerance. The bake-down skill document covers the algorithm in detail.

## Threading and performance

- Spring-damper math runs on the main thread inside the tag's `Execute` — this is unavoidable in C4D's tag model.
- Audio decoding and onset detection run on a worker thread, posted back to the main thread when complete.
- Thumbnail generation runs on a worker thread.
- Waveform drawing is cached as a pre-rendered bitmap, redrawn only when zoom or audio changes.
- Avoid scene traversal inside per-frame tag code. Cache references to target objects on tag init; only walk the scene when the user changes a target.

## Versioning strategy

Target C4D 2026.2.0 on Windows. No compatibility shim, no parallel implementation, no `c4d_compat.py` until at least one additional target is on the roadmap. macOS is the natural next milestone after v0; older C4D versions are not on the roadmap. See `c4d-api.md`.

## Direct manipulation contract

The timeline must behave like Adobe After Effects' timeline. After Effects is the reference because Shotblocks's target users — motion designers and 3D artists who composite their renders downstream — already have AE muscle memory. The plugin must respect it.

### Drag is primary

The full plugin must be operable using only the mouse. Hotkeys exist as accelerators for users who want them; they are never the only path to any operation. The following drag interactions are non-negotiable:

- **Drag a camera from the Object Manager onto the timeline** → creates a new shot referencing that camera. Shot defaults to a sensible duration (e.g. 4 seconds) starting at the cursor's current frame, but the user can drag the shot's edges immediately to refine.
- **Apply a Shotblocks tag through C4D's standard tag menu** (right-click camera → Tags → Shotblocks, or via the menu bar) → the camera now has Shotblocks rig parameters. Existing tags can be moved between cameras by dragging — that's standard C4D behavior — but new tags are created via the menu.
- **Drag a preset from the preset panel onto an existing shot** → applies that preset to the shot's camera (must have Shotblocks tag; if not, prompt to add one or create a new tagged camera).
- **Drag a preset onto empty timeline space** → creates a new tagged camera with the preset applied, and a new shot referencing it.
- **Drag an audio file onto the timeline** → loads it as the document's audio, generates waveform and beat markers.
- **Drag a shot block** to move its position. Horizontal drag changes frame range; vertical drag changes track. Same-track collision: replace by default, Shift = ripple; snap-to-edge selectable via toolbar toggle (see "Overlap policy" above).
- **Drag the leading or trailing edge of a shot** to resize it. Same-track collision uses the overlap policy: trim neighbor by default, Shift = ripple neighbor; snap to neighbor's edge when snap toggle is on.
- **Alt is the canvas navigation modifier.** Alt+LMB drag → pan. Alt+RMB drag → zoom around click. Alt+scroll → zoom around cursor. Plain scroll → horizontal pan. Middle-mouse drag is *not* bound — C4D's framework intercepts MMB before it reaches `GeUserArea`'s drag system regardless of qualifier (verified empirically: `MouseDrag` returns terminal immediately for both plain MMB and Alt+MMB). Native C4D panels pan on Alt+MMB because they use the lower-level C++ input layer; Python plugins don't get that access in 2026. We substitute Alt+LMB so Alt remains the unifying nav modifier across all gestures.
- **Drag a cut point** (the boundary between two shots) to perform a roll edit.
- **Drag the in-point or out-point handles** at the top of the timeline to change the play range.
- **Drag the play-range bar itself** (between the handles) to slide both handles together preserving range length.

### Click and right-click

- **Click a shot** to select it; shift/cmd-click to extend selection; marquee drag to multi-select.
- **Click the play button** to play; click again to pause.
- **Click the loop toggle** to switch between play-once and play-looped.
- **Right-click a shot** to access contextual operations: Slate to nearest beat, Bake to standard camera, Set range to this shot, Duplicate, Delete, Convert to alt take.
- **Right-click a multi-selection** for the multi-shot equivalents: Slate selection, Bake selection, Set range to selection.
- **Right-click empty timeline space** for global operations: Range to all, Clear all markers, etc.

### Optional hotkey accelerators

For users who want them — none of these are the only path:

- `Spacebar` — play/pause (the one near-universal convention worth honoring as a default)
- `S` — slate the current selection
- `I` / `O` — set in/out at cursor for the play range
- `B` — bake the current selection
- `M` — drop a manual marker at the cursor
- `Delete` — remove selected shot(s)
- `Cmd/Ctrl+D` — duplicate selected shot as alt take

### Editability outside the range

- Shots outside the play range are dimmed visually but remain fully selectable, draggable, editable, and slate-able.
- The cursor can be scrubbed outside the range freely.
- The range affects *playback behavior only* — never editability.

Slate is *additive* to all of this. Every slate produces a new arrangement that is then immediately editable by all the above operations. Slate never produces a "shotblocks" lock state. Slate never disables drag.

## Module layout (src/)

```
src/
  __init__.py
  plugin_main.py            # registration entry point
  # c4d_compat.py             # API version shims — re-introduce only when targeting more than one version
  rig/
    shotblocks_tag.py       # the TagData class - applied by user to a camera
    parameters.py           # parameter IDs and defaults exposed in Attribute Manager
    hierarchy.py            # generates/maintains the world→boom→pan→tilt→camera nulls
    behaviors/
      spring_damper.py      # internal subsystem, not a separate tag
      look_at.py
      autofocus.py
      noise_profile.py
      framing_rule.py
  sequencer/
    core.py                 # shot list, active-shot resolution
    shot.py                 # Shot data class
    motion_energy.py        # per-shot motion-energy curve and peak detection
    slate.py                # the slate engine: edge / single / multi / all
    play_range.py           # in-point, out-point, loop state, range queries
    persistence.py          # document save/load
  audio/
    decoder.py              # audio file loading
    waveform.py             # waveform generation and caching
    onset.py                # beat / onset detection
    playback.py             # scrubbing-synced playback
  presets/
    library.py              # load / save / browse
    thumbnails.py           # generation
    schema.py               # preset JSON schema
  ui/
    timeline_dialog.py      # main GeDialog; owns the status line
    timeline_area.py        # GeUserArea for the timeline
    direct_manipulation.py  # drag-move, drag-resize, ripple/roll, multi-select
    inspector.py            # per-shot property panel
    preset_panel.py         # preset library panel
    drawing.py              # shared draw utilities
  bake/
    baker.py                # rig → standard camera bake
    curve_reduction.py      # F-curve simplification
```
