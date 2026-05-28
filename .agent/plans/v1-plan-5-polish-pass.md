# v1 Plan 5 — Polish pass (settings, render UI, tooltips, icons, debug cleanup)

> **Release:** v1 — see [v1-release-roadmap.md](v1-release-roadmap.md)
> **Status:** items 1-5 shipped 2026-05-28 (`30c75b8`, `08112d2`,
> `3db1e0e`, `6a0154f`, `8eb172d`); item 6 dropped (no icon changes
> needed); item 7 deferred to its own design session.
> **Plan owner:** Mike + Claude

A grab-bag of pre-ship polish items, ordered smallest-to-largest so each
ships as its own atomic commit. The camera-rig-tag rework (item 7) is
explicitly deferred to its own design session — listed here only as a
placeholder so it isn't lost.

---

## Item 1 — Default camera type = Redshift (when available)

**Now:** default is Standard Camera (`5103`) in two places:
- `web/src/store/slices/ui.ts:131` — store init `defaultCameraType: 5103`
- `web/src/usePersistence.ts:361` — load fallback `: 5103`

**Want:** default to RS Camera (`1057516`) when Redshift resolves at this
C4D session; fall back to Standard when it doesn't. Redshift ships with
C4D subscriptions now, so it's the common case — but it may not be
*installed*, so the fallback is required (a hard Redshift default would
break Add Camera for users without it).

**Approach:** the available-camera list already comes from C++
(`availableCameraTypes`, populated by walking known plugin IDs and
keeping the ones that resolve — see `SettingsPanel.tsx` + `lib/host.ts`).
The default should be *derived* once that list arrives, not a hard
constant: prefer `1057516` if present in `availableCameraTypes`, else
`5103`. Apply this only when the doc has no persisted choice (a saved
doc keeps the user's pick). Touch the load path in `usePersistence.ts`
and the post-`available-camera-types` resolution; keep `5103` as the
last-resort literal.

**Files:** `web/src/usePersistence.ts`, `web/src/store/slices/ui.ts`,
possibly `SettingsPanel.tsx` (where availableCameraTypes lands).

**Acceptance:** fresh scene on a Redshift machine → Settings shows RS
Camera selected by default; Add Camera makes an RS camera. Fresh scene
without Redshift → Standard selected, Add Camera makes a Standard cam.
Saved doc with an explicit pick → that pick is preserved.

**Risk:** low.

---

## Item 2 — Hide "Add to Queue" + "Settings" in Whole-sequence render mode

**Now:** in `web/src/components/Inspector.tsx` (Render section):
- "Add to Queue" button (line ~132) shows in BOTH modes.
- "Settings" (sync render settings) button (line ~140) is ALREADY gated
  to `renderMode === 'individual-shots'`.

**Want:** in Whole-sequence mode, hide BOTH the Add to Queue and Settings
buttons — the user renders via C4D's Render to Picture Viewer (now that
Plan 4.1 makes native render paths switch cameras). Show both only in
Individual-shots mode.

**Approach:** wrap the Add to Queue button (and the existing Settings
gate) in `renderMode === 'individual-shots' && (...)`. Check the
`.inspector-section__button-row` / `.inspector-section__action` CSS for
empty-state layout (the status line below should still render fine with
no buttons). Note App.css:2124 mentions a single-button case — verify
the zero-button case looks right too.

**Files:** `web/src/components/Inspector.tsx` (+ maybe App.css spacing).

**Acceptance:** switch render mode to Whole sequence → both buttons
disappear; the Render section shows just the mode dropdown. Switch to
Individual shots → both buttons return.

**Risk:** low.

---

## Item 3 — Remove the Dump Stage button + Plan-4.1 debug logging

**Now:**
- "Dump stage" button in `web/src/components/AddCameraButton.tsx:37-39`
  sends `{ kind: 'dump-stage' }`.
- C++ `HandleDumpStage()` (`main.cpp:2297`) + the `dump-stage` dispatch
  (`main.cpp:1720`) + the `dump-stage` outbound type in `lib/host.ts`.
- Verbose `[dump] ...` GePrints inside HandleDumpStage.

**Want:** remove the button and the `[dump]` logging — they were
diagnostics for the render bug, now fixed. Keep the code easy to revive
if needed (the plan-4.1 doc documents the dump format), but delete it
from the shipping build.

**Approach:** delete the button JSX + its handler wire; delete
`HandleDumpStage` + its dispatch line + the `dump-stage` host type.
Leave other `[Shotblocks/v2]` lifecycle GePrints (load confirmation,
HTTP listener) — those are useful and documented in CLAUDE.md as the
verification signal. Only remove the dump-specific noise.

**Files:** `web/src/components/AddCameraButton.tsx`, `web/src/lib/host.ts`,
`host/shotblocks/source/main.cpp`.

**Acceptance:** no Dump stage button in the UI; render still switches
cameras (unrelated to the dump); Console no longer shows `[dump]` lines.
Build clean.

**Risk:** low. Pure removal.

---

## Item 4 — Tooltips + shortcut keys for all tools (incremental)

**Now:**
- Tools live in `web/src/components/ToolPalette.tsx` (TOOLS array).
- Tooltips are native `title=` only, and INCONSISTENT: only Hand `(H)`
  and Zoom `(Z)` show their shortcut; Select/Razor/Slip/Pen don't.
- Shortcuts ARE wired in `web/src/useKeyboard.ts:125-138`:
  V=select, B=razor, S=slip, H=hand, Z=zoom. **Pen has NO shortcut.**
- Other shortcuts exist scattered: N=snap, M=marker, I/O/`/`=range,
  `?`=range-to-selection, spacebar=play, Delete, arrows, Ctrl+Z/Y.

**Want:** consistent, discoverable tooltips showing the tool name + its
shortcut key for every tool; and decide/assign a Pen shortcut. Possibly
a nicer tooltip than native `title` (native is slow + unstyled), but
that's a judgment call — native may be fine for v1.

**Decisions made:**
- **Pen shortcut = `P`** (confirmed 2026-05-28; free in useKeyboard).

**Open sub-decisions (resolve at build time):**
- Native `title` vs a small custom tooltip component. Native is zero-risk
  and ships now; custom is nicer but more work. Lean native for v1
  unless the hover delay feels bad.
- Whether to surface the *other* shortcuts (snap/marker/range/play)
  somewhere discoverable — ties into Plan 5's help/manual item. Maybe a
  "Keyboard shortcuts" section in the eventual user manual rather than
  per-control tooltips.

**Approach (incremental):**
1. Make tool tooltips consistent: `"<Name> (<Key>)"` for all six,
   sourced from a single map so the palette and useKeyboard agree.
2. Assign + wire the Pen shortcut.
3. (Optional) custom tooltip component if native feels bad.

**Files:** `web/src/components/ToolPalette.tsx`, `web/src/useKeyboard.ts`,
possibly a new tooltip component + App.css.

**Acceptance:** every tool's tooltip shows name + key; pressing each key
activates the matching tool; Pen has a working shortcut shown in its
tooltip.

**Risk:** low-medium (custom tooltip would be the only real work).

---

## Item 5 — Shotblocks menu/command icon

**Now:** `RegisterCommandPlugin` (`main.cpp:3516-3521`) passes `nullptr`
for the icon → the Shotblocks menu item has no icon next to it.

**Icon size to provide:** **32×32 PNG with transparency.** C4D auto-
downscales to 24/18px for denser UI contexts. For crisp HiDPI, a 64×64
can also be supplied. Mike to provide the asset.

**Approach:** load the PNG into a `BaseBitmap` (via `AutoBitmap` from a
resource path, or bundle it under the plugin's `res/` and load at
register time) and pass it as the icon arg to `RegisterCommandPlugin`.
Confirm the deploy script ships the icon file (robocopy /MIR covers new
files under the plugin dir, but verify the path).

**Files:** `host/shotblocks/source/main.cpp`, plugin `res/` (new icon
asset), maybe deploy script verification.

**Acceptance:** Extensions menu (or wherever the command lives) shows the
Shotblocks command with its icon.

**Risk:** low — needs the asset from Mike first.

**Blocked on:** Mike provides a 32×32 (and optionally 64×64) PNG.

---

## Item 6 — Update the Shotblocks icon set (UI icons)

**Want:** Mike has updated icons to bring in (separate from item 5's menu
icon). Scope TBD per which icons changed — follow the existing Figma →
SVG → icons.css workflow (see memory `reference_figma_mcp_workflow` and
`feedback_recolor_svgs_via_mask`). Treat as its own commit once Mike
specifies which icons.

**Blocked on:** Mike specifies which icons + provides Figma nodes.

---

## Item 7 — Camera-rig-tag functionality rework (DEFERRED)

**Placeholder only.** Mike wants to re-examine and tweak what the
Shotblocks camera-animation tag does (the Python rig: spring/damper,
quat look-at, fBm noise, autofocus, framing, zoom — `src/sb_rig_*.py`).
This is open-ended and gets its OWN design session — not planned here.
When that session happens, spin up a dedicated plan doc and go through
each behavior with Mike. Reference: `.agent/skills/rig-hierarchy.md`,
`src/sb_rig_tag.py` and siblings.

**Do NOT start this as part of Plan 5.**

---

## Suggested order

1. Item 3 (remove dump button + debug logging) — pure cleanup, fastest.
2. Item 2 (hide render buttons in whole-sequence) — small, self-contained.
3. Item 1 (Redshift default) — small, needs the available-types derive.
4. Item 4 (tooltips + shortcuts) — incremental, medium.
5. Item 5 (menu icon) — when Mike provides the asset.
6. Item 6 (UI icon set) — when Mike provides the icons.
7. Item 7 — separate session, not now.

Each item = one atomic commit (verify in the live app before committing,
per CLAUDE.md). Items 5 + 6 are blocked on assets from Mike.

---

## Living document

When an item ships, mark it and link the commit. When item 7's design
session happens, create its own plan doc and link it here.
