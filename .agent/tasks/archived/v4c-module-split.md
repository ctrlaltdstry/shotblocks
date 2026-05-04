# Task: v4c — Module split (refactor, no behavior change)

## Goal
Break the 2000-line `src/shotblocks.pyp` into focused sibling modules so the audio subsystem and slate engine (v5+) don't have to share a file with the timeline UI. **Strict constraint: no behavior changes.** Same code, organized.

## Why
v0 through v4b deliberately kept everything in one file because C4D's plugin loader behavior with sibling modules wasn't verified empirically. The v2 task notes flagged this directly: "C4D adds the plugin folder to `sys.path` so `from shot_model import ...` should work — verify this assumption first, fall back to keeping it all in `.pyp` if not." That verification never happened; the file just kept growing.

The architecture doc (`architecture.md` "Module layout (src/)") has always anticipated a multi-file layout. v5+ work — audio decoding/onset detection, motion-energy curves, slate engine, bake — really shouldn't share a file with `GeUserArea` drawing code. Now is the moment to split, before any of that lands.

## Scope

**In scope:**

- New module structure under `src/`:
  - `shotblocks.pyp` — entry point. Constants, tokens, plugin IDs, `ShotblocksTag`, `ShotblocksTimelineDialog`, `OpenShotblocksTimelineCommand`, the `__main__` registration block. Adds a `sys.path` bootstrap so sibling imports work regardless of how C4D's loader sets things up. ~300 lines.
  - `sb_persistence.py` — helper-null find/create, `_read_shots/_write_shots`, `_read_range/_write_range`. The C4D-aware persistence layer.
  - `sb_shot_model.py` — `_make_shot`, track helpers (`_shot_track`, `_shots_on_track`, `_max_used_track`, `_displayed_lane_count`), `_active_shot_at`, `_collect_edit_points`, magnetic-snap functions, `_resolve_position`, `_resolve_resize`, `_ripple_around`, `_replace_overlap`. Pure-function, ideally no `c4d` import.
  - `sb_canvas.py` — `ShotblocksTimelineCanvas` and everything it depends on (drag handlers, hit-testing, drawing, color tokens that are canvas-only).
- Bootstrap line near the top of `shotblocks.pyp`:
  ```python
  import sys, os
  _here = os.path.dirname(os.path.abspath(__file__))
  if _here not in sys.path:
      sys.path.insert(0, _here)
  ```
- Constants stay close to their consumers: layout constants and color tokens used only inside the canvas live in `sb_canvas.py`; plugin IDs (`PLUGIN_ID_TAG`, etc.) stay in `shotblocks.pyp`. BaseContainer keys (`BCKEY_*`) and helper-null marker live in `sb_persistence.py`.
- Imports follow a one-way dependency graph: `sb_canvas` imports from `sb_shot_model` and `sb_persistence`; `sb_persistence` imports from `sb_shot_model` if needed (it currently doesn't); `sb_shot_model` imports from neither. No circular imports.

**Out of scope:**

- Any behavior change. Logic, prints, parameters, interactions, persistence format — all identical to current `main`. Diffs are pure refactor.
- Function renames or signature changes. Even names that start with a leading underscore stay underscored where they were, so future grep/blame still tells the same story.
- Splitting the canvas class further. `sb_canvas.py` will be ~1300 lines and that's fine — it's cohesive (it *is* the canvas). v5+ may extract sub-pieces (drag-loop helpers, drawing utilities) if natural breaks emerge.
- Type annotations, docstring polish, or other "while I'm here" improvements. Keep the diff reviewable.

## Approach

Order matters because each step has to leave the plugin in a runnable state:

1. **Bootstrap.** Add the `sys.path` insert to `shotblocks.pyp`. Deploy. Verify the plugin still loads. (Should be a no-op since nothing imports siblings yet.)
2. **Extract `sb_shot_model.py`.** Pure functions, no C4D dependency. Move them, add `from sb_shot_model import *` (or explicit imports) at the top of `shotblocks.pyp`. Deploy, drag a camera onto the canvas, verify it works.
3. **Extract `sb_persistence.py`.** Helper-null code + read/write. Move them, import. Deploy, verify create/move/delete + undo all still work.
4. **Extract `sb_canvas.py`.** The big one. The class itself moves; constants used only by it move with it; imports adjust accordingly. Deploy, verify the entire v3+v4a+v4b feature set still works.
5. **Manual smoke test** via `dev-loop.ps1`: drag-from-OM, drag-move, edge-resize, snap toggle behavior, marquee, right-click menus (Delete, Duplicate, Set Range to *), I/O hotkeys, range-bar drag, playhead scrub, Alt+navigation. Anything that breaks is a refactor bug.

If step 2 fails (sibling import doesn't work), the bootstrap was wrong; debug there. If step 4 fails, likely a missed reference between the canvas and a moved helper; grep for the symbol and add an import.

## Open questions

- **Star-imports vs. explicit imports.** `from sb_shot_model import *` keeps the canvas code looking identical to today, but pollutes the namespace. Explicit imports (`from sb_shot_model import _make_shot, _resolve_position, ...`) are more honest but add ceremony. Pick: **explicit imports**, because the cleanup pays off the next time we want to know what each file actually uses.
- **Should we name the modules `shotblocks_*.py` or `sb_*.py` or no prefix?** The plugin folder is `shotblocks/`, so module names there are already namespaced. A prefix is cosmetic. Use `sb_` prefix; it's short, matches the plugin's mental shorthand, and avoids collisions with anything C4D might inject into `sys.path`.
- **C4D plugin reload behavior.** If C4D ever holds a stale reference to one of the sibling modules (e.g., after an in-process Reinit Plugins), the user might see wrong behavior. Our dev-loop force-restarts C4D every deploy so this never bites us in development. Document it in `pitfalls.md` as a known issue for any future user who tries to reinit-without-restart.

## Done when
- [ ] `src/shotblocks.pyp`, `src/sb_persistence.py`, `src/sb_shot_model.py`, `src/sb_canvas.py` all exist
- [ ] `shotblocks.pyp` is under ~400 lines; has the `sys.path` bootstrap; only contains constants, plugin IDs, the Tag/Dialog/Command classes, and the registration block
- [ ] `sb_shot_model.py` has zero `import c4d` (pure-function module)
- [ ] No circular imports
- [ ] Deploy via `dev-loop.ps1` succeeds
- [ ] All v3+v4a+v4b features pass a manual smoke test (drag-from-OM, move, resize, snap toggle, marquee, right-click menus, Set Range to *, I/O hotkeys, range-bar drag, playhead scrub, Alt+nav, Ctrl+D, Delete/Backspace, undo)
- [ ] No new console errors or warnings
- [ ] `pitfalls.md` notes the in-process reload caveat for sibling modules

## Notes
_(populate during/after the work)_
