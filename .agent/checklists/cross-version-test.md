# Cross-version test checklist

**Currently inactive.** Shotblocks targets a single version on a single platform (C4D 2026.2.0 on Windows). There is nothing to cross-version-test against.

This checklist comes back into use when the target expands — first when macOS support is added, then if older C4D versions enter the roadmap (no current plans).

When that happens, the checklist will resemble:

- [ ] Tested on the primary target version
- [ ] Tested on each secondary target version, with any degradation explicitly documented
- [ ] Tested on each supported platform
- [ ] Documents saved on one target open cleanly on others
- [ ] Plugin loads cleanly on every target's matching plugin folder

Until macOS support work begins, this file stays as a stub.
