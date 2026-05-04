# Cinema 4D plugin development standards

How to actually build C4D plugins correctly. The implementation-side counterpart to `c4d-conventions.md`. Read this before writing any plugin code.

## Authoritative tone

This document captures patterns and constraints that have been stable across C4D versions. Specific API method signatures, parameter IDs, and registration details may differ between R23, R25, 2023, 2024, and newer versions. **Verify any specific API call against the current SDK documentation at https://developers.maxon.net/ before relying on it.** The role of this file is to capture the architectural shape and constraints, not to replace API reference.

## Plugin types

C4D Python plugins extend specific base classes. The relevant ones for Shotblocks:

- **`TagData`** — custom tags. The Shotblocks tag is one of these. Has an `Init`, `Execute` (per-frame), `Message` (events), and `GetDescription` (Attribute Manager) lifecycle.
- **`GeDialog`** — custom windows. The Shotblocks timeline is one of these. Has `CreateLayout`, `InitValues`, `Command`, and `Message` methods.
- **`GeUserArea`** — custom-drawn regions inside a `GeDialog`. The timeline area itself is one of these. Has `DrawMsg`, `InputEvent`, and `Sized` methods.
- **`MessageData`** — receives global messages (document-level events, undo, etc.). Used for scene hooks if needed for cross-document behavior.
- **`CommandData`** — menu commands. The "Open Shotblocks Timeline" menu entry is one of these.
- **`ObjectData`** — custom scene objects (generators). Shotblocks does NOT use this — the original architecture had a rig generator, but the redesign moved that into the tag.

## Plugin IDs

Every C4D plugin component (tag, dialog, command, etc.) needs a unique integer ID. Two plugins claiming the same ID cause a collision — only one loads. This is enforced by the plugin loader itself, not by policy.

**For prototyping and internal development:** the range `1000001-1000010` is reserved for testing and can be used without any registration. This is the right choice while we're iterating on architecture.

**For shipping a public release:** request unique IDs from Maxon's plugin identifier generator. As of writing, this still lives at `plugincafe.maxon.net` (the legacy URL) — Maxon migrated the developer forum to `developers.maxon.net` but plugin ID generation hasn't been ported yet and still uses the old site. The process is a form, not a long approval cycle. Verify the current URL before requesting; Maxon may complete the migration at some point.

For Shotblocks specifically: use the testing range during development, swap in real IDs before the first public release. Hardcode the IDs as named constants in `plugin_main.py` (or a dedicated `plugin_ids.py`) so the swap is one place.

Components Shotblocks needs IDs for:
- 1× Shotblocks tag plugin ID
- 1× timeline dialog ID
- 1× "Open Shotblocks Timeline" command ID
- 1× scene hook / message data ID for document-level events
- A range of parameter IDs for the tag's Attribute Manager fields (these are local to the tag and don't need Maxon registration; they only need to be unique within the tag)

## Project layout

A standard Python plugin lives in a directory under `plugins/` in either the install or user-prefs path. Layout:

```
shotblocks/
  shotblocks.pyp                    # entry point — name must match folder
  res/
    c4d_symbols.h                   # plugin-wide symbol enum (stub OK; required)
    description/
      tshotblocks.res               # tag's parameter description
      tshotblocks.h                 # parameter ID #defines (used by .res)
    strings_en-US/
      c4d_strings.str               # plugin-wide string table (stub OK; required)
      description/
        tshotblocks.str             # localizable strings for the .res
    icons/
      tshotblocks.tif               # 32x32 RGBA, the tag's icon
```

**`c4d_symbols.h` and `c4d_strings.str` are required stubs**, even when there are no plugin-wide symbols or strings to declare. Without them, `RegisterTagPlugin(description=...)` fails at startup with `RuntimeError: Could not initialize global resource for the plugin.` C4D's resource subsystem treats those two files as the "plugin's global resource bundle" and refuses to load any per-component resource (like the tag's `.res`) until the bundle is initialized. An empty enum and an empty `STRINGTABLE 0 { }` are sufficient. This was verified during v0 — was not in the original docs.

The `.pyp` file is what C4D loads. It registers all plugin components and imports our Python modules. Keep it thin — it's the entry point, not the implementation.

The `res/` directory follows C4D's resource-file conventions. `tshotblocks.res` describes the parameters; `tshotblocks.str` localizes the labels. C4D auto-discovers these by naming convention (the `t` prefix indicates a tag; objects use `o`, commands use `c`).

## Tag lifecycle

A `TagData` plugin has these methods that get called by C4D:

- **`Init(node)`** — called once when the tag is created. Set parameter defaults here. Cache references that won't change.
- **`Message(node, type, data)`** — called for various events (document load, undo, parameter change). Handle specific message types as needed.
- **`Execute(tag, doc, op, bt, priority, flags)`** — called once per frame during animation. This is the hot path. Read parameters, do the per-frame math, write the result.
- **`GetDescription(node, description, flags)`** — called when the Attribute Manager needs to show the tag's parameters. Usually delegates to the `.res` file via `description.LoadDescription(node.GetType())`.
- **`GetDDescription(...)`** (alternative) — for fully programmatic descriptions; used when parameters are dynamic. Shotblocks probably doesn't need this initially.

**Critical performance constraint:** `Execute` runs every frame. Every line of Python in `Execute` runs ~24 times per second of playback per tag. Vectorize math, cache references in `Init`, avoid scene traversal. Profile early.

## The "Execute priority" parameter

`Execute` has a `priority` argument. Tags have an execution order, and the priority determines when each tag runs in the per-frame pipeline. Standard priorities:

- `EXECUTIONPRIORITY_INITIAL` — early
- `EXECUTIONPRIORITY_ANIMATION` — after C4D's standard animation evaluation
- `EXECUTIONPRIORITY_EXPRESSION` — after expressions
- `EXECUTIONPRIORITY_DYNAMICS` — after physics
- `EXECUTIONPRIORITY_GENERATOR` — for generator tags

For Shotblocks:
- The Shotblocks tag should run at `EXECUTIONPRIORITY_EXPRESSION` so user keyframes are already evaluated when our `Execute` runs (critical for additive mode — we need the camera's animated values before we add deltas).

This is the kind of thing to verify against current SDK docs before locking in.

## Threading model

C4D's main rules:

- The main thread owns the document and the UI. Most API calls require the main thread.
- Plugin lifecycle methods (`Init`, `Execute`, `Message`, etc.) run on the main thread.
- Worker threads can do CPU-bound work (audio decoding, motion-energy computation, thumbnail generation), but cannot directly modify the document or call most C4D API functions.
- To pass results from a worker back to the main thread, use a thread-safe queue and post a message that's picked up on the main thread (e.g., `c4d.SpecialEventAdd()`).
- File I/O can happen on worker threads but path resolution should use `c4d.storage` helpers, which are thread-safe for read.

Shotblocks threading needs:
- Audio decoding → worker thread, posts back when complete
- Motion-energy curve computation → worker thread, cached results read on main thread
- Thumbnail generation for presets → worker thread
- Everything else (timeline UI, tag execution, sequencer) → main thread

## Document state and persistence

C4D documents are `BaseDocument` objects. Plugins can attach data to them in several ways:

- **Per-tag storage** — parameters defined in `.res` are automatically saved with the document (when on a tag attached to an object)
- **Custom containers** — `BaseList2D` containers can store arbitrary data; attach to the document via `BaseDocument.GetData()` / `SetData()`
- **Scene hooks** — global plugins that get serialized with documents; useful for document-level state that doesn't belong to a specific object

For Shotblocks:
- **Per-camera tag parameters** — stored on the Shotblocks tag itself, automatic
- **Shot list, audio reference, markers, play range** — stored in a custom `BaseContainer` attached to the document via a scene hook or a hidden helper object
- **Preset library, user preferences** — stored in the user's plugin directory, not the document

The exact persistence approach (scene hook vs hidden helper object vs attached container) is worth verifying against current SDK best practices; both have worked historically but Maxon's recommendations have shifted.

## Undo/redo integration

To make an operation undoable:

```python
doc.StartUndo()
doc.AddUndo(c4d.UNDOTYPE_CHANGE, target_object)  # or UNDOTYPE_NEW, UNDOTYPE_DELETE
# perform the change
doc.EndUndo()
c4d.EventAdd()  # tell C4D to update the UI
```

Important rules:
- Always `AddUndo` *before* making the change; C4D snapshots the pre-change state.
- Wrap related changes in a single `StartUndo`/`EndUndo` pair so they coalesce into one undo entry.
- The undo type matters: `UNDOTYPE_CHANGE` for parameter edits, `UNDOTYPE_NEW` for object creation, `UNDOTYPE_DELETE` for removal.
- Custom container changes need `UNDOTYPE_CHANGE_SMALL` or a custom hook; this is more involved.

the Shotblocks slate operation, for example: one `StartUndo` at the beginning, `AddUndo` for each shot whose position is changing, do the changes, one `EndUndo` at the end. Result: one undo step that reverses the entire slate operation.

## Drawing in `GeUserArea`

The timeline area is a `GeUserArea`. Drawing happens in `DrawMsg`:

```python
def DrawMsg(self, x1, y1, x2, y2, msg):
    self.OffScreenOn()  # double-buffered drawing
    self.DrawSetPen(c4d.COLOR_BG)
    self.DrawRectangle(x1, y1, x2, y2)
    # ... draw content
```

Key methods:
- `DrawSetPen(color)` — set stroke/fill color (use `c4d.COLOR_*` constants for theme-aware colors)
- `DrawRectangle`, `DrawLine`, `DrawText` — primitive drawing
- `DrawBitmap(bmp, ...)` — draw cached bitmaps (use this for waveforms, thumbnails)
- `OffScreenOn()` — enable double-buffering to avoid flicker

Performance: `DrawMsg` can be called many times per second during scrub/resize. Cache expensive content as bitmaps and blit, don't recompute pixels in `DrawMsg`.

Input handling happens in `InputEvent`:

```python
def InputEvent(self, msg):
    if msg[c4d.BFM_INPUT_DEVICE] == c4d.BFM_INPUT_MOUSE:
        # handle mouse
    elif msg[c4d.BFM_INPUT_DEVICE] == c4d.BFM_INPUT_KEYBOARD:
        # handle keyboard
    return True
```

Mouse drag is a sequence of move events between a button-down and button-up. Custom drag-and-drop within and between `GeUserArea` instances uses C4D's `MouseDragStart`/`MouseDrag`/`MouseDragEnd` family.

**Verified in 2026.2.0 (v1 timeline canvas):**

- `BFM_INPUT_DEVICE`, `BFM_INPUT_MOUSE`, `BFM_INPUT_KEYBOARD`, `BFM_INPUT_X`, `BFM_INPUT_Y`, `BFM_INPUT_CHANNEL` all exist and work via `msg.GetInt32(...)`.
- **Mouse channels:** `1` = left button, `2` = right button. Middle button is presumed `3` but unverified — check before relying.
- **Keyboard channels:** Letter keys A–Z map to ASCII codes 65–90 (e.g. `D` → 68, `R` → 82). Modifier and special-key encodings are unverified for this version.
- Coords are in canvas-local pixel space, top-left origin.

Inside `DrawMsg(x1, y1, x2, y2, msg)`, do **not** treat `x2 - x1` as the canvas width — that rect can be a partial-redraw dirty region, not the full canvas. Use `self.GetWidth()` / `self.GetHeight()` to get the true canvas dimensions, and don't cache them from `Sized()`. Caching produced left-edge ghost ticks during v1 because `Sized()` had not yet fired on the first paint.

## Drag-and-drop from the Object Manager

Receiving an Object Manager drag (e.g., user drags a camera onto the Shotblocks timeline) requires:

- The receiving area handles `BFM_DRAGRECEIVE` messages
- Inspecting the dragged object's type (`c4d.Ocamera` for cameras)
- Calling `Message(self, c4d.BFM_DRAGFINISHED, ...)` or similar to confirm the drop

Specifics here depend on whether the area is a `GeUserArea` inside a dialog or something else. Verify against SDK docs before implementing — drag-and-drop between Object Manager and custom areas has historically been one of the trickier C4D plugin interactions.

## Resource files

`.res` files describe Attribute Manager parameter UIs declaratively:

```
CONTAINER Tshotblocks
{
    NAME Tshotblocks;
    INCLUDE Texpression;

    GROUP ID_TAGPROPERTIES
    {
        REAL SHOTBLOCKS_DAMPING { MIN 0.0; MAX 1.0; STEP 0.01; }
        LONG SHOTBLOCKS_OPERATOR_PERSONALITY { CYCLE { SHOTBLOCKS_OP_STEADY; SHOTBLOCKS_OP_NERVOUS; SHOTBLOCKS_OP_ENERGETIC; } }
    }
}
```

The corresponding `.h` file:
```c
#ifndef TSLATED_H__
#define TSLATED_H__

enum
{
    SHOTBLOCKS_DAMPING = 1000,
    SHOTBLOCKS_OPERATOR_PERSONALITY = 1001,
    SHOTBLOCKS_OP_STEADY = 0,
    SHOTBLOCKS_OP_NERVOUS = 1,
    SHOTBLOCKS_OP_ENERGETIC = 2,
};

#endif
```

The strings file `.str`:
```
STRINGTABLE Tshotblocks
{
    Tshotblocks "Shotblocks";
    SHOTBLOCKS_DAMPING "Damping";
    SHOTBLOCKS_OPERATOR_PERSONALITY "Operator personality";
    SHOTBLOCKS_OP_STEADY "Steady veteran";
    SHOTBLOCKS_OP_NERVOUS "Nervous documentarian";
    SHOTBLOCKS_OP_ENERGETIC "Music-video energetic";
}
```

C4D auto-loads these when the plugin registers. The Python side uses the IDs from the `.h` (typically replicated as Python constants):

```python
SHOTBLOCKS_DAMPING = 1000
SHOTBLOCKS_OPERATOR_PERSONALITY = 1001

# in tag's Init:
node[SHOTBLOCKS_DAMPING] = 0.5
```

## Registering the plugin

In `shotblocks.pyp`:

```python
import c4d
import os

PLUGIN_ID_TAG = 1000001       # testing range; replace with Maxon-issued ID before release
PLUGIN_ID_DIALOG = 1000002    # ditto
PLUGIN_ID_COMMAND = 1000003   # ditto

class ShotblocksTag(c4d.plugins.TagData):
    def Init(self, node):
        # ...
        return True

    def Execute(self, tag, doc, op, bt, priority, flags):
        # ...
        return c4d.EXECUTIONRESULT_OK

# At module load:
if __name__ == "__main__":
    c4d.plugins.RegisterTagPlugin(
        id=PLUGIN_ID_TAG,
        str="Shotblocks",
        info=c4d.TAG_VISIBLE | c4d.TAG_EXPRESSION,
        g=ShotblocksTag,
        description="tshotblocks",  # references tshotblocks.res by name
        icon=icon,                  # BaseBitmap loaded with InitWith(path)
    )
    # ... register dialog and command
```

Register at module load, not lazily.

## Common gotchas

- **`c4d.EventAdd()` is required after most state changes.** Without it, the UI doesn't refresh and your changes appear to do nothing.
- **`doc.SetActiveObject()` and similar selection changes do NOT trigger Attribute Manager refresh automatically.** You may need `c4d.EventAdd(c4d.EVENT_FORCEREDRAW)` or specific message types.
- **Parameter changes via Python (`node[ID] = value`) do not always trigger expression re-evaluation.** Use `node.Message(c4d.MSG_UPDATE)` after setting parameters when you need expressions to recompute.
- **The Attribute Manager is per-document.** If multiple documents are open, each has its own state. Be careful with global state.
- **Python's `print()` writes to C4D's console window** (Window → Console). Visible during development; remove before shipping.
- **Performance: tag execution is single-threaded.** Don't try to parallelize within `Execute`. Move heavy work to worker threads via the threading model above.
- **`MoveAfter`, `MoveBefore`, `InsertUnder` for hierarchy manipulation each have specific use cases and ordering implications.** Read the SDK docs carefully before manipulating hierarchies.
- **Plugin folders cannot be hot-reloaded.** Changing Python code requires restarting C4D (or using the dev workflow with the Script Manager for testing fragments).

## Testing and debugging

- C4D's Python Console (Script Manager) is the primary REPL. Useful for testing API calls without restarting.
- Set up logging early — Python's `logging` module works fine; pipe to a file in the user's plugin directory.
- The Plugin Manager (Window → Customization → Customize Commands → Plugin Manager) shows what's loaded and any errors at load time.
- For step-debugging, attach an external debugger (PyCharm, VS Code) to C4D's Python interpreter. Specifics vary by version.

## Cross-version compatibility

C4D's Python API has evolved across versions:
- R23 used Python 2.7 (legacy, not relevant for new development)
- R25 transitioned to Python 3
- 2023+ uses modern Python 3 with stable APIs
- 2024+ has additional new APIs (Capsules, scene-graph improvements, etc.)

For Shotblocks, target 2024+ as primary. R25 / 2023 compatibility is a stretch goal that should not compromise the architecture. Use feature detection (`hasattr(c4d, 'NewAPI')`) rather than version checks where possible — versions can lie about what they support.

The compatibility shim layer (`c4d_compat.py`) is the place to put any version-specific branching. Keep this thin; don't let it become a parallel implementation.

## What to verify before relying on specifics

This document captures the *architectural* shape of how C4D plugins work. Specific API calls, parameter IDs, message constants, and other details should always be verified against:

1. The current SDK documentation at https://developers.maxon.net/
2. The Python SDK example code shipped with C4D
3. Empirical testing in the target C4D version

If a specific detail in this document conflicts with current SDK docs, the SDK docs win. Update this file when the conflict is found.