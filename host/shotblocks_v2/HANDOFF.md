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
- **Tool palette rail** — click-to-select wired through store +
  `sendToHost`; C4D console prints the active tool. dB meter is
  visual-only.
- **Track headers column** rendered from store (V1 video, A1 audio).
- **Ruler** with frame numbers + minor/major ticks, auto-densifying
  with horizontal zoom; first/last labels anchor to edges so they
  don't clip.
- **V/A divider** is a draggable splitter (3 grabbable instances — in
  the headers column, lanes-area, and v-gutter — all sharing one
  `vaShare` store value, hover-linked so the whole seam lights up).
  Snaps to dead-center within 6px.

### Playhead
- Red vertical line through the lanes + blue triangle handle floating
  into the ruler.
- Driven live by C++ `tick` messages (every ~250 ms + on every
  EVMSG_TIMECHANGED).
- **Scrub:** click + drag on the ruler. Local `scrubFrame` override
  for smoothness during drag; C++ tick echo reconciles after release.
  (Without the override, scrub felt jumpy because C++ ticks at ~10 Hz
  while pointermove fires at 60 Hz.)

### Scrollbars
Three custom scrollbars (h-time, v-video, v-audio). Track + thumb +
two end-dots. Thumb panning, dot zoom. The horizontal scrollbar pans
& zooms the visible window via `state.h.{vMin,vMax}`.

For verticals, the default visible window is **centered with zoom
headroom on both sides** (range = 2× track count, default span =
track count) so the user can drag dots IN to zoom in OR OUT to zoom
out from the natural 65px lane height.

### Shot blocks (clips)
- Render from store via `<Lane>` → `<ShotBlock>`.
- Full Figma-spec state matrix: unselected / selected / orphaned /
  orphaned-selected / locked, video vs audio (camera/camera-off vs
  waveform icon), tall vs thin (auto-flipped when lane height < 32px
  via `useElementSize`).
- 1px border per clip in the clip's own color × 70% (color-mix with
  30% black). Two adjacent clips render as one continuous strip with
  a clean 2px-divider seam and rounded outer corners.

### OM → timeline drag
- C++ `Message(BFM_DRAGRECEIVE)` handler accepts AtomArray drags over
  the HtmlViewer area. Forwards `om-hover` continuously during drag,
  `om-drop` on `BFM_DRAG_FINISHED`, `om-cancel` when the drag leaves
  the dialog area.
- Per-item payload carries `hasAnim`, `inFrame`, `outFrame` — C++
  walks the dragged object's tracks, tags, child objects, AND parent
  chain to compute the animated frame range (see memory
  `c4d-animation-range-three-sources` — Align to Spline tags hold the
  keys; cameras parented under animated nulls inherit the parent's
  range).
- Coords are translated in C++ from absolute screen pixels to
  HtmlViewer viewport pixels via `Screen2Local` + `GetItemDim`. JS
  receives ready-to-use viewport coords (see
  `feedback_webview2_screen_coords`).
- JS `useOmDrop` hook routes hover → `dragPreview` (drives the
  `<DropGhost>`), drop → `addClip`, cancel → clears the ghost.
- **Audio drops from OM are silently rejected** — audio comes from
  file imports (WAV/MP3) later. Memory: `v2-audio-source-is-file-only`.

### Drop ghost
- Dark blue-black fill, 1px primary-highlight blue border, 6-layer
  blue drop-shadow glow (Figma node 184:1320 "Ghosted" variant).
- Rendered inside `.lanes-area` (not inside the target lane) so the
  glow isn't clipped by lane `overflow:hidden`.
- Width matches the source camera's animated range, or 48 frames if
  the source has no animation.

### Clip placement
- `addClip` routes through `findFreeSlot` — never overlaps existing
  clips, snaps flush against an existing clip's edge when dropped
  within `SNAP_FRAMES = 20`. `outFrame` is exclusive, so adjacent
  clips share an exact frame boundary (A.outFrame === B.inFrame) with
  no gap and no overlap.

### Edge hover (trim/roll affordance)
- Standard NLE model (memory: `v2-nle-trim-model`).
- Lane-level pointer tracking computes which clip edges are hit.
- Isolated edge (no adjacent neighbor): 8px single-trim band, yellow
  bracket on that side, ew-resize cursor.
- Seam (two adjacent clips): the 16px overlap is split into thirds —
  left third trims clip A (ew-resize, A's right bracket); middle
  third is rolling edit (col-resize, BOTH brackets); right third
  trims clip B (ew-resize, B's left bracket).
- **No actual trim/roll drag logic yet.** Hover only displays the
  affordance; drag does nothing.

### Page zoom suppress
- Ctrl+wheel and Ctrl+[+,-,0] are intercepted so they don't scale
  the whole UI inside the docked dialog.
- `document.body.style.zoom = '1'` on mount snaps back any persisted
  WebView2 zoom.

### Debug overlay
- `<DebugOverlay>` mirrors `console.log/warn/error` into a corner
  panel. Toggle with backtick (`` ` ``). Currently rendered in App by
  default — flip the `visible` initial state if you want it hidden.

## What does NOT work yet

- **Clip drag-to-reposition** within / between lanes (Round 6 — GSAP
  Draggable + InertiaPlugin).
- **Clip drag-to-trim** + **rolling edit drag** (the affordance shows
  the right cursor, but the drag handler is unwired).
- **Implicit track add/remove** on clip drag — the state model
  supports any number of tracks but the UI only ever has V1 + A1.
- **Clip selection / multi-select / delete.**
- **Audio file import** (drag a WAV / MP3 onto the audio lane).
- **C++ driving the camera** when the playhead enters a clip range —
  the clip is currently a UI object only; the C4D viewport doesn't
  respond. This is the port of the v1 plugin's core logic.
- **Real shot library / shot-creation flow.**

## Stack

- **C++ plugin:** `host/shotblocks_v2/source/main.cpp` — single file.
  Registers one `CommandData` opening a dockable `GeDialog` that
  hosts one `AddCustomGui<HtmlViewerCustomGui>`.
- **Web UI:** `host/shotblocks_v2/web/` — Vite + React 18 + TypeScript.
- **State:** Zustand (`src/store.ts`).
- **Animations:** GSAP + `@gsap/react` (installed, not yet used).
- **Bundling:** `vite-plugin-singlefile` inlines all JS / CSS /
  assets into one `dist/index.html` (~730KB). Required because
  WebView2 under `file://` blocks ES module imports. Memory:
  `vite-singlefile-for-file-url`.

The legacy vanilla UI lives at `web-legacy/` as a reference snapshot
of the pre-React port. Not deployed.

## JS ↔ C++ bridge

Both Maxon-blessed JS→C++ paths are dead in C4D 2026's HtmlViewer
(memory: `c4d-htmlviewer-postmessage-oneway`). The working channel:

- **JS → C++:** loopback HTTP server inside the plugin DLL.
  `main.cpp` runs Winsock on `127.0.0.1:<OS-picked-port>`, queues
  each request, wakes the main thread via `SpecialEventAdd`, fulfills
  a `std::promise` with the response. Port is announced to JS via
  `PostWebMessage({kind:"hello",port:N})` on first navigate.
  Memory: `v2-js-to-cpp-via-loopback-http`.
- **C++ → JS:** `htmlView->PostWebMessage(...)` →
  `window.chrome.webview.addEventListener('message')` directly.

## Asset / typography pipeline

- **Icons** live in `web/src/icons/`. Figma SVGs come with
  `preserveAspectRatio="none"`; patch to `xMidYMid meet` unless the
  icon needs to stretch (e.g. the edge-bracket SVG stays `none`).
- **`web/src/icons.css`** maps icon class names to `mask-image` URLs
  using the `mask-image: url('./icons/foo.svg')` pattern. Vite
  inlines as data URLs at build.
- **Per-state coloring** via `background-color` + the SVG used as a
  CSS mask (one shape, any color). Memory:
  `recolor-svgs-via-mask`.
- **Inter** lives in `web/src/fonts/` as woff2 + `@font-face` in
  `index.css`; Vite inlines.

## Figma → code workflow

Memory: `reference_figma_mcp_workflow`.

1. Designer selects a frame / instance in Figma Desktop.
2. Pull via MCP: `get_metadata` for structure overview,
   `get_design_context` for layout + asset URLs + tokens,
   `get_screenshot` for visual reference.
3. SVGs come from `http://localhost:3845/assets/<hash>.svg`. Patch
   `preserveAspectRatio` as needed; drop into `web/src/icons/` and
   wire into `icons.css` or use a direct Vite asset import.
4. The Figma response includes React + Tailwind code — translate it
   to the project's vanilla CSS + component conventions; don't copy
   the Tailwind classes verbatim.

## Dev loop

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev-loop.ps1
```

Kills C4D → rebuilds the C++ plugin via cmake → deploys to the C4D
prefs folder → restarts C4D with `scenes\dev-test.c4d`. **The kill
must happen BEFORE deploy** — a running C4D locks the plugin DLL and
robocopy silently no-ops. Memory: `dev-loop-kill-before-deploy`.

For **web-only changes** (no C++ rebuild needed):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1
```

Runs `npm run build` (Vite) and copies `web/dist/` into the plugin's
deployed `web/` folder. C4D doesn't need a restart — just close + reopen
the dialog from Extensions menu. Build is ~100 ms; full deploy is ~3 s.

For **C++ changes**, run cmake yourself before deploying:

```powershell
cmake --build "C:\Dev\c4d_sdk_2026\build-win64" --config Release --target shotblocks_v2
```

Memory: `dev-loop-does-not-build-cpp`.

## DevTools

C4D's HtmlViewer doesn't expose F12 / right-click Inspect. Two paths:

1. **Remote debugging** — `dev-loop.ps1` sets
   `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`.
   In Chrome: visit `http://localhost:9222/json/list`, find the
   Shotblocks page, paste its `devtoolsFrontendUrl` into a new tab.
2. **On-page overlay** — backtick (`` ` ``) toggles `<DebugOverlay>`,
   which mirrors console output into a corner panel. Sufficient for
   most "what did this event contain" debugging without leaving C4D.

Memory: `webview2-devtools`.

## Component map

```
App.tsx
├── Timecode               (live HH:MM:SS:FF from store)
├── Logo + Utilities strip (static markup)
├── Ruler                  (ticks + labels + scrub)
├── ToolPalette            (click-to-select)
├── HeadersColumn          (renders TrackHeader per track)
├── LanesStack             (renders Lane per track)
│   └── Lane               (renders ShotBlock per clip + edge hover detection)
│       └── ShotBlock      (Figma-spec state matrix; reads edgeHover from store)
├── DropGhost              (overlays inside .lanes-area; reads dragPreview)
├── Playhead               (red line; handle is rendered inside Ruler)
├── HScroll / VScroll      (custom Scrollbar component)
├── VaSplitter             (3 instances: headers, lanes, v-gutter)
└── DebugOverlay           (backtick-toggled console mirror)
```

Bridge:
```
useHost  — bridge init + tick/doc-info routing
useOmDrop — om-hover / om-drop / om-cancel routing
```

Effects:
```
useTrackCountSync   — keeps vVideo.max / vAudio.max in sync with track count
useVerticalZoomVars — drives --video-track-h / --audio-track-h / --*-scroll-y
usePageZoomSuppress — blocks Ctrl+wheel / Ctrl+[+,-,0]
```

## Next planned steps (in rough order)

1. **Round 6 — clip drag-to-reposition** using GSAP Draggable +
   InertiaPlugin. Drag within a lane to reorder; drag onto another
   lane (or past the outermost) to move/spawn tracks. This is where
   the implicit track lifecycle finally lands. Memory:
   `v2-auto-track-lifecycle`.
2. **Clip selection** (single + multi via shift/cmd), keyboard
   shortcuts (delete to remove), context menu.
3. **Clip trim drag** — wire the existing edge-hover affordance to
   actually trim. The cursor + bracket are already displayed; the
   drag handler needs to map cursor delta to a new
   `inFrame`/`outFrame`.
4. **Rolling edit drag** — middle-third drag at a seam slides both
   adjacent edges together.
5. **Snap-to-clip-edges** + **snap-to-playhead** during drag/trim.
6. **C++ driving the camera** when the playhead enters a clip's
   range — port the v1 plugin's pose-driving logic.
7. **Audio file import** flow.

## Key memories

User profile + collaboration:
- `user_designer_not_engineer` — Mike is a designer; explain in
  visual/UX terms, make engineering judgment calls myself, surface
  decisions only when they affect what he sees.

Project decisions:
- `v2-react-when-needed` — vanilla → React migration policy.
- `v2-gsap-free-all-plugins` — GSAP is now 100% free (post-Webflow).
- `v2-om-drag-works` — drag from OM works natively, no overlay needed.
- `v2-audio-source-is-file-only` — audio NEVER comes from OM.
- `v2-auto-track-lifecycle` — tracks are implicit, no add/remove UI.
- `v2-nle-trim-model` — standard NLE trim/roll, not custom semantics.
- `shotblocks-v2-va-splitter` — splitter pans the stack.
- `shotblocks-v2-scrollbar-zoom` — scrollbar end-handles zoom.

Hard-won technical findings:
- `vite-singlefile-for-file-url` — Vite + `file://` requires inlining.
- `webview2-screen-coords` — translate coords in C++, not JS.
- `webview2-devtools` — how to attach DevTools.
- `c4d-animation-range-three-sources` — walk object + tags + children
  + parent chain to find all keyframes.
- `c4d-htmlviewer-postmessage-oneway` — Maxon's JS→C++ paths are dead.
- `v2-js-to-cpp-via-loopback-http` — loopback HTTP server bridge.
- `dev-loop-kill-before-deploy` — kill C4D before robocopy.
- `dev-loop-does-not-build-cpp` — dev-loop only deploys, doesn't build.
- `react-drag-state-in-ref` — drag state must use useRef, not let-vars.
- `c4d-html-viewer-custom-gui` — C4D 2026's dockable web widget.

UX/design rules:
- `figma-svg-export-quirks` — preserveAspectRatio + wrapper rotation.
- `icons-always-proportional` — never stretch icons.
- `recolor-svgs-via-mask` — mask-image + background-color pattern.

Read `MEMORY.md` at session start; it's the index over all of these.
