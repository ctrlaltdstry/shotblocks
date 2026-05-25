# v1 Plan 2 — Markers + render workflow

Two features bundled in one plan because they evolved together as the inspector took shape:

**Markers:** lightweight timing reference points dropped at the playhead via `M` hotkey, persist with scene, no properties beyond frame number. **Shipped (Commits 1–4).**

**Render workflow:** a single render-mode control in the inspector, plus an Add-to-Queue button. The plugin creates / refreshes Takes in the doc and adds the doc to C4D's Render Queue. Plugin does NOT fire render — user fires via C4D's Render Queue UI.

---

## Render workflow — what the plan REALLY is, post-audit

The original plan assumed the C4D Render Queue API takes per-entry overrides (camera, frame range, output path). **It doesn't.** Commit 7's audit (`lib_batchrender.h`) found the API only accepts `.c4d` file paths via `BatchRender::AddFile(filename, position)`. Per entry, you can choose which of the doc's **cameras** / **render-settings presets** / **takes** is active, but you can't override individual fields.

This forces a different shape. Combined with Mike's call to "keep it simple — the user already has the complicated render config in C4D's Render Settings," the v1 render workflow collapses to:

- **One control in the inspector:** a Render mode dropdown with `Whole sequence` / `Individual shots`.
- **Whole sequence mode:** plugin adds the saved doc file to the queue once. No overrides at all — C4D's Render Settings (range, camera, output) is the source of truth.
- **Individual shots mode:** plugin manages **Takes** in the doc:
  - One Take per shot, named `Shotblocks_<shotName>` (or `Shotblocks_<shotNum>` if unnamed).
  - Each Take overrides:
    - The active camera (via `BaseTake::SetCamera`).
    - The frame range parameters on the doc's master RenderData (via `BaseTake::FindOrAddOverrideParam` on `RDATA_FRAMEFROM` / `RDATA_FRAMETO`).
  - **No new RenderData presets.** AOVs, samples, format, output path template — everything else inherits from the user's existing render settings. When the user updates an AOV, every Shotblocks Take picks it up automatically.
  - Plugin then `AddFile`s the doc N times to the queue, and `SetActiveTakeIndex(entryIndex, takeIndex, takeOnly=true)` per entry.

**Trade-off accepted:** N Takes named `Shotblocks_*` clutter the Take Manager. Reversible — plugin can clean them up via a separate command later. Way better than cloning the full render settings per shot, which would go stale every time the user edits their master config.

---

## Status

| # | Commit | Status |
|---|---|---|
| 1 | feat(markers): marker data model + persistence | shipped (`0f363cf`) |
| 2 | feat(markers): M hotkey + ruler pin visual | shipped (`f1603d5`) |
| 3 | feat(markers): right-click delete (marker + clear all) | shipped (`0077c73`) |
| 4 | feat(markers): utility-strip toggle wires to visibility | shipped (`3ab4958`) |
| 5 | chore(inspector): always-open inspector; Settings modal owns Audio toggle | shipped (`a442052`) |
| 6 | feat(inspector): section scaffold + reusable building blocks per Figma | shipped (`ee5ab49`) |
| 7 | audit: C4D 2026 Render Queue API reachability | **done in-session (not committed)** — see findings below |
| 8 | feat(render): Render mode dropdown in inspector | not started |
| 9 | feat(render): Add-to-Queue button — Whole sequence mode | not started |
| 10 | feat(render): Add-to-Queue button — Individual shots mode (Takes) | not started |
| 11 | chore(render): edge cases + polish | not started |

Original Plan 2 had 13 commits. Post-pause revision has 11 — render content collapsed from a five-section inspector into a single dropdown + button.

---

## Audit findings (Commit 7, not committed)

**SDK header:** `frameworks/cinema.framework/source/c4d_libs/lib_batchrender.h`.

- `BatchRender::GetBatchRender()` is the singleton accessor.
- `AddFile(Filename, Int32 number)` is the only way to add an entry. Position -1 / large = append.
- Per-entry overrides ARE available, just constrained:
  - `SetActiveCameraIndex(n, idx)` — picks a camera by index in the doc's camera list.
  - `SetActiveTakeIndex(n, idx, takeOnly)` — picks a Take by index. **This is the one we use.**
  - `SetActiveRenderSettingsIndex(n, idx)` — picks a render-settings preset.
- `Open()` opens the Render Queue window.

**Take overrides:** `frameworks/cinema.framework/source/c4d_libs/lib_takesystem.h`.

- `BaseTake::SetCamera(takeData, BaseObject*)` overrides the take's active camera. Per-Take.
- `BaseTake::FindOrAddOverrideParam(takeData, node, descID, overrideValue, backupValue)` overrides a single parameter on any BaseList2D node within the Take. RenderData is a BaseList2D — so we can override `RDATA_FRAMEFROM` (5017) and `RDATA_FRAMETO` (5018) per Take without forking the whole RenderData.
- `BaseTake::SetRenderData(takeData, rData)` is the heavy-handed "use a different RenderData entirely for this take" — we deliberately DON'T use this.

**RenderData IDs** (`description/drendersettings.h`):
- `RDATA_FRAMEFROM = 5017` (BaseTime)
- `RDATA_FRAMETO = 5018` (BaseTime)
- `RDATA_PATH = 5041` (Filename)
- `RDATA_FORMAT = 5033` (Int32)

**Pre-flight constraint:** `AddFile` takes a Filename — needs an on-disk path. The doc must be saved (`GetDocumentPath()` non-empty) before Add-to-Queue can succeed. If the doc isn't saved, Add-to-Queue refuses with a status-line message.

---

## Scope

**Markers (shipped):** see status table above.

**Render workflow (remaining):**
- Inspector has ONE section labeled `Render` with one control row inside it:
  - Render mode → dropdown: `Whole sequence` / `Individual shots`. Default: `Individual shots`.
- Below the section, an `Add to Queue` primary button + status line.
- Click Add to Queue:
  - Whole sequence mode → 1 queue entry, doc-as-is.
  - Individual shots mode → N queue entries, one per non-orphan video clip in document order. Each entry references a `Shotblocks_<name>` Take.
- Orphan clips are silently skipped.
- Doc must be saved on disk; if not, status line says "Save scene first".

---

## Decisions locked in

### Render
- **No Output / File format / Frame range / Render settings fields in the inspector.** All of that lives in C4D's Render Settings dialog, where the user manages it via the standard C4D workflow.
- **No skip-orphans toggle.** Orphan shots are always skipped in Individual shots mode.
- **No render-all-tracks toggle.** Always renders all video tracks (no per-track filter in v1).
- **Doc save is the user's responsibility.** Plugin doesn't auto-save; it refuses Add-to-Queue if the doc has no path.
- **Take naming:** `Shotblocks_<shotName>` if the camera has a name, else `Shotblocks_<shotNum>` where N is the 1-indexed position in document order. Conflicts (a Take by that name already exists) → plugin updates it in place rather than creating a duplicate.
- **No render trigger.** Plugin only adds to queue. User opens Render Queue and clicks Render manually.
- **Audio not rendered.** As before — render iterates video tracks only.

---

## Implementation order (remaining commits)

### Commit 8 — `feat(render): Render mode dropdown in inspector`

- New `renderSettings` slice in the store with a single field `renderMode: 'whole-sequence' | 'individual-shots'`. Defaults to `individual-shots`. Persisted alongside markers in the helper JSON.
- Inspector renders a single `Render` section with one `Render mode` row using the existing `InspectorDropdown` building block.
- Click the dropdown → simple inline menu (or a tiny CSS-only `<select>`-style picker — match the Figma dropdown aesthetic).
- No Add-to-Queue button yet — that's Commit 9.

**Verification:** dropdown shows both options, switching persists across save/load.

### Commit 9 — `feat(render): Add-to-Queue — Whole sequence mode`

- Add the `Add to Queue` primary button below the Render section (matches Figma if available; otherwise a sane primary-blue button).
- Add a status line below the button. Auto-clears after 5s.
- JS sends a new `add-to-queue` command to C++. Body includes the mode + (for individual-shots later) the shot list.
- C++ handler for `mode = whole-sequence`:
  1. Check `doc->GetDocumentPath()` is non-empty.
  2. Get `BatchRender* br = GetBatchRender()`.
  3. `br->AddFile(doc->GetDocumentPath(), 1 << 30)` (append).
  4. `br->Open()` to make sure the Queue window pops up.
- Returns success / "save scene first" / "queue add failed" to JS for the status line.

**Verification:** save a scene, click Add to Queue with mode = Whole sequence → Render Queue opens with the doc as one entry. Frame range / camera / output path all come from C4D's own settings.

### Commit 10 — `feat(render): Add-to-Queue — Individual shots mode (Takes)`

- JS gathers the list of non-orphan video clips in document order, sends `{mode: 'individual-shots', shots: [{clipId, name, inFrame, outFrame, objectId}, ...]}`.
- C++ handler for `mode = individual-shots`:
  1. Pre-flight: doc saved, master RenderData exists.
  2. Get `TakeData* takeData = doc->GetTakeData()`.
  3. For each shot:
     - Resolve `BaseObject* cam = _cameraLinks[objectId]->GetLink(doc)`. Skip if null (orphan).
     - Find or create a Take named `Shotblocks_<shotName>` under the Main take. Reuse if exists, create if not.
     - `take->SetCamera(takeData, cam)`.
     - `take->FindOrAddOverrideParam(takeData, masterRD, DescID(RDATA_FRAMEFROM), GeData(BaseTime(inFrame, fps)), backup)`.
     - Same for `RDATA_FRAMETO` with `outFrame - 1` (queue uses inclusive end frame).
  4. For each shot (again, in queue-add order):
     - `br->AddFile(docPath, 1 << 30)`.
     - `br->SetActiveTakeIndex(newEntryIndex, takeIndex, true)`.
  5. Skipped orphans are counted; status line reports count.
- All Take edits are wrapped in `doc->StartUndo()` / `doc->EndUndo()` so a Ctrl+Z after Add-to-Queue cleanly reverts.
- One `EventAdd()` at the end so Take Manager refreshes.

**Verification:** scene with 3 shots → Add to Queue with mode = Individual shots → Render Queue shows 3 entries with the right take selected, frame ranges + cameras correct.

### Commit 11 — `chore(render): edge cases + polish`

- No clips in doc → button disabled with tooltip "No shots to render".
- All clips orphan → button enabled but Add shows status "All shots are orphan — nothing to queue".
- Doc unsaved → status "Save scene first".
- Take collision: a Take named `Shotblocks_X` already exists from a prior run → plugin updates it in place (resets the overrides for the current shot's data) rather than creating `Shotblocks_X (1)`.
- Stale Shotblocks Takes: if the user removed shot 3 from the timeline but `Shotblocks_3` is still in the doc, the next Add-to-Queue does NOT delete it — the user might want to keep custom edits on it. (A future "Clean Shotblocks Takes" command can come if needed.)
- Status line variants: success ("Added N shots to Render Queue"), skip ("Added N · skipped M orphans"), error.
- Visual feedback: button briefly pulses on successful Add (subtle, match v1 style).

**Verification:** edge cases above produce sane behavior. No crashes.

---

## Verification — end-to-end after all 11 commits

1. `cd host/shotblocks/web; npm run build` — clean
2. `cmake --build "C:\Dev\c4d_sdk_2026\build-win64" --config Release --target shotblocks` — clean
3. **Smoke test in C4D (`scripts/dev-loop.ps1`):**

   **Markers** — already verified in Commits 1–4.

   **Inspector layout (Commit 5–6):** already verified — inspector docked at 250px, section scaffold matches Figma.

   **Render mode dropdown (Commit 8):**
   - Inspector shows a Render section with one row: "Render mode" + dropdown.
   - Dropdown switches between Whole sequence / Individual shots.
   - Save scene, close, reopen — selection persists.

   **Add to Queue — Whole sequence (Commit 9):**
   - Save scene with 3 clips on V1.
   - Select Whole sequence mode → Add to Queue.
   - Render Queue opens with 1 entry pointing at the saved .c4d, no overrides.
   - Status line: "Added scene to Render Queue".

   **Add to Queue — Individual shots (Commit 10):**
   - Same scene.
   - Select Individual shots → Add to Queue.
   - Render Queue shows 3 entries, all pointing at the same .c4d.
   - Each entry's active Take is `Shotblocks_<cameraName>`.
   - Take Manager (Window → Take System) shows the 3 new takes under Main.
   - Hover an entry → the displayed frame range matches the shot's [inFrame, outFrame).
   - User clicks Render in the Queue → C4D renders each shot with its take's camera + range, output goes to whatever path C4D's render settings has (with `<take>` token if user set one up).

   **Edge cases (Commit 11):**
   - Unsaved scene → Add to Queue refused with "Save scene first".
   - Empty doc → button disabled.
   - Mix of orphan + healthy clips → only healthy ones added; status line counts orphans skipped.
   - Add to Queue twice with same shots → second click updates existing Takes in place, doesn't create duplicates.

---

## Open questions to resolve during implementation

- **(a) Dropdown menu UI.** v1's existing dropdowns (toolbox, etc.) are all single-step — no real menu yet. For the Render mode dropdown we can either build a tiny custom menu (matches the Figma dropdown look) or use a native `<select>` and style it minimally. Decide during Commit 8.
- **(b) Take naming collision policy.** A Take named `Shotblocks_X` exists. Three options: (1) update in place, (2) skip with warning, (3) create `Shotblocks_X (2)`. v1 ships option 1 per the locked decisions. May revisit if users complain.
- **(c) RenderData parameter override semantics.** The `BaseTime` overridden into `RDATA_FRAMEFROM` needs the doc's FPS attached. Confirm Take override + the queue's "use this take" actually changes the render range C4D uses, not just the displayed value. Pending Commit 10 testing.
- **(d) Take Manager pollution.** N takes named `Shotblocks_*` will show up. v1 ships with no cleanup command — user can delete them manually if they want. Worth a small "Reset Shotblocks Takes" item in a future Settings panel.

---

## What this plan explicitly does NOT do

- **No render trigger** — plugin only adds to queue. User fires render manually.
- **No render progress UI** — C4D's Render Queue handles this.
- **No output path / file format / frame padding / filename template config** in the inspector. All of this lives in C4D's Render Settings (the user's existing workflow).
- **No skip-orphans toggle** — orphans are always skipped.
- **No render-all-tracks toggle** — always renders all video tracks.
- **No automatic Take cleanup** — `Shotblocks_*` Takes stay in the doc until the user removes them.
- **No render presets / configurations** — render mode is the entire surface.
- **No motion-layers content** — that's v2.

---

## Hard rules (from CLAUDE.md and memory)

- C4D must be force-killed before deploy for C++ changes (dev-loop.ps1 handles).
- JS-only changes don't need the C4D restart — just `deploy.ps1` then close + reopen the Shotblocks dialog.
- C4D plugin must be rebuilt for any C++ changes (Take + queue work in Commits 9 and 10).
- BaseContainer undo registers AT AddUndo time — Take edits in Commit 10 must AddUndo before write.
- Markers + renderSettings live in helper-BaseObject JSON, not separate persistence.
- No silent `except: pass` — log exceptions.
- Verify in C4D before committing.
