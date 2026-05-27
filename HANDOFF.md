# Handoff — end of 2026-05-27 session

Huge session. **Plan 4 (camera workflow) fully shipped**, **Plan 4.1
(live Stage render) ~80% done — render-time camera switching still
broken** despite the Stage having correct keyframes and Enable=ON
during render.

## Read these first

1. `CLAUDE.md` (project root) — non-negotiable rules. Especially: dev-
   loop pattern, "measure before fixing", **two failed attempts on
   the same bug → stop and surface the architectural alternative**.
   We violated this rule twice today; both times the unstacking led
   to the actual fix (DescID `creator=Ostage`, BaseDraw pivot away
   from Stage's STAGEOBJECT_CLINK write).
2. `.agent/plans/v1-plan-4.1-live-stage-render.md` — full Plan 4.1
   spec with today's investigation trail and the **next-session queue**.
   The queue lists what to try in what order; the most likely fix
   (NBIT_OHIDE removal) is already-typed in the working tree.
3. `scenes/test stage animation.c4d` — ground-truth reference. Mike's
   hand-keyed Stage that renders correctly. Open it, render it, then
   click Dump stage to see what a working Stage's keys look like.
   Our auto-built Stage matches this structurally (DescID + dtype +
   key data) — but renders blank. Something other than key structure
   is the blocker.

## What shipped today (11 commits + this one)

| Hash | Subject |
|---|---|
| `8dd5325` | fix(clip): NLE-style edge-zone gating + label hide on tiny clips |
| `87642be` | docs: release roadmap split (v1/v1.5/v2) + Plan 4 spec |
| `f6e5d4d` | feat(v1-polish): help button placeholder, new razor/slip cursors, thin black cut-line |
| `e8075b3` | docs(plan-4): R1-R3 research resolved |
| `fd6f678` | docs(plan-4): R4 (chip Figma) resolved |
| `6e9f65c` | feat(plan-4 commit 1): Settings → Defaults → camera-type dropdown |
| `cdc91d9` | feat(plan-4 commit 2): Add Camera button + create-camera handler |
| `eec0ad5` | feat(plan-4 commit 3): A/V chip UI + targeting state |
| `6b120f9` | feat(plan-4 commit 4): wire chips into Add Camera + paste |
| `2114aeb` | feat(plan-4 commit 5): selection-follows-playhead |
| `81c327a` | docs: Plan 4 shipped, Plan 4.1 (live Stage render) spec drafted |
| `b7d17bb` | feat(plan-4.1 commit 1): hidden Stage helper, dormant by default |
| `ef93aa1` | feat(plan-4.1 commit 2): cache per-boundary camera events in C++ |
| `5fb799f` | feat(plan-4.1 commit 3): Stage Driver tag + render-Enable toggle (WIP, render still broken) |

**Plan 4 status:** fully shipped (commits 1–5). All workflow features
work in production. Plan 4 chips, camera creation, selection-follows-
playhead are verified.

**Plan 4.1 status:** structurally complete, render still broken.

## The Plan 4.1 puzzle (read carefully before touching code)

**Goal:** native C4D render paths (Picture Viewer, Render Queue,
batch) should honor Shotblocks's camera sequencing without our dialog
being open. C4D's standard way to do this is a Stage object with a
keyframed camera link.

**Today's setup:**
1. Hidden helper Onull at root, holding persistence data (existing).
2. Hidden helper Ostage at root, holding the keyframed
   `STAGEOBJECT_CLINK` track that mirrors Shotblocks's clip boundaries.
3. Hidden TagData driver on the Onull, listening for
   `MSG_MULTI_RENDERNOTIFICATION` to toggle the Stage's Enable flag
   ON for the render's duration.

**What works:**
- Stage helper auto-created on first save-state. ✓
- Driver tag auto-attached. ✓
- JS computes per-boundary events (`lib/stageCameras.ts`), pushes via
  `set-stage-cameras`. ✓
- C++ rewrites the Stage's animation track on every save with **correct
  DescID** (`DescLevel(STAGEOBJECT_CLINK, DTYPE_BASELISTLINK, Ostage)`
  — the `Ostage` creator is critical; without it keyframes silently
  ignore link writes). ✓
- Keys appear in the dope sheet, correct frames, correct camera links.
  Dump matches reference structurally. ✓
- During render, Message handler fires `MSG_MULTI_RENDERNOTIFICATION
  start=true` → Stage Enable flips ON. `SetParameter ok=1
  readback=1`. ✓
- After render, Enable flips back OFF. ✓

**What doesn't work:**
- Render output does NOT switch cameras despite everything above. ❌

**Why this is surprising:** Mike's reference scene
(`scenes/test stage animation.c4d`) has a hand-built Stage with
camera keyframes — same DescID, same dtype, same link data — and it
renders cameras switching correctly. Same C4D version, same render
path.

## The known difference

| | Reference (works) | Our auto-built (broken) |
|---|---|---|
| Stage name | `Stage` | `_shotblocks_stage` |
| **NBIT_OHIDE** | **not set (visible)** | **set (hidden)** |
| Key interp | LINEAR (2) | STEP (3) |
| Everything else | matches | matches |

The strong suspect is **NBIT_OHIDE excluding the Stage from render
evaluation entirely**. Hidden objects may be skipped by the render
scene walk regardless of their Enable flag. Easy to test (5 min);
already-staged uncommitted change has the OHIDE removal queued — see
the working tree at end-of-day.

## What to try first tomorrow (don't skip)

The next-session queue is in
`.agent/plans/v1-plan-4.1-live-stage-render.md`. Top of the queue:

**1. Test the NBIT_OHIDE hypothesis.** In
`GetOrCreateStageHelper` (`host/shotblocks/source/main.cpp`), comment
out the `stage->ChangeNBit(NBIT::OHIDE, NBITCONTROL::SET);` line.
Build, deploy, fresh scene, add 2 cameras, render. If cameras switch
in the output: NBIT_OHIDE was the blocker. Then decide UX (leave
Stage visible OR find a different hide mechanism).

**2-5: Other ordered hypotheses** in the plan doc.

## Don't repeat what we already know

- ✗ DescID needs `creator=Ostage` (5136). We know. Don't try `creator=0`.
- ✗ `SetGeData(curve, ld)` with `ld.SetBaseList2D(cam)` works for
  keyframes. We know.
- ✗ `MSG_MULTI_RENDERNOTIFICATION` reaches the driver tag and the
  Enable-flag write succeeds. We know.
- ✗ Per-frame `SetParameter` on the Stage from a tag's Execute doesn't
  persist. We know. (Doesn't matter — keyframes work now.)
- ✗ Per-frame `BaseDraw::SetSceneCamera` from a tag's Execute works
  for interactive native scrub BUT forces the viewport onto the
  Shotblocks-active camera at all times — Mike pulled this. The
  Execute body is now an intentional no-op; leave it that way.

## Diagnostics that helped (and stay around)

- **Dump stage button** (next to Add camera, bottom-right). Calls
  `HandleDumpStage` which logs every Ostage's CTrack/CKey structure
  to the C4D Console. Use this to compare our auto-built Stage to
  any reference Stage. Output format documented in main.cpp.
- **Reference scene** (`scenes/test stage animation.c4d`). Open this
  to validate "is the render path itself working in this C4D session"
  before assuming our code is broken.

## What this session DID NOT do

- **No Plan 4.1 finish.** Render still doesn't switch. Plan 4.1
  shouldn't ship until it does.
- **No Plan 5** (user manual + help button wiring). Help button is
  there as a placeholder (alerts "User manual coming in v1").
- **No fix for the C4D Timeline collapse-button quirk** (closing/
  reopening tabs with anything docked breaks C4D's collapse button
  until restart). Researched — undocumented public bug. Not ours
  to fix. File as Maxon support ticket later.
- **No fix for the rig tag freezing renders.** Cameras using the
  Shotblocks rig tag render as a single frozen frame (spring-damper
  state isn't initialized cold). Related to v2 motion-layers Plan 10
  bake-to-keyframes scope. Filed but deferred.

## Hard rules (re-stated)

- Dev loop: `powershell -ExecutionPolicy Bypass -File scripts\dev-loop.ps1`
  kills C4D + deploys + relaunches with `dev-test.c4d`. C++ changes
  must `cmake --build c:/Dev/c4d_sdk_2026/build-win64 --target shotblocks --config Release`
  first.
- **Run dev-loop backgrounded** if you don't need to block on it —
  it takes ~10s.
- Commit only when explicitly asked. Verify visual / behavioral
  changes in the live app before committing.
- **Don't band-aid.** Two failed local fixes on the same bug → stop,
  surface the architectural option explicitly. We violated this rule
  in the keyframe-write chase today and it cost ~2 hours. The rule
  works.

## Commit message style

Match the existing today's commits. `feat(plan-N commit M): ...`
for plan work. Subject is one imperative sentence; body explains WHY.
Co-author trailer if Claude:

```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

## Files left dirty in the working tree

```
host/shotblocks/source/main.cpp                  (Plan 4.1 commit 3 work — committed)
host/shotblocks/web/src/components/AddCameraButton.tsx  (committed)
host/shotblocks/web/src/lib/host.ts              (committed)
scenes/test stage animation.c4d                  (reference — committed)
scenes/dev-test.c4d                              (autosave noise — don't commit)
scenes/dewhfwhefbbvw.c4d  scenes/dwfweffefw.c4d  scenes/uihrdgiuhurgsd'.c4d  (test scene garbage — delete)
.claude/  HANDOFF-CLAUDE-SCRUB-BUG-2026-05-26.md  HANDOFF-CODEX-SCRUB-BUG.md  (session artifacts — not tracked)
```

Good luck.
