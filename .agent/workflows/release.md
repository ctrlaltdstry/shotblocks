# Workflow: Release

## Pre-release

1. Run `.agent/checklists/pre-release.md` end to end
2. Confirm all constitution quality bars pass
3. Run full eval suite (`scripts/fullcheck.sh`)
4. Test on both primary and secondary version targets
5. Verify all shipped presets have working thumbnails
6. Verify clean install on the current target (C4D 2026.2.0 on Windows for now)

## Build

_(populate when build process exists)_

## Versioning

Semantic versioning. Major bumps for breaking changes to scene file format or preset schema. Minor for new features. Patch for fixes.

## Release notes

Write notes from the user's perspective, not the changelog's. "You can now sync orbit shots to the third beat of every bar" not "Added beat-sync parameter to OrbitPreset class."

## Post-release

1. Tag the release in version control
2. Archive completed tasks under `tasks/archived/<version>/`
3. Switch mode back to `exploration` for the next cycle
