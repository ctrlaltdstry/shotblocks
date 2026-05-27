# Plan 1 — Motion Layers Foundation

The chassis. No evaluation yet. Ships pill data model, persistence, sub-lane UI, empty inspector shell. After this lands, Plan 2 (Targeting evaluation) is a straightforward feature add against an already-built foundation.

**Scope discipline:** this plan does NOT make pills actually animate the camera. It makes pills *exist* as data, persist, render in sub-lanes, and be selectable/editable. Pills evaluate to no-ops at render time. The goal is to prove the chassis works end-to-end before adding any pill type's math.

---

## Decisions this plan locks in (from the design exploration)

These are settled and inform implementation choices below. Captured here so they don't drift.

- **Pills are typed.** Four types: `targeting`, `movement`, `lens`, `texture`. Only `targeting` ships actual behavior (in Plan 2); the other three exist as type-tags but cannot be created from the UI yet.
- **Sub-lanes auto-spawn and auto-collapse, Final Cut magnetic-style.** Adding the first pill of a new type spawns its sub-lane; removing the last pill of a type removes the lane. Lanes stack in *spawn order*, not fixed order. User can drag-reorder sub-lanes within a shot.
- **Recipe library lives in a left panel** (consistent with existing v2 left-panel placement for the animation library).
- **Pill ripple on shot trim:** shorten = pills scale-down proportionally; lengthen = pills hold their length, user can stretch up to (not past) shot edge.
- **Universal pill params:** name, color, ease in/out (curve picker with Linear/Smooth/Snappy/Custom presets), hold-after-end (toggle + frames), mute, solo.
- **Pill defaults fill the shot's range on drop.**
- **Per-action undo granularity** (matches v2 elsewhere).
- **Live evaluation during edits** (no on-release re-eval).
- **Multi-select inspector uses "Mixed" label** for differing values (Figma pattern).
- **Pill data persists nested inside its shot's helper-BaseObject JSON entry.** Decision: simpler, atomic with the shot, undo-friendly because clip-edit and pill-edit hit the same JSON. Performance neutral at expected scale (≤100 pills per scene).
- **Render-time pill evaluation runs in C++.** Decision: keeps the playback hot path single-process, enables headless render later. JS owns editing (inspector + pill manipulation); C++ owns per-frame math. JS pushes pill edits over the existing loopback HTTP server. *Foundation plan only stubs the C++ side — no real eval yet.*

---

## Architecture overview

### Data model

A pill is a discriminated union by `type`:

```typescript
type Pill =
  | TargetingPill
  | MovementPill
  | LensPill
  | TexturePill;

interface PillBase {
  id: string;                    // uuid, stable across saves
  type: 'targeting' | 'movement' | 'lens' | 'texture';
  shotId: string;                // owning shot
  startFrame: number;            // relative to shot start? or absolute? See open question (a) below
  endFrame: number;
  subLaneIndex: number;          // 0-based; defines stacking order within the shot
  name: string;
  color: string;                 // hex; defaults per type
  easeIn: EaseCurve;             // 'linear' | 'smooth' | 'snappy' | {bezier}
  easeOut: EaseCurve;
  holdAfterEnd: { enabled: boolean; frames: number | 'infinite' };
  mute: boolean;
  solo: boolean;
}

interface TargetingPill extends PillBase {
  type: 'targeting';
  // Plan 2 adds: targetObjId, influence, blendIn, blendOut, aimOffset, upMode, leadAmount, banking
}

interface MovementPill extends PillBase { type: 'movement'; /* Plan 6 */ }
interface LensPill extends PillBase { type: 'lens'; /* Plan 8 */ }
interface TexturePill extends PillBase { type: 'texture'; /* Plan 9 */ }
```

**Open question (a):** Pill frames relative-to-shot or absolute? Absolute is consistent with how clips work today (clips have absolute startFrame/endFrame on the doc timeline). Pills moving with their shot is automatic if absolute (because the shot's startFrame moves them). Choosing **absolute** unless we hit a wall.

### Persistence

Pills nest inside the shot's helper-BaseObject JSON entry:

```json
{
  "shots": {
    "<shotId>": {
      "trackId": "V1",
      "startFrame": 0,
      "endFrame": 60,
      "cameraObjPath": "/Camera.1",
      "pills": [
        { "id": "...", "type": "targeting", "startFrame": 0, "endFrame": 60, ... },
        { "id": "...", "type": "movement", "startFrame": 10, "endFrame": 50, ... }
      ]
    }
  }
}
```

`save-state` and `load-state` already handle the shot JSON — pills ride along automatically. No new C++ persistence work needed for this plan beyond grandfathered-in.

### Store (Zustand)

Pills get their own slice in the already-split store:

```
web/src/store/
  slices/
    pills.ts    — NEW: pill CRUD + reorder, sub-lane spawn/collapse logic
```

Slice exposes:
- `addPill(shotId, type, libraryEntry)` — creates pill with defaults, picks sub-lane index (next empty or matching-type lane)
- `updatePill(pillId, partial)` — generic edit
- `removePill(pillId)` — auto-collapses sub-lane if it was the last pill of its type
- `movePill(pillId, newStartFrame, newSubLaneIndex)` — drag handler target
- `reorderSubLane(shotId, fromIndex, toIndex)` — drag-reorder sub-lanes

Selectors:
- `selectShotPills(shotId)` — pills sorted by subLaneIndex
- `selectSubLanes(shotId)` — derived `[{ type: 'targeting', pills: [...] }, ...]` in stack order

### UI components

```
web/src/components/
  ShotExpansion.tsx    — NEW: container that renders inside an expanded shot, holds the sub-lane stack
  SubLane.tsx          — NEW: one row, renders all pills of one type for one shot
  Pill.tsx             — NEW: the pill visual (rounded rect, color, label, drag handles)
  PillInspector.tsx    — NEW: right-side inspector shell, switches body by pill type
  PillLibraryPanel.tsx — NEW: left-panel library (Plan 1 ships an empty placeholder; Plan 5 fills it)
```

Existing components that need touching:
- `Clip.tsx` (or whichever component currently renders a shot) — when shot is "expanded," render `<ShotExpansion shotId={...} />` underneath
- `Track.tsx` — when a track contains an expanded shot, allocate the extra vertical height for the expansion (similar to how track height grows for keyframe expansions today)
- `App.tsx` — wire the new left panel + right inspector into the existing grid columns

### Shot expansion / collapse UI

A shot needs a way to expand to show its sub-lanes. Mirrors how Final Cut expands clips for keyframing:
- Click a small triangle on the shot's left edge → shot expands downward
- Expansion shows the sub-lane stack below the shot itself
- Click triangle again → collapses
- Default: shots collapsed until user expands them
- Persistence: expansion state is per-shot, saved with the shot JSON (just an `expanded: bool` flag)

---

## Implementation order (commits)

Each commit must build clean and run. Order is chosen so verification at each step is a real demonstration of progress.

### Commit 1 — `feat(motion-layers): pill data model + Zustand slice`

- Add `web/src/store/slices/pills.ts` with the interfaces, CRUD actions, sub-lane logic
- Wire slice into the store composition
- Add pill JSON to the existing save-state/load-state schema (just round-trip; no new fields the C++ side needs to know about)
- No UI yet

**Verification:** open browser DevTools console, run `useStore.getState().addPill('shotid', 'targeting', {})` — confirm pill appears in state, persists across save/load round-trip.

### Commit 2 — `feat(motion-layers): shot expansion toggle + ShotExpansion shell`

- Add expand/collapse triangle to shot visual
- Render empty `<ShotExpansion />` container when expanded
- Track height grows to accommodate expansion
- Expansion state persists

**Verification:** click the triangle on a shot — shot expands, track grows; click again — collapses, track shrinks. State survives reload.

### Commit 3 — `feat(motion-layers): SubLane + Pill components, render-only`

- `SubLane.tsx` renders pills for one type
- `Pill.tsx` renders one pill (rounded rect, type color, name label)
- `<ShotExpansion />` enumerates `selectSubLanes(shotId)` and renders one `<SubLane />` per non-empty type
- Add a temporary debug button "Add Targeting Pill" to the inspector area for testing — fires `addPill(shotId, 'targeting', ...)`

**Verification:** click debug button on an expanded shot — a green pill appears in the (newly-spawned) Targeting sub-lane. Click again — second pill appears in same lane. Verify pill survives save/load.

### Commit 4 — `feat(motion-layers): pill selection + delete`

- Click pill → selects (selection state in pills slice or shared selection slice)
- Selected pill shows highlight (border + shadow per existing v2 selection visual pattern)
- Delete key removes selected pill
- Removing last pill of a type auto-collapses its sub-lane

**Verification:** click a pill, it highlights; press Delete, it disappears; if it was the last of its type, the sub-lane disappears too.

### Commit 5 — `feat(motion-layers): pill drag (resize + move within sub-lane)`

- Pill edges = trim handles (mirrors existing clip edge behavior)
- Pill body = move handle (drag within sub-lane changes startFrame; drag to different sub-lane changes subLaneIndex)
- Snap behavior matches clips
- Pill cannot extend past shot boundaries (clamped)
- Pill cannot overlap with itself across sub-lanes (just visual stacking — overlap within a sub-lane is allowed because SUM composition is fine)

**Verification:** drag pill edges to trim, drag pill body to move; confirm shot-edge clamping; confirm pill survives save/load with new position.

### Commit 6 — `feat(motion-layers): pill ripple on shot trim`

- When a shot is trimmed shorter, all pills inside scale proportionally
- When a shot is extended longer, pills keep their length and position; user can drag-stretch up to new edge
- Pill timing change is one undo step coupled with the shot trim

**Verification:** drop a pill on a shot, trim the shot shorter — pill shrinks proportionally. Extend the shot — pill stays the same length, edge unchanged.

### Commit 7 — `feat(motion-layers): PillInspector shell with universal section`

- Right-side inspector pane (new grid column or extension of existing inspector slot)
- Visible only when a pill is selected
- Universal section: name (text input), color (swatch — defaults per type, editable), ease in (curve picker), ease out (curve picker), hold-after-end (toggle + frames input), mute (icon toggle), solo (icon toggle)
- Type-specific section: empty placeholder for now ("Targeting parameters coming in Plan 2")
- Multi-select: show "Mixed" in fields with differing values; editing a field commits to all selected

**Verification:** select a pill — inspector shows universal section with the pill's values; edit name → updates in pill; ease curve picker swap reflects in pill state (no visible effect yet since eval doesn't exist). Multi-select two pills with different names → name field shows "Mixed."

### Commit 8 — `feat(motion-layers): PillLibraryPanel shell`

- New left-panel column (or extension of existing left panel)
- Empty placeholder grid — "Library entries coming in Plan 5"
- Just establishes the layout so Plan 5 can drop into it

**Verification:** left panel renders, doesn't break existing layout.

### Commit 9 — `chore(motion-layers): conflict-detection helper (stub)`

- Add a utility `hasCompetingKeyframes(cameraObj, channels, frameRange)` — placeholder that always returns `false` for now
- Wire into pill creation: pill records a `conflictState: 'ok' | 'error'` field, set to `'ok'` always
- Pill renders normally — error visual treatment lands in Plan 2 when the helper is real

**Verification:** stub exists, pill records conflictState, pills always create successfully.

### Commit 10 — `chore(motion-layers): per-action undo wiring`

- Confirm each pill action (add, remove, move, resize, inspector edit) is its own undo step
- Mirrors v2's existing per-action undo pattern
- Helper-BaseObject write happens once per action, with single AddUndo before write (matches the `BaseContainer undo registers AT AddUndo time` memory)

**Verification:** drop pill, edit name, move pill, delete pill — each Cmd-Z reverses exactly one action.

---

## Verification — end-to-end after all 10 commits

1. `cd host/shotblocks/web; npm run build` — clean, no new warnings
2. `npx tsc -b` — clean
3. **Smoke test in C4D** (`scripts/dev-loop.ps1`):
   - Open dev-test.c4d
   - Drop a camera from OM onto V1 — clip appears as today (unchanged)
   - Click the new expansion triangle on the clip — clip expands, empty sub-lane area appears below
   - Click debug "Add Targeting Pill" — green pill appears, fills shot range
   - Click pill — inspector shows universal section
   - Edit pill name — updates
   - Drag pill edges — trims
   - Drag pill to a position outside any sub-lane — spawns new sub-lane (still Targeting type, since debug button only adds Targeting; OK for foundation)
   - Trim shot shorter — pill scales proportionally
   - Save scene, close C4D, reopen scene — pill persists with its name, position, edits
   - Delete pill — disappears; sub-lane collapses if it was the last
   - Cmd-Z several times — undo reverses one action at a time
4. **What is NOT yet working** (and shouldn't be — these are Plan 2+):
   - Playback does not move the camera based on the pill (no evaluation yet)
   - Library panel is empty (Plan 5)
   - Type-specific inspector params don't exist (Plans 2/6/8/9)
   - Pill cannot be created from drag-and-drop (only debug button)
   - Conflict detection doesn't actually detect anything (Plan 2)

---

## Open questions to resolve during implementation

These don't block Plan 1 start, but flag them when they come up:

- **(a) Frame storage relative vs absolute.** Going with absolute; revisit if it makes ripple math awkward.
- **(b) Sub-lane fixed height vs auto.** All sub-lanes same height in v1 (matches design simplicity). Each is roughly half a track height. Revisit if pills get visually cramped.
- **(c) Inspector right-side vs floating.** v2 today has no permanent right inspector. Adding one is a layout shift — may be worth a separate small commit before Commit 7 to allocate the column. Decide when wiring.
- **(d) Pill default duration when added outside a shot context.** Doesn't apply — pills can ONLY be added inside a shot (their `shotId` is required).
- **(e) Should sub-lanes be the same height as a clip's audio waveform area, or smaller?** Likely smaller — they're secondary. Match Final Cut sub-lane density visually.

---

## What this plan explicitly does NOT do

- **No pill evaluation.** Plan 2.
- **No Targeting drag-from-OM creation flow.** Plan 2.
- **No library entries.** Plan 5.
- **No Movement/Lens/Texture pill types beyond their type-tag definitions.** Plans 6/8/9.
- **No recipes.** Plan 5.
- **No multi-target handoff visuals.** Plan 4.
- **No baking to keyframes.** Future plan.
- **No render flow changes.** Future plan.

---

## Hard rules (from CLAUDE.md and memory)

- C4D must be force-killed before deploy (deploy.ps1 chain handles it)
- C4D plugin must be rebuilt (`cmake --build ...`) for any C++ changes — but Plan 1 has zero C++ changes, so JS-only `dev-loop.ps1` is sufficient
- Verify in C4D before committing — no "this should work" commits
- One atomic change per commit; commit must build + run if checked out alone
- Read Python source before guessing on v2 behavior (but Python timeline is dead; the rig tag is in a different layer and not touched by this plan)
- No silent `except: pass` — but no Python changes here either
