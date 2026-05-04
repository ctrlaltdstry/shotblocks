# Task: v0 — Plugin shell smoke test

## Goal
Build the smallest possible Shotblocks plugin that registers and loads in **C4D 2026.2.0 on Windows**, proving the basic plugin shell works before any feature code is written.

## Why
Multiple claims about C4D specifics in the docs have already turned out wrong (tag application path, plugin ID registration, install paths). Those were caught conversationally; the next layer of "I think this works this way" statements will be caught by *running real code in real C4D* or not at all. Before we build any Shotblocks functionality, we need ground truth on the basic registration mechanics. This task is that ground truth.

It also serves as a forcing function: setting up the plugin folder, the `.pyp` entry point, the resource files, and the C4D install to load from a dev directory exposes any environmental issues now rather than during feature work.

## Scope

**In scope:** C4D 2026.2.0 on Windows. One platform, one version.

**Out of scope:** macOS support, older C4D versions, any rig math, any timeline rendering, any audio handling, any procedural behavior. The dialog is empty. The tag does nothing. The command pops a placeholder.

The temptation to fill the empty dialog will be strong. Resist. The point is that it stays empty until the plumbing is verified.

## Approach
1. Create the plugin folder structure under `src/` matching the layout in `c4d-plugin-development.md`:
   - `shotblocks.pyp` entry point
   - `res/description/tshotblocks.res` and `tshotblocks.h` with one or two trivial parameters
   - `res/strings_en-US/description/tshotblocks.str` with English labels
   - `res/icons/tshotblocks.tif` (a placeholder 32x32 RGBA is fine)
2. Implement the absolute minimum:
   - A `TagData` subclass with `Init` that sets parameter defaults and `Execute` that does nothing but return `EXECUTIONRESULT_OK`
   - A `CommandData` subclass that pops up a `MessageDialog` saying "Shotblocks timeline (placeholder)"
   - A `GeDialog` subclass with a single label that says "Shotblocks timeline goes here"
3. Register all three components in `shotblocks.pyp` using the testing-range plugin IDs (1000001-1000003).
4. Set up the dev junction per `dev-environment.md`:
   ```cmd
   mklink /J "%APPDATA%\Maxon\Cinema 4D 2026\plugins\shotblocks" "C:\path\to\shotblocks\src"
   ```
5. Create the canonical test scene at `scenes/dev-test.c4d` with the contents specified in `dev-environment.md`.
6. Run the deploy-and-test loop:
   - Launch C4D 2026.2.0
   - Open `scenes/dev-test.c4d`
   - Verify all of the items in "Done when" below
7. Document any deviation from what the conventions and plugin-development docs predicted. Updates go straight into `c4d-conventions.md` or `c4d-plugin-development.md` so the next person doesn't repeat the same discovery.

## Open questions to resolve during this task

These are currently in `open-questions.md`. Resolve them by direct observation in 2026.2.0 and migrate the answer to the relevant context doc:

- Which top-level menu does the command land in? (Extensions vs Plugins — naming has shifted between versions; verify which holds in 2026.2.0)
- Does the resource file get auto-loaded by naming convention or do we need to register it explicitly?
- What's the actual `EXECUTIONPRIORITY_*` constant name in 2026.2.0? (We've assumed `EXECUTIONPRIORITY_EXPRESSION`; verify the spelling and the value.)
- Does the `.tif` icon load, or is a different format needed?
- Does the plugin folder path differ between the Maxon One subscription install and a standalone install? (The doc currently asserts `%APPDATA%\Maxon\Cinema 4D 2026\plugins\` — confirm.)

## Done when
- [x] Plugin loads cleanly in C4D 2026.2.0 on Windows (no console errors at startup)
- [x] All three components (tag, command, dialog) are reachable through the UI
- [x] Tag applies to a camera without crashing and shows the trivial parameters in the Attribute Manager with proper labels
- [x] Command opens the placeholder dialog without errors
- [x] Dialog renders the single label correctly
- [x] Deploy mechanism works (changed from junction to copy-on-deploy via `scripts/deploy.ps1` — see Notes)
- [x] Canonical test scene exists at `scenes/dev-test.c4d`
- [x] Any discrepancies vs. the docs are written into the relevant context files
- [x] A short "how to install Shotblocks for development" note is added to the project root (`DEVELOPING.md`)
- [x] Open questions above are resolved and migrated out of `open-questions.md`

## Notes (post-completion)

### What we verified (now living in `c4d-api.md` "Verified facts")
- Plugins folder: `%APPDATA%\Maxon\Maxon Cinema 4D 2026_<hash>\plugins\` — the `Maxon ` prefix and the install-specific hash suffix were both wrong in the original docs.
- Python runtime in C4D 2026.2.0: 3.11.4.
- "Open Shotblocks Timeline" command lands under the **Plugins** top-level menu.
- `.tif` icons at 32×32 RGBA load correctly via `c4d.bitmaps.BaseBitmap().InitWith(path)`.
- Resource auto-load by basename: `description="tshotblocks"` resolves `res/description/tshotblocks.{res,h}` and `res/strings_en-US/description/tshotblocks.str`.
- `EXECUTIONPRIORITY_EXPRESSION` exists, value is 3000.
- Tag application path is the standard right-click → Tags → Shotblocks.

### Things that were wrong in the original docs
- **Plugins folder name**: was `Cinema 4D 2026`, actually `Maxon Cinema 4D 2026_<hash>`.
- **Junction-based deployment**: original `mklink /J` recommendation does not load reliably in C4D on this dev box across multiple of the user's C4D plugin projects. Switched to copy-on-deploy via `scripts/deploy.ps1` (robocopy /MIR). Documented in `dev-environment.md` and `pitfalls.md`.
- **Stale `slated`/`tslated` strings** in `c4d-plugin-development.md` from the prior project name. Fixed.

### New finding (was not on the open-questions list)
- `RegisterTagPlugin(description=...)` requires `res/c4d_symbols.h` and `res/strings_en-US/c4d_strings.str` stub files to exist, even when the plugin has no global symbols/strings. Without them, registration fails with `RuntimeError: Could not initialize global resource for the plugin.` Now part of the canonical layout in `c4d-plugin-development.md` and called out in `pitfalls.md`.

### Deferred to subsequent tasks
- The `scenes/dev-test.c4d` exists but its contents have not been validated against the spec in `dev-environment.md` (2-3 cameras with mixed animation, audio file, primitive subject). Future tasks that need specific scene contents should check and extend.
- The .pyp's startup `print()` line is dev-only; strip before any release per `dev-environment.md`'s logging guidance.
