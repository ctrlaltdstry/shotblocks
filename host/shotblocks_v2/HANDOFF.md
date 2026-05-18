# Shotblocks v2 — handoff

C++ host plugin (`shotblocks_v2.xdl64`) plus its React + TypeScript web
UI under `web/`. Co-exists with the legacy Python timeline; only v2 is
the eventual target.

## What's working today

### Layout & chrome
- **Top bar** with live timecode `HH:MM:SS:FF` (Inter Regular 14px,
  primary-highlight blue, tabular-nums).
- **Logo** + **Utilities strip** (Snap / Beat Detection / Markers /
  Settings — visual only, no handlers).
- **Tool palette rail** — click-to-select wired through store. dB
  meter is visual-only.
- **Track headers column** rendered from store. Auto-spawned tracks
  (V2, A2, ...) appear here as they're created.
- **Ruler** with frame numbers + minor/major ticks, auto-densifying
  with horizontal zoom.
- **V/A divider** is a draggable splitter (3 grabbable instances —
  headers, lanes-area, v-gutter — sharing one `vaShare` store value).
  Snaps to dead-center within 6px.

### Playhead
- Red vertical line through the lanes + blue triangle handle floating
  into the ruler.
- Driven by C++ `tick` messages.
- **Scrub:** click + drag on the ruler. Local `scrubFrame` override
  for smoothness during drag.

### Scrollbars
Three custom scrollbars (h-time, v-video, v-audio). Track + thumb +
two end-dots. Thumb panning, dot zoom. Default centered with zoom
headroom on both sides (range = 2× track count).

### Shot blocks (clips)
- Render from store via `<Lane>` → `<ShotBlock>`.
- Figma-spec state matrix: unselected / selected / orphaned /
  locked, video vs audio (camera vs waveform icon), tall vs thin
  (auto-flipped when lane height < 32px).
- Inner content wrapper (`.shot-block__content`) keeps `overflow:
  hidden` for label/icon clipping; the outer `.shot-block` is
  `overflow: visible` so state overlays can extend 1px past the
  border.

### State overlays (new pattern — see memory `clip-state-overlay-pattern`)
- **Selected outline**: white 1px border child div at `inset: -1px`,
  opacity-toggled by `.is-selected`.
- **Edge-hover brackets**: 13×lane-height child divs at the left and
  right edges. 30% white fill, yellow `#EDA840` border on three
  sides, three white dots vertically centered. Inset:-1px so the
  yellow corners sit exactly on the clip's outer corners. Fades in
  via `opacity` transition (180ms) when `.is-edge-left` /
  `.is-edge-right` is set on the parent clip.

### OM → timeline drag
- C++ `Message(BFM_DRAGRECEIVE)` accepts AtomArray drags.
- Per-item payload carries `hasAnim`, `inFrame`, `outFrame`,
  `objectId` (session-unique session id C++ uses to resolve back to
  the BaseObject for camera routing).
- Animated range walks object + tags + child objects + parent chain
  (memory `c4d-animation-range-three-sources`).
- Coords translated in C++ via `Screen2Local` + `GetItemDim`.
- Audio drops from OM silently rejected — file imports come later.
- **OM drops auto-trigger save-state** so dropped clips survive
  reload immediately.

### Drop ghost
- Dark blue-black fill, 1px primary-highlight blue border, layered
  blue glow. Width = source camera's animated range, or 48 frames if
  no animation.

### Clip placement
- OM-drop uses `findFreeSlot` (avoid-collide + snap-flush within
  `SNAP_PIXEL_RADIUS = 8` pixels). Mirrors Python's snap.
- In-timeline drag uses `magneticSnap` (snap-only, allows overlap)
  followed by `replaceOverlap` on commit — overlapping clips get
  trimmed/removed per Python's "replace" mode.
- `outFrame` is exclusive — two adjacent clips share an exact frame
  boundary with no gap or overlap.

### Body drag (single + group)
- Pointer-down on a clip body (NOT in the 24px edge zones) starts
  a body-drag.
- Solo drag: CSS `transform` translation under the cursor; commits
  to the store via `moveClip` on release. Snaps to cross-track edit
  points + playhead.
- Group drag: if the clicked clip is part of a multi-selection
  (size > 1, contains the clicked clip), drags ALL selected clips
  together. Commits LIVE per pointermove via `moveClips` (so all
  selected ShotBlocks re-render in sync). Mirrors Python's
  `_resolve_group_move`.
- Drag past V1 (above) or A1 (below) spawns a new track on release.
  Implicit track lifecycle (memory `v2-auto-track-lifecycle`).

### Trim drag
- Pointer-down in the 24px edge zone (matches Python `EDGE_HIT_PX`)
  starts a single-edge trim.
- Lane-level pointer detection sets `.is-edge-left` /
  `.is-edge-right` on the clip + `cursorMode='trim'` (ew-resize).
- During drag, magneticSnap against cross-track edit points; commits
  live via `resizeClip` per pointermove.
- Edge hit zone scales down with clip width (Python sb_canvas.py:1342
  rule: `min(EDGE_HIT_PX, clip_width / 3)`, floored at 6px so handles
  stay grabbable on very narrow clips).
- `MIN_CLIP_FRAMES = 8` — clips can't be trimmed below 8 frames.
  Diverges from Python's 1-frame minimum because the React UI needs
  real pixel area for hit zones (see `mine-python-for-constants`).

### Rolling edit
- Middle third of a seam between two adjacent clips → cursor
  becomes `col-resize`, BOTH edge brackets light up.
- Pointer-down + drag moves the seam — clip A's outFrame and clip
  B's inFrame shift by the same delta. Clamps so neither side drops
  below MIN_CLIP_FRAMES. Snaps to cross-track edit points (excludes
  A's and B's own edges to prevent self-snap).
- No Python equivalent — implemented to standard NLE convention.

### Selection
- **Click a clip** → it becomes the sole selection. White outline
  overlay fades in.
- **Shift/Cmd/Ctrl+click** → toggles in/out of the selection.
- **Click empty lanes-area** (no drag) → clears selection.
- **Marquee drag** on empty lanes-area background → rectangle
  selects intersecting clips live as you drag. Shift+drag is
  additive (unions with existing selection). Mirrors Python's
  `_drag_marquee`.

### Playhead → active camera
- When the playhead enters a clip's range, that clip's source
  camera becomes the active scene camera in C4D's viewport.
  Highest-track-wins for stacked clips (Python rule).
- C++ uses `bd->SetSceneCamera(cam) + DrawViews(FORCEFULLREDRAW) +
  EventAdd()`. The `DrawViews` is required to push the new camera
  state through to the GL drawport on backward scrub (memory
  `basedraw-setscenecamera-drawviews`).
- Camera link survives the doc save/reload (see Persistence below).

### Persistence
- All clip data + camera links persist inside the C4D scene file
  via a hidden helper BaseObject at the doc root, mirroring Python's
  sb_persistence.py. Memory: `v2-persistence-model`.
- Auto-save: debounced 250ms after any clip mutation. Auto-load on
  first `hello` from C++.
- Saves are wrapped in `StartUndo / AddUndo(CHANGE_SMALL, helper) /
  EndUndo` AND bump a version counter on the helper.

### Undo / redo (C4D native)
- Ctrl+Z and Ctrl+Y are intercepted by JS (WebView2 swallows them
  before C4D's menu sees them — memory
  `webview2-swallows-modifier-shortcuts`), forwarded to C++ via the
  `undo` / `redo` commands. C++ calls `doc->DoUndo()` /
  `doc->DoRedo()`.
- C4D rolls back the helper's BaseContainer. EVMSG_CHANGE fires.
  Our handler sees the version counter mismatch and posts
  `state-changed` to JS, which re-fires `load-state` and the
  timeline rolls back. Redo is symmetric.
- Edit menu Undo/Redo also works (same path).

### Keyboard shortcuts
- **Delete / Backspace** → remove all selected clips.
- **Arrow Left / Right** → nudge selected clips by 1 frame (Shift =
  10 frames). Clamps so no clip goes below frame 0.
- **Ctrl/Cmd+Z** → undo (forwarded to C4D).
- **Ctrl/Cmd+Y** or **Ctrl/Cmd+Shift+Z** → redo.

### Page zoom suppress
- Ctrl+wheel and Ctrl+[+,-,0] intercepted so they don't scale the
  whole UI inside the docked dialog.

### Debug overlay
- `<DebugOverlay>` mirrors `console.log/warn/error` into a corner
  panel. Toggle with backtick (`` ` ``). Copy / Clear buttons.
  Buttons use `onMouseDown preventDefault` so they don't grab
  keyboard focus and intercept subsequent shortcuts.

## What does NOT work yet

- **Ripple drag mode** (Shift while dragging pushes neighbors out
  of the way rather than replace-overwriting them — Python has it
  as a third drag mode).
- **GSAP inertia animation** on vertical lane-change during drag —
  visual polish, would smooth the transform-jump when crossing
  tracks. Library is installed; never wired up.
- **Razor tool** — palette button exists but does nothing. Should
  split a clip at the cursor position into two clips.
- **Right-click context menu** — Delete / Lock / Copy / Paste.
- **Copy/paste clips.**
- **Audio file import** (drag a WAV / MP3 onto an audio lane).
- **Real shot library / shot-creation flow** (currently every clip
  comes from OM-dropping a camera; v1 had a preset shot library).
- **C++ driving the rig** (camera pose math: spring/damper, quat
  look-at, fBm noise, autofocus, framing, zoom). Currently the
  active camera just swaps; the rig math from v1 Python hasn't been
  ported yet.

## Stack

- **C++ plugin:** `host/shotblocks_v2/source/main.cpp` — single file.
- **Web UI:** `host/shotblocks_v2/web/` — Vite + React 19 + TypeScript.
- **State:** Zustand (`src/store.ts`).
- **Animations:** GSAP + `@gsap/react` (installed, not yet wired).
- **Bundling:** `vite-plugin-singlefile` inlines all JS / CSS /
  assets into one `dist/index.html` (~740KB).

## JS ↔ C++ bridge

- **JS → C++:** loopback HTTP server inside the plugin DLL on
  `127.0.0.1:<OS-port>`. Port announced via `PostWebMessage` hello.
- **C++ → JS:** `htmlView->PostWebMessage(...)` →
  `window.chrome.webview.addEventListener('message')`.

Commands JS → C++:
- `ping`, `seek`, `tool`, `set-active-camera`, `save-state`,
  `load-state`, `undo`, `redo`.

Messages C++ → JS:
- `hello`, `tick`, `doc-info`, `om-hover`/`om-drop`/`om-cancel`,
  `state-changed`.

## Asset / typography pipeline

- **Icons** in `web/src/icons/`. Figma SVGs come with
  `preserveAspectRatio="none"`; patch to `xMidYMid meet`.
- **`web/src/icons.css`** maps icon class names to `mask-image` URLs.
- **Per-state coloring** via `background-color` + the SVG as mask.
- **Inter** in `web/src/fonts/` as woff2 + `@font-face`.

## Figma → code workflow

1. Designer selects a frame in Figma Desktop.
2. Pull via MCP: `get_metadata`, `get_design_context`,
   `get_screenshot`.
3. SVGs come from `http://localhost:3845/assets/<hash>.svg`.

## Dev loop

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev-loop.ps1
```

Kills C4D → deploys to C4D prefs folder → restarts C4D with
`scenes\dev-test.c4d`. **The kill must happen BEFORE deploy** —
running C4D locks the plugin DLL.

For **web-only changes**:
```powershell
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1
```
Build + deploy; just close + reopen the dialog.

For **C++ changes**, build first:
```powershell
cmake --build "C:\Dev\c4d_sdk_2026\build-win64" --config Release --target shotblocks_v2
```

## DevTools

1. **Remote debugging** — Chrome → `localhost:9222/json/list`.
2. **On-page overlay** — backtick toggles `<DebugOverlay>`.

## Component map

```
App.tsx
├── Timecode               (live HH:MM:SS:FF from store)
├── Logo + Utilities strip
├── Ruler                  (ticks + labels + scrub)
├── ToolPalette
├── HeadersColumn          (TrackHeader per track)
├── LanesStack
│   └── Lane               (ShotBlock per clip + edge hover detect + trim + roll handlers)
│       └── ShotBlock      (Figma-spec state matrix; child overlays for hover / selected)
├── DropGhost              (OM drop preview)
├── MarqueeOverlay         (selection rectangle)
├── Playhead
├── HScroll / VScroll
├── VaSplitter
└── DebugOverlay
```

Hooks:
```
useHost                — bridge init + tick/doc-info routing
useOmDrop              — om-hover / om-drop / om-cancel routing
useActiveClipRouter    — playhead → set-active-camera per Python _route_camera_for_frame
usePersistence         — load on hello / state-changed, debounced save on store changes
useKeyboard            — Delete, arrows, Ctrl+Z/Y forwarding
useMarquee             — marquee drag selection on lanes-area
useClipDrag            — body drag (solo via transform / group via moveClips)
useElementSize         — ResizeObserver wrapper
```

Effects:
```
useTrackCountSync      — vVideo.max / vAudio.max ← track count
useVerticalZoomVars    — drives --video-track-h / --audio-track-h
usePageZoomSuppress    — blocks Ctrl+wheel / Ctrl+[+,-,0]
```

## Next planned steps (in rough order)

1. **Ripple drag mode** — Shift held during a body or trim drag
   pushes neighbors out of the way instead of overwriting them.
   Python has the algorithm: `_ripple_around` in sb_shot_model.py.
2. **Razor tool** — palette button is wired to set
   `activeTool='razor'`; clicking a clip with that tool active
   should split it at the cursor X (mapped to frame). Python
   has the split rules in sb_shot_model.py.
3. **Right-click context menu** — Delete / Lock / Copy / Paste.
4. **Copy / paste clips** — JS-side clipboard (timeline-local; no
   cross-app clipboard needed).
5. **GSAP inertia** on vertical lane-change during drag.
6. **Audio file import** — drag WAV/MP3 onto audio lane.
7. **Real shot library / shot-creation flow.**
8. **Port v1 rig math to C++** (spring/damper, quat look-at, fBm
   noise, autofocus, framing, zoom). This is the load-bearing piece
   that turns v2 from "timeline UI" into "actual Shotblocks plugin."

## Key memories

User profile + collaboration:
- `user_designer_not_engineer` — Mike is a designer; explain in
  visual/UX terms, make engineering judgment calls myself, surface
  decisions only when they affect what he sees.
- `mine-python-for-constants` — read Python source BEFORE guessing
  on v2 behavior. Recurring lesson; constants, ordering,
  race-handling, semantics all live there.

Project decisions:
- `v2-persistence-model` — clips + camera links inside doc.
- `v2-react-when-needed` — vanilla → React migration policy.
- `v2-gsap-free-all-plugins` — GSAP is now 100% free.
- `v2-om-drag-works` — drag from OM works natively, no overlay needed.
- `v2-audio-source-is-file-only` — audio NEVER comes from OM.
- `v2-auto-track-lifecycle` — tracks are implicit, no add/remove UI.
- `v2-nle-trim-model` — standard NLE trim/roll.
- `clip-state-overlay-pattern` — child-div overlays at inset:-1px
  for every state visual.
- `shotblocks-v2-va-splitter` — splitter pans the stack.
- `shotblocks-v2-scrollbar-zoom` — scrollbar end-handles zoom.

Hard-won technical findings:
- `vite-singlefile-for-file-url` — Vite + `file://` requires inlining.
- `webview2-screen-coords` — translate coords in C++, not JS.
- `webview2-swallows-modifier-shortcuts` — Ctrl+Z must be forwarded
  to C4D via JS→C++ command; plain keys reach JS fine.
- `webview2-devtools` — how to attach DevTools.
- `c4d-animation-range-three-sources` — walk object + tags +
  children + parent chain.
- `c4d-htmlviewer-postmessage-oneway` — Maxon's JS→C++ paths are
  dead.
- `v2-js-to-cpp-via-loopback-http` — loopback HTTP server bridge.
- `basedraw-setscenecamera-drawviews` — camera swap needs
  SetSceneCamera + DrawViews(FORCEFULLREDRAW).
- `dev-loop-kill-before-deploy` — kill C4D before robocopy.
- `dev-loop-does-not-build-cpp` — dev-loop only deploys, doesn't
  build.
- `react-drag-state-in-ref` — drag state must use useRef, not
  let-vars.
- `c4d-html-viewer-custom-gui` — C4D 2026's dockable web widget.

UX/design rules:
- `figma-svg-export-quirks` — preserveAspectRatio + wrapper rotation.
- `icons-always-proportional` — never stretch icons.
- `recolor-svgs-via-mask` — mask-image + background-color pattern.

Read `MEMORY.md` at session start; it's the index over all of these.
