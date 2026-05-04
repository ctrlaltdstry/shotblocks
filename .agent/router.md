# Router

The entry point for any agent working on this project. Read this first, then read what it points you to.

## Always read first

1. `.agent/constitution.md` — the non-negotiable principles
2. `.agent/context/glossary.md` — vocabulary

## When you don't know what's been decided

`.agent/open-questions.md` — explicit list of decisions we've deferred. Check here before assuming something has been settled.

## When you're starting development work

`.agent/context/dev-environment.md` — how to install, run, debug, iterate.

## When licensing affects your choice

`.agent/licensing.md` — current state of the licensing decision and what depends on it (notably the audio decoder choice).

## When committing, branching, or moving the repo to GitHub

`.agent/context/version-control.md` — branching style (trunk-based on `main`), commit cadence (one per milestone), commit-message format, GitHub move plan, what not to commit.

## When designing or implementing UI

1. `.agent/design/principles.md` — the "why" behind visual choices. Non-negotiable.
2. `.agent/design/visual-language.md` — concrete tokens (colors, spacing, type) for the surfaces Shotblocks controls.
3. `.agent/context/c4d-conventions.md` — for surfaces C4D's host owns; we follow rather than lead.
4. `.agent/context/ui-conventions.md` — drag-primary affordances, optional hotkeys.

The design files govern what Shotblocks *looks like*; the convention files govern what Shotblocks *feels like to operate*. Both need to be considered for any UI work.

## Then, by task type

### "Anything that touches Cinema 4D specifically"

Three files cover different aspects of C4D — pick based on what you're doing:

1. **Designing a feature that interacts with C4D's UI** → `.agent/context/c4d-conventions.md` (what C4D users expect: tag application paths, Object Manager norms, Attribute Manager behavior, undo expectations, etc.)
2. **Writing plugin code** → `.agent/context/c4d-plugin-development.md` (plugin types, lifecycle methods, threading model, resource files, registration)
3. **Resolving a version-specific question** → `.agent/context/c4d-api.md` (Shotblocks's targeting decisions, where we deviate, known version issues)

Read at least the conventions file before designing anything that touches the user's existing C4D workflow. The earlier in design the C4D constraints are surfaced, the less rework later.

### "Add a new preset shot"
1. `.agent/context/domain.md` — confirm the shot type is defined
2. `.agent/context/architecture.md` — section on presets
3. `.agent/workflows/new-preset.md`
4. `.agent/skills/` — any relevant math skill (e.g., dolly-zoom-math.md)
5. `.agent/checklists/new-preset-quality.md` before committing

### "Work on the slate engine or motion-energy module"
1. `.agent/constitution.md` — principle 10 on slate, principle 5 on direct manipulation
2. `.agent/skills/slate-engine.md`
3. `.agent/skills/motion-energy.md`
4. `.agent/context/domain.md` — cut-on-action and motion-energy sections
5. `.agent/context/architecture.md` — slate engine section

### "Add or change a rig behavior" (spring-damper, autofocus, noise, framing, look-at)
1. `.agent/context/domain.md` — relevant math section
2. `.agent/context/architecture.md` — Shotblocks tag section
3. `.agent/context/c4d-plugin-development.md` — TagData lifecycle, threading
4. `.agent/context/pitfalls.md` — performance and threading constraints
5. `.agent/workflows/new-rig-feature.md`

### "Change the timeline UI"
1. `.agent/design/principles.md` — the why
2. `.agent/design/visual-language.md` — the tokens
3. `.agent/context/architecture.md` — UI layer
4. `.agent/context/ui-conventions.md` — affordances and hotkeys
5. `.agent/context/c4d-conventions.md` — drag-and-drop conventions, hotkey expectations
6. `.agent/context/c4d-plugin-development.md` — GeDialog and GeUserArea specifics
7. `.agent/workflows/timeline-change.md`

### "Audio subsystem work"
1. `.agent/context/audio.md`
2. `.agent/context/architecture.md` — audio subsystem section
3. `.agent/skills/onset-detection.md` if relevant
4. `.agent/context/c4d-plugin-development.md` — threading model (audio runs on worker threads)

### "Bug fix"
1. `.agent/workflows/bugfix.md`
2. `.agent/context/pitfalls.md` — has it been seen before?
3. Reproduce in a test scene under `scenes/` before fixing

### "Cross-version compatibility issue"
1. `.agent/context/c4d-api.md` — Shotblocks version targeting and known issues
2. `.agent/context/c4d-plugin-development.md` — cross-version section
3. `.agent/workflows/version-compat-check.md`
4. Constitution: modern API wins, older version degrades gracefully

### "Release prep"
1. `.agent/checklists/pre-release.md`
2. `.agent/workflows/release.md`
3. Constitution quality bars — must all pass

### "User asks for a feature"
1. Constitution — does this fit the timeline metaphor? Does it stay in scope?
2. If no: explain why, suggest the in-scope adjacent thing
3. If yes: which workflow above applies?

## Review lenses (when reviewing work)

Pick the one that fits the change:
- Cinematography work → `.agent/team/cinematographer.md`
- Motion graphics / sim work → `.agent/team/motion-designer.md`
- Plugin idiom / API use → `.agent/team/c4d-veteran.md`
- Audio sync / DSP → `.agent/team/audio-engineer.md`
- Stress / edge cases → `.agent/team/qa-tester.md`

## Modes

Check `.agent/modes/` for the current mode. It changes how aggressive changes can be:
- **exploration** — prototyping, breaking APIs is fine
- **stabilization** — no new features, polish only
- **release** — only critical fixes, extra review

## When you cannot resolve a question from these documents

Ask the user. Then write the answer back into the appropriate file so the next session can resolve it without asking.
