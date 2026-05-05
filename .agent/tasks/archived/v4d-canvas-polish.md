# Task: v4d — Canvas polish (UX pass before v5 features land)

## Goal
Make the timeline canvas comfortable enough to use for real before the v5 feature work starts piling on. v0–v4c proved the canvas works mechanically; v4d makes it usable: NLE-standard layout, visible affordances, group manipulation, and a robust camera-name link. No new domain features — this is the last pure-canvas pass.

## Why
Two pressures converged:

1. **The user couldn't tell where the resize zone was on a clip.** Edges were 1 px borders; "click 6 px in from the edge" was an invisible target. C4D 2026 Python's cursor pipeline can't be made stable on `GeUserArea` (verified against multiple APIs — `c4d.gui.SetMousePointer`, `result.SetInt32(RESULT_CURSOR, ...)`, direct `user32.SetCursor` via ctypes; all flicker under motion because C4D's framework re-resolves the cursor on every WM_SETCURSOR and we can't register at the C++ window-class level from Python). So "fix the cursor" was a dead end.
2. **Multi-select existed but drag still moved one shot.** Marquee or shift-click let you select multiple, and then a body-drag would only carry the clicked clip — silently broken.

The fix had to be visual rather than cursor-based, and rigid-group rather than per-shot.

## Scope

**Layout & visual hierarchy:**

- Track 0 (base video) anchored to the vertical center of the canvas; video tracks grow upward; below is reserved for audio. NLE convention (Premiere V1/A1, FCP/Resolve same). `_track_y_top()` no longer takes `lane_count` — the anchor is canvas-height-derived. Emphasized 1 px divider line under track 0 marks the video/audio boundary.
- Edge grip bands: 8 px-wide darker tint (`#4a4a4a`) at each shot edge. Visible resize zone replaces the invisible 6 px hit-test boundary. Width clamped to one third of clip width for narrow clips. Click and cursor zones match the visible band exactly (`EDGE_HIT_PX = CURSOR_EDGE_PX = EDGE_BAND_PX = 8`).
- Hover highlight on bands and on play-range handles: warm-cream tint (`#c8c8a8` / `#e0e0c0`) when the cursor is over them. This is the primary "you can drag here" affordance, drawn entirely by us — replaces the unreliable Windows cursor change. Updated only on hover-state transitions (cheap).
- Selection swapped from yellow 2 px outline to a warm gold-tinted body fill (`#8a7c4c`). The outline approach clashed with the marquee selection rectangle, which is also yellow.
- Playhead head: blue downward-pointing triangle (`#4a90d9`) at the top of the playhead line, ~12 × 10 px. Click-and-drag the triangle to scrub (no-snap drag — clicking off-center on the handle doesn't yank the playhead to the click point). Triangle no longer changes the cursor.
- Shot label moved past the left band (`sx1 + band_w + 4`) and clamped to end before the right band. The text-bg color tracks the body fill, so selected clips don't show a gray text rectangle against their gold body.

**Direct manipulation:**

- Group drag: when the user drags a shot that's part of a multi-selection, the entire selection moves rigidly. Delta is clamped so no member goes below frame 0 or off the track range. Replace mode (default) trims non-selected shots out of the way; snap mode magnetizes against the anchor shot's edges; ripple is treated as replace for v1 (proper group ripple is a future enhancement). New helper: `_resolve_group_move()` in `sb_shot_model.py`.

**Live camera-name updates:**

- Each shot stores a persistent `BaseLink` to its camera in the helper null's `BaseContainer` (key `BCKEY_CAM_LINK_BASE + shot_id`). The link survives save/load and follows the camera through Object Manager renames. `_resolve_cam_name()` dereferences the link on every draw; in-session renames reflect immediately, and renames after a project is closed and reopened also reflect.
- `EVMSG_CHANGE` from C4D triggers a canvas redraw via the dialog's new `CoreMessage` handler so renames don't wait for mouse motion to show up.
- BaseLink cleanup on shot deletion; duplicates inherit the source's camera link.

**Out of scope:**

- Rounded corners on shots. Tried a stairstep approximation; user preferred hard edges over visible stairsteps.
- Cross-platform cursor handling. Cursor calls dropped entirely; macOS work (when it lands) won't have to delete anything.
- Audio waveform, beat markers, orphan visuals, slate engine, presets — all v5+ candidates.

## Approach

Empirical, iterative, mostly small deploys with the user testing each round. The cursor investigation produced four memory entries' worth of empirical findings about C4D 2026 Python (`reference_c4d2026_cursor_and_drawing.md` updated to record the "don't fight it from Python" conclusion).

## Done when
- [x] Track 0 centered vertically, video tracks grow up
- [x] Visible edge bands with hover highlight on shots
- [x] Hover highlight on play-range handles
- [x] Selection rendered as fill color, not yellow outline
- [x] Playhead has a blue triangle head, draggable
- [x] Group drag moves all selected shots rigidly with collision resolution
- [x] Camera renames in the OM update timeline labels (in-session and across save/load)
- [x] Cursor-change code removed entirely; hover highlights are the affordance
- [x] All v3+v4a+v4b+v4c features still pass smoke test
- [x] Memory updated with C4D 2026 cursor / drawing findings

## Notes
- C4D 2026 `DrawRectangle` is degenerate when `y1 == y2` (renders zero pixels). Use `y2 = y1 + 1` for a guaranteed 1 px tall row.
- `BFM_GETCURSORINFO` carries position in `BFM_DRAG_SCREENX` / `BFM_DRAG_SCREENY` (screen coords). Convert to canvas-local via `Local2Screen()` origin.
- `c4d.RESULT_CURSOR = 1` and `c4d.RESULT_BUBBLEHELP = 2` (small ints, NOT the 20000-range used by older SDKs). Documented for posterity even though we ended up not using them.
- `c4d.gui.SetMousePointer` is a module-level function, NOT an instance method on `GeUserArea` — `self.SetMousePointer(...)` raises `AttributeError`.
