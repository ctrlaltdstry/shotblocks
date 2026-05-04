# Task: v2 — Drag a camera onto the canvas to create a shot

## Goal
Drag a Camera object from C4D's Object Manager onto the Shotblocks timeline canvas → a shot block appears, persists with the document, and can be undone. The first feature where Shotblocks actually owns document state.

## Why
The constitution names drag-from-Object-Manager as the canonical path to create a shot (`constitution.md` §2, §5; `ui-conventions.md`). v1 gave us a canvas; this gives the canvas content and forces the data-model decision (`open-questions.md` "Persistence approach") that's been deferred since v0. Without this, every subsequent feature — slate, bake, drag-resize, presets — has nothing to operate on.

It also exercises C4D's drag-receive API for the first time, which `c4d-plugin-development.md` flags as historically tricky and worth verifying empirically before building a UX on top of it.

## Scope

**In scope:**
- The timeline canvas accepts drops of objects from the Object Manager.
- If the dropped object is a `c4d.Ocamera`, a shot is created and rendered as a block on the canvas. Drop x-coord → shot's start frame; default duration is 24 frames.
- If the dropped object is anything else (Cube, Light, Null, etc.), the drop is rejected gracefully (no crash, no error in console — just nothing happens).
- A Shot data structure (camera reference, in-frame, out-frame, stable id) and a ShotList that lives on the document.
- Shots persist with the document — save the .c4d, close, reopen, shots are still there.
- The create operation is undoable (`Cmd/Ctrl+Z` removes the just-created shot).
- Shot blocks render on the canvas using the **untagged passthrough** colors from `visual-language.md` (gray fill, lighter gray border, near-white label). Every shot is rendered as untagged-passthrough for v2 regardless of whether its camera has a Shotblocks tag — coloring by tag state is a future task.
- The shot block's label is the source camera's name.

**Out of scope:**
- Multi-track layout (one row of shots for v2).
- Drag-to-move existing shots, drag-to-resize edges, hit-testing for selection.
- Right-click context menu on a shot.
- Per-shot rig state, additive/replace mode coloring, framing rules.
- Orphaned shot handling (camera deletion intercept).
- Shot inspector panel.
- Slate, bake, audio, presets, hotkeys, zoom UI — all later tasks.
- Drop on an existing shot (e.g., to relink) — for v2 the canvas is treated as flat empty space.

The temptation to add hit-testing or drag-move alongside this will be strong because they feel cheap once the shot is on the canvas. Resist. The data model's correctness needs verification before we layer interactions onto it.

## Approach

### Persistence
Using a **scene hook** (`c4d.plugins.SceneHookData`, the per-document variant — not `MessageData`, which is global). The scene hook gives us one `BaseList2D` node per document automatically, invisible to the user, that serializes with the .c4d file. Shots live as sub-containers in `node.GetDataInstance()`. Each shot sub-container holds:
- `BaseLink` to the source camera (survives renames, save/load, undo)
- in-frame (int)
- out-frame (int)
- shot id (string GUID generated at create)

This resolves the `open-questions.md` "Persistence approach" entry by picking the scene hook option from the architecture doc's "BaseList2D container or scene hook" choice. Picked over a `BaseContainer` slot in `doc.GetData()` because **undo** is the deciding factor: `AddUndo(UNDOTYPE_CHANGE_SMALL, ...)` requires a `BaseList2D`, and the scene hook gives us one. A bare container slot would have made undo hacky.

`PLUGIN_ID_SCENE_HOOK = 1000004` (next testing-range ID).

### Drag receive
Override `Message(msg, result)` on `ShotblocksTimelineCanvas`. Handle `BFM_DRAGRECEIVE` for drop validation and the drop itself; reject non-camera objects by returning early. Use `GetDragObject()` (or whatever the 2026 API equivalent is — verify) to inspect the dragged object before accepting.

### Drawing
In `DrawMsg`, after the ruler/playhead, iterate the shot list and draw each shot as a rectangle. Y position is fixed (a single row below the ruler, e.g. y=32–80). Use `_frame_to_x` for in/out → pixel translation.

### Undo
Wrap the create in `doc.StartUndo()` / `doc.EndUndo()` with `AddUndo(UNDOTYPE_CHANGE_SMALL, ...)` on the document's data container. Verify `UNDOTYPE_CHANGE_SMALL` is the right type for container-data changes — it's the documented one but we haven't tried it.

### Code organization
Three small Python modules in `src/`:
- `shotblocks.pyp` — registration only (already there)
- `shot_model.py` — Shot dataclass + ShotList helpers (read/write the document container)
- `timeline_canvas.py` — `ShotblocksTimelineCanvas` extracted from `shotblocks.pyp`

The .pyp is approaching 200 lines; split now per the v1 task's stated heuristic. C4D adds the plugin folder to `sys.path` so `from shot_model import ...` should work — verify this assumption first, fall back to keeping it all in `.pyp` if not.

## Open questions to resolve during this task

- **Drag-receive API in 2026.2.0.** `BFM_DRAGRECEIVE`, `MSG_DRAGSTART`/`MSG_DRAGEND`, `GetDragObject` — which exist, what's the message dict shape, how do we read drop position vs validation hover position?
- **Object type checking.** Is `obj.GetType() == c4d.Ocamera` reliable, or do we need `obj.CheckType(c4d.Ocamera)` / `isinstance` against a specific class?
- **Plugin folder on `sys.path`?** Does C4D 2026.2.0 add the plugin's folder to `sys.path` automatically, allowing sibling-module imports from a `.pyp`? If not, we use a relative loader or keep everything in the `.pyp`.
- **`UNDOTYPE_*` for container changes.** Confirm `UNDOTYPE_CHANGE_SMALL` is the right type for our use case, or whether we need `UNDOTYPE_CHANGE` on the document itself.
- **`BaseContainer` round-trip.** Does writing to `doc.GetData().GetContainerInstance(ID)` actually serialize with `.c4d` save/load, or do we need a scene hook to opt into it?
- **`BaseLink` from Python.** Confirm the create / set / dereference pattern in 2026.2.0 — historically `c4d.BaseLink` and `BaseList2D` have had subtle API shifts.

## Done when
- [ ] Dragging a Camera object from the Object Manager onto the canvas creates a visible shot block
- [ ] Shot block label is the source camera's name
- [ ] Shot block is gray (untagged passthrough) per `visual-language.md`
- [ ] Drop x-coordinate becomes the shot's start frame; default duration 24 frames
- [ ] Dragging a non-camera object (Cube, Light, Null) is rejected without crashing or printing errors
- [ ] Saving the document, closing it, and reopening it preserves the shot
- [ ] Cmd/Ctrl+Z immediately after a create removes the shot from the canvas and from the document container
- [ ] All v2 open questions are resolved and migrated out
- [ ] No regression on v0 or v1: tag still applies, dialog opens, canvas draws, mouse logging works

## Notes
_(populate during/after the work)_
