# Plan: keyframe snapping + slip-on-camera + manual/release refresh

Status: **designed, not started.** Three sequential pieces, each verified
before the next. Both features reuse existing plumbing heavily — little new
C++. Follow-up to the editable keyframe dots (`57aa0eb`, `4a43e54`,
`01a6584`).

Order is deliberate: (1) keyframe snapping, (2) slip-on-camera, (3) update
the user manual to cover the new editing features, then (4) refresh the
GitHub release. Do NOT start the manual until 1+2 are built and verified;
do NOT touch the release until the manual is done.

---

## Part 1 — Snap to a camera's keyframes

Make a camera's keyframe dots act as magnetic snap targets, like clip
edges / playhead / beats / markers already do.

**How snapping works today** (research-confirmed):
- `magneticSnap(desiredInFrame, duration, editPoints, snapFrames)` in
  `store/clipMath.ts` — closest edit point within `snapFrames` wins;
  returns `{inFrame, targets}`. `targets` feeds the yellow
  `SnapIndicators` automatically.
- Four call sites build an `editPoints: number[]` then call it:
  - `useClipDrag.ts` (clip body drag) — builds editPoints ~L258-278.
  - `Lane.tsx` (trim edge) — ~L349-364.
  - `Lane.tsx` (roll seam) — ~L456-469.
  - `Ruler.tsx` (playhead scrub) — ~L67-81.
- Each pushes: every other clip's in/out, the playhead, beats (if
  `beatGridVisible`), markers (if `markersVisible`). Gated on
  `snapEnabled || shiftKey`. `SNAP_PIXEL_RADIUS = 8` (constants.ts).
- `cameraKeyTimes: Map<objectId, number[]>` (doc frames) is reachable at
  every call site via `useStore.getState()`.

**Build:**
1. A shared helper `cameraKeyframeSnapFrames(state)` in clipMath (or
   inline) that unions the keyframe doc-frames to snap to. Decide scope
   (open question below): all cameras' keys, or only the dragged clip's
   camera, or only visible ones. Recommend: push the keys of EVERY video
   clip's camera that's in view — same "everything snaps to everything"
   spirit as clip edges. For the trim/move of a SPECIFIC clip, also
   include that clip's OWN camera keys is fine (you're not moving the
   keys, just the window — snapping the window edge to a key is the whole
   point of this feature).
2. Push those frames into `editPoints` at all four call sites (one added
   line each, behind the same snap gate). The yellow indicator + targets
   are automatic.
3. **Gating decision** (open question): always-on with the Snap toggle, or
   its own sub-toggle? Recommend: ride the existing Snap toggle (N) — no
   new UI. If it feels too busy, add a toggle later. Could also gate on
   `KeyframeTicks` being shown (always, currently).

**Verify:** with Snap on, dragging a clip edge / playhead near a keyframe
dot pulls to it with a yellow line; Snap off (and no Shift) = no pull.

**RESOLVED (2026-06-02, with Mike):**
- Snap scope: **ALL visible cameras' keys** (every in-view video clip's
  camera contributes its keys). Dedupe + cap for perf (a camera caps at
  200 keys already in C++; still dedupe the union across cameras).
- Playhead scrub: **YES, snaps to keys too** — same gate as clip edits.

### Part 1b — marquee color: blue, not purple (quick polish)

The keyframe marquee rect gets LOST over the purple video clips. The
`.marquee-rect` (App.css ~L1271) uses `--color-timeline-primary-highlight`
which is `#824cee` (purple, the brand accent) — so a purple box over
purple clips is invisible. `useMarquee` already tracks `mode` ('clip' vs
'keyframe'). Fix: when in keyframe mode, add a modifier class (e.g.
`.marquee-rect.is-keyframe`) and color it BLUE (use a clearly-blue value,
e.g. Maxon blue `#2C7CD3` from the design system, or a brighter cyan-blue
that pops on purple) for both the 1px border and the ~12% fill. The clip-
mode marquee (over the dark canvas) can stay purple — it's only the
over-clips keyframe marquee that needs the contrast. `MarqueeOverlay` /
`useMarquee` set the class based on the active mode.

---

## Part 2 — Slip tool on camera clips

Today Slip is **audio-only**: it slides the media window
(`mediaOffsetFrames`) under a fixed audio clip. For a CAMERA clip, slip
should slide the camera's whole keyframe ANIMATION within the clip window
— the clip stays put, the animation translates under it.

**Key reframe of "the clip window":** the user wants the clip's endpoints
to represent the camera's FIRST and LAST keyframe, and slip moves the
whole animation. Mechanically that's: **slip = shift ALL the camera's
keyframes by a frame delta** (drag right → animation moves later, or
earlier — match the audio slip direction convention). This is EXACTLY
what C++ `ApplyKeyframeShift(doc, objectId, deltaFrames, refCount)` does —
the same function clip-MOVE and the move-feature already use. **No new C++
needed.**

**How audio slip works today** (research-confirmed):
- `useClipDrag.ts` ~L527-534: gate `side === 'audio' && activeTool ===
  'slip'` → `startSlipDrag(...)`.
- `startSlipDrag.ts`: tracks the drag, live-previews via `setSlipPreview`
  (imperative, no React re-render), commits `slipClip(clipId, trackId,
  offset)` on release.
- `slipClip` (timeline.ts) clamps `mediaOffsetFrames` to keep the window
  inside the media. Audio-specific.
- Cursor: `useToolCursor.ts` ~L92-96 shows `slip` only over
  `.shot-block.is-audio`.

**Build:**
1. **Gate:** in `useClipDrag.ts`, allow slip on video too. Branch: audio →
   `startSlipDrag` (existing media-window slip); video → a NEW
   `startCameraSlipDrag` (or a `mode` flag on the existing one) that
   shifts keyframes instead.
2. **Camera-slip drag:** mirror `startSlipDrag`'s structure but commit a
   keyframe shift, not a media-offset. On release, compute `deltaFrames`
   from the drag (px → frames via the lane's pxPerFrame) and call a new
   JS `flushCameraSlip` (or reuse `flushKeyframeShifts` directly — it
   already queues `{objectId, deltaFrames, refCount}` and immediate-saves;
   C++ `ApplyKeyframeShift` applies it in the undo block). **Reuse
   `flushKeyframeShifts` — it's exactly this.** refCount via the same
   per-camera count used by delete/retime.
3. **Live preview:** during the drag, translate the keyframe DOTS by the
   drag delta (reuse the `KeyframeTicks` group-translate / echo-hold
   machinery — the dots already know how to preview a shift and hold until
   the echo). The CLIP itself does NOT move (slip = clip fixed, content
   slides). Decide: preview by moving all dots together by the live delta;
   commit shifts the real keys; echo-hold bridges the round-trip.
4. **Cursor:** `useToolCursor.ts` — show the slip cursor over
   `.shot-block.is-video` too (change `.is-audio` gate to `.shot-block`,
   or add a video branch). The slip.cur already exists.
5. **Clamp — RESOLVED (2026-06-02, with Mike):** bounded by the WINDOW
   EDGES against the END KEYS (not keys-pinned-to-window). The animation
   slides within the window viewport and stops when an end-key reaches the
   matching window edge:
   - Slip RIGHT (keys later)  → stop when FIRST key hits window LEFT edge.
   - Slip LEFT  (keys earlier) → stop when LAST  key hits window RIGHT edge.
   THE clamp (corrected after implementing — a single a,b ordering can't
   cover all three cases; min/max can):
     `a = clip.inFrame  - firstKeyFrame`   (first key → clip LEFT edge)
     `b = clip.outFrame - lastKeyFrame`    (last  key → clip RIGHT edge)
     `delta = clamp(rawDelta, min(a,b), max(a,b))`
   - window < anim span → a>0, b<0 → range straddles 0 → real slip range
     (pick which slice of the longer animation shows).
   - window == anim span → a==b → range is a point → no-op (the "slip has
     no purpose" case). NOTE: it's window==span that's the no-op, not
     window<span — Mike's "smaller → no purpose" was loose phrasing.
   - window > anim span → a<0, b>0 → range straddles 0 → short animation
     roams freely between the edges.
   Bonus: slip is now the one-gesture "shift the whole animation" — no
   need to marquee-select every dot first.
   firstKeyFrame/lastKeyFrame come from `cameraKeyTimes.get(objectId)`
   (already sorted). No new C++ — `ApplyKeyframeShift(delta)` applies it.

   **Dots while slipping (corrected after first build):** the static path
   only renders in-window keys, but during a slip you must render ALL the
   camera's keys so out-of-window keys can SLIDE INTO view as the
   animation moves. So KeyframeTicks switches to an all-keys, absolute-
   fraction render mode while slipping (and through the echo-hold), drops
   the edge-anchoring, and the `.keyframe-dots` container gets a
   `clip-path: inset(-1000px 0)` mask so dots past the clip edges are
   hidden but their height isn't clipped. `.shot-block` is overflow:visible
   by design (brackets), so the mask must live on the dots container.

**Verify:** Slip tool active, drag a camera clip body → the keyframe dots
slide together, clip stays put; on release the camera's animation has
shifted in time; one Ctrl+Z undoes it; scrub shows the motion moved.

**RESOLVED (2026-06-02, with Mike):**
- Clamp model: window-edge-vs-end-key bounded (see step 5 above).
- Window auto-fit: NO. Clip window and keyframe range stay INDEPENDENT —
  the window is just a "which camera is live" label; you size it freely,
  slip moves keys under it. Window never resizes itself to the keys.
- refCount guard: never fires (video clips can't share a camera) but keep
  it, like delete/retime.

---

## Part 3 — Update the user manual

Only after 1+2 are built + verified. The manual is hand-written static
HTML at `host/shotblocks/docs/index.html` (no build step — edit directly).
Deployed by `deploy.ps1` (robocopy /MIR) and bundled by `package.ps1`
(excludes `_*` scratch). Sidebar nav auto-builds from `<section
class="doc-section">` — just add/extend sections.

**Sections to update** (line refs approximate, re-read before editing):
- **Editing Clips → Move, trim, roll** (~L464-482): document clip TRIM
  (window-only, keys stay), and **Alt+Ctrl edge-drag = RETIME** (rescale
  the camera's animation to the new duration).
- **Editing Clips → The tools** (~L484-504): Slip (S) now works on CAMERA
  clips too — slips the animation within the clip.
- **NEW subsection — Keyframe dots:** video clips show their camera's
  keyframes as dots; click / Shift-click / **Alt+drag marquee** to select;
  Delete removes the column; drag a dot to move it; (snapping) edits snap
  to keyframes.
- **Editing Clips → Snapping** (~L520-534): add keyframe dots as snap
  targets.
- **Keyboard reference** (~L684-729): add Alt+Ctrl retime, Alt-marquee,
  any new keys. (Most of this is mouse/modifier, not hotkeys — document in
  prose where there's no key.)
- **Release notes** (~L760-778): bump for the new editing features.
- **Camera rig tag** (~L662-682): the damping fix + frame-offset pan (now
  works target-less, both axes) shipped this round — worth a line.

**Verify:** deploy, open the Help button in C4D, read the updated sections
render correctly (sidebar nav picks up any new `doc-section`).

---

## Part 4 — Refresh the GitHub release

Only after the manual is done. The release currently predates ALL the C++
timeline work (retime, scrub fix, keyframe dots, rig fixes, these two new
features) — it's badly stale.

**Process** (research-confirmed):
1. `scripts/package.ps1` → builds C++ (Release) + web (Vite), stages a
   clean `dist/shotblocks/` tree, emits `shotblocks-v<ver>.zip` +
   `.sha256`. Excludes scratch/debug.
2. `scripts/shotblocks.iss` via Inno Setup ISCC → the `-setup.exe`.
3. Upload the zip + sha256 (+ exe) to the GitHub release, replacing the
   current assets. **This step is Mike's to run** (the actual GitHub
   publish + asset replacement); Claude preps the artifacts + release
   notes.

**Decisions to confirm at release time:**
- **Version bump:** the website copy says Shipped as **v1.0** (FREE, not
  beta) per `project_website_and_pricing_decisions` — so the
  `v1.0.0-beta` naming in package.ps1 / shotblocks.iss may need to change
  to `v1.0.0` (drop "beta"). CONFIRM the version string + whether to drop
  "beta" everywhere (package.ps1 `$version`, shotblocks.iss, README,
  manual release-notes, the GitHub release title).
- Still unsigned (SmartScreen one-time warning) — fine for now per the
  beta-installer plan; EV cert is a public-release-later thing.
- Tag the release (`git tag -a v1.0.0 -m "..."`) per
  `.agent/context/version-control.md`.

**Do NOT** auto-publish to GitHub — surface the prepped artifacts and let
Mike do the upload/publish.

---

## Reuse map (don't reinvent)

- Snapping: `magneticSnap` + the four editPoints builders +
  `SnapIndicators` (automatic). Just add keyframe frames to editPoints.
- Camera slip: C++ `ApplyKeyframeShift` (UNCHANGED — already shifts all a
  camera's keys), JS `flushKeyframeShifts` (UNCHANGED — queues + immediate-
  saves), the `KeyframeTicks` preview/echo-hold for the live dot
  translate, `startSlipDrag` as the gesture template.
- Manual: edit `docs/index.html` directly; deploy.ps1 / package.ps1 ship
  it. No build step.
- Release: package.ps1 + shotblocks.iss already exist; Mike publishes.

## Don't repeat / known traps

- C++ 600-line `Dispatch` cap — but neither feature needs new Dispatch
  code (snapping is JS-only; camera slip reuses ApplyKeyframeShift via the
  existing save-state path). [[feedback_maxon_sourceprocessor_function_line_limit]]
- C++ changes need `cmake --build ... --target shotblocks` BEFORE
  dev-loop. Snapping is JS-only (no build). Camera slip is likely JS-only
  too (reuses existing C++). [[feedback_dev_loop_does_not_build_cpp]]
- Echo-hold: any keyframe shift round-trips through C++; the dots flicker
  back unless held until the `cameras` echo lands. Reuse the existing
  hold. [[project_v2_keyframe_dots]]
