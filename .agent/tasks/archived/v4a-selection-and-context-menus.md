# Task: v4a — Selection polish + right-click context menus

## Goal
Make the canvas feel like a real NLE for everything *except* range and the slate engine: multi-select, marquee select, right-click menus, and the `Delete` / `Cmd-Ctrl+D` hotkeys. Operations work on a single shot or any selection.

## Why
v3 made shots first-class: persistent, draggable, resizable, snappable. But the canvas still acts like there's only one shot at a time — the selection model is single-int, and there's no way to act on multiple shots without dragging each one individually. Constitution principle 5 (drag is primary, hotkeys optional) and `ui-conventions.md` both call for right-click contextual operations and multi-select; v3 explicitly punted both. v4a is the smallest coherent slice that closes those gaps, which then makes v4b's play-range work feel useful (Set Range to Selection has nothing to point at without multi-select).

## Scope

**In scope:**

- **Selection state.** Replace `_selected_id` (single int) with `_selected_ids` (set of ints). Render selection overlay on every member.
- **Click behavior.**
  - Plain click on a shot → select only that shot (clear others).
  - Shift+click on a shot → toggle that shot in/out of the selection.
  - Plain click on empty canvas → deselect all (existing behavior, preserved).
- **Marquee select.**
  - Plain LMB-drag on empty canvas → draw a rectangle; on release, all shots whose bodies *intersect* the rectangle become the new selection (Premiere/Resolve convention, not "fully contained").
  - Shift+LMB-drag on empty → marquee, but adds to the existing selection rather than replacing.
  - Marquee rectangle is rendered live during the drag (1px warm-yellow outline).
- **Right-click context menu.**
  - Right-click on a shot:
    - If that shot is part of the current selection → menu acts on the whole selection (e.g., "Delete (3)" / "Duplicate (3)").
    - If not → that shot becomes the sole selection first, then the menu opens for it.
  - Items for v4a: **Delete**, **Duplicate**. (Set Range to This / Selection waits on v4b's play-range bar.)
  - Right-click on empty canvas → no menu in v4a (deferred to v4b).
- **Hotkeys (also bound to the menu items).**
  - `Delete` → remove all selected shots; undoable.
  - `Cmd/Ctrl+D` → duplicate all selected shots; undoable.
- **Duplicate semantics.**
  - For each selected shot, place a copy with the same in/out range on `track + 1` (auto-grows up to MAX_TRACKS).
  - At the cap (track 3 already, so track 4 doesn't exist): duplicate falls back to same-track-adjacent (`out_frame + 1` start), then resolves under the current overlap policy (replace by default, snap if toggle is on, ripple if Shift is held during the duplicate hotkey).
  - Duplicates inherit the source's `cam_name`. Per-shot rig state will inherit too once we have rig state in the data model — for now there's nothing to inherit.
  - The newly created shots become the selection.
- **Undo.** Both delete and duplicate are wrapped in `StartUndo / AddUndo(UNDOTYPE_CHANGE_SMALL, helper) / EndUndo`. One Cmd+Z reverts the whole batch, not one shot at a time.

**Out of scope (v4b or later):**

- Multi-shot drag-as-group (moving multiple shots at once preserves their relative offsets). Today, drag-move still operates on the single shot under the cursor; if it's part of a multi-selection, the others stay put. Document the limitation, fix in a later task.
- Right-click menu on empty canvas (Range to All, Clear Selection, etc.) — needs v4b play-range.
- "Set Range to This" / "Set Range to Selection" — same.
- Free-form lasso selection — only rectangular marquee.
- Convert to alt-take (architecturally distinct from plain duplicate) — separate concept, deferred.
- Backspace as a Delete alias — easy to add; keeping the binding minimal until we know users want both.

## Approach

Order matters here, mostly because each step is testable on its own:

1. **Selection state refactor.** `_selected_id: int | None` → `_selected_ids: set[int]`. Update `DrawMsg` to render the warm-yellow overlay for every member. Adjust `_on_left_press` so a non-shift click sets `_selected_ids = {id}` and an empty click sets `_selected_ids = set()`. Verify v3 single-select still feels identical.
2. **Shift+click toggle.** In `_on_left_press`, if Shift is held and the click hits a shot, toggle that id in `_selected_ids` instead of replacing.
3. **Marquee.** Plain LMB on empty becomes a `_drag_marquee` path that uses `_drag_loop` to collect deltas, drawing the rectangle in `DrawMsg` via a new instance flag. On release, hit-test every shot's bbox against the rect; intersection rule. Shift adds to existing instead of replacing.
4. **Context menu API.** Verify what's available in C4D 2026 Python — likely `c4d.gui.ShowPopupDialog(cd, parent, x, y, bc)` or `GeUserArea.ShowPopupDialog`. First test prints the constant set; we then build a BaseContainer of menu items and dispatch on the returned id. This is the riskiest empirical step.
5. **RMB hit-test routing.** `_on_right_press` (no Alt): hit-test the click. If hit, ensure the clicked shot is in the selection (replace selection if not), then show the menu at the click point.
6. **Delete operation.** Removes every shot whose id is in `_selected_ids`; clears selection; commits with one undo entry.
7. **Duplicate operation.** Per-shot, computes `target track = min(MAX_TRACKS - 1, src.track + 1)` and falls back to same-track-adjacent at the cap. Applies the active overlap policy via `_resolve_position`. New ids replace the selection.
8. **Hotkey wiring.** `_on_keyboard` routes Delete and Cmd/Ctrl+D to the same handlers the menu uses. Confirm `BFM_INPUT_CHANNEL` for Delete (probably 65535-ish — verify on first run with the existing key-channel print).

## Open questions

- **C4D 2026 popup-menu API.** Does `c4d.gui.ShowPopupDialog` exist? What's its parameter shape? Build a BaseContainer with `bc.SetString(menu_id, "label")` or use `MENURESOURCE_*` constants? Verify empirically with a one-item test menu, then expand. (`c4d.gui.GePopupMenu` is the older name on some builds — check.)
- **Delete-key channel value.** The existing `_on_keyboard` already prints `channel=...` for keypresses; first deploy will reveal Delete's value.
- **Cmd vs Ctrl on Windows.** We're Windows-only, so Ctrl is the modifier. The hotkey doc says "Cmd/Ctrl+D" but the implementation just checks `_QCTRL`.
- **Marquee + cancel via Esc.** Should pressing Esc during a marquee abort the selection? Nice-to-have; do it if the drag-loop already surfaces the ESC state (it does, via `_is_drag_terminal`).
- **Selection on RMB hit-test.** If RMB hits an unselected shot, do we replace the selection (Resolve/Premiere) or extend it (some DAWs)? Default to replace; matches video-editor expectations.

## Done when

- [ ] Plain click on a shot selects only that shot
- [ ] Shift+click toggles a shot in/out of the selection
- [ ] Plain click on empty canvas deselects everything
- [ ] LMB-drag on empty canvas draws a marquee rectangle live
- [ ] Marquee release replaces the selection with intersecting shots
- [ ] Shift+marquee adds intersecting shots to the existing selection
- [ ] Esc during marquee cancels (selection unchanged) — *if cheap with the existing drag loop*
- [ ] Right-click on a selected shot opens a menu showing Delete and Duplicate; counts reflect the selection size when >1
- [ ] Right-click on an unselected shot replaces the selection with that shot, then opens the menu
- [ ] Menu Delete removes all selected shots in one undo step
- [ ] Menu Duplicate places copies on `track+1` (or same-track-adjacent at cap) and selects the new shots
- [ ] Delete key matches menu Delete
- [ ] Cmd/Ctrl+D matches menu Duplicate
- [ ] Selection overlay renders correctly on every selected shot, multi or single
- [ ] No regressions on v3: single-shot click, drag-move, edge-resize, snap toggle, replace/ripple modifiers, Alt+LMB pan, Alt+RMB zoom, Alt+wheel zoom, plain wheel pan, drag-from-OM still all behave the same
- [ ] Pre-commit checklist passes

## Notes
_(populate during/after the work)_
