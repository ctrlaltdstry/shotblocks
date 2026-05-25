# Handoff — v1 Plan 2 Commit 10 (Individual shots / Takes)

**Last updated:** end of session, ready to start Commit 10.

## Read these first

1. `CLAUDE.md` (project root) — non-negotiable rules: dev-loop, debugging method, commit policy, plugin model essentials, style.
2. `.agent/router.md` — task-keyed navigation into the rest of `.agent/`.
3. `.agent/plans/v1-plan-2-markers-and-render.md` — current plan, including the post-audit revision that changed the render workflow shape. **Commit 10 is described in detail in the "Implementation order" section.**
4. `.agent/bugs.md` — known issues filed for later; the scrub-direction bug + .c4d file-size bloat are still open.
5. (Claude only — these are auto-loaded) memory files under `C:\Users\Mike\.claude\projects\c--Dev-SHOTBLOCKS\memory\`. Codex won't see these; relevant ones for Commit 10:
   - `feedback_dev_loop_kill_before_deploy.md` — kill C4D before deploying ANY C++ change.
   - `feedback_dev_loop_does_not_build_cpp.md` — must run `cmake --build` BEFORE `dev-loop.ps1` for C++ changes.
   - `feedback_undo_addundo_timing.md` — BaseContainer undo registers AT AddUndo time; every helper-container write inside StartUndo/EndUndo must follow a single AddUndo.
   - `feedback_no_silent_except_pass_at_boundaries.md` — never swallow C4D API errors silently.

## What's shipped so far in Plan 2

| # | Hash | Subject |
|---|---|---|
| 1 | `0f363cf` | feat(markers): marker data model + persistence |
| 2 | `f1603d5` | feat(markers): M hotkey + ruler pin visual |
| 3 | `0077c73` | feat(markers): right-click delete (marker + clear all) |
| 4 | `3ab4958` | feat(markers): utility-strip toggle wires to visibility |
| 5 | `a442052` | chore(inspector): always-open inspector; Settings modal owns Audio toggle |
| 6 | `ee5ab49` | feat(inspector): section scaffold + reusable building blocks per Figma |
| 7 | (in-session audit, not committed) — drove the plan revision |
| — | `873e7b4` | docs: revise v1 Plan 2 render workflow post-API-audit |
| 8 | `9cc391b` | feat(render): Render mode dropdown in inspector |
| 9 | `bff6cc6` | feat(render): Add to Queue button — Whole sequence mode |

Plus prep work earlier this session: revised plan doc (`873e7b4`).

## What Commit 10 needs to do

Wire the **Individual shots** branch of `HandleAddToQueue` in `host/shotblocks/source/main.cpp` (currently a stub returning `"Individual shots mode coming soon"`).

The architecture, locked in during Commit 7 audit:
- **One Take per shot**, named `Shotblocks_<shotName>` (or `Shotblocks_<shotNum>` if no name).
- Each Take overrides:
  - **The active camera** via `BaseTake::SetCamera(takeData, BaseObject*)`.
  - **The doc's master RenderData's `RDATA_FRAMEFROM` and `RDATA_FRAMETO`** via `BaseTake::FindOrAddOverrideParam(takeData, masterRenderData, DescID(RDATA_FRAMEFROM), GeData(BaseTime(inFrame, fps)), backup)`. Same for FRAMETO with `outFrame - 1` (queue uses inclusive end frame; verify this).
- **No new RenderData presets** — the user's existing master RenderData keeps AOVs / sampling / format / output template. Takes only override the two range fields.
- After Takes are created/updated, plugin calls `BatchRender::AddFile(docPath, 1<<30)` N times, then `SetActiveTakeIndex(entryIndex, takeIndex, takeOnly=true)` per entry.
- Orphan clips (`_cameraLinks[id]->GetLink(doc) == nullptr`) are skipped; status line counts them: e.g. `"Added 5 shots · skipped 1 orphan"`.

### JS-side changes needed

The current JS only sends `{kind, mode}`. For Commit 10, JS needs to include the shot list so C++ knows which clips to render. Add to the outbound payload:

```ts
{ kind: 'add-to-queue', mode: 'individual-shots',
  shots: [{ clipId, name, inFrame, outFrame, objectId }, ...] }
```

Gather the shots in `Inspector.tsx`'s `onAddToQueue`: iterate `useStore.getState().videoTracks` in document order (V1 → V2 → …), collect every clip where `clip.objectId > 0`, attach `clip.sourceName` as the name. Filter orphans on the C++ side (we have the live `_cameraLinks` resolution there).

You'll need to extend the `HostOutbound` union in `host/shotblocks/web/src/lib/host.ts`:

```ts
| { kind: 'add-to-queue';
    mode: 'whole-sequence';
  }
| { kind: 'add-to-queue';
    mode: 'individual-shots';
    shots: { clipId: number; name: string; inFrame: number; outFrame: number; objectId: number }[];
  };
```

### C++-side changes needed

In `host/shotblocks/source/main.cpp`, the `HandleAddToQueue` method has a stub for individual-shots. Replace it with the real implementation:

1. **Parse the shots array** from the JSON body. The naive parser (`ParseIntField` / `ParseStringField`) doesn't do arrays; you'll either need to extend it or extract a small helper that walks `"shots":[{...},{...}]` and pulls each object's fields. Keep it scoped to this command — a real JSON parser is a separate cleanup.
2. **Get TakeData:** `TakeData* takeData = doc->GetTakeData();` (from c4d_basedocument.h).
3. **Resolve the master RenderData:** `RenderData* masterRD = doc->GetActiveRenderData();` (or `GetFirstRenderData()` — pick the active one).
4. **Wrap everything in StartUndo/EndUndo.** Per the project rule, every BaseContainer write inside StartUndo/EndUndo must follow a single AddUndo. For Take edits you'll AddUndo(UNDOTYPE::CHANGE_SMALL, take) on each modified Take.
5. **For each shot in the JS-provided list:**
   - Look up the camera via `_cameraLinks[objectId]->GetLink(doc)`. Skip if null (orphan); increment a counter for the status line.
   - Find or create a Take. To find: walk `takeData->GetMainTake()->GetDown()` (or use `BaseTake::GetTakeFromName` if it exists — check the header) for a child named `Shotblocks_<name>`. If not found, create one via `takeData->AddTake()`.
   - `take->SetCamera(takeData, cam)`.
   - Build a `DescID` for `RDATA_FRAMEFROM`: `DescID(RDATA_FRAMEFROM)`. The override value goes through GeData wrapping `BaseTime(inFrame, fps)`. Backup value can be the master RD's current value (read via `masterRD->GetParameter(...)`).
   - `take->FindOrAddOverrideParam(takeData, masterRD, fromDescID, GeData(BaseTime(inFrame, fps)), GeData(/*backup*/));`
   - Same for `RDATA_FRAMETO`. Confirm the inclusive-vs-exclusive end frame; if C4D's render range is inclusive, you'll want `outFrame - 1`.
6. **Add the doc to the queue N times:**
   - For each shot (in queue-add order, same as the iteration above), call `br->AddFile(docPath, 1<<30)`.
   - Right after each AddFile, call `br->SetActiveTakeIndex(newEntryIndex, takeIndex, true)`. `newEntryIndex` is the index of the entry you just added — i.e. `br->GetElementCount() - 1`.
   - `takeIndex` is the position of the Take. Get this via `SetActiveTakeIndex` documentation — usually a flat index across all takes. You'll likely need to count the Takes in document order and map your `Shotblocks_<name>` Take to its index.
7. **EventAdd()** at the end so Take Manager refreshes.
8. **`br->Open()`** to bring the queue window forward.
9. **Return** a status JSON like `{"ok":true,"kind":"add-to-queue-ack","status":"Added 5 shots to Render Queue"}` (or with `· skipped N orphan` appended when applicable).

### Risk / unknowns

- **Inclusive vs exclusive end frame.** C4D's `RDATA_FRAMETO` is inclusive (last frame to render). Shotblocks' `clip.outFrame` is exclusive (first frame NOT in the clip). So pass `outFrame - 1` to FRAMETO. Verify this with a small render test (1 clip, expected frames vs actual rendered output).
- **`SetActiveTakeIndex` takeIndex meaning.** It might be "index into the doc's Take tree flattened" or "index in some hash order." Likely the same flat tree-walk index that `GetAllTakeNames` produces. The BatchRender's `GetAllTakeNames(n, names)` output is the authoritative ordering — use the same order to compute your take index.
- **`DescID(RDATA_FRAMEFROM)` construction.** C4D's DescID can be one or multi-level. RenderData params are flat top-level Int32 IDs; `DescID(DescLevel(RDATA_FRAMEFROM))` may be the exact form. Check how other plugin code in `main.cpp` constructs DescIDs (e.g. the `BASEDRAW_DATA_PROJECTION` read in `PickTargetBaseDraw`).
- **TakeData API surface.** Some methods on `BaseTake` actually live on `TakeData` or `iBaseTake`. The header `c4d_libs/lib_takesystem.h` has the canonical signatures. Read the header carefully before guessing.
- **Pre-existing Shotblocks Takes.** If a Take named `Shotblocks_X` already exists from a prior Add-to-Queue run, the spec says: update it in place, don't duplicate. So always find-first, create-if-missing.

### Build + verify

This is C++ work → full kill-deploy-relaunch cycle.

```powershell
# Build C++
cmake --build "C:/Dev/c4d_sdk_2026/build-win64" --config Release --target shotblocks

# Then deploy + relaunch (kills C4D first, see memory)
powershell -ExecutionPolicy Bypass -File scripts/dev-loop.ps1
```

For JS-only iteration on the inspector wiring, you can skip the C4D restart:
```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1
```
Then close + reopen the Shotblocks dialog.

CDP eval for inspecting JS state without DevTools UI:
```powershell
node scripts/cdp-eval.mjs "__SHOTBLOCKS_STORE__.getState().renderMode"
```

### Verification scenario (from the plan)

Scene with 3 clips on V1: shot 1 (Cam A, 0–60), shot 2 (Cam B, 60–120), shot 3 (Cam A, 120–180).
1. Set Render mode → Individual shots in the inspector.
2. Save the scene (required for AddFile).
3. Click Add to Queue.
4. Open Render → Render Queue in C4D.
5. **Expect:** 3 entries, all pointing at the same .c4d. Each entry's active Take is `Shotblocks_<cameraName>`.
6. Take Manager (Window → Take System) shows the 3 new Takes under Main.
7. Hover an entry → frame range matches the shot's `[inFrame, outFrame)`.
8. Render → output goes wherever the user's render settings has the path.

Edge cases (Commit 11 handles polish, but Commit 10 should at least not crash):
- Empty doc (no video clips) → status `"No shots to render"` and button is no-op.
- All clips orphan → status `"All shots orphan — nothing to queue"`.
- Mix of orphan + healthy → only healthy added; status counts orphans skipped.
- Add to Queue twice → second click updates existing Takes in place (no duplicates).

### Files you'll be touching

- `host/shotblocks/source/main.cpp` — extend `HandleAddToQueue` for `mode == "individual-shots"`.
- `host/shotblocks/web/src/lib/host.ts` — extend `HostOutbound` for the new shots-array payload.
- `host/shotblocks/web/src/components/Inspector.tsx` — gather the shots list in `onAddToQueue`.

No new files expected.

### One last thing about Dispatch's 600-line limit

The Maxon sourceprocessor enforces a hard 600-line cap per function. `Dispatch` is currently around 580 lines after Commit 9's extraction of `HandleAddToQueue`. If you add more inline handlers in Dispatch, you'll need to extract them into helper methods — same pattern as `HandleAddToQueue` (just one if-line that calls a private method).

### Commit message style

Match the existing Plan 2 commits — see `git log --oneline -20`. Format:
- Subject: `feat(render): Add to Queue button — Individual shots mode (Takes)` or similar.
- Body explains the architecture chosen + any non-obvious decisions.
- `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer if Claude.

Good luck.
