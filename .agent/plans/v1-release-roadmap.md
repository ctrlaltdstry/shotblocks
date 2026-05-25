# v1 Release Roadmap

The work to get Shotblocks to a shippable v1. After this lands, motion-layers becomes the v2 release.

**v1 scope:** the timeline tool, complete and polished. Camera animation via shot sequencing, audio scrubbing, basic editor ergonomics, render workflow, user manual. No procedural camera animation (that's v2).

**Why this comes before motion-layers:** the timeline has accumulated edge cases (orphan handling, scene-load races, render integration gaps) that should be closed before layering a major feature on top. A v1 release also produces a natural "stable foundation" that v2 can build against.

---

## Plan sequence

| # | Plan | Status | Spec | One-liner |
|---|---|---|---|---|
| 1 | **Edge cases + orphan handling** | shipped (`1323fa6`..`7607233`) | [v1-plan-1-orphan-and-edge-cases.md](v1-plan-1-orphan-and-edge-cases.md) | Orphan visuals for deleted cameras + audio, relink flows, edge-case audit across scene-load/rename/undo |
| 2 | **Markers + render workflow** | ready to start | [v1-plan-2-markers-and-render.md](v1-plan-2-markers-and-render.md) | Timeline markers (M hotkey, ruler toggle, persist), render gear popover that adds C4D Render Queue entries per shot |
| 3 | **User manual + docs** | ready to start | [v1-plan-3-user-manual.md](v1-plan-3-user-manual.md) | Bundled HTML manual covering every plugin feature, opens in default browser, written from plugin audit |

Three plans. v1 ships when all three land verified.

---

## Order rationale

**Plan 1 (orphans + edges) first** because it's pure cleanup against the current surface — closing known gaps without adding new concepts. Done before render because render touches data that orphan handling will reshape (a deleted camera's clip needs to behave sanely when render iterates over it).

**Plan 2 (markers + render) second** because both are net-new feature surface. Markers are small and self-contained; render is the bigger piece. Bundled because they share the utility-strip area (markers toggle lives there, render gear lives there).

**Plan 3 (docs) last** because the docs document what shipped — writing them before Plans 1+2 means rewriting them after. Also gives a natural reason to do a full feature audit at the end (what does the plugin actually do today? — answering that = the manual).

---

## What v1 is NOT

- **No motion layers / pills / sub-lanes** — v2.
- **No procedural camera animation beyond the rig tag** — v2.
- **No per-shot inspector** — by your call. Render config is the only "inspector-shaped" thing v1 ships, and it lives in a popover.
- **No color tagging of shots** — deferred. Easy add later if useful.
- **No shot list export** — deferred.
- **No public release mechanism** — v1 means "feature-complete and stable." Distribution is a separate concern.

---

## Cross-plan decisions already locked in

(So they don't drift as plans get drafted.)

- **Orphan camera clip = visual treatment per Figma** (Mike provides design at implementation). Selectable, persists, playback treats it as "no camera" (black or unchanged).
- **Orphan audio = right-click → Relink** → OS file picker.
- **Orphan camera = right-click → Relink to camera** → list of doc cameras to pick.
- **Camera rename:** clip label re-reads `cameraLink.GetObject().GetName()` per render. BaseLink already survives renames; just confirm the UI is reactive.
- **Two cameras with same name:** non-issue, BaseLink resolves by object identity, not name.
- **Markers:** `M` hotkey drops at playhead. Ruler shows them. Right-click marker → delete. Right-click empty ruler → "Delete all markers." Toggle visibility from utility strip. Persist with scene. No properties — just frame number.
- **Render:** popover in render gear. Two modes: Current shot / All shots. Adds entries to C4D Render Queue — does NOT fire render. User fires from C4D's Queue UI.
- **Render output path:** popover has a base path field, default `<docfolder>/<docname>_<shot>.exr`. Plugin substitutes `<shot>` token per entry; auto-appends `_<shot>` if token missing.
- **Audio:** never rendered. Editor-preview only.
- **In/Out range:** plugin's I/O points don't push to C4D render settings. Render range = the shot's range per queue entry.
- **Renderer:** plugin doesn't touch renderer setting. Whatever the user has in C4D render settings (Redshift, Standard, Octane) is what each queue entry inherits.
- **Docs:** HTML files bundled in plugin folder. Opens in OS default browser. Sidebar nav. Mike's call on visual style at implementation.

---

## After v1 ships

Motion-layers roadmap (`motion-layers-roadmap.md`) becomes the v2 release. Add a note at its top: "Depends on v1 release shipping."

This roadmap goes to "shipped" status; no further plans land here. v1.x maintenance (bugfixes, polish) doesn't need plan files — those are commits straight to main.

---

## Living document

Like the motion-layers roadmap, this is expected to change. If a plan reveals new scope or surfaces blockers, add or rewrite. When a plan is shipped, change Status to "shipped" and link the final commit range.
