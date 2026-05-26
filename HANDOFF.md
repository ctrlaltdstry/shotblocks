# Handoff — v1 polish + final bug-fix pass (before Plan 3 user manual)

**Last updated:** end of session. Plan 2.5 is functionally complete;
this handoff is for a focused final sweep — known bugs, paper-cuts,
and any verification gaps — before kicking off Plan 3 (the user
manual). When this pass is done, v1 is feature-complete and ready
for the manual.

## Read these first, in order

1. `CLAUDE.md` (project root) — non-negotiable rules: dev-loop,
   debugging method, commit policy, plugin model essentials, style.
2. `.agent/router.md` — task-keyed navigation into the rest of
   `.agent/`.
3. `.agent/bugs.md` — open bugs filed for later. Triage these into
   what's still real vs. what's been fixed since they were filed.
4. `.agent/plans/v1-release-roadmap.md` — where the project sits in
   the v1 release sequence.
5. `.agent/plans/v1-plan-2.5-ui-refinement.md` — Plan 2.5 plan doc;
   read the "What this plan explicitly does NOT do" section to
   understand scope boundaries.
6. Claude-only auto-loaded memories — see the new entries logged in
   this session at the bottom of `MEMORY.md`. The four newest
   directly inform this pass:
   - `figma-flattened-raster-assets` — when Figma's design-context
     returns just `<img src=...>`, read the SVG path data instead
     of guessing chrome properties.
   - `gsap-selector-scope-during-react-swap` — `querySelectorAll`
     at tween time can match a newly-mounted variant rather than
     the one that was visible when triggered.
   - `css-transition-two-paint-pattern` — exit animations driven
     by class-add need a 1-rAF deferral so the browser captures
     the "before" state.
   - `hydration-aware-first-render` — gate first-run UI on an
     `isHydrated` flag set by `usePersistence` after load resolves.
   - `canvas-chrome-grey-palette` — the grey ramp / radii / strokes
     for every floating chrome surface; reference when adjusting
     anything visual.

## What shipped this session

| # | Hash | Subject |
|---|---|---|
| - | `96e6d2f` | feat(tools): Hand tool — click-drag pan, H hotkey, open/closed-hand cursors |
| - | `7c082ca` | feat(tools): Zoom tool — left-click drag zoom, Z hotkey |
| - | `424fc2e` | feat(ui): floating tool palette card chrome |
| - | `2eb93e4` | feat(ui): floating dB meter card + skim icon above bars |
| - | `798c35a` | feat(ui): rounded track headers + 2px inter-track gap |
| - | `c57a981` | feat(ui): JetBrains Mono timecode |
| - | `ae7e4a0` | feat(ui): new playhead shape from Figma |
| - | `3c35bfa` | fix(drag): clamp clip body / trim / roll drags at the doc end |
| - | `c6448ae` | feat(audio): Selection tool gains keyframe edit parity with Pen |
| - | `487c059` | feat(ui): progressive empty-state overlay (camera + audio dropzones) |
| - | `e35ff94` | feat(ui): motion library floating button replaces logo cell |
| - | `efea842` | feat(ui): ruler chrome — grey-12 fill, 8px numbers, top/left borders |
| - | `23aa3e3` | feat(ui): utilities strip chrome — grey-12 fill, rounded left corners |
| - | `897d346` | feat(ui): layout pass — floating chrome, full-height inspector, drop ceremony |

That covers Plan 2.5 commits 1–10 + the deferred spacing pass + the
drop ceremony + the bug fixes that fell out of the polish work
(re-add-after-delete, multi-track reset, drop-into-audio-side,
dropzone flash on reopen).

## What this session DID NOT do (and what to look at first)

Open items from this session that didn't land:

- **`.agent/bugs.md` triage.** Two bugs there were filed during
  earlier rounds. They may have been incidentally fixed by the work
  in this session — start by re-reading the file and verifying
  whether each repro still happens. If a bug no longer repros,
  remove it from the file.

- **Cursor verification through screensharing.** The user is using
  Jump Desktop to remote in, which doesn't render custom cursors at
  all — so we couldn't visually verify cursor behavior remotely
  during the session. If you have local-only access available, run
  through the cursor states (slip / razor / pen / hand-open /
  hand-closed / zoom / play-range / roll / av-split) to confirm none
  flicker, none disappear on release, and that the hand-open ↔
  hand-closed swap during MMB pan / Hand-tool pan works smoothly.
  Memory `tool-cursor-pattern` has the full recipe.

- **Empty-state edge cases.** The drop ceremony works for the happy
  path (V1/A1 only, first drop). Worth testing:
  - Drop a clip → undo → redo. Does the empty-state ceremony fire on
    the redo? Probably should NOT — the redo is a state-restore, not
    a user drop.
  - Drop a clip → undo → drop a DIFFERENT camera. Should work
    cleanly.
  - Drop a clip while the Add to Queue button is active (mid-render-
    settings interaction). No reason to break, just worth sanity-
    checking.

- **GSAP timeline lingering.** Hot reload of the JS bundle during dev
  can leave stale GSAP tweens running on detached elements. Not a
  user-facing issue, but if you see odd console errors during
  `deploy.ps1` reload they're probably from this. Killing the tweens
  in `useDropCeremony`'s cleanup might be worth adding.

- **Spacing pass — final tightening.** The user said "padding and
  spacing are wrong again but we'll address that in a single pass
  once we get the rest updated" at one point. Most of that landed
  in `897d346` but the user may still flag specific paddings that
  feel off. Use the Figma `400:1788` frame as the source of truth;
  read every value before changing.

## Open bugs / paper cuts to verify or close

These are all small. If any reproduces, fix in its own commit; if it
doesn't repro on this branch, just close it from `.agent/bugs.md`.

1. **Scrub direction reversal sometimes misses camera switch.**
   Filed in `.agent/bugs.md`. Documented as ~50% repro with the
   clip-3 → gap → clip-4 → reverse pattern. The orphan-handling
   commits + this session's polish may or may not have nudged it.
   Re-test with the test scene; if it still happens, the bugs.md
   entry has the diagnostic plan (instrument the C++
   set-active-camera handler to log prevCam / cam / branch fired).

2. **.c4d file-size bloat.** Filed in `.agent/bugs.md`. Scene with
   one geometry + cameras clocks at ~90MB; expected 1-2MB. Suspect
   is helper-BC audio-bytes + peak-pyramid accumulation. Has its
   own CDP-eval diagnostic plan in the entry. Not blocking v1 ship
   but worth at least confirming whether it's still as bad.

3. **Drag-clamp on body/trim/roll.** Already fixed in `3c35bfa`,
   but worth verifying that:
   - Dragging a clip body past the inspector → clip stops at doc end ✓
   - Trimming an edge past the inspector → edge stops at doc end ✓
   - Roll-edit past the inspector → seam stops at doc end ✓
   Plus the cases on the LEFT edge (dragging past frame 0).

4. **Re-adding the same camera after delete.** Fixed mid-session
   when the resolver short-circuit was added (the dropzone's
   centered position landed below the V/A divider, which the
   resolver was rejecting). Worth verifying the path still works
   after various delete states (delete-via-Delete, delete-via-
   right-click, delete-multiple-then-redrag).

5. **Multi-track reset on empty-doc redrag.** Fixed by calling
   `deleteEmptyTracks` on both sides before the addClip. Verify by:
   set up V1/V2/V3 + A1/A2 with clips → delete all → empty-state
   shows → drop a camera → only V1 + A1 remain.

6. **Dropzone flash on reopen.** Fixed via `isHydrated` gate.
   Verify by saving a scene with a clip → close + reopen the
   Shotblocks dialog → populated state should appear without ANY
   panel flash.

## Reference: how the drop ceremony is now wired

If you need to touch the empty-state / first-drop flow, the moving
pieces:

- `EmptyStateOverlay.tsx` — owns the camera dropzone DOM + the
  CSS-transition-driven scale-to-0 exit. Reads `isHydrated`
  (gates initial render), `omDragging` (sticky highlight
  precondition), and the bounding-rect hit-test against `panelRef`
  per om-hover (actual highlight gate).
- `useDropCeremony.ts` — GSAP timeline for the tracks-parting +
  divider fade + new-clip scale-in. Exports `runDropCeremony()`
  (called from `useOmDrop`) and `consumeDropCeremonyFlag()`
  (called from `EmptyStateOverlay`'s exit effect to distinguish
  user-drop from hydration).
- `useOmDrop.ts` — om-drop handler. On `wasEmpty` it overrides
  inFrame to 0, short-circuits the resolver to V1, calls
  `deleteEmptyTracks` on both sides, calls `addClip`, then
  `runDropCeremony()`.
- `usePersistence.ts` — `loadFromHost` flips `isHydrated: true`
  after the load resolves (success or failure paths).
- App.css — `.empty-state__panel.is-active` for the hover
  highlight (scale 1.05 + glow); `.empty-state__panel.is-exiting`
  for the scale-to-0 exit (260ms transform transition).

## Hard rules (re-stated)

- Dev loop: `dev-loop.ps1` kills C4D + deploys + relaunches with
  `dev-test.c4d`. JS-only changes can use `deploy.ps1` + close-and-
  reopen the dialog. C++ changes must `cmake --build` first.
- Commit when explicitly asked — never auto-commit.
- Read every Figma property from `get_design_context`; never guess.
  If the context is flattened to a raster, read the SVG path data.
- Memories under `C:\Users\Mike\.claude\projects\c--Dev-SHOTBLOCKS\
  memory\` are auto-loaded for Claude only. New rules learned in
  this session are in MEMORY.md.

## Commit message style

Match the existing v1 Plan 2.5 commits. `feat(ui): ...`,
`feat(tools): ...`, `fix(drag): ...`, etc. Subject is a single
imperative sentence — no "and"s. Body explains WHY where the WHAT
isn't obvious. Co-author trailer if Claude:

```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Good luck.
