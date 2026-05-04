# Developing Shotblocks

How to install Shotblocks for development on this machine.

## Target

Cinema 4D 2026.2.0 on Windows. Sole supported target during early development. See `.agent/context/c4d-api.md` for the reasoning.

## One-time setup

Nothing to install — the deploy script uses tools that ship with Windows (`robocopy`, PowerShell). C4D itself is the only prerequisite, and it must already be installed at:

```
%APPDATA%\Maxon\Maxon Cinema 4D 2026_<hash>\
```

Confirm it exists with:

```powershell
Get-ChildItem $env:APPDATA\Maxon | Where-Object Name -like 'Maxon Cinema 4D 2026*'
```

If your install hash differs from the one hardcoded in `scripts/deploy.ps1` (`_1ABCDC12`), update the `$c4dPrefs` line in that script.

## The deploy-and-test loop

Every code change runs through one command:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev-loop.ps1
```

`dev-loop.ps1` deploys, force-kills any running Cinema 4D, and relaunches it with `scenes/dev-test.c4d` open. Then you verify by inspecting the dialog and the console (Extensions → Console).

The kill is **unconditional** by design — save first if you have unsaved work in C4D. This trade lets the iteration loop be a single command instead of a multi-step quit-and-relaunch.

If you only need to deploy without restarting C4D (rare):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1
```

The `-ExecutionPolicy Bypass` flag is needed because the machine's default execution policy blocks unsigned scripts. The bypass applies only to that one invocation; nothing global is changed.

## Why copy and not a junction

We tried `mklink /J` for a zero-copy dev workflow. C4D's plugin loader does not load reliably from directory junctions on this dev box. Junctions are filesystem-level reparse points (not `.lnk` shortcuts) and most apps treat them as regular folders, but C4D apparently does not. The copy-on-deploy script is the canonical workflow. If you are tempted to reintroduce the junction approach, verify it actually loads in your specific C4D version first — and if it works, please update the docs.

## What's deployed

Everything under `src/`:

- `shotblocks.pyp` — plugin entry point
- `res/description/tshotblocks.{h,res}` — tag parameter description
- `res/strings_en-US/description/tshotblocks.str` — English labels
- `res/icons/tshotblocks.tif` — tag icon

`robocopy /MIR` mirrors, so renames and deletes in `src/` propagate (orphaned files in the plugins folder get removed).

## Project context

Anything about the *what* and *why* of this plugin lives in `.agent/`. Start with `.agent/router.md`.
