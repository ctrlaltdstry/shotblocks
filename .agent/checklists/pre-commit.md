# Pre-Commit Checklist

Before any commit:

- [ ] Code runs without errors on a fresh C4D launch
- [ ] No new warnings in the console
- [ ] No print statements left in production code
- [ ] If touching a hot path: profiled, viewport stays interactive
- [ ] If touching the timeline UI: tested at min and max zoom
- [ ] If touching a tag: tested with multiple instances on the same scene
- [ ] If touching persistence: saved, closed, reopened
- [ ] If touching presets: thumbnail still generates correctly
- [ ] If touching audio: tested with WAV, MP3, and a missing file
- [ ] Pitfalls.md updated if I learned something the hard way
- [ ] Glossary updated if I introduced a new concept
