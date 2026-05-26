# v1 Plan 2.5 — UI refinement + hand/zoom tools

A polish pass between Plan 2 and Plan 3. New design surface in Figma plus
one functional addition: two new tools (Hand for pan, Zoom for drag-rect
zoom) that surface the existing modifier-key gestures for users who don't
know them.

**Scope:** what's already in Figma. No new features beyond the two tools.
No restructuring. The dev-test scene should look like the Figma
"ShotBlocks Edit" frame (`150:1348`) at the end of this plan.

---

## Status

| # | Commit | Status |
|---|---|---|
| 1 | feat(tools): Hand tool — click-drag pan | not started |
| 2 | feat(tools): Zoom tool — drag-rect zoom-to-area | not started |
| 3 | feat(ui): floating tool palette card | not started |
| 4 | feat(ui): simplified floating dB meter + skim icon | not started |
| 5 | feat(ui): rounded track headers | not started |
| 6 | feat(ui): top-bar timecode font + color | not started |
| 7 | feat(ui): playhead shape from Figma | not started |
| 8 | fix(drag): clamp clip drag at Inspector's left edge | not started |
| 9 | feat(audio): Selection tool can edit level keyframes | not started |
| 10 | feat(ui): progressive empty state — camera + audio dropzones | not started |

10 commits total. (1), (2), (9), and (10) are functional changes;
(3)–(7) are visual; (8) is a bug fix.

---

## Functional changes

### Commit 1 — Hand tool

A new tool in the palette. While active, left-click drag pans the canvas
the same way middle-mouse-button drag already does (the existing pan
gesture lives in [useCanvasPan.ts](../../host/shotblocks/web/src/useCanvasPan.ts)
or equivalent — find via `Grep`). Surfacing the gesture as a tool lets
users who don't know the MMB shortcut discover panning.

- Add `'hand'` to the `ToolId` union in [store/types.ts](../../host/shotblocks/web/src/store/types.ts).
- Add a hand SVG icon to `src/icons/` (download from Figma node
  `366:850`).
- Add the tool to the palette in the same order as Figma: Select /
  Razor / Pen / **Hand** / **Zoom** / Slip (verify order against the
  Figma frame — the metadata names some nodes "Frame" so visual
  inspection is needed).
- Wire the active-tool state: while `activeTool === 'hand'`, the
  canvas uses **two custom cursor PNGs** authored by the user:
  open-hand (idle / hover) and closed-hand (pointer down / panning).
  Swap on pointerdown → use closed; swap back on pointerup → use
  open. The transition holds the closed-hand for the entire drag
  even if the cursor leaves the canvas momentarily, matching what
  the user expects from every map / NLE app.
- Cursor follows the project's two-layer pattern (CSS cursor + the
  C++ subclass forced cursor); see memory `feedback_tool_cursor_pattern`.
  This is the first tool with a TWO-cursor state machine — existing
  tools (Razor / Slip / etc.) each have one cursor. The C++
  subclass already supports forcing an arbitrary HCURSOR per tool;
  we just need to add a second slot keyed on "is panning right now"
  and wire the JS side to push the right one. JS state lives on the
  pan gesture (already tracked for MMB-pan); piggy-back on it.
- **Hotkey `H`** activates the Hand tool. Premiere-style: stays on
  after release until the user switches to another tool. Add to the
  existing keyboard-shortcut router (find via `Grep` for the
  existing tool hotkeys — Razor probably has one).
- The palette **button icon** (the glyph inside the floating
  tool-palette card) comes from Figma node `366:850`; download as
  SVG with the recolor-via-mask pattern, same approach as the Sync
  Settings icon shipped in Plan 2.

### Commit 2 — Zoom tool

While active, left-click drag draws a rectangle on the canvas. On
release, the timeline zooms (and pans) so that the dragged rectangle's
horizontal extent fills the visible canvas width. Vertical extent is
informational only — vertical zoom isn't bound to the timeline's H
zoom axis.

- Add `'zoom'` to `ToolId`.
- Add a zoom SVG icon (download from Figma node `366:856`).
- While active: pointerdown → record start `(x, frame)`; pointermove
  → render a translucent blue rectangle overlay; pointerup → compute
  the new horizontal zoom + scroll target so the dragged range fills
  the canvas, animate via the existing zoom plumbing.
- Click-without-drag (drag distance < ~3px) → no-op, don't accidentally
  zoom to a single frame.
- Cursor: **custom zoom PNG** authored by the user (magnifier
  glyph). Single cursor, no down-state variant — unlike Hand.
- **Hotkey `Z`** activates the Zoom tool. Premiere-style: stays on
  after release.
- The palette **button icon** (the glyph inside the floating
  tool-palette card) comes from Figma node `366:856`; download as
  SVG with the recolor-via-mask pattern.

These two are pure additions; existing MMB-pan and Alt+RMB-zoom keep
working unchanged.

---

## Visual changes

### Commit 3 — Floating tool palette

Currently the tool palette is docked against the left edge. Figma node
`366:863` shows it as a floating card:
- Background: `--color-grey-12` (#1f1f1f)
- Border: 0.5px `--color-grey-16` (#292929)
- Radius: 6px
- Drop shadow: `0 0 4.75px rgba(0, 0, 0, 0.6)`
- Padding: 15px
- 39px wide, vertical column of tools
- Positioned 4px from the left edge (Figma x=4, y=74)

Existing CSS for the palette is in [App.css](../../host/shotblocks/web/src/App.css)
— find via `Grep` for `tool-palette` or similar. Update the chrome to
match Figma; layout (which tools, in what order) stays as Commit 1+2
defined it.

### Commit 4 — Simplified floating dB meter + skim icon

Audio dB meter is now its own floating card below the tool palette:
- Same floating-card chrome as the tool palette (grey-12 fill, grey-16
  border, 6px radius, drop shadow).
- Two thin vertical bars, 8px wide × 153px tall, 3px gap, fully
  rounded ends, grey-7 fill (the background; fill animates with
  levels).
- A small audio-skim icon sits above the bars (the same waveform
  glyph from Figma node `371:1124`).
- Positioned 4px from the left edge, below the tool palette
  (Figma x=4, y=323).

The current dB meter is more complex (rectangle bars with peak ticks
etc.). Simplify to match Figma — just two solid bars that fill from
bottom up. The skim icon is purely decorative (a label for "this is
the audio meter").

Existing meter code: find via `Grep` for `DbMeter` / `audio-meter`.

### Commit 5 — Rounded track headers

Currently track headers are rectangular (no border-radius). Figma node
`373:1133` shows them with:
- 4px border radius
- 0.5px grey-16 border
- 8px horizontal padding
- "Video 1" / "Audio 1" label is now right-aligned, 12px Inter,
  grey-50 color

The internal layout (lock / eye / label) is unchanged; only the
container chrome and the label styling shift.

### Commit 6 — Top-bar timecode font + color

The big top-bar timecode display switches to JetBrains Mono Regular
14px in primary-highlight blue (#007aff). The bar background is
grey-10 (#1a1a1a), 26px tall, full width.

JetBrains Mono needs to be bundled. Two paths:
1. Add the woff2 file to `src/fonts/` and `@font-face` it in CSS.
2. Use the Google Fonts version via an `@import url(...)` in CSS.

The project ships as a single inlined HTML via vite-plugin-singlefile —
the woff2 approach bundles cleanly and works offline. (`@import` from
Google Fonts wouldn't work in WebView2 under `file://` either.) Go
with the woff2 path.

### Commit 7 — Playhead shape from Figma

The playhead head is a slightly different shape now (Figma node
`317:903`). Download the SVG, drop it in `src/icons/`, replace the
existing playhead asset. The line below the head stays as-is.

### Commit 8 — Drag clamp at Inspector's left edge

**Bug:** When dragging a clip on the timeline, the drag continues
under the Inspector panel instead of clamping at the Inspector's left
edge. Pointer-event boundaries are probably set to the window edge,
not the canvas edge.

- Reproduce: drop a clip on V1, start dragging it, drag right past
  the canvas → it disappears under the inspector and stays there.
- Find via `Grep`: `useClipDrag` or similar. The clamp probably uses
  `window.innerWidth` or `document.body.clientWidth`; should use the
  canvas's right edge (the inspector's left).

Likely the simplest fix: compute the drag-area bounds from the
canvas container's `getBoundingClientRect()` once at drag start
rather than reading `innerWidth` each frame.

### Commit 9 — Selection tool can edit level keyframes

Today the Selection tool is read-only on the volume-automation curve.
To move a keyframe or drag a Bézier tangent handle, the user has to
switch to the Pen tool. Friction we don't need.

**Goal:** Selection tool gets full parity with Pen on existing
keyframes:
- Move keyframes (vertical = gain, horizontal = time in media-space
  frames).
- Drag tangent handles to reshape the curve.
- Right-click a keyframe for the same context menu Pen surfaces
  today (delete, change interpolation type, etc.).

**Only difference between Selection and Pen:** creating new keyframes.
- Pen tool: click on the curve line → new keyframe.
- Selection tool: click on the curve line → does nothing.
- Selection tool: **Alt+click on the curve line** → new keyframe
  (temporary Pen behavior while Alt is held).

**Alt over an existing keyframe is a no-op.** Holding Alt while
hovering an existing KF must not start a "duplicate-drag" or block
the grab. The user has to release Alt before clicking an existing
KF — the click is then a normal grab. This keeps the Alt modifier
strictly meaning "create" so there's no ambiguity between
"editing an existing KF" and "spawning a new one near it."

**Cursor:** Selection arrow over keyframes (no special move cursor).
Standard NLE convention. The hover-only cursor stack already handles
Pen-tool-specific cursors on the curve; Selection tool simply doesn't
participate in that override for KFs.

Implementation notes:
- Find the KF hit-testing + drag logic via `Grep` for `levelKeyframes`
  / `LevelCurve` (the component lives in
  [components/LevelCurve.tsx](../../host/shotblocks/web/src/components/LevelCurve.tsx)).
- Today the hit-test + drag-start probably checks
  `activeTool === 'pen'`. Loosen to also accept `'select'`.
- Curve-line hit-test (the "click empty curve to spawn KF" path)
  must remain Pen-only OR Selection+Alt. That's where the boundary
  matters.
- Right-click context menu: probably already lives in the same
  component, conditional on Pen — extend to Selection.
- Don't touch the Pen tool's existing behavior. Pen still works
  exactly as it does today.

### Commit 10 — Progressive empty state

Today an empty timeline shows… an empty timeline. Discoverability
is poor — a first-time user has no idea they're meant to drag a
camera from the Object Manager.

Two dropzones, revealed progressively:

**State A — empty doc (no clips anywhere):**
- Big dashed-border dropzone occupies the center of the canvas,
  matching the screenshot the user shared.
- Label: `drop a camera from the object manager` (centered, dim
  grey).
- Plus glyph centered under the label.
- The dropzone is visual only — the existing OM-drop drop target
  is the whole canvas, not just this rect. Dropping anywhere still
  works; the dropzone is the discoverability cue.
- V1 and A1 tracks DON'T exist yet at this point — the canvas is
  truly empty. (Need to verify: today's empty timeline probably
  pre-creates V1 + A1. If it does, that behavior changes — both
  tracks materialize on first drop, not on dialog open.)
- Hides the moment ANY video clip exists anywhere in the doc.

**State B — V1 has a clip, A1 has nothing:**
- A1 lane shows a smaller dropzone INSIDE the audio lane area.
- Label: `drag an audio file from your file browser` (dim grey).
- Same dashed-border styling as the camera dropzone, scaled down.
- This dropzone is the in-lane drop target itself — clicking does
  nothing; the user must drag-drop a file from Windows Explorer.
- Hides the moment any audio clip exists anywhere in the doc (A1,
  A2, etc).

**State C — both video and audio have at least one clip:**
- No dropzone prompts at all. Standard timeline view.

**Track lifecycle change:** today V1 + A1 may always exist. With this
empty state, the first camera drop is also what spawns V1 + A1
together. If the user deletes every video clip, V1 stays (you can
still have an empty V1) — the camera dropzone does NOT come back
just because V1 is empty. The trigger for State A is **"no clips
in any video track"**, not "V1 doesn't exist." Same logic for the
audio dropzone (State B → State C).

Implementation notes:
- Find the empty-state / track-creation logic via `Grep` for
  `videoTracks` initial state, `useStore`'s default state, and the
  OM-drop handler that spawns clips.
- Dropzone visuals are dashed-border rects; pull exact stroke,
  spacing, label-styling values from the Figma frame `150:1348`
  before writing CSS. The screenshot shows the layout; Figma is
  the source of truth for pixel values.
- Both dropzones are **visual cues**, not drop targets. The
  existing OM-drop / file-drop targets stay as they are
  (whole-canvas for OM; per-lane for file). The dropzone div has
  `pointer-events: none` so it never intercepts drag events meant
  for the underlying drop targets.

---

## Out of scope for this plan

- **No new functionality beyond Hand + Zoom.** Inspector content,
  render workflow, motion layers — all unchanged.
- **No new tools beyond Hand + Zoom.** The palette has Slip / Razor /
  Pen / Select already; this plan adds 2.
- **No new tool hotkeys beyond H (Hand) and Z (Zoom).** Existing tool
  hotkeys stay as they are; this plan adds two.

---

## Hard rules

- **Read every Figma detail. Do not guess.** Before writing CSS for
  any visual surface (palette card, dB meter card, track header,
  timecode bar, etc.), fetch the Figma design context for the
  specific node and read EVERY property: fill, border/stroke
  (including width — 0.5px strokes are a deliberate detail),
  radius, padding, gap, drop shadow values, font face + size +
  weight + color. The user has designed these intentionally. If a
  property isn't in the design context I fetched, fetch a child
  node or ask before assuming. Reusing a value from another
  similar-looking surface is not allowed — every card may have its
  own measurements.
- **Floating panels all have a 0.5px stroke** as part of their
  shared chrome — confirmed by the user. The tool palette
  (`366:863`) and dB meter (`371:1087`) both spec
  `border: 0.5px solid var(--color-grey-16, #292929)` in Figma's
  output. Any other floating panel added later inherits this.
- C4D doesn't need to restart for JS-only changes — `deploy.ps1` +
  reopen the Shotblocks dialog is enough.
- Cursor changes follow the two-layer pattern (CSS + C++ subclass)
  per `feedback_tool_cursor_pattern`. Hand/Zoom both need entries
  in the cursor map.
- Icons go in `src/icons/` and load via the recolor-via-mask pattern
  if state-tinted, else via `<img src={url}>` if single-color.
- JetBrains Mono woff2 lives in `src/fonts/`, vite-plugin-singlefile
  inlines it as a data URL alongside the other assets.

---

## Verification — end of plan

1. Open the dev-test scene. Compare against Figma frame `150:1348`
   side-by-side:
   - Floating tool palette card with 6 tools, drop shadow visible.
   - Floating dB meter card below it, two simple bars, skim icon
     above.
   - Track headers have rounded corners + 0.5px border.
   - Top bar shows blue JetBrains Mono timecode on grey-10 strip.
   - Playhead head matches Figma shape.
2. Hand tool: activate via palette OR `H` hotkey, click-drag on
   canvas → canvas pans like MMB-drag does. Stays active until
   another tool is picked.
3. Zoom tool: activate via palette OR `Z` hotkey, click-drag a
   rectangle → timeline zooms so the rectangle's horizontal extent
   fills the canvas. Stays active.
4. Drag bug: pick up a clip, drag right past the canvas edge → clip
   stops at the Inspector's left edge, doesn't slide under it.
5. MMB pan + Alt+RMB zoom still work unchanged.
6. Existing tools (Select / Razor / Pen / Slip) unchanged.
7. Volume keyframes with Selection tool: click an existing KF → it
   grabs. Drag → it moves. Drag a tangent handle → curve reshapes.
   Right-click → context menu appears. Click on the empty curve →
   nothing happens. Alt+click on the empty curve → new KF appears.
   Alt+hover over an existing KF → does nothing; release Alt to grab.
8. Pen tool unchanged from today's behavior.
9. Empty state: open Shotblocks on a fresh doc → big dashed
   camera dropzone is centered in the canvas, V1/A1 don't exist
   yet. Drop a camera from the OM → V1 + A1 both materialize, the
   camera dropzone vanishes, A1 shows its in-lane audio dropzone.
   Drag an audio file from Explorer into A1 → its dropzone
   vanishes too. Delete the last video clip → camera dropzone
   does NOT come back (V1 still exists; the dropzone is the "doc
   has zero video clips" cue, but track creation is one-shot per
   session).

When all nine check, plan is shipped.
