# Task: v1 — Timeline canvas skeleton

## Goal
Replace the placeholder static-label content in the Shotblocks dialog with a `GeUserArea` that draws a basic timeline backdrop and proves the draw / input / sizing primitives work as expected in C4D 2026.2.0. No data model, no shots, no drag-from-Object-Manager — just the canvas the rest of the product hangs off.

## Why
The constitution names the timeline as the spine of every feature (`constitution.md` §1). Until a custom-drawn surface exists, every subsequent task — shot blocks, drag-from-OM, audio waveform, slate visuals, in/out range handles — is gated on someone bringing one up. v1 brings one up at the smallest scope that's still useful: a canvas with a ruler, a playhead, themed background, and an input event hook that logs to the console. After v1 there is something to draw onto.

It also forces verification of `GeUserArea` mechanics in 2026.2.0 — `DrawMsg` / `InputEvent` / `Sized` lifecycle, `OffScreenOn` default, `BFM_INPUT_*` message constants, the `c4d.COLOR_*` theme tokens — none of which we've touched yet. Same forcing-function logic as v0.

## Scope

**In scope:**
- A `GeUserArea` subclass added to `ShotblocksTimelineDialog` in place of the static text.
- `DrawMsg` paints: themed background fill, a horizontal time ruler at the top with frame numbers (every Nth frame, rounded by zoom), a single vertical playhead line at a fixed frame position.
- `Sized` recomputes layout on resize without artifacts.
- `InputEvent` logs mouse-down events with their pixel coords and routes keyboard events to a no-op handler. Just proves the pipeline; behavior comes later.
- Use the tokens from `design/visual-language.md` ("Background and structure", "Cursor and play range") via the closest available `c4d.COLOR_*` theme constants — *or* a small palette helper if no theme constant matches the visual-language value.
- Document any `c4d.COLOR_*` token discrepancies (constant missing, wrong shade, theme-vs-fixed) as a finding back into `visual-language.md` or `c4d-plugin-development.md`.

**Out of scope:** shot blocks, drag-and-drop from Object Manager, audio waveform, in/out range handles, real playhead tracking the document's current frame, hotkeys, persistence, multi-track layout, zoom controls. Each of these is its own future task.

The temptation to draw "just a placeholder shot block" or "just the in/out handles" will be strong. Resist. The canvas's job is to prove the substrate works; the substrate must be trusted before content goes on it.

## Approach

1. Add a `GeUserArea` subclass `ShotblocksTimelineCanvas` in `shotblocks.pyp` (or split into `src/timeline_canvas.py` if the .pyp gets long — judgment call when the file passes ~200 lines).
2. In `ShotblocksTimelineDialog.CreateLayout`, replace the `AddStaticText` with `AddUserArea` + `AttachUserArea` per C4D Python pattern.
3. Implement `DrawMsg(x1, y1, x2, y2, msg)`:
   - `OffScreenOn()` first
   - Fill background with `bg.timeline` token equivalent
   - Draw ruler region at top with `bg.ruler` token equivalent and frame numbers via `DrawText`
   - Draw playhead line at a fixed pixel x with `cursor.line` token equivalent
4. Implement `Sized(w, h)`:
   - Cache width/height as instance state for layout math in `DrawMsg`
5. Implement `InputEvent(msg)`:
   - Branch on `BFM_INPUT_DEVICE` for mouse vs keyboard
   - On mouse-down: print `[Shotblocks] click x=... y=... button=...`
   - On keyboard: print key code
   - Return `True` from anything handled
6. Run the deploy-and-test loop:
   - `scripts/deploy.ps1`
   - Restart C4D 2026.2.0
   - Open `scenes/dev-test.c4d`
   - Plugins → Open Shotblocks Timeline
   - Verify the canvas draws, resizes cleanly, and clicks log to the console
7. Document any deviations from C4D plugin docs — same as v0, fixes go straight into `c4d-plugin-development.md` or relevant context file.

## Open questions to resolve during this task

Resolve by direct observation; migrate answers into the relevant context doc.

- **Theme color constants.** Which `c4d.COLOR_*` constants exist in 2026.2.0, and what are their values under the user's current theme? Specifically: is there a constant that approximates each `bg.*`, `border.*`, `cursor.*` token from `visual-language.md`, or do we draw with literal RGB and accept that the canvas won't follow C4D theme changes?
- **`OffScreenOn` default.** Is double-buffering on by default, or do we need to call `OffScreenOn()` every `DrawMsg`? Same for the matching `OffScreenOff` if needed.
- **`Sized` first-call timing.** Is `Sized` called before the first `DrawMsg`, or do we need a guard for "haven't been sized yet"?
- **`BFM_INPUT_*` message structure.** Confirm `BFM_INPUT_DEVICE`, `BFM_INPUT_MOUSE`, `BFM_INPUT_KEYBOARD`, and the keys for x/y/button inside the input message dict. The conventions doc names them but doesn't pin shapes.
- **`AddUserArea` vs `AttachUserArea` order.** The standard pattern is `AddUserArea(id, flags)` in `CreateLayout` then `AttachUserArea(self.canvas, id)` in `InitValues`, but variations exist. Which one works in 2026.2.0?
- **`DrawText` API and font choice.** Is there a default font we get for free, or do we need to set one explicitly? Does the ruler text size scale with the OS DPI?

## Done when
- [x] `ShotblocksTimelineDialog` opens with a custom-drawn canvas instead of static text
- [x] Canvas paints background, ruler with frame numbers, and a playhead line on first open
- [x] Resizing the dialog redraws the canvas without crashing or leaving artifacts
- [x] Clicking inside the canvas prints a coordinate to the console
- [x] All open questions above are resolved and migrated out
- [x] Any deviations from `c4d-plugin-development.md` or `visual-language.md` are written back into the relevant doc
- [x] No regression on v0: tag still applies, dialog still opens via Plugins menu, no console errors at startup

## Notes (post-completion)

### What was verified (now in `c4d-plugin-development.md`'s "Verified in 2026.2.0" sub-section)
- `BFM_INPUT_*` constants all exist and behave as expected.
- **Mouse channels:** 1 = left, 2 = right. Middle is presumed 3 but unverified.
- **Keyboard channels:** A–Z map to ASCII 65–90.
- `AddUserArea` + `AttachUserArea` keyword shape works as the docs predicted.
- `DrawText` works without explicit font selection at a sane default size.
- `OffScreenOn()` per-`DrawMsg` is the correct double-buffering pattern; no flicker observed.

### The cached-Sized() trap
- First implementation cached width/height from `Sized()` and used `(x2 - x1)` as a fallback when `_w == 0`. This produced left-edge ghost ticks because `DrawMsg` is called with **partial redraw rects**, not the full canvas, and partial rects on initial paint hit the fallback.
- Fix: ignore `Sized()` and the rect args entirely; query `self.GetWidth()` / `self.GetHeight()` inside `DrawMsg`. Documented in `c4d-plugin-development.md`'s drawing section.

### Theme colors (one open question deferred, not resolved)
- We chose to draw with literal RGB derived from `design/visual-language.md` tokens, not C4D `c4d.COLOR_*` constants. The canvas therefore renders the same colors regardless of C4D theme.
- Whether this is right (consistent palette across themes) or wrong (canvas should follow theme) is a product call, not a technical one. Deferred until users tell us. Adding theme-following later is a small change.

### Zoom-ready structure
- `visible_first`, `visible_last`, `playhead_frame` are instance state on the canvas, not module constants. Future zoom feature is a property update, not a refactor.
- Adaptive tick spacing (`_pick_tick_step`) picks from a "nice" multiples-of-24 ladder so ticks stay readable across zoom levels.
- Zoom design intent (AE-style horizontal stretch, drag-primary zoom bar) captured in `ui-conventions.md`.

### Deferred for later tasks
- Real playhead following the document's current frame (currently fixed at frame 60).
- Middle-mouse-button channel verification (presumed 3).
- Modifier-key encoding in keyboard events.
- Zoom UI itself — the bar, the scroll-wheel handler, the `=`/`-` accelerators.
