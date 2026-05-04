# Version compatibility check

**Currently dormant.** Shotblocks targets a single version (C4D 2026.2.0 on Windows). There is no compatibility surface to check.

This workflow becomes active when the target expands — initially when macOS support is added.

When that happens, the workflow looks roughly like:

1. Identify which API surfaces the change touches.
2. Confirm those surfaces exist and behave the same on every active target.
3. Where they don't, branch in the compatibility shim, not in feature code.
4. Run the deploy-and-test loop on each target.
5. Document any degradation explicitly in `c4d-api.md`.

Until then, this file stays as a stub. Don't add speculative compatibility code.
