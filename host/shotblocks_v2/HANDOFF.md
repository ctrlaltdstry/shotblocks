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
two end-dots.

- **Thumb drag** pans the visible window.
- **End-dot drag** zooms mirrored-from-center (both edges move
  symmetrically about the window's midpoint).
- **Video scrollbar is inverted** — thumb-at-top corresponds to
  V<max> (the visually-topmost track) being visible. Audio +
  horizontal stay natural.
- **maxSpan cap** prevents zoom-out past where lanes hit
  MIN_TRACK_PX (48px). Past that the dots stop sliding apart since
  further zoom-out is a no-op visually.
- **Adaptive vMax**: `vVideo.max / vAudio.max = maxSpan + (overflow /
  MIN_TRACK_PX)`. When all content fits at min height, max = maxSpan
  and the thumb fills the entire scrollbar at zoom-out. When content
  overflows, the extra is pan headroom.
- The v-window on each side **scales proportionally** on track-count
  changes (zoom ratio preserved) and **pins to the outer end** so
  newly-spawned tracks land in view with their spawn-buffer.

See memory `v2-min-track-height-clamp` for the full math.

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

### Ripple drag (body + trim)
- **Shift** held during a body drag or trim drag → ripple mode. Same-
  track neighbors are pushed aside (preserving each clip's duration)
  instead of being trimmed or overwritten. Ports Python
  `_ripple_around` (sb_shot_model.py:296).
- Direction policy: push-right is tried first; only if no clip needs
  shoving right does it try push-left. Matches Python.
- **Live toggle**: Shift state is read on every pointermove. Press
  Shift mid-drag → switches to ripple; release Shift mid-drag →
  switches back to replace. Each toggle re-anchors `startClientX` +
  `startInFrame` to current pointer + current store position so the
  two modes' delta math stays coherent across the switch.
- **Neighbors stay pushed** when ripple-then-replace mid-drag. Only
  the dragged clip resumes transform-only preview from its new
  position (user-confirmed UX call).
- Body drag in ripple mode commits LIVE per pointermove (same pattern
  as group drag) — no CSS transform; React re-renders neighbors as
  they shove. `fromTrackId` tracks via `dragRef.currentTrackId`
  because cross-track ripple commits migrate the moving clip.
- **Group ripple is not implemented** — Python explicitly punted
  (sb_shot_model.py:356) and v2 mirrors that. Shift during a multi-
  select body drag is ignored.
- Known wart: each ripple pointermove is its own undo entry, so a
  long ripple drag may take many Ctrl+Z's to fully undo. Same wart
  exists for group drag today; not yet batched.

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
- **Ctrl/Cmd+C / X / V** → copy / cut / paste from timeline-local
  clipboard.

### Navigation gestures (C4D viewport style)
- **Alt + right-click + drag** = zoom around the cursor's frame +
  track-row. Sensitivity `factor = exp(-delta / 200)` matching Python
  (`sb_canvas_drag.py:661`). Diagonal drag zooms both axes
  simultaneously and independently. Contextmenu is suppressed when
  Alt is held; plain right-click still opens the menu.
- **Middle-mouse-button drag** = hand-tool pan. 1:1 cursor-glue.
  Horizontal pans h-time; vertical pans the side (V/A) the cursor
  started in. Couldn't ship in Python — C4D intercepts MMB before
  GeUserArea (`sb_canvas.py:2190`); works in WebView2 because we get
  MMB as `button === 1` pointer events.

See memory `v2-c4d-nav-gestures`.

### Track lifecycle
- **Add**: implicit. Drag a clip into the upper half of the outermost
  V<max> lane → V<max+1> spawns on release (lower half for audio).
  Throwing past the stack edge entirely also spawns. A `.lane-spacer`
  slot is always rendered above V<max> / below A<max> so the spawn
  buffer is always reachable. See memory `v2-auto-track-lifecycle`.
- **Delete**: right-click any track header → `Delete Track` or
  `Delete Empty Tracks` (per-side). Any track is deletable; after
  delete, remaining tracks renumber dense from id=1. Deleting the
  last track on a side auto-respawns an empty V1/A1.
- **No more auto-cull.** Empty tracks persist until explicitly
  removed. The earlier "empty non-base track vanishes on every move"
  behavior is gone.

### Page zoom suppress
- Ctrl+wheel and Ctrl+[+,-,0] intercepted so they don't scale the
  whole UI inside the docked dialog.

### Debug overlay
- `<DebugOverlay>` mirrors `console.log/warn/error` into a corner
  panel. Toggle with backtick (`` ` ``). Copy / Clear buttons.
  Buttons use `onMouseDown preventDefault` so they don't grab
  keyboard focus and intercept subsequent shortcuts.

### CDP introspection from outside the dialog
- The store is exposed on `window.__SHOTBLOCKS_STORE__` for live
  introspection. WebView2's remote-debugging port is on
  `localhost:9222` (set by dev-loop.ps1).
- `scripts/cdp-eval.mjs <expression>` evaluates JS inside the live
  Shotblocks page from the command line. Useful for snapshotting
  store state, computed styles, or `elementsFromPoint` results when
  a "weird interaction" comes in.
- See memory `webview2-devtools`.

### Drag-state recovery (defensive)
- `useDragRecovery` (App.tsx) mirrors `body.is-clip-dragging` from
  `store.dragClip` (single source of truth). It also registers
  global window listeners — `pointerup` (capture), `pointercancel`,
  `blur`, `visibilitychange` — that force-clear stuck drag state and
  inline drag styles.
- Two cases needed this safety net:
  1. **Cross-track re-mount.** useClipDrag's effect deps include
     `trackId`. A ripple drag's cross-track commit unmounts the
     ShotBlock from its source lane and remounts on the dest; the
     old listeners die before pointerup, the new ones don't see the
     original pointerdown.
  2. **Win+Shift+S screenshot.** Steals focus from the WebView2
     mid-drag; pointerup never reaches the page.
- See memory `v2-drag-recovery-pattern` and
  `webview2-screenshot-loses-focus`.

## What does NOT work yet

- **Audio file import** (drag a WAV / MP3 onto an audio lane).
- **Real shot library / shot-creation flow** (currently every clip
  comes from OM-dropping a camera; v1 had a preset shot library).
- **C++ driving the rig** (camera pose math: spring/damper, quat
  look-at, fBm noise, autofocus, framing, zoom). Currently the
  active camera just swaps; the rig math from v1 Python hasn't been
  ported yet.

## Known latent issues

- **Cross-track ripple drag stuck-class** — useClipDrag's effect deps
  include trackId; cross-track ripple commits re-mount the hook
  mid-drag. `useDragRecovery` papers over the user-visible symptom
  (stuck class, stuck inline styles) but the underlying listener
  teardown still happens. Solo replace drag isn't affected.

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
useKeyboard            — Delete, arrows, Ctrl+Z/Y forwarding, Ctrl+C/X/V
useMarquee             — marquee drag selection on lanes-area
useClipDrag            — body drag (solo via transform / group via moveClips)
useDragRecovery        — body class mirror + global drag-state safety net (Round 11)
useAltRightZoom        — Alt+RMB drag → zoom around cursor (Round 11)
useMmbPan              — MMB drag → hand-tool pan (Round 11)
useElementSize         — ResizeObserver wrapper
```

Effects:
```
useTrackCountSync      — adaptive vVideo.max / vAudio.max; reproportions
                         user zoom on track-count change; pins to outer
                         end on add
useVerticalZoomVars    — drives --video-track-h / --audio-track-h /
                         --video-scroll-y / --audio-scroll-y;
                         MIN_TRACK_PX = 48 hard clamp
usePageZoomSuppress    — blocks Ctrl+wheel / Ctrl+[+,-,0]
useSuppressNativeContextMenu — kills WebView2 "Reload/Inspect" menu
```

## Next planned steps (in rough order)

1. **Audio file import** — drag WAV/MP3 onto audio lane.
2. **Real shot library / shot-creation flow.**
3. **Cross-track ripple stuck-class bug** — useClipDrag's effect
   deps tear listeners down mid-drag on ripple commits. Currently
   masked by `useDragRecovery`, but the underlying lifecycle is
   wrong.
4. **Port v1 rig math to C++** (spring/damper, quat look-at, fBm
   noise, autofocus, framing, zoom). The load-bearing piece that
   turns v2 from "timeline UI" into "actual Shotblocks plugin."

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
- `v2-auto-track-lifecycle` — implicit add via drag, explicit
  Delete Track / Delete Empty Tracks via right-click menu.
- `v2-nle-trim-model` — standard NLE trim/roll.
- `v2-min-track-height-clamp` — MIN_TRACK_PX=48 + adaptive vMax.
- `v2-c4d-nav-gestures` — Alt+RMB zoom + MMB pan.
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
- `webview2-screenshot-loses-focus` — Win+Shift+S steals focus
  mid-drag; needs visibilitychange + blur recovery.
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
- `v2-drag-recovery-pattern` — body class mirror + global cleanup
  for stuck drag state (cross-track re-mount, focus-loss).
- `css-transform-makes-stacking-context` — `transform: translateY(0)`
  silently creates a stacking context. Use `top` for pan-offset.
- `css-container-type-size-collapses-content-driven-elements` —
  `container-type: size` on a flex child with content-sized height
  collapses to 0. Use inline-size or a JS body class.
- `dont-derive-track-count-from-vmax` — old `max = 2*count` is dead;
  read `videoTracks.length` directly.
- `c4d-html-viewer-custom-gui` — C4D 2026's dockable web widget.

UX/design rules:
- `figma-svg-export-quirks` — preserveAspectRatio + wrapper rotation.
- `icons-always-proportional` — never stretch icons.
- `recolor-svgs-via-mask` — mask-image + background-color pattern.

Read `MEMORY.md` at session start; it's the index over all of these.
