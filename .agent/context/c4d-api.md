# C4D API: Shotblocks version targeting and decisions

Shotblocks-specific decisions about which C4D versions we target, where we deviate from C4D conventions, and known version-specific issues we've decided to work around (or accept).

For general C4D plugin development standards, see `c4d-plugin-development.md`.
For C4D user-side conventions and norms, see `c4d-conventions.md`.

## Version target

**Sole target for v0 and early development:** C4D **2026.2.0 on Windows**.

This is a deliberate scope narrowing. Until v0 ships, every other concern — macOS support, older C4D versions, cross-version compatibility shims — is out of scope. We will not write speculative compatibility code for versions we are not testing against. We will not maintain a `c4d_compat.py` until we have at least two versions to compatibly target.

Adding macOS support is the natural second milestone after v0 works on Windows. Older versions (2025, 2024, 2023) are *not on the roadmap* — adding them would require effort against versions we don't actively use, with no clear payoff. If a user on an older version asks, the answer is "upgrade C4D, or stay on a Shotblocks version that supports it" — and that older Shotblocks version doesn't yet exist.

### Why this scoping

Three reasons:
1. **Iteration speed.** Testing one version on one platform is a meaningful fraction of the work of testing the matrix; we'd rather ship something that works perfectly in one place than something that mostly works in many places.
2. **Honest assumptions.** The conversation establishing the architecture made multiple confident statements about C4D specifics that turned out to be wrong. Concentrating on one target lets us replace assumptions with verified behavior faster.
3. **Real users.** The expected user is on the latest Maxon One subscription. Splitting effort to support legacy installs serves a smaller and shrinking audience.

## Plugin components Shotblocks registers

| Component | Plugin type | Purpose |
|---|---|---|
| Shotblocks tag | `TagData` | Applied to cameras; provides rig + procedural pipeline |
| Shotblocks timeline | `GeDialog` | The timeline window |
| Open Shotblocks Timeline | `CommandData` | Menu command to open the dialog |
| Shotblocks scene hook | `MessageData` | Document-level events; persistence of shot list |

The Shotblocks tag is the single user-visible plugin element on the C4D side. Earlier drafts had multiple per-behavior tags (SpringDamperTag, LookAtTag, etc.) — these are now internal subsystems of the single Shotblocks tag. See `architecture.md` for the rationale.

## Where Shotblocks deviates from C4D conventions

These are deliberate choices, not accidents. Each one has a reason; if a contributor wants to "fix" any of them, they should re-read this section first.

- **Shotblocks has its own timeline window separate from C4D's native Timeline.** Reason: the native Timeline is a per-parameter F-curve editor; ours is a shot sequencer. They serve different purposes; merging them would be a category error.
- **Shotblocks does not use the Take System for shot variants.** Reason: Takes are scene-level; our alt takes are shot-level. The vocabulary collision is unfortunate but the semantics are genuinely different.
- **Shotblocks's preset library lives outside the document.** Reason: presets are global assets shared across projects; embedding them in each document would bloat files and prevent sharing.
- **Shotblocks cameras are not generator objects.** Reason: cameras the user already owns work as shots without modification. Forcing users to use a Shotblocks-specific generator object would be hostile.
- **the Shotblocks tag includes the procedural rig hierarchy as children of the camera, not as a sibling structure.** Reason: keeps everything related to a Shotblocks-driven camera in one parent. Removing the tag cleans up everything in one operation.

## Known version-specific issues

_(populate this as we encounter them — any issue that requires version-specific code goes here, with the version, the issue, and our workaround)_

## API patterns we've adopted

Initial set we know we'll use:

- **Plugin IDs.** During prototyping, use the reserved testing range `1000001-1000010`. Before public release, swap in unique IDs from Maxon's identifier generator (currently still at the legacy `plugincafe.maxon.net` — the developer forum migrated to `developers.maxon.net` but ID generation hasn't been ported yet). Hardcode IDs as named constants in `shotblocks.pyp` so the swap is one place.
- **Resource files for tag parameters.** The Shotblocks tag's Attribute Manager UI is described in `res/description/tshotblocks.res` declaratively. Auto-loaded by name when `RegisterTagPlugin(description="tshotblocks", ...)` matches the file's basename. Verified in v0.
- **Custom containers for shot list persistence.** Shot list and timeline state stored as a `BaseContainer` attached to the document via the scene hook.
- **Worker threads for audio decoding, motion-energy computation, thumbnail generation.** Main thread for everything else.
- **Coalesced undo for slate operations.** A single `StartUndo`/`EndUndo` pair wraps the entire slate, so one undo step reverses the whole operation.
- **Tag execution priority: `EXECUTIONPRIORITY_EXPRESSION` (= 3000 in 2026.2.0).** Confirmed present and named exactly that. So the user's keyframes are evaluated before our `Execute` runs; critical for additive mode. Note: this constant is the value passed to `Execute(..., priority, ...)` by C4D when it dispatches per-frame; we don't pass it at registration time — the `TAG_EXPRESSION` info flag at registration is what schedules the tag in the expression pass.

## Verified facts (C4D 2026.2.0 on Windows)

Captured during v0; treat as ground truth for this version.

- **Plugins folder.** `%APPDATA%\Maxon\Maxon Cinema 4D 2026_<hash>\plugins\` — note the `Maxon ` prefix and the install-specific hash suffix.
- **Python runtime.** 3.11.4.
- **Menu placement.** "Open Shotblocks Timeline" command appears under the **Plugins** top-level menu (not Extensions, despite C4D's recent menu reshuffles).
- **Tag application.** Right-click camera → Tags → Shotblocks. Standard C4D path; no surprises.
- **`.tif` icon at 32×32 RGBA loads correctly** via `c4d.bitmaps.BaseBitmap().InitWith(path)`. Renders in the Tags submenu and on the applied tag in the Object Manager.
- **Resource auto-load.** `description="tshotblocks"` resolves to `res/description/tshotblocks.{res,h}` and `res/strings_en-US/description/tshotblocks.str` by basename match. Labels render correctly in the Attribute Manager.
- **Plugin global resource stubs are mandatory.** `res/c4d_symbols.h` and `res/strings_en-US/c4d_strings.str` must exist (can be ~empty) or `RegisterTagPlugin(description=...)` fails with `Could not initialize global resource for the plugin.` See `c4d-plugin-development.md` and `pitfalls.md`.
- **Junctions in plugins folder don't load.** Use copy-on-deploy. See `dev-environment.md`.

## Gotchas we've hit

_(populate as we hit them — these go here, in `pitfalls.md`, or both)_
