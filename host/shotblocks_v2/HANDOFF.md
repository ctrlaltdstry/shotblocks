# Shotblocks v2 — handoff

This is the C++ host plugin (`shotblocks_v2.xdl64`) plus its web UI under
`web/`. It's a separate plugin from the Python timeline. The two
co-exist; only Shotblocks v2 is the eventual target.

## What's built today (empty-state UI, static)

A pixel-faithful static rendering of the Figma "ShotBlocks Empty State"
frame:

- **Top bar** — timecode in Inter Regular 14px, primary-highlight blue.
- **Logo cell** — Shotblocks camera mark (22×11 svg).
- **Utilities strip** — 4 icons (Snap / Beat Detection / Markers / Settings)
  at the Figma spacing, grey-24 default.
- **Tool palette rail** (50px wide, full body height):
  - Top half: 4 tool icons (Select / Razor / Pen / Range). Default is
    grey-50, hover gives a subtle grey rounded box + white icon, active
    gives a primary-blue rounded box + white icon. "Select" is hardcoded
    `.is-active`; real click-to-toggle isn't wired yet.
  - Bottom half: dB meter (Figma's spec — scale labels + L/R bars + L/R
    letters). Sized responsively, takes whatever vertical space is left.
- **Track headers column** (200px wide):
  - 1 video header (V1, blue chip, eye, "Video 1")
  - 1 audio header (A1, grey-24 chip, M/S row, "Audio 1") — A1 shows the
    "locked" lock variant
  - Black 4px V/A divider between them
  - Drop-shadow gradient on the right edge fading into the stage
- **Ruler** — frame numbers + bottom-aligned ticks (majors every 8 frames).
- **Lanes** — V1 + A1 strips in `grey-12`, separated by the V/A divider.
- **Playhead** — Figma's blue triangle handle floats up into the ruler,
  apex sits at the ruler/lanes boundary. Red line `#c94b4b` runs down
  through the lanes.
- **Scrollbars** (h-bottom, v-video, v-audio) — 15px pill, grey-16 track,
  grey-12 dot end-handles with grey-24 stroke. Stroke goes primary-blue
  on hover. 4px breathing room between the pill and the outer dialog
  edge (the "wall" side); pill is flush against the canvas side.

Everything is sized in CSS variables (`--track-h`, `--headers-w`, etc.).
The page is responsive — the dialog can be resized and the layout
adapts.

## What does NOT work yet

- **Nothing is interactive.** No click handlers, no JS state, no shot
  blocks, no audio waveforms, no scroll/zoom drag.
- **No V/A splitter drag yet.** Memorized as a separate task — see
  the `shotblocks-v2-va-splitter` memory.
- **No scrollbar drag/zoom yet.** Memorized as
  `shotblocks-v2-scrollbar-zoom`.
- **Track add/remove not wired.** Tracks are hardcoded V1 + A1 in the
  markup.

## JS ↔ C++ bridge (live)

Both Maxon-blessed JS→C++ paths are dead in C4D 2026's HtmlViewer:
`SetWebMessageCallback` is a known no-op, and
`SetResourceRequestInterceptCallback` registers cleanly but its
callback never fires for any URL (verified this session).

The working channel is a **loopback HTTP server inside the plugin
DLL**. `main.cpp` runs Winsock on `127.0.0.1:<OS-picked-port>` in a
worker thread, queues each request, wakes the main thread via
`SpecialEventAdd`, and fulfills a `std::promise` with the response.
The port is pushed to JS via `PostWebMessage({kind:"hello",port:N})`
on first navigate; JS calls
`fetch('http://127.0.0.1:PORT/cmd', {method:'POST', body:JSON.stringify(...)})`.
See memory `v2-js-to-cpp-via-loopback-http`.

C++ → JS still uses `htmlView->PostWebMessage(...)` →
`window.chrome.webview.addEventListener('message')` directly.

## Asset / typography pipeline

- **Icons** live in `web/icons/`. Each is a Figma export with the
  `preserveAspectRatio="none"` patched to `xMidYMid meet` after
  download (see `figma-svg-export-quirks.md`).
- **`web/icons.css` is GENERATED** by a PowerShell snippet at the
  bottom of conversations. It inlines every icon SVG as a `data:` URL
  so CSS `mask-image` works under `file://` (WebView2 has quirks with
  external `mask-image` URLs). Don't edit it by hand — regenerate.
- **Icons are recolored via CSS `mask-image` + `background-color`**, not
  via colored SVG fills (see `recolor-svgs-via-mask.md`). One SVG per
  shape; CSS controls the color per state.
- **All icons must preserve aspect ratio** (see `icons-always-proportional.md`).
  The only thing that's allowed to stretch non-proportionally is the
  lane container during vertical zoom — and even then, the icons
  *inside* the lane stay proportional.
- **Inter is bundled** at `web/fonts/Inter-{Regular,SemiBold,Bold}.woff2`,
  declared with `@font-face` in `timeline.html`. Don't add new font
  weights unless they're needed.

## Figma → code workflow

1. User selects a frame or icon group in Figma Desktop.
2. We pull via the MCP: `get_metadata` for structure,
   `get_design_context` for layout + asset URLs + tokens,
   `get_screenshot` for visual reference.
3. For new SVGs: download from `http://localhost:3845/assets/<hash>.svg`,
   patch `preserveAspectRatio`, drop into `web/icons/`.
4. Regenerate `web/icons.css` so the new icons get inlined as data URLs.
5. Wire them into `timeline.html` using the existing patterns:
   `<span class="icon icon--name" style="--icon-w:NN;--icon-h:NN">`.

## C++ host plumbing

- `host/shotblocks_v2/source/main.cpp` is the whole plugin. ~270 lines.
- Registers one `CommandData` ("Open Shotblocks v2") that opens a
  dockable `GeDialog` containing one `AddCustomGui<HtmlViewerCustomGui>`.
- The HTML viewer loads `file:///.../web/timeline.html` (resolved
  relative to the DLL via `GetModuleFileNameW`).
- Per-tick `PostWebMessage` from `Timer()` (every 250 ms) and on every
  `EVMSG_TIMECHANGED` (for live scrub).
- `SetWebMessageCallback` is registered but **dead**. Leave it for now
  in case Maxon fixes the wrapper.

## Dev loop

```
powershell -ExecutionPolicy Bypass -File scripts\dev-loop.ps1
```

Does everything: kills C4D, rebuilds the C++ plugin via cmake, deploys
to the C4D prefs folder, restarts C4D with the dev scene.

For **HTML/CSS-only changes** (no C++ rebuild needed) use:

```
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1
```

C4D doesn't need a restart for these — just close + reopen the dialog
from Extensions menu.

## Next planned steps (in rough order)

1. **Live playhead** — JS consumes `tick` messages from C++ and
   positions the playhead based on `frame / docFrames` across the
   lanes-area width. `{kind:"doc-info"}` carries the frame range.
2. **Tool palette click-to-select** — JS state, send
   `{kind:"tool", id:"razor"}` via `sendToHost`.
3. **Draggable V/A splitter** (memory: `shotblocks-v2-va-splitter`).
4. **Scrollbar pan + end-handle zoom** (memory:
   `shotblocks-v2-scrollbar-zoom`).
5. **Track add / remove** — start from JS-rendered tracks (vs the
   current hardcoded markup).
6. **Real shot blocks** — clip rects rendered in the lanes.
