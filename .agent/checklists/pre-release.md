# Pre-Release Checklist

Before tagging a release:

- [ ] All constitution quality bars pass
- [ ] Full eval suite green (`scripts/fullcheck.sh`)
- [ ] Tested on the current target (C4D 2026.2.0 on Windows for v0; expand list as targets are added)
- [ ] Every shipped preset has a working thumbnail
- [ ] Every shipped preset is dragged onto a timeline and produces a usable shot
- [ ] Bake-down produces clean curves on every preset
- [ ] Document save / reopen survives all preset types
- [ ] No crashes on any QA edge case from `team/qa-tester.md`
- [ ] Doc review pass completed per `workflows/doc-review.md`
- [ ] Release notes written from the user's perspective
- [ ] Version number bumped per semver
