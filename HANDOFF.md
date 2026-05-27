# Handoff — end of 2026-05-26 session

Big day. Three blocking bugs fixed, ~10 polish items shipped. Plan 3
(user manual) is the next milestone but a handful of design tweaks
still stand between us and that.

## Read these first

1. `CLAUDE.md` (project root) — non-negotiable rules: dev-loop,
   debugging method (measure before fixing; two failed attempts →
   instrument, not a third blind try), commit policy, style.
2. `.agent/router.md` — task-keyed navigation into `.agent/`.
3. `.agent/bugs.md` — five open items at the top (clip min-size,
   spawn-ghost visual, help button, razor/slip icons + highlight,
   plus reference to the new architectural-fix-before-banding meta
   memory). The two fixed bugs (file bloat + reverse-scrub camera)
   stay in the file for reference, marked FIXED.
4. Claude-only memories — three new ones logged this session, all
   load-bearing for tomorrow's work:
   - `c4d-setscenecamera-bypasses-cache-invalidation` — the
     reverse-scrub fix recipe. SetSceneCamera doesn't fire
     MSG_DESCRIPTION_POSTSETPARAMETER; use SetParameter on
     BASEDRAW_DATA_CAMERA + dirty cams + ExecutePasses.
   - `exhaust-creative-options-before-escalating` — two failed
     fixes ≠ "file a vendor ticket." Look at what working
     subsystems use, search SDK internals.
   - `propose-architectural-fix-when-bandaiding` — two failed
     LOCAL band-aids on the same bug = surface the refactor option
     explicitly. Mike was livid yesterday because I didn't.

## What shipped this session

Three commits today:

| Hash | Subject |
|---|---|
| `b825da0` | fix(camera): route camera switch via SetParameter so reverse scrub repaints |
| `b1ad091` | fix(drag): audio body draggable + drop-zone hides when only audio present |
| `3162f64` | fix(persistence): audio-add/remove no longer snapshots helper BC into undo |
| `9c63966` | feat: v1 polish — rail layout, audio block redesign, drag refactor |

The big batch (`9c63966`) covers:

- **Chrome layout per Figma 150:1348:** default window 1497×594;
  rail column 64px wide (4 inset + 50 card + 10 gap); 50px-tall
  utilities + ruler rows; motion library button 50×50; tool palette
  50×292 fixed with 34px tool hit-boxes + 8px even padding; dB
  meter 50×144 fixed, anchored to canvas bottom with 4px bottom
  inset and 10px MIN gap above the palette; range-handle SVG bumped
  to native 16×50 viewBox.

- **Audio block redesign:** new green #01904b fill / #016535 border;
  waveform-toggle button at clip bottom-left (24×24, three states
  per Figma); per-clip `waveformVisible` flag persisted; new audio
  clips default to waveform-OFF; waveform fill is now translucent
  black (rgba(0,0,0,0.30)) so it reads as a darkening; keyframe +
  bezier accent is now orange #ff9500 (new `--color-audio-kf-accent`
  var); click in empty canvas now also clears keyframe selection.

- **Drag system refactor:** useClipDrag converted from
  `el.addEventListener('pointerdown')` to a React onPointerDown
  handler returned by the hook and bound by ShotBlock. Previously
  the native listener fired BEFORE React dispatched, so
  LevelCurve's stopPropagation couldn't block the body drag —
  every keyframe / bezier-handle drag also dragged the clip.
  Removed three earlier band-aid attempts (hasPointerCapture gate,
  microtask deferral, duplicated hit-test). With the React handler,
  propagation order is deterministic. This unblocked a whole class
  of bugs.

- **Scope cleanups + new behaviors:** razor cuts audio only AND
  no longer shows the cut-line preview on video clips; markers
  act as snap targets for body drag / trim / roll / ruler scrub
  (only when markers visible); OM drop centered under cursor;
  dropping onto a locked V-track redirects upward to the next
  non-locked track (spawns V<max+1> if none exists); OM hover
  detection recognizes the spawn band above V<max>; addClip
  gained spawn-when-toNum=max+1 behavior matching moveClip;
  spawn ghost positioned directly above outermost video lane
  (was projecting above the whole video share area).

Audio drag, video drag, keyframes, beziers, ghost positioning,
razor-on-audio, and spawn-on-locked-V1 are all manually verified.

## What's outstanding (in .agent/bugs.md)

1. **Clip minimum size scales with timeline length.** At very
   high zoom-out, clip width gets so small the edge-hit-zones
   collide and trim/roll stop working. Fix: enforce minimum in
   pixels (not frames). v1 used `EDGE_HIT_PX = 24`, so ~72px min
   clip width keeps all three zones reachable.
2. **New-track spawn ghost: different visual treatment.** Ghost
   is positioned correctly now; Mike wants a fresh visual.
   Specifics TBD — fetch Figma when ready.
3. **Help button in inspector** (`?` glyph) — blocks Plan 3.
   On click, launches the user manual. Launch mechanism TBD.
4. **New razor + slip icons + razor highlight tweak.** Mike has
   new SVGs; razor highlight design needs adjustment.

## What this session DID NOT do

- **Audio waveform render quality.** Toggle works, off-by-default
  shipped, color updated — but nobody scrutinized the actual
  rendered envelope shape against Figma. If the user-confirmed
  shape isn't what they want once they turn it on, that's a new
  ticket against `host/shotblocks/web/src/components/WaveformCanvas.tsx`.
- **Plan 3 (user manual).** Not started; help button is its
  prerequisite (#3 above).
- **`dev-test.c4d` file.** Got modified by C4D throughout the
  session (autosaves on every launch); kept out of commits. It
  has a couple of test clips on it. Leave as-is or curate later.
- **CDP port (9222) flakiness.** Earlier in the session I added
  a fix to `dev-loop.ps1` using `ProcessStartInfo` instead of
  `$env: + Start-Process` for the env var. Then a `git reset` at
  some point reverted it. CDP works inconsistently as a result.
  If you need CDP tomorrow, re-apply that fix to dev-loop.ps1.
  (Not blocking — most diag now goes through the on-page debug-log
  overlay, which is always available via backtick.)

## Hard rules (re-stated)

- Dev loop: `powershell -ExecutionPolicy Bypass -File scripts\dev-loop.ps1`
  kills C4D + deploys + relaunches with `dev-test.c4d`. C++ changes
  must `cmake --build c:/Dev/c4d_sdk_2026/build-win64 --target shotblocks --config Release`
  first.
- **Run dev-loop backgrounded** if you don't need to block on it —
  it takes ~10s and the foreground call freezes the agent.
- Commit only when explicitly asked. Verify visual / behavioral
  changes in the live app before committing.
- Read every Figma property via `get_design_context`; never guess.
  If get_design_context returns a flattened raster, read the SVG
  path data directly.
- **Don't band-aid.** Two failed local fixes on the same bug → stop,
  and surface the architectural-refactor option explicitly. Mike
  has said this directly. See the memory.

## Commit message style

Match the existing v1 Plan 2.5 / today's commits. `feat(ui): …`,
`feat(audio): …`, `fix(drag): …`, etc. Subject is one imperative
sentence; body explains WHY. Co-author trailer if Claude:

```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Good luck.
