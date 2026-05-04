# Task: v4b — Play-range bar with I/O handles

## Goal
Add the always-visible play-range bar to the top of the timeline, with draggable in-point/out-point handles, draggable body (slide both together), the I/O hotkeys, and the deferred "Set Range to…" right-click menu items. Range persists with the document and is undoable.

## Why
Constitution principle 5 names the play range as a non-negotiable, always-defined, always-visible element of the timeline ("a single play range is always defined and always visible at the top of the timeline, with draggable in-point and out-point handles"). The glossary reinforces it. v4a deferred "Set Range to This / Selection" because there was no range to point at. v4b unblocks that, and lays the foundation for spacebar playback + the loop toggle once an actual playback engine exists.

## Scope

**In scope:**

- **Layout shift.** A 16px range-bar band gets added at the very top of the canvas. Order top-to-bottom: range bar (16) → ruler (24) → track lanes. `SHOT_Y_TOP` shifts from 28 to 44; every Y-coord helper that depends on it updates accordingly.
- **Range-bar rendering** per `visual-language.md`:
  - Background: `#3a3a3a` (`range.bar`).
  - Active region between in and out: `#5a5a4a` (`range.active`).
  - Handles at in and out: `#aaaa8a` (`range.handle`), drawn as small rectangles flanking the active region.
- **Persistence.** Range stored as `{"in": int, "out": int}` JSON in the helper null's `BaseContainer` under a new key (`KEY_RANGE_JSON = 1012`). Default on first read: `[0, 240]`. Writes wrapped in `AddUndo(UNDOTYPE_CHANGE_SMALL, helper)` so range edits join the undo stack.
- **Drag interactions.**
  - Drag in-handle → resize the in side (clamped to `0 ≤ in < out`).
  - Drag out-handle → resize the out side (clamped to `in < out`).
  - Drag the bar body (between handles) → slide both handles together preserving length; clamp to `in ≥ 0` (no upper clamp — out can extend freely).
  - All three use `_drag_loop` like the existing drag handlers.
- **Hit testing for the bar.** A 6px-wide hit zone on each handle (same convention as edge-drag on shots). If `y < RANGE_HEIGHT`, route to range-bar handler before the shot/marquee path.
- **Right-click menu additions.**
  - On a single shot: prepend `Set Range to This` to the existing Delete/Duplicate items.
  - On multi-selection: prepend `Set Range to Selection (N)`.
  - On empty canvas (which had no menu in v4a): show a global menu with `Range to All` (= `[0, max(out_frame across all shots)]` if any; otherwise no-op or default).
- **I/O hotkeys.**
  - `I` → set in-point to the current playhead frame; clamp `in < out` (if I would push past out, no-op or trim to `out - 1`).
  - `O` → set out-point to the current playhead frame; clamp `out > in`.
- **Undo.** Every range mutation (drag, menu item, hotkey) wraps in `StartUndo / AddUndo / EndUndo` exactly like shot mutations.

**Out of scope (future):**

- **Spacebar play/pause + actual playback.** No timer, no frame-walker, no audio. The range exists; playback is its own task once we have audio + a frame-stepper.
- **Loop toggle button.** Visual UI element next to a transport-controls toolbar that doesn't exist yet. Constitution mentions it; defer until transport lands.
- **Auto-fit on first shot creation.** When a fresh document gets its first shot, range stays at `[0, 240]` rather than auto-snapping to that shot. The user can always invoke "Range to All" if they want it to fit. (Less surprise this way.)
- **Range scaling on zoom.** Range is per-document, not per-view; zoom doesn't affect it.

## Approach

1. **Constants + tokens.** Add `RANGE_HEIGHT = 16`, `RANGE_Y_TOP = 0`, shift `SHOT_Y_TOP` to `RANGE_HEIGHT + RULER_HEIGHT + 4`. Add `COL_RANGE_BAR`, `COL_RANGE_ACTIVE`, `COL_RANGE_HANDLE`. Add `RANGE_HANDLE_PX = 6` (handle hit-zone width).
2. **Persistence.** Add `KEY_RANGE_JSON = 1012`, `_read_range(doc)`, `_write_range(doc, in_f, out_f, with_undo=True)`. Default `(0, 240)` on absent or invalid data.
3. **Drawing.** In `DrawMsg`, draw the range bar before the ruler. Three rectangles: background span (full width), active span (in→out), handle markers (small squares at in and out). Verify the playhead still draws through the bar.
4. **Hit test.** Add `_hit_test_range(x, y, range_in, range_out, w)` returning `"in_handle" | "out_handle" | "body" | None`. Body hit only when `range_in_x < x < range_out_x`. Body has lower priority than handles when zones overlap.
5. **Mouse routing.** In `_on_left_press`, if `y < RANGE_HEIGHT`, dispatch to range-bar logic instead of falling through to shot hit-test / marquee. Alt-LMB pan still wins (Alt check comes first; that's already how it works).
6. **Drag handlers.** `_drag_range_in`, `_drag_range_out`, `_drag_range_body`. Each uses `_drag_loop` with an `on_tick` that updates a preview range and calls `Redraw`. On commit, `_write_range(doc, ..., with_undo=True)`.
7. **Right-click menu wiring.** Extend `_open_context_menu` to prepend the Set-Range items. Add an empty-canvas branch that builds and shows the global menu.
8. **I/O hotkeys.** Add channel handling in `_on_keyboard` for `ord('I')` and `ord('O')`. No qualifier required (constitution treats them as plain accelerators).
9. **Verify regressions.** v3 drag/resize/snap, v4a selection/menus, drag-from-OM all still work after the layout shift.

## Open questions

- **Drag-handle zone overlap.** When `out − in` is small (a 1-frame range zoomed out), the two handles' hit zones overlap. Pick: in-handle wins on the left side, out-handle wins on the right; tiebreak at the midpoint by closer pixel distance. Acceptable to clamp the range to a minimum width on commit (e.g., 1 frame).
- **Right-click on empty canvas — single item only?** "Range to All" is the only operation that makes sense in v4b. A one-item popup feels awkward. Acceptable: show the menu anyway; we'll add "Clear All Markers" etc. when those concepts exist.
- **I/O when cursor is outside the current range.** Setting in past out (or vice versa) should clamp rather than error. Pick: clamp to `out - 1` / `in + 1` so the action always succeeds; print a status line so the user knows it clamped. (Status line doesn't exist yet; defer the user-feedback piece.)
- **Default range when document opens with shots already present.** If the user saves and reopens, range comes back from the helper. If for some reason the range data is corrupted, default to `(0, 240)` rather than `(0, max(out))` — less surprise on data loss.

## Done when
- [ ] A 16px range bar is visible at the top of the timeline, above the ruler
- [ ] Default range on a fresh document is `[0, 240]`
- [ ] Active region between in and out renders in the active color
- [ ] In and out handles are visually distinct from the bar body
- [ ] Dragging the in-handle changes the in-point; out stays fixed; clamps to `0 ≤ in < out`
- [ ] Dragging the out-handle changes the out-point; in stays fixed; clamps to `in < out`
- [ ] Dragging the bar body slides both handles together preserving length; clamps `in ≥ 0`
- [ ] Range edits are undoable in one step
- [ ] Range persists across dialog close/reopen (helper-null storage)
- [ ] Right-click on a single shot shows `Set Range to This` (plus Delete and Duplicate)
- [ ] Right-click on multi-selection shows `Set Range to Selection (N)` (plus Delete (N) and Duplicate (N))
- [ ] Right-click on empty canvas shows a menu with `Range to All`
- [ ] `I` hotkey sets in-point to current playhead frame; clamps if needed
- [ ] `O` hotkey sets out-point to current playhead frame; clamps if needed
- [ ] No regressions: v3 drag-from-OM / drag-move / drag-resize / snap, v4a selection / marquee / Delete / Duplicate, Alt+navigation gestures all still work
- [ ] Pre-commit checklist passes

## Notes
_(populate during/after the work)_
