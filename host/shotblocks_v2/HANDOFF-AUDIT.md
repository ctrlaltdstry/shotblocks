# Handoff — Shotblocks v2 audit & cleanup pass

The v1 Python port is complete. Before any new feature work (motion
layers, slate engine, shot library, rig math), the v2 codebase gets a
**full audit + cleanup pass**. This is its own plan; this document is
the starting context.

## What just shipped (this is the "before" state for the audit)

Phase 1 (track headers, 7 commits on `main`):
- Fixed-height video tracks, vertical zoom is audio-only, mouse-wheel
  pan on both stacks, audio zoom top-anchored at the V/A divider.
- The twirl icon moved off the track header (the future motion-layer
  plan owns its return on the clip).
- Track header redesigned to match the Figma components — lock, eye
  (video) / mute/solo (audio), editable track-name label, no number
  chip (no track-targeting; this isn't an NLE).
- Per-track flags (muted/solo/locked/visible/nameIsCustom) added to
  the `Track` model; persisted; renumber-after-delete preserves
  custom names. Lock guards in moveClip / moveClips / resizeClip /
  rollEdit / slipClip / splitClip + deleteSelection + nudgeSelection;
  marquee skips locked-track clips. Locked lane gets a diagonal
  zebra wash; muted / solo'd-out audio lane gets a flat dim.
- Eye gates active-camera routing (useActiveClipRouter); mute/solo
  gate playback + scrub blips + the live dB meter. The label is
  inline-renamed (Enter/blur commits, Esc cancels, empty reverts).
- The track-headers column is resizable by dragging the headers /
  timeline seam (HEADERS_MIN_W..HEADERS_MAX_W); the body's
  grid-template-columns transition is suppressed mid-drag.

Phase 2 (pen tool, 5 commits on `main`):
- `LevelKeyframe` data model: per-node bezier (After Effects style)
  with `inTan` + `outTan` segment-normalized handles. `interp` enum
  (linear / hold / ease-in / -out / -in-out / custom). Five presets
  in `LEVEL_PRESET_TANGENTS`; default new node = ease-in-out (flat
  tangents — a smooth eased curve by default, not a linear ramp).
  `evaluateLevel` in `lib/levelCurve.ts` solves the cubic; persisted
  through save/load.
- `LevelCurve.tsx` overlay on audio clips: SVG curve (cubic per
  segment, step for hold) + diamond DOM nodes positioned in
  clip-fraction percentages — lag-free during zoom (the browser does
  the layout). Hover + selected (blue) node states; resting unity
  line dead-centre on empty clips.
- Add / drag / delete keyframes; per-node tangent handles with a
  clamped pixel render distance so they don't pile up at high zoom.
  The handle's direction comes from the tangent; drag maps back to
  the tangent. Right-click a node for delete + interp; the
  `setLevelKeyframeInterp` preset seeds both this node's outTan and
  the next node's inTan.
- Waveform ducks with the curve (`WaveformCanvas` multiplies bucket
  amplitude by `evaluateLevel`, floored at WAVE_MIN_GAIN so a
  fully-ducked region keeps a sliver).
- Playback: per-clip `GainNode` driven by `setValueCurveAtTime`
  across the play span; scrub blips evaluate the curve at the blip
  frame; dB meter shifts by `20*log10(gain)`.
- Pen cursor: `pen.cur` (from `Cursors/Pen tool.png`) + matching CSS
  data-URI. CURSOR_PEN added to the C++ enum; loaded in
  `LoadCursors()`. Sticky during a LevelCurve drag
  (`levelCurveDragging` in the store).
- Marquee multi-select modelled on Premiere / Audition / Pro Tools:
  press on node = drag (group drag for a multi-selection), press on
  handle = reshape, press elsewhere = marquee, click on the line
  (no drag) adds a node. Shift is additive. Group node drag is
  incremental (the store action is RELATIVE per call). Selection
  lives in the store (`levelKfSelection`) so Delete + the context
  menu act on the set. The context menu shows "Delete N Keyframes"
  and interp applies to all selected.
- Alt held = pen modifier with any tool (Premiere/Audition
  convention). `altHeld` and `altRmbZooming` go through the store
  so `useToolCursor`, `LevelCurve`, `useClipDrag` all agree. Alt+RMB
  stays a zoom — pen mode is suppressed during that gesture.
  `useClipDrag` bails on Alt-over-audio so the clip doesn't drag
  underneath a curve edit.

Open issue noted but parked: changing the pen-cursor IMAGE causes
a brief CSS↔C++ two-writer race because the C++ side caches the
`HCURSOR` until C4D restarts. Memory `tool-cursor-pattern` updated
with this. The cursor currently uses older artwork that both layers
have in sync; a new `Pen tool.png` is committed for the next time
both layers can swap atomically.

## Audit + cleanup — the work to do

Hard gate before any new feature work. The audit covers, in this
order:

1. **Consolidate redundancy.**
   - Video/audio-side handling has grown mirrored branches (vVideo /
     vAudio, the two halves of `useTrackCountSync`, the two halves of
     `useVerticalZoomVars`, save/load mirroring video/audio tracks).
     Where the asymmetry is real (video fixed-height vs audio
     zoomable) keep it; where it's just duplicated code, factor it.
   - Repeated constants — `NATURAL_TRACK_PX`, `MIN_TRACK_PX`,
     `MIN_CLIP_FRAMES`, `SNAP_PIXEL_RADIUS`, `EDGE_HIT_PX`, hit-
     radius values across the curve / nodes / handles / line. List
     them, see which want centralizing.
   - Multiple cursor pipelines (slip / razor / roll / play-range /
     pen) repeat the same two-layer pattern. Could land in a small
     helper.

2. **Remove dead code.**
   - Reverted per-track-resize remnants (HANDOFF.md "per-track height
     resize was attempted and reverted").
   - Gutter-scrollbar leftovers (Round 16 replaced them with the
     7px overlay bars).
   - Anything the round-by-round changelog obsoleted (HANDOFF.md
     reads as a changelog from Round 11 onward; cross-reference what
     it says is gone).
   - Stale `.agent/` docs that no longer match the code. The
     architecture doc was aspirational ("flatter sb_* convention
     rather than the package layout sketched in architecture.md") —
     either update or drop the aspirational shape.
   - Unused exports, hooks, modules. `tsc -b` is clean; ESLint or a
     tree-shake report might surface more.

3. **Optimize.**
   - **Re-render hotspots.** Several components subscribe to the
     whole store via `useStore` selectors — confirm each only watches
     the slice it needs. `LevelCurve` reads `levelKfSelection`,
     `altHeld`, `altRmbZooming`, `h.vMin/vMax`, `activeTool` — each
     is a separate subscription; fine, but worth a scan.
   - Per-frame paths: `WaveformCanvas`'s redraw + the playback tick
     + the dB meter rAF loop. `LevelCurve.buildPath` rebuilds the
     SVG string every render — could memoize on `[kfs, hMin, hMax]`.
   - Bundle size. `dist/index.html` is ~900 KB gzipped to ~480 KB.
     `vite-plugin-singlefile` is needed (memory
     `vite-singlefile-for-file-url`) but the build could be leaner.
   - Folder / module structure. `web/src/` has flat `useX` /
     `componentY` files; with ~30 hooks + ~20 components a
     `hooks/` / `components/` / `lib/` layout would help. The
     `.agent/` architecture sketch already suggests something like
     it.

4. **Fix the latent bug.** HANDOFF.md "Known latent issues":
   > Cross-track ripple drag stuck-class — useClipDrag's effect deps
   > include trackId; cross-track ripple commits re-mount the hook
   > mid-drag. `useDragRecovery` papers over the user-visible
   > symptom but the underlying listener teardown still happens.
   Fix properly during the audit, not with another band-aid.

## How to start

1. Read the `.agent/` docs (especially `router.md`,
   `context/architecture.md` if it still maps to the code,
   `context/pitfalls.md`), CLAUDE.md, the **full** existing
   `HANDOFF.md` (this audit handoff is a supplement, not a
   replacement), and recent commit history (`git log --oneline -30`).
2. Read every memory referenced in CLAUDE.md's MEMORY.md index — the
   `feedback_*` memories carry the hard-won lessons. Particularly
   `tool-cursor-pattern`, `no-assumptions-research-first`,
   `mine-python-for-constants`.
3. Plan-mode the audit. Each cleanup goal becomes a small atomic
   commit (per CLAUDE.md "Commits"). No mixing — refactors, dead-code
   removal, optimizations are separate commits each.
4. **Measure before changing** anything performance-related — CDP
   `scripts/cdp-eval.mjs` is the standard. Don't optimize what
   hasn't been shown slow.
5. **No new features during the audit.** If a fix surfaces a
   feature-shaped gap, note it for the post-audit plan, don't bolt
   it in.

## Pen-cursor follow-up (small, do during audit if convenient)

A new `Cursors/Pen tool.png` is committed but unused — both writers
(CSS data-URI in App.css + the C++ `pen.cur`) still show the older
art that they had in sync. To swap atomically:
1. Re-run `scripts/make-cursor.mjs "Cursors/Pen tool.png" host/shotblocks_v2/web/public/cursors/pen.cur 0,0`.
2. Paste the new sidecar data-URI value into `App.css`'s
   `.level-curve.is-pen` rule.
3. Run `scripts/dev-loop.ps1` (kills C4D so the new `.cur` is
   `LoadCursorFromFileW`-ed fresh on relaunch).
The flicker the user saw was a deploy-window race — CSS swapped
to new art before C++ released the cached old `HCURSOR`. The memory
`tool-cursor-pattern` captures the rule.

## Post-audit follow-ups — ALL CLEARED

Every bug filed during the audit was fixed in the follow-up pass.
Listed here for archaeology + as a paper trail of root causes:

- **Video eye-off has no visual dim on the lane.** Fixed by adding a
  parallel `.lane__invisible-overlay` (mirrors the audio inaudible
  path). Commit `6d37607`.
- **Snap still snaps to beat lines when the grid is hidden.** Fixed by
  gating `audioPeakDocFrames` calls behind `state.beatGridVisible` at
  every snap edit-point assembly site (useClipDrag, Lane trim+roll,
  Ruler scrub). Commit `d3dab7a`.
- **Alt-tap toggles `altHeld` instead of held-while-down.** Fixed by
  deriving `altHeld` from `e.altKey` on every pointer/wheel/key event
  (ground truth) instead of relying on Windows-quirk-prone
  keydown/keyup pairs. `setAltHeld` got an identity-skip check since
  it's now called on every pointermove. Commit `4d7a048`.
- **Cross-side group drag drops the other side's clips silently.**
  Fixed by extending `moveClips` to walk both sides and apply
  `dxFrames` to other-side clips too (horizontal-only; `dtTrack` only
  applies to the anchor side, matching NLE convention). Commit
  `4bc37a5`.
- **Clip label ellipsis and audio level-curve bleed past clip edge at
  minimum width.** Self-resolved during the audit — most likely fixed
  incidentally by the clip-state overlay pattern work shipped earlier.
- **useDragRecovery leaves a thin-vertical-line clip after screenshot
  cancel mid-drag.** Root cause was the recovery itself wiping
  React-managed inline styles (`left`/`right`) on the DOM, bypassing
  React's style-diffing so the next render didn't re-apply them.
  Narrowed the wipe to just `transform` (the only inline style
  useClipDrag writes). Commit `2a96a80`.
- **Level-keyframe interp presets apply inconsistently.** Root cause
  was the actions seeding only the OUTGOING segment's tangents — the
  segment arriving at the selected node was untouched, so users saw
  "sometimes it reshapes, sometimes it doesn't." Fix seeds all four
  involved tangents (this node's inTan+outTan, prev node's outTan,
  next node's inTan). Commit `f53b244`.
- **Cross-track group drag shrinks the anchor clip to near-zero
  width.** Self-resolved by the cross-side group drag fix
  (`4bc37a5`) — the same `moveClips` overhaul touched the relevant
  code paths.

## Audit-related polish

- **Group drag had no vertical glide between tracks.** Reported during
  bug verification, not in the original audit punch list. Solo drag
  already glides via useClipDrag's GSAP transform tween, but group
  drag committed live each pointermove and the React re-render snapped
  the clips into their new positions. Fixed with a FLIP layout-
  transition hook (`hooks/useFlipLanes.ts`) that animates only when a
  group drag is in flight, the clip is in the active selection, and
  its top moved by more than half a natural track height. Commit
  `5d62160`.

## Next plan after the audit

**Camera motion layers** — its own dedicated plan (see
`.agent/layer-model.md` and the original plan file at
`C:\Users\Mike\.claude\plans\i-want-you-to-goofy-boot.md` for the
"Out of scope" section that records the constraints). Don't start it
until the audit lands.
