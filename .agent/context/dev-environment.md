# Development environment and workflow

How to run, debug, and iterate on Shotblocks locally. Shotblocks-specific dev workflow — for general C4D plugin development practices, see `c4d-plugin-development.md`.

## Target

**C4D 2026.2.0 on Windows. Nothing else, for now.** Single platform, single version. macOS and older C4D versions are out of scope for v0. See `c4d-api.md` for the reasoning.

This narrowing simplifies the dev loop considerably: one OS, one C4D install, one set of paths. No conditional compatibility code. No matrix testing. If something works on the dev machine, it works.

## Local install

C4D 2026 on Windows loads plugins from the user-prefs plugin directory. The verified path on the dev machine is:

```
%APPDATA%\Maxon\Maxon Cinema 4D 2026_1ABCDC12\plugins\
```

Two things to note vs. what you might guess:
- The folder name is **`Maxon Cinema 4D 2026_<hash>`** — has a `Maxon ` prefix *and* a build-hash suffix. Plain `Cinema 4D 2026` is wrong.
- The hash segment (`_1ABCDC12` here) is install-specific. A C4D update can reissue it. If the deploy script breaks after an update, that's the first thing to check.

**Deployment is by copy, not junction.** We tried `mklink /J` originally; C4D's plugin loader does not reliably load plugins through directory junctions on this machine. Junctions are not the same as `.lnk` shortcuts (they're filesystem-level reparse points), but C4D treats them in a way that prevents reliable plugin discovery. Empirically confirmed across multiple Maxon prior plugin projects on this dev box. Don't reintroduce the junction approach without verifying it works in the exact target version first.

The canonical deploy path is `scripts/deploy.ps1`, which mirrors `src/` into the plugins folder via `robocopy /MIR`. Run it before each C4D restart:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1
```

(`-ExecutionPolicy Bypass` is needed because the machine's default execution policy blocks unsigned scripts. The bypass applies only to that invocation; we don't change the machine-wide policy.)

C4D needs a full restart to pick up code changes — there is no reliable hot-reload for plugins.

## The deploy-and-test loop

**This is the canonical iteration cycle.** Every code change runs through it. Single command:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev-loop.ps1
```

`scripts/dev-loop.ps1` does three things in order:
1. Mirrors `src/` into the C4D plugins folder (`scripts/deploy.ps1` under the hood).
2. Force-kills any running Cinema 4D process.
3. Relaunches Cinema 4D with `scenes/dev-test.c4d` open.

The force-kill is unconditional and intentional — the assumption is that you don't have unsaved work in C4D mid-iteration, and the value of one-command iteration outweighs the safety prompt. If you do have unsaved work, save before invoking.

Once C4D is up:
4. Run the test steps relevant to the change.
5. Check the C4D console (Extensions → Console) for warnings or errors. The `[Shotblocks] loaded ...` line confirms the plugin loaded.
6. Note any issues: file as tasks if actionable, add to `pitfalls.md` if recurring, update the relevant context doc if the issue reveals a stale assumption.

The canonical test scene is the *fixed reference point* for development. It contains a small representative set of cameras and audio so the same change can be tested the same way each time. Drift in what gets tested means drift in what we know works; pinning the test scene prevents that.

When a feature requires testing scenarios that the canonical scene doesn't cover, add a new scene to `scenes/` (e.g., `scenes/dev-stress-100-shots.c4d`, `scenes/dev-no-audio.c4d`) — don't bloat the canonical one.

## What goes in the canonical test scene

`scenes/dev-test.c4d` should contain:
- Two or three cameras at different positions in the scene
- One camera with existing keyframe animation (for additive-mode testing)
- One camera with no animation (for replace-mode testing)
- A simple subject (a primitive at world origin works) for the cameras to look at
- A representative audio file in the document folder, referenced relatively

Concrete contents will be defined during the v0 task as we discover what we actually need. Update this list as the scene evolves.

## Iteration tactics beyond the test loop

The deploy-and-test loop is constrained by C4D's restart cost. To work around that during finer-grained iteration:

- **Script Manager for fragments.** C4D's Script Manager lets you run Python snippets in the live document without reloading the plugin. Use this for testing API calls, exploring the SDK, and prototyping math before moving it into the plugin code.
- **Module-level reloads.** Within a session, the Shotblocks plugin's submodules can sometimes be reloaded via `importlib.reload()` from the Script Manager. This is fragile — class identities don't survive the reload, so any persistent objects using the old class instances misbehave. Useful for one-off debugging, not as a substitute for the deploy-and-test loop.

The deploy-and-test loop is the source of truth. Script Manager experiments are scaffolding — when something works there, it gets moved into the plugin code and verified through the full loop.

## Logging

Use Python's `logging` module. A logger configured at plugin import:

```python
import logging
import os
import c4d

log_path = os.path.join(c4d.storage.GeGetStartupWritePath(), "shotblocks.log")
logging.basicConfig(
    filename=log_path,
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("slated")
```

Per-frame logging (e.g., from `Execute`) should be off by default — log volume in the per-frame path will fill the disk in a long playback session. Gate it behind a debug flag or use `log.debug()` with the level set to INFO.

`print()` statements during development write to C4D's console (Extensions → Console). These should not ship — strip them before any release.

## Debugging

For step-debugging, attach an external debugger to C4D's Python interpreter. Specifics need to be verified against C4D 2026.2.0:

- **PyCharm:** Use `pydevd_pycharm` package, run a debug listener in PyCharm, call `pydevd_pycharm.settrace(...)` from C4D's Script Manager or from plugin code.
- **VS Code:** Similar with `debugpy`.

Specific setup details belong here once we've actually done it. *(Populate during v0.)*

For non-step debugging:
- Console output via `print()` or `log.info()`
- Inspecting object state via the Script Manager's REPL
- The Plugin Manager (Window → Customization → Customize Commands → Plugin Manager) shows what's loaded and any errors at load time

## Doc review

To prevent doc rot as the codebase comes online and reality diverges from assumptions, every release-prep cycle includes a doc review pass — see `workflows/doc-review.md` and the corresponding checkbox in `checklists/pre-release.md`. The review is brief; the goal is to flag stale claims, not to rewrite anything in place.

The deploy-and-test loop should also feed back into docs: when the loop reveals a stale claim, the immediate fix is to update the relevant context doc, not just to make a mental note. Continuous correction in the moment is what keeps the doc set trustworthy.

## Common pitfalls during development

- **Forgot to run deploy.ps1 before restarting C4D.** Old code is what was last copied. Run the deploy script every iteration.
- **Forgot to restart C4D after deploy.** The error message will be confusing because old code is running in the still-open C4D session. Always restart unless you're using the Script Manager for snippets.
- **Resource file edits don't take effect.** C4D caches resources at startup. Restart C4D when changing `.res`, `.h`, or `.str` files (after re-running the deploy script).
- **Plugin works on the dev machine but not on a fresh install.** Often a path assumption — code that hardcodes `os.path.expanduser("~/...")` works for one user, breaks for another. Always use C4D's path helpers (`c4d.storage.GeGetStartupPath()`, etc.).
- **Tag won't apply to camera.** Most often a registration error or a missing icon. Check the console at startup; load errors are reported there.

## The fast-check and full-check scripts

`scripts/fastcheck.sh` runs in under 30 seconds and is what you run before committing. Right now it's a stub; populate it with:
- Python syntax check on `src/`
- Lint pass (ruff or similar)
- Preset JSON schema validation
- Smoke import of `src/plugin_main.py`

`scripts/fullcheck.sh` runs the full eval suite plus the fast checks. Used before release.

Both are populated as the relevant validation tools come online.
