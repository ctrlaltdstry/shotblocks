# v5 — Orphan-shot handling

When a camera referenced by a shot is deleted, the shot becomes an *orphan*: its
visual state changes to communicate "broken" without alarm, and the user can
resolve it three ways (remove, relink, or undo).

## Scope (what v5 ships)

1. **Orphan detection** — predicate `_is_orphan(shot, doc)` returning True when
   the shot's persisted BaseLink is dead and no fallback resolves to a real
   camera object.
2. **Orphan visuals** — body fill `#3a2a2a`, dashed `4 2` border `#7a4a4a`,
   label `#a08080` prefixed with `(missing) `. Tokens land in
   `sb_canvas.py` next to the existing `COL_SHOT_*` family.
3. **Sweep on `EVMSG_CHANGE`** — every `EVMSG_CHANGE` the dialog already
   redraws. We piggy-back: count orphans on each redraw and `print()` a status
   line whenever the count *transitions upward* (e.g. "[Shotblocks] camera
   deleted; 2 shot(s) now orphaned. Cmd+Z to restore."). One log per
   transition, not per redraw.
4. **Drag-relink (any shot)** — drag a camera onto an *existing* shot block
   (orphan or not) re-links that shot's camera and refreshes its label. In/out
   range, track, and id are preserved. Drag onto empty space still creates a
   new shot.
5. **Context menu** — the existing `Delete` entry already covers
   "remove the orphan." We rename it to `Remove` when the right-clicked shot
   is orphaned to match the architecture's verb.
6. **Persistence across save/load** — already works: BaseLink returns None
   when its target is gone, and the persisted `cam_name` string survives in
   the helper-null JSON. v5 only verifies this and records the result.

## Out of scope (deferred)

- **Hard deletion intercept / confirmation dialog** — C4D 2026 Python doesn't
  expose a deletion veto path. `SceneHookData` is unavailable; `MessageData`
  is post-hoc. The architecture spec is being relaxed to "Shotblocks detects
  and surfaces deletion" — see architecture.md edit.
- **Viewport placeholder frame** — no playback engine yet. Revisit when
  v5+ playback lands.
- **Status-line widget** — the dialog has no status bar yet. v5 prints to
  the C4D console. A real status bar joins the post-v5 visual-polish pass.
- **Rig-state migration on relink** — there is no per-shot rig state in v5
  (open-questions.md:31 — resolved as "trivial in v5; revisit when rig state
  exists"). Relink today just swaps the camera reference.

## Implementation outline

### `sb_canvas.py`

- Add tokens: `COL_SHOT_FILL_ORPHAN`, `COL_SHOT_BORDER_ORPHAN`,
  `COL_SHOT_LABEL_ORPHAN`, plus a `DASH_ORPHAN_ON`/`DASH_ORPHAN_OFF` pair.
- `_is_orphan(shot, doc)` — wraps `_get_shot_cam(doc, shot["id"])`.
- `_resolve_cam_name` — drop the walk-by-name fallback so a deleted camera
  *stays* deleted instead of being re-bound by name to a same-named survivor.
  Keep returning the persisted `cam_name` so the orphan label has something
  to show.
- `_draw_shot_block` — orphan branch chooses orphan palette, draws dashed top
  and bottom borders via a `_draw_dashed_hline` helper, prefixes label with
  `(missing) `. Selection still wins on body fill (Maxon blue) — selected
  orphan reads as "this is the broken one I'm acting on."
- `_orphan_count(shots, doc)` + cached `_last_orphan_count` instance attr.
  Compared in `DrawMsg`; on increase, print the transition log once.
- `_on_drag_receive` — when `BFM_DRAG_FINISHED` and the drop position hits an
  existing shot (`_hit_test` returns body or band), call new
  `_relink_shot(shot_id, cameras[0])` and skip `_create_shots_at`.
- `_relink_shot(shot_id, cam)` — wraps `_remember_cam` + `cam_name` rewrite
  in undo, refreshes the canvas. Emits a `print` log.
- `_open_context_menu` — when `_is_orphan` is true for the clicked shot,
  rename `Delete` to `Remove` (label only — same menu id).

### `shotblocks.pyp`

- No changes for v5. The dialog already pumps `EVMSG_CHANGE` into
  `canvas.Redraw()`, which is where the orphan sweep runs.

### `sb_persistence.py`

- No schema changes. The existing `cam_name` string and BaseLink survive
  save/load already; v5 just *uses* both signals.

## Manual test plan

1. Create three shots from three different cameras.
2. Delete one camera in the Object Manager.
   - Console prints "camera deleted; 1 shot(s) now orphaned."
   - The matching block flips to dark-red dashed visual + `(missing) name`.
   - Other shots unchanged.
3. Right-click the orphan → menu shows `Remove` (not `Delete`). Click it →
   shot vanishes, no orphan logs on the next redraw.
4. Re-create another orphan. Drag a *different* camera from the OM onto
   the orphan block. Block heals: new label, normal palette, range/track
   preserved, id preserved.
5. Re-create another orphan. Press Cmd+Z. The deleted camera comes back;
   block returns to normal.
6. Save, close, reopen — orphans (any remaining) persist visually with
   the same label.
7. Drag a camera onto a *healthy* shot block. That block adopts the new
   camera (and renames). Drop on empty space still creates a new shot.

## Architecture notes

- `architecture.md` lines 110–125 are edited from "intercepts the deletion
  attempt" → "detects and surfaces deletion." The three resolution paths
  (remove, relink, undo) stay; the confirmation dialog leaves the spec.
- `open-questions.md` line 31 is closed: rig-state compatibility on relink
  is trivial in v5 (no rig state). When per-shot rig state lands in a
  future version, re-open the question with the actual schema in hand.

## Definition of done

- All seven manual tests pass on C4D 2026.2.0 / Windows.
- `architecture.md` and `open-questions.md` reflect the new reality.
- `current-task.md` advanced to "v5 complete; pick v6."
