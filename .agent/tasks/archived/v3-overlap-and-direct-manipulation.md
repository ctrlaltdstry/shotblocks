# Task: v3 — Overlap policy, multi-track, direct manipulation, persistence, zoom

## Goal
Make the timeline canvas a real working surface: shots persist with the document, can be selected, moved, resized, and stacked across multiple tracks; the user can zoom/pan; same-track overlap is resolved by snap-to-edge with Shift/Alt modifiers.

## Why
v2 proved the data path (drag a camera onto the canvas → shot block appears). It left four foundational gaps that block every later feature:

1. **No persistence.** `_INMEM_SHOTS` is keyed on `id(doc)` and dies with the dialog; undo is broken because `c4d.plugins.SceneHookData` isn't exposed in the C4D 2026.2.0 Python SDK (verified — see auto-memory `reference_c4d2026_drag_drop.md`).
2. **No direct manipulation.** Constitution principle 5 makes drag-move and edge-drag-resize non-negotiable; v2 has neither.
3. **Overlap is unprevented.** Constitution principle 2 mandates "exactly one source camera per frame." v2 lets shots overlap freely.
4. **Single track only.** A flat row makes timing experimentation hostile — the user can't stack alternates or shift one shot up to compare against another in sequence.

This task closes all four gaps in one push so v4 onward (right-click menus, audio, presets, slate) operate on a sound foundation.

## Scope

**In scope:**

- **Persistence via hidden helper null.** Replace `_INMEM_SHOTS` with a `BaseObject` (null) inserted into the document with `NBIT_OHIDE` so it does not appear in the Object Manager. Shot list serializes as JSON in the null's `BaseContainer`. Lifecycle:
  - On first read/write per document, locate the helper by a known marker (BaseContainer key) or create one if absent.
  - All mutations go through `doc.StartUndo() / AddUndo(UNDOTYPE_CHANGE_SMALL, helper) / EndUndo()` so undo works for create / move / resize / delete.
  - Survives save/load (it's a real document object).

- **Multi-track data model.** Each shot gains `track: int` (0 = bottom; max 3 → cap of 4 tracks). Active-shot resolver returns the highest-track shot covering frame N (top wins, standard NLE convention). The constitution's "one camera, one appearance per frame" rule still applies *across all tracks* — same-camera overlap across tracks is illegal even if track stacking is legal.

- **Multi-track rendering.** Auto-grow lane count: dialog opens with 1 visible lane; new lanes appear when a shot is dragged or dropped into them, up to a hard cap of 4. Empty top lanes do not collapse mid-session (would destabilize the canvas). Track separator: 1px `border.subtle`. Alternating track backgrounds: `bg.track` (`#222222`) and `bg.track.alt` (`#1e1e1e`) per `visual-language.md`.

- **Click-to-select.** Click on a shot block selects it; click on empty timeline deselects. Selected shot draws a 2px warm-yellow (`#ffd966`) border *over* its state border (selection is an overlay, not a state change — per `visual-language.md`). Single-select only for v3; multi-select is v4+.

- **Body-drag move.** Drag inside a shot's body to move it. Horizontal drag changes frame range (preserves duration). Vertical drag changes track (snap to nearest lane center; auto-grows up to 4). Same-track collision resolution:
  - Default: snap to edge of the colliding shot (no overlap, no neighbor movement).
  - Shift held: ripple — push subsequent same-track shots later/earlier to make room.
  - Alt held: replace — trim or remove the colliding shot.
  - Cross-track moves never collide (top wins at render time).

- **Edge-drag resize.** ~6px hit zone on each leading and trailing edge. Drag changes that edge's frame; opposite edge stays put. Same-track collision rules:
  - Default: clamp at neighbor's edge.
  - Shift held: ripple neighbor.
  - Alt held: trim/consume neighbor.
  - Minimum shot duration: 1 frame.

- **Undo.** Create / move / resize / delete all wrap in `StartUndo / AddUndo / EndUndo` against the helper null. `Cmd/Ctrl+Z` reverts each operation cleanly.

- **AE-style horizontal zoom.** `Ctrl+ScrollWheel` over the canvas zooms `visible_first / visible_last` around the cursor's frame (cursor-anchored zoom). Middle-mouse drag (or scrollwheel without modifier?) pans by adjusting both bounds. Zoom and pan are view state; they don't persist across sessions in v3.

- **Doc updates.** Fix `architecture.md:258` (`slated_tag.py` → `shotblocks_tag.py`). Add an "Overlap policy" subsection. Add a "Multi-track" subsection clarifying the active-shot resolver across tracks. Update `open-questions.md` to remove the resolved Persistence approach entry.

**Out of scope (v4+):**

- Right-click context menus (slate, bake, set range, duplicate, delete).
- Multi-select, marquee select, shift-click extend.
- Roll edit (drag the cut point between two adjacent shots).
- BaseLink for camera reference (still a name string in v3 — upgrade when we touch the data model again).
- Track-add/remove UI affordances (auto-grow only, no explicit "add track" button).
- Track lock / solo / mute states.
- Vertical zoom (per `ui-conventions.md` track height is fixed).
- Zoom-bar handles at the bottom of the timeline (Ctrl+scroll covers v3; bar comes later).
- Orphaned shot rendering (camera deletion intercept) — separate task.
- Audio, presets, slate, bake, hotkeys other than what comes naturally from selection (`Delete` is v4+).

## Approach

Order of work — strict, because each step depends on the previous:

1. **Task file + doc updates.** Write this file. Fix the `slated_tag.py` line. Add overlap-policy and multi-track sections to `architecture.md`. Remove the resolved Persistence-approach entry from `open-questions.md`.

2. **Persistence layer.** Replace `_INMEM_SHOTS` with helper-null storage. Keep `_read_shots / _write_shots` as the public API; rewire their internals. Verify undo works for create (regression on v2's known-broken undo).

3. **Multi-track field.** Add `track: int = 0` to shot dicts on create. Update active-shot resolver (introduce `_active_shot_at(frame)` returning top-track winner). No UI change yet — render still uses lane 0.

4. **Multi-track rendering.** Compute `lane_count = max(3 used + 1 spare, 1, min(4, max_track + 1))` so an empty timeline shows one lane and the canvas grows as the user uses upper lanes. Per-track Y bands; alternating background; 1px separators. Update `_draw_shot_block` to take a `track` arg and use it for Y.

5. **Hit testing.** Add `_hit_test(x, y)` returning `(shot_id_or_none, region)` where region is one of `body / left_edge / right_edge`. Edge zones are 6px. Use this for both selection and drag.

6. **Click-to-select.** Track `self._selected_id`. Wire `InputEvent` mouse-down to `_hit_test`; if body, set selection and redraw. Selection overlay drawn after the shot's normal border.

7. **Body-drag move.** Press body → enter drag mode capturing initial frame, initial track, initial mouse. On `BFM_INPUT_MOUSEMOVE` updates (need `MouseDragStart` / `MouseDrag` API — verify in C4D 2026 Python), translate movement to frame delta and track delta. On release, apply same-track collision resolution per modifier state. Wrap in undo.

8. **Edge-drag resize.** Press left/right edge zone → enter resize mode. Drag updates the corresponding edge with same-track collision rules. Min duration 1 frame. Wrap in undo.

9. **Zoom + pan.** Handle `BFM_INPUT_MOUSEWHEEL` with Ctrl modifier for cursor-anchored zoom. Middle-mouse drag for pan. Verify `BFM_INPUT_QUALIFIER` flags expose Ctrl/Shift/Alt state in C4D 2026.

10. **Deploy + smoke test.** `scripts/dev-loop.ps1`. Verify each behavior against the dev-test scene with its 100mm and Focus Redshift cameras.

## Open questions (to resolve during work)

- **Mouse drag API in C4D 2026 Python `GeUserArea`.** What's the correct way to track ongoing drag — `MouseDragStart` / `MouseDrag` polling loop, or per-tick `BFM_INPUT_MOUSEMOVE` events? Historically `MouseDragStart` blocks until release with a polling callback. Verify empirically.
- **Modifier qualifier flags.** Which `BFM_INPUT_QUALIFIER` bits expose Ctrl, Shift, Alt during InputEvent in 2026 Python? Constants we need: shift, ctrl/cmd, alt.
- **Mouse wheel input.** Is wheel delivered as a separate `BFM_INPUT_MOUSEWHEEL` channel, or as a `BFM_INPUT_MOUSE` event with a wheel delta field? Need to dump events on first scroll to find out.
- **Hidden null marker.** What marker uniquely identifies our helper null in the document? Options: a custom BaseContainer key on the null, or `op.GetUniqueIP()`-style ID. Pick the first that survives copy/paste between docs gracefully (a custom container key is fine since it's data, not identity).
- **`NBIT_OHIDE` vs other hide flags.** Verify `NBIT_OHIDE` hides from Object Manager *and* viewport in 2026; if it leaks into either, switch to a combination of bits or use `SetEditorMode(MODE_OFF) + SetRenderMode(MODE_OFF)` plus name munging.

## Done when
- [ ] Shots persist across dialog close/reopen (still scoped to a document session — full save/load round-trip is bonus, will hold until v3 is verified)
- [ ] Cmd/Ctrl+Z reverts shot creation (v2 regression closed)
- [ ] Helper null does not appear in the Object Manager
- [ ] Clicking a shot draws the warm-yellow selection border
- [ ] Clicking empty timeline deselects
- [ ] Dragging a shot's body horizontally moves it; same-track collision snaps at neighbor's edge
- [ ] Holding Shift while dragging into a same-track neighbor pushes the neighbor (ripple)
- [ ] Holding Alt while dragging trims/consumes the neighbor
- [ ] Dragging a shot vertically moves it to another track; new lanes auto-grow up to 4
- [ ] Cross-track overlap renders correctly (top track wins at any covered frame)
- [ ] Edge-drag resize on either edge changes that edge's frame; clamps at neighbor by default
- [ ] Edge-drag with Shift ripples; with Alt trims neighbor
- [ ] Min shot duration is 1 frame
- [ ] All move / resize ops are wrapped in StartUndo/AddUndo/EndUndo and undo works
- [ ] Ctrl+scroll on canvas zooms around cursor; middle-drag pans
- [ ] Lane count never exceeds 4
- [ ] No regressions on v2 drag-create (drop a Redshift camera → shot still appears, on lane 0 by default)
- [ ] `architecture.md` updated: `slated_tag.py` → `shotblocks_tag.py`; overlap policy and multi-track resolver documented
- [ ] `open-questions.md` Persistence-approach entry removed (resolved)

## Notes

**Overlap policy decision (final after two revisions):**
- Default (no modifier, snap toggle off) = replace
- Shift = ripple (push same-track shots)
- Snap-to-edge = toolbar toggle (not a modifier) — when on, no-modifier moves use snap; Shift still overrides to ripple
- Cross-track overlap is legal; top track wins at render time

**Zoom/pan bindings (final — Alt is the unified navigation modifier):**
- Alt+LMB drag = pan (overrides hit-test on shot bodies)
- Alt+RMB drag = zoom around click point
- Alt+scroll wheel = zoom around cursor
- Plain scroll wheel = horizontal pan (one notch ≈ 10% span; quick alternative)
- Plain RMB = reserved for v4 context menus

**MMB drag is unavailable**, even with Alt: C4D's framework intercepts MMB at a layer below GeUserArea's drag-poll loop, so `MouseDrag` returns terminal (state=2) on the first poll for both plain MMB and Alt+MMB. C4D's native timeline (which does pan on Alt+MMB) uses the C++ input system; Python plugins don't get that access in 2026. Verified empirically across multiple attempts. Pan was rebound to Shift+LMB-on-empty-canvas (a working drag gesture) plus the wheel.

Revisions:
1. Initial sign-off: snap-default + Alt = replace.
2. First runtime test: replace-default + Shift = ripple + Alt = snap. Replace felt more intuitive than snap.
3. Second runtime test: Alt is the C4D-universal zoom modifier; can't double-bind it. Snap moved to a toolbar toggle, freeing Alt for zoom. Final layout matches C4D's native conventions throughout.

**Track ceiling decision (signed off):**
- Auto-grow on demand, hard cap of 4 tracks
- Start with 1 visible lane on a fresh document
- Empty top lanes don't collapse mid-session

**Why these defaults over user's initial ripple-default instinct:**
- Slate trustworthiness: aligned timelines must not be silently disturbed by drops/drags.
- AE-doc consistency: `architecture.md:215` already says default move is non-rippling.
- Modifiers preserve the FCPX magnetic feel for users who want it (held shift), without forcing it on everyone.
