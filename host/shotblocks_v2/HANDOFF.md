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

## Audio (shipped post-Round-11)

### Import
- Drag a `.wav` or `.mp3` from Explorer onto an audio lane. Clip
  spawns at the cursor frame at the file's full duration.
- WebView2 hides the file path, so the binary bytes are pushed once
  to C++ via `audio-add` and persisted in the doc helper container
  keyed by `BCKEY_V2_AUDIO_BASE + clipId`. Save-state JSON references
  by clipId so bytes never re-ship on clip moves/trims.
- `audio-fetch` pulls bytes back on doc reload; `audio-remove` frees
  helper storage when an audio clip is deleted.
- HTTP server cap bumped 64KB → 256MB to accommodate WAV bytes
  (peaks live in the smaller per-clip JSON; the bulk is the WAV).

### Waveforms
- `lib/peaks.ts` decodes via WebAudio `decodeAudioData`, mono
  down-mix, then computes a multi-resolution peak pyramid at SPS
  levels `[64, 256, 1024, 4096, 16384]`. ~1.33x finest level total
  size; persists with the clip.
- `WaveformCanvas.tsx` picks the COARSEST pyramid level whose
  bucket is still ≤1 CSS pixel wide, draws a smooth quadratic-Bezier
  filled envelope. dB-scaled (`DB_FLOOR = -60`) auto-gain via
  `peakAbsMax` so quiet material fills the lane.
- rAF-throttled redraw on every zoom event. Intersection-clipped
  canvas keeps the bitmap bounded (no 32k-px white-block bug).
- Memory: `v2-audio-waveforms`.

### Playback
- `useAudioPlayback` schedules each visible audio clip as an
  `AudioBufferSourceNode` on transport start. Anchor-sync model:
  `audioCtx.currentTime` snapshot at start; if C4D playhead drifts
  >3 frames from the predicted position, stop+restart from new
  position.
- Mid-play scrub detected via tick subscription.

### Scrub
- Audio-scrub toggle below the dB meter in the left rail (Figma
  icon `icon--audio-scrub`). On = play short ~80ms blips at the
  scrub position; off = silent scrub. rAF + 60ms throttle so a
  single ruler-drag doesn't fire dozens of overlapping sources.

### Spacebar play/pause + v2-owned playback
- **v2 owns the playhead clock during spacebar playback** (Python's
  `_playback_tick` pattern). C++ `Timer()` advances `doc->SetTime`
  per frame; honors `_v2LoopEnabled` + `_v2RangeIn` / `_v2RangeOut`.
  Wraps if loop on, stops if off. C4D's native play button still
  works independently (we react to its `EVMSG_TIMECHANGED`).
- Why: C4D 2026 doesn't expose its cycle/loop button state to
  plugins (confirmed both Python and C++ — see
  [[no-c4d-cycle-api]]). Owning the clock is the only way the v2
  loop toggle can actually mean something.
- Memory: `v2-playback-owned`.

## Play range + loop

- `RangeBar.tsx` overlays the ruler. Two chevron handles, blue
  vertical bars at the inner edges, translucent blue tint between.
  When range = full doc, only the thin edge bars show (no-play-range
  visual from Figma).
- `RangeDim.tsx` paints a 30% black overlay outside [in, out],
  spanning both ruler AND stage (lanes area). `pointer-events: none`.
- Range data lives in C++ `_v2RangeIn` / `_v2RangeOut` (cached only;
  NOT written to C4D's `LoopMinTime` / `LoopMaxTime`). Loop flag
  lives in C++ `_v2LoopEnabled`. JS sends edits via `set-play-range`
  / `set-loop`. PostDocInfo broadcasts the cached values back.
- Hotkeys: `I` set in at playhead, `O` set out at playhead, `/`
  range-to-selection (or all clips if no selection).
- Loop button in the utilities strip — drives the v2 loop flag,
  consumed by the C++ playback timer.
- Memories: `v2-play-range`, `v2-playback-owned`, `no-c4d-cycle-api`.

## Round 13–14 additions (snap, audio media-window, slip, cursors)

### Snap (Round 13)
- **Snap toggle** in the utilities strip — gates magnetic snap on
  clip body / trim / roll drags. Default OFF (mirrors Python).
- Yellow **snap-indicator lines** during a snapped drag.
- **Playhead scrub** snaps to clip edges when Snap is on.
- **Razor snaps to the playhead**; the razor cut-line has a two-tier
  look — faint full-height line + a brighter segment over the
  hovered clip.

### Audio media-window model (Round 13)
- An audio clip is a **fixed window onto its media**, not a container
  that rescales. Clip fields: `mediaDurationFrames`,
  `mediaOffsetFrames`, `mediaId`.
- Cut / trim / roll / slip reveal a different slice of the SAME
  waveform — no rescaling. `splitClip`, `resizeClip`, `rollEdit` all
  carry the media-window correctly (audio only).
- Audio bytes + decoded buffer are keyed by `mediaId` (not clipId),
  so split halves share one media with no re-upload / re-decode.
- `useAudioPlayback` offsets the buffer by `mediaOffsetFrames`.
- Load-time backfill: pre-media-window audio clips get sane defaults.

### Slip tool (Round 13)
- 4th palette tool (the mislabeled "range" slot — it was always the
  `|<->|` slip glyph). Drag an audio clip body to slide the media
  under a fixed-position clip. Live preview via `slipPreview.ts`
  (imperative canvas redraw, no React re-render).

### Tool cursors (Round 14) — see memory `tool-cursor-pattern`
- Custom cursors for **slip, razor, select, av-split, roll,
  play-range**. Each is a multi-resolution `.cur`
  (`web/public/cursors/`, 32/48/64) generated from a PNG by
  `scripts/make-cursor.mjs`.
- **Two-layer model, both required:** a CSS data-URI cursor (in
  App.css, must show the SAME image) + C++ `WM_SETCURSOR` ownership.
  C++ subclasses the C4D dialog window, re-asserts the cursor on a
  fast Win32 timer — works around WebView2 not repainting CSS
  cursors after a drag. JS `useToolCursor` sends `set-cursor-mode`.
- The C++ handler gates on `HTCLIENT` so window-resize cursors at
  the dialog border still work.

### Range bar (Round 14, superseded — see Round 15–16)
- The blue play-range tint is a VISUAL fill (`pointer-events:none`,
  scrub passes through). The Round-14 9px top grab-strip was replaced
  in Round 16 by a centered `|||` grip — see below.

## Round 15–16 additions

These rounds are committed as small per-feature commits (the commit
policy changed mid-Round-15 — see CLAUDE.md "Commits": one commit per
atomic verified feature/fix, not one per milestone). `git log` reads
as a changelog from `b979b68` onward.

### Play range — drag, scrub, keys
- **Drag the range:** a centered `|||` grip (three 2px vertical lines)
  is the ONLY range-move target. The blue tint is `pointer-events:none`
  — a press anywhere in the blue falls through to the ruler and scrubs
  the playhead, exactly like scrubbing outside the range. No
  scrub-vs-range ambiguity. Matches the NLE model (e.g. Railcut).
- **Click anywhere in the ruler** (in or out of the range) jumps the
  playhead; press on the playhead scrubs it. Click inside the blue
  scrubs on **pointerdown**, not pointerup (waiting felt laggy).
- **Keys:** `/` resets the play range to the full timeline;
  `Shift+/` (reported as `?`) sets it to the selection (or all clips).
- **Scrub-during-playback pauses transport:** grabbing the v2 playhead
  while playing freezes the timeline + audio at the held frame
  (`scrub-begin` / `scrub-end` C++ commands gate the playback timer);
  releasing re-anchors and resumes from the drop point.
- **Seek during playback re-anchors** the C++ playback clock so the
  playhead keeps playing from where it was dropped.
- **Scrub jump-back fixed:** `scrubFrame` is no longer cleared on
  pointer-release; `setTick` clears it once C++'s tick echo reaches
  the seeked frame (see memory `scrub-frame-echo-handoff`).

### Snap (Premiere model — changed from Round 13)
- **Shift** during a drag/trim/roll/scrub now FORCE-ENABLES snap even
  when the Snap toggle is off (was: Shift suppressed snap).
- **Cmd/Ctrl** during a body drag or trim is ripple mode (was Shift).
- Snap edit points span the WHOLE timeline (both sides, all tracks)
  for body-drag, trim, and roll — global snapping.
- The old Ctrl-held slip shortcut is gone (Ctrl = ripple now); slip is
  the Slip tool / `S` hotkey.

### Cursors — select cursor removed
- The custom select cursor was REMOVED. It was the only cursor
  onscreen during playback and flickered (structural two-writer race:
  WebView2's CSS cursor vs C++ `WM_SETCURSOR`). The select tool now
  uses the OS default cursor; clips/ruler/playhead all use default.
  slip/razor/roll/av-split/play-range cursors remain (hover-only, no
  playback flicker). Memory `tool-cursor-pattern` updated.
- Razor no longer shows a dead roll cursor at seams — trim/roll
  edge-detection is select-tool-only.

### Keyboard shortcuts
- `V` select, `B` blade/razor, `S` slip, `N` snap toggle,
  `Shift+L` loop toggle. Plus the `/` and `Shift+/` range keys above.

### Inspector panel
- Right-side slide-in panel — a real grid column (column 4) that
  PUSHES the timeline (no overlap), opened from the utilities-strip
  gear icon. Built as a shell to grow into shot properties + the
  layered-preset sub-timeline (see `.agent/Camera Presets and Motion
  Layers.md`). First content: the "Audio follows C4D timeline" toggle.

### Audio decoupled from the C4D native timeline
- Inspector toggle "Audio follows C4D timeline" (default on). When
  off, scrubbing/playing C4D's NATIVE timeline produces no v2 audio —
  audio responds only to v2 playback + v2 scrub. The visual playhead
  stays in sync either way. The `tick` message carries a `v2Playing`
  flag so JS can tell v2-owned playback from C4D-native activity.

### Minimal overlay scrollbars
- The gutter scrollbars are gone — replaced by thin **7px** rounded
  overlay bars on the stage's bottom/right edges (50% black fill so
  clips show through, 1px faint border). Pan-only — zoom is Alt+RMB.
- A bar shows ONLY when its axis is actually scrollable: horizontal
  when zoomed in, vertical when the tracks OVERFLOW the visible region
  (a zoomed-but-still-fitting view has nowhere to pan → no bar).
- The `--scrollbar-sz` grid row/column and the v-gutter (with its
  redundant VaSplitter) were removed; the timeline reclaimed the space.

### Clip label — full-width header band
- The label is a full-clip-width header band (10% black tint over the
  clip fill, `3px/13px` padding) — Figma node 287:1811. Replaced the
  earlier rounded pill (which overhung short clips). Thin clips keep a
  plain inline label.

### Live stereo dB meter
- Ports `sb_audio_meter.py` + the meter ballistics from
  `sb_canvas_audio.py`. `lib/audioMeter.ts` builds a per-channel RMS
  dBFS envelope (60ms windows, -60..0 floor) per audio clip's decoded
  buffer, cached per mediaId. `Meter.tsx` samples it at the playhead
  on a rAF loop with peak-meter ballistics (instant attack, 11 dB/s
  VU-ish release, 40 dB/s pause decay, 12 dB/s peak-hold tick).
- Envelope-based (not a live AnalyserNode tap) so it reads during
  scrub too, matching Python. Two thin L/R bars share the meter's
  footprint; mono media drives both identically.

## What does NOT work yet

- **Real shot library / shot-creation flow** (currently every clip
  comes from OM-dropping a camera; v1 had a preset shot library).
- **C++ driving the rig** (camera pose math: spring/damper, quat
  look-at, fBm noise, autofocus, framing, zoom). Currently the
  active camera just swaps; the rig math from v1 Python hasn't been
  ported yet.
- **Most v1 Python features beyond range/loop** — see "Next planned
  steps" for the punch list.

## Known latent issues

- **Cross-track ripple drag stuck-class** — useClipDrag's effect deps
  include trackId; cross-track ripple commits re-mount the hook
  mid-drag. `useDragRecovery` papers over the user-visible symptom
  (stuck class, stuck inline styles) but the underlying listener
  teardown still happens. Solo replace drag isn't affected.
- ~~Cursor flickers during playback~~ — RESOLVED in Round 16 by
  removing the custom select cursor entirely (the only cursor onscreen
  during playback). The flicker was a structural two-writer race
  (WebView2's CSS cursor + C++ `WM_SETCURSOR`); the select tool now
  uses the OS default cursor. See memory `tool-cursor-pattern`.

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
  `load-state`, `undo`, `redo`, `toggle-play`, `set-play-range`,
  `set-loop`, `audio-add`, `audio-fetch`, `audio-remove`.

Messages C++ → JS:
- `hello`, `tick`, `doc-info` (includes playRangeIn/playRangeOut),
  `om-hover` / `om-drop` / `om-cancel`,
  `file-hover` / `file-drop` / `file-cancel`,
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
useFileDrop            — Explorer drag-drop for audio files (.wav/.mp3)
useAudioPlayback       — WebAudio scheduling + scrub blips (audio-scrub toggle)
useActiveClipRouter    — playhead → set-active-camera per Python _route_camera_for_frame
usePersistence         — load on hello / state-changed, debounced save on store changes;
                         audio bytes fetched per-clip on load
useKeyboard            — Delete, arrows, Ctrl+Z/Y forwarding, Ctrl+C/X/V,
                         Space (toggle-play), I/O (play-range), / (range-to-selection)
useMarquee             — marquee drag selection on lanes-area
useClipDrag            — body drag (solo via transform / group via moveClips)
useDragRecovery        — body class mirror + global drag-state safety net (Round 11)
useAltRightZoom        — Alt+RMB drag → zoom around cursor (Round 11)
useMmbPan              — MMB drag → hand-tool pan (Round 11)
useElementSize         — ResizeObserver wrapper
```

New components since Round 11:
```
RangeBar               — play-range chevron handles overlay on ruler
RangeDim               — 30% black overlay outside [in, out], ruler + stage
WaveformCanvas         — multi-res pyramid render for audio clips
```

New JS modules:
```
lib/audioStore.ts      — in-memory blob Map + C++ bridge for audio bytes
lib/peaks.ts           — WebAudio decode + multi-resolution pyramid
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

## Next planned steps (in rough order — Python→v2 port punch list)

Strategy: complete the v1 Python feature port BEFORE auditing the
codebase for cleanup. Then a full audit pass to reorganize files,
remove dead code, and fix the lurking lifecycle bugs. Then new
features (shot library, slate engine, rig port).

Done since this list was written: snap toggle + indicator lines,
slip tool, live dB meter (Rounds 13–16).

**Top-down port order, biggest user-facing wins first:**

1. **Peak detection + visual peak markers + beat-grid overlay.**
   Port `sb_audio_onsets.py` (~747 lines) to JS. Triggered via the
   Beat Detection button (currently a dead icon in the utilities
   strip). Tall yellow ticks on audio clips. Unlocks snap-to-peak
   (the Snap infra already exists) + an optional beat-grid overlay.
   This is the biggest remaining feature — give it a fresh runway.
   IMPORTANT: read `sb_audio_onsets.py` first — memory
   `v9-peak-detection-envelope-only` records that v9 uses envelope
   local-maxima on a drum-band signal, NOT spectral flux (tried and
   removed). Don't reintroduce spectral flux.
2. **Track-header controls (mute / solo / lock / eye)** — the
   icons render in `TrackHeader.tsx` but none are wired. Mute/solo
   gate playback; lock prevents edits; eye on video tracks toggles
   viewport visibility.
3. **Pen tool — audio level keyframes** with interp modes
   (Linear/Hold/Ease). Affects playback gain. Largest single item.
4. **Medium-tier hotkeys** — Ctrl+D duplicate, Up/Down jump to
   prev/next edit point, Alt+Arrow vertical move, zoom-to-fit,
   Ctrl+= zoom around playhead, razor snap-to-peak.
5. **Polish** — hover-fade clip edges, range-bar dbl-click clear,
   orphan "Remove" vs "Delete" label, OM-rename live-reflect.

**Then:**
6. **Audit + cleanup pass** — folder structure, dead code, dead
   files. Fix the cross-track ripple stuck-class bug properly (not
   just masked by useDragRecovery).
7. **Shot library / shot-creation flow** — preset shot templates
   the user can drag onto V1. Bigger UX surface; design first.
8. **Port v1 rig math to C++** (spring/damper, quat look-at, fBm
   noise, autofocus, framing, zoom). Turns v2 from "timeline UI"
   into "actual Shotblocks plugin."

Slate (the signature "align shots to motion-energy peaks" feature)
was never built in v1 either — parked until v2 reaches feature
parity with v1.

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
- `figma-svgs-as-files` — verbatim Figma SVGs go in `web/src/icons/`
  as `.svg` files, imported as URLs. Don't redraw as inline
  mask-image paths (except for state-tinted monochrome icons).

Audio (post-Round-11):
- `v2-audio-file-import` — DOM drop, blob URL → loadedmetadata.
- `webview2-intercepts-file-drops` — handle via DOM dragover/drop.
- `webview2-hides-file-paths` — Chromium security model; no
  absolute paths from JS.
- `v2-audio-waveforms` — multi-res pyramid, dB-scaled, smooth Bezier.
- `canvas-height-attr-overrides-css` — set explicit CSS height when
  JS sets canvas.height for the bitmap.
- `v2-http-cap-4mb` — bumped to 256MB later for audio bytes.
- `v2-playback-owned` — v2 owns playhead during spacebar; C4D's
  play button still works independently.
- `v2-play-range` — RangeBar + RangeDim + I/O hotkeys.
- `no-c4d-cycle-api` — confirmed no SDK access to C4D's loop flag.

Read `MEMORY.md` at session start; it's the index over all of these.
