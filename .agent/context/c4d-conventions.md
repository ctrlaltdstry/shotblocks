# Cinema 4D conventions

How C4D users expect things to work. The unwritten norms of the application. When designing any feature that interacts with the rest of C4D, check against this document — if Shotblocks does something differently, that's friction, and friction needs a reason.

This is the document that catches "I think C4D works this way" assumptions before they reach the user. Several mistakes early in this project came from guessing wrong; this is the antidote.

## Authoritative tone

Some things in this document I am confident about because they're foundational and stable across versions. Others may have shifted in recent versions or have edge cases I don't know. Where I'm not certain, I say so. **Before relying on a specific detail for implementation, verify against the current SDK docs and a recent C4D installation.** The role of this file is to capture norms, not to replace empirical testing.

## The Object Manager

The Object Manager is the central hierarchy display. Most C4D users live here. Conventions:

- Objects appear as a tree. Selection is single-click. Multi-select is shift/cmd-click and marquee drag.
- Drag-and-drop within the Object Manager moves objects in the hierarchy. Drag onto an object to make it a child; drag between objects to reorder siblings.
- Tags appear as small icons to the right of the object name. They can be dragged between objects (this *moves* the tag — it does not copy by default). Hold Ctrl/Cmd to copy.
- Right-click an object exposes a contextual menu with Tags as a submenu, plus standard operations (Delete, Group Objects, Connect, etc.).
- Eye icons control viewport visibility (top dot = editor view, bottom dot = render view). Three states: visible, hidden, default-from-parent.
- Layer color appears as a small swatch; clicking it opens layer assignment.

**Important norm:** users expect the Object Manager to be the source of truth for "what's in my scene." Shotblocks must not create cameras, nulls, or other objects without surfacing them here. Hidden objects are a usability landmine — a user who can't see something they own will distrust the tool.

## Tags

Tags are object-attached pieces of behavior or data. Examples: Compositing tag, Phong tag, Constraint tag, Vibrate tag.

Application paths (any of these):
- Right-click the object → Tags → [tag name]
- Tags menu in the Object Manager menu bar → [tag name]
- Some tags are added by other operations (e.g., applying a material adds a Texture tag)

**Tags are NOT applied by dragging from a panel.** This was a mistake earlier in this project. Existing tags can be moved between objects by drag (cut-and-paste behavior); they are not created by drag.

Tag conventions:
- A tag belongs to exactly one object.
- An object can have many tags; their order in the row matters for some tag types (execution order).
- Tags can be enabled/disabled (icon toggles) without being removed.
- Some tags expose parameters in the Attribute Manager when selected; some are pure markers.
- Custom plugin tags follow the same conventions — `TagData` subclasses register an icon and parameter description.

## The Attribute Manager

The Attribute Manager shows parameters for the currently-selected object or tag. Conventions:

- Parameters group into tabs (Basic, Coord., Object, Tag-specific, etc.).
- Numeric fields support drag-to-scrub (drag the field horizontally to change values).
- Right-clicking a parameter exposes "Animate" (creates a track in the Timeline), "Set Driver"/"Set Driven" (Xpresso-style links), and "Reset to default."
- Parameters can be set to expressions or driven by Xpresso nodes — Shotblocks should not assume a parameter is a static value at any frame.
- Sliders and numeric inputs respect the unit system the user has set (cm, m, in, ft, etc.). Use C4D's unit conversion functions; don't assume centimeters.
- The Attribute Manager is *modal to selection* — what shows up depends on what's selected. Plugin parameters appear here automatically when the relevant object/tag is selected; we do not need a custom panel for them.

For the Shotblocks tag, all per-camera defaults belong in the Attribute Manager. Per-shot overrides belong in the Shotblocks timeline's inspector panel. Don't duplicate.

## The Coordinate Manager

Shows the position, scale, rotation of the selected object. Two coordinate spaces: *World* and *Object* (local relative to parent). Users toggle between them via a button.

Shotblocks must respect the user's coordinate space choice. When displaying or editing camera positions, match what the Coordinate Manager would show.

## Cameras

C4D cameras are objects in the scene like any other, with parameters for focal length, sensor size, focus distance, depth of field, projection type, etc.

Conventions:
- A scene can have many cameras. The "active" camera (what the viewport renders through) is set via the camera icon in the Object Manager or via the viewport's camera dropdown.
- Cameras can be parented to nulls or other objects to inherit transforms (this is how rigs work in standard C4D).
- The default camera (the one you fly around with) is not part of the scene — it's the editor camera. Plugins should not confuse this with scene cameras.
- Cameras animate via standard keyframing, splines (via Align to Spline tag), constraints (via Constraint tag), or Xpresso. Shotblocks must work with all of these as input animation in additive mode.

**The Shotblocks tag goes on a camera object.** Not on a null, not on a hierarchy parent. The user creates the camera the standard way; the tag is what makes it Shotblocks-aware.

## Animation

The Timeline window (separate from the Shotblocks timeline — this is C4D's native one) shows F-curves and keyframes. Conventions:

- Animation is per-parameter. Position has three tracks (X, Y, Z); rotation has three; focal length has one.
- Keyframes have interpolation modes (linear, spline, step) and tangent handles.
- The frame rate is set per-document; common values are 24, 25, 30, 60.
- The timeline starts at frame 0 by default but the document can have an arbitrary start frame.
- Animation can also come from non-keyframe sources: splines, expressions, Xpresso, constraints, Vibrate tag, Take System.

**Important norm:** users expect that any change they make to a parameter while at a non-zero frame creates a keyframe automatically *only if* "auto-keyframe" mode is on. Don't assume. the Shotblocks bake-down should produce explicit keyframes regardless of auto-keyframe state.

## Undo/redo

C4D has a global undo stack. Conventions:

- Every user action that changes the document state should be undoable.
- Plugin operations must register themselves with the undo system to participate.
- Coalescing: a single user action that touches many objects (like applying a preset) should be one undo entry, not many. Use `BaseDocument.StartUndo()` / `EndUndo()` and add individual changes with `AddUndo()`.
- Some operations are not undoable by default — file operations, plugin internal state changes — but should be made undoable when they affect what the user sees in the Object Manager or Attribute Manager.

Shotblocks must register every shot edit, slate operation, and rig parameter change with the undo system. This is a constitutional quality bar.

## The Take System

C4D's Take System is a way to manage scene variations. A "take" is a snapshot of parameter overrides relative to a base scene. Used for client variants, camera coverage, version control of looks.

the Shotblocks "alt take" (duplicate shot block as variant) is *separate* from C4D's Take System and uses the same word. This is a vocabulary collision worth being aware of, but the two systems serve different purposes:
- C4D Takes are scene-level (different versions of the whole scene)
- Shotblocks alt takes are shot-level (different versions of a single shot's rig state)

Don't try to integrate them initially. Keep them parallel. If users request the integration later, we'll evaluate then.

## Layers

C4D layers are organizational groupings (color-coded, can be hidden/locked together). Lighter-weight than the Object Manager hierarchy.

- Shotblocks should not require the user to use layers, but should respect layer visibility — if the user hides a camera's layer, that camera shouldn't render in Shotblocks playback either.
- Shotblocks could optionally tag its generated nulls with a "Shotblocks" layer for easy identification, but this should be off by default and opt-in via preferences.

## File operations

- Documents save as `.c4d` (binary) or `.c4d.zip` (compressed).
- Shotblocks state must be embedded in the document, not stored externally. Per-document things include: shot list, audio reference, markers, play range, slate settings.
- Global things (preset library, user preferences) live outside the document in the user's plugin directory.
- Asset references (audio files, textures) can be embedded or linked. C4D's Project Asset Inspector helps users see what's linked vs embedded. Audio in Shotblocks should default to linked (with project-relative path) and offer "embed" as an option for delivery.

## Viewport

The viewport is what the user is looking at. Conventions:

- Multiple viewports can be open, each with its own camera selection and rendering mode.
- Viewport refresh is event-driven — plugins should call `EventAdd()` when document state changes that affect rendering.
- Frame-by-frame playback can be slow on complex scenes. Users have learned to work with this; don't try to "fix" it inside a plugin.
- The viewport HUD shows the current frame, FPS, render time. Shotblocks may want its own HUD overlay (frame count within active shot, beat marker, slate-applied indicator) but this needs careful UX work — viewport HUD overlays are intrusive.

## Menu structure

C4D's menus are hierarchical: File, Edit, Create, Select, Tools, Mesh, Animate, Render, etc. Plugin commands typically live in:

- **Plugins** menu (for command-style plugins)
- **Create → ... → [your category]** (for object generators)
- **Tags** submenu in object context menus (for tags)

For Shotblocks, the timeline window opens via a Plugins menu entry: "Plugins → Shotblocks → Open Timeline." The Shotblocks tag appears in the Tags submenu. New presets can be created via the timeline UI, not via menu.

## Asset paths and platform differences

- C4D plugin paths differ by OS. Since R20, plugins are installed in the *user preferences* directory, not the application install directory. On Windows the path is something like `%APPDATA%\Maxon\Maxon Cinema 4D <version>_<hash>\plugins\` (note the `Maxon ` prefix and the build-hash suffix — both are real, both are install-specific). On macOS it is the analogous `~/Library/Preferences/Maxon/...` location. The exact name should be verified against the running install — see `dev-environment.md` for the verified path on the current dev box. (Pre-R20 plugins lived in `Plugins/` inside the app install — that path is deprecated and Maxon discourages it for cleaner upgrades.)
- File path separators: use `os.path.join()` and `os.path.sep`, never hardcode `/` or `\`.
- C4D's API has cross-platform path helpers (`c4d.storage.GeGetStartupPath()`, etc.) — prefer those when interacting with C4D-managed locations.

## Resource files

C4D plugins traditionally describe their UI parameters in `.res` files (text-based resource definitions) that C4D reads to build the Attribute Manager UI. Modern Python plugins can also describe parameters programmatically. Both work; resource files are more declarative and easier to maintain for stable parameter sets.

For Shotblocks:
- The tag's parameter description should be a `.res` file under `res/description/`. Stable, declarative, easy to localize.
- The timeline UI is custom-drawn, not resource-described.
- Preset definitions are JSON, not C4D resources.

## What "feels native" means in C4D

A C4D user trying Shotblocks for the first time should not have to learn that:
- Cameras are different here than the rest of C4D (they're not — Shotblocks just references them)
- Tags work differently (they don't — the Shotblocks tag follows tag conventions)
- The Object Manager doesn't show what's in their scene (it does — Shotblocks doesn't hide things)
- Undo doesn't work consistently (it does — every Shotblocks operation registers with the undo stack)
- Their existing animation will be replaced by the plugin (it won't — additive mode is the default)

If a user feels like they need a separate mental model to use Shotblocks, the integration is wrong. Shotblocks should feel like *more capability* attached to the C4D they already know, not a foreign system bolted on.