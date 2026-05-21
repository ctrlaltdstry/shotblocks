# Shotblocks: conversation handoff

This document captures the design conversation that produced the Shotblocks project's operating context (everything in `.agent/`). It's meant for a fresh AI assistant session (Cursor, Claude Code, or otherwise) to pick up where the original conversation left off without re-discovering the same ground.

The `.agent/` folder is the authoritative source for decisions and architecture. This document adds:
- The reasoning behind decisions (the *why*, not just the *what*)
- Open threads that were mid-discussion when the conversation paused
- Patterns and gotchas the original conversation surfaced repeatedly

If anything here conflicts with `.agent/`, the `.agent/` docs win — they were updated as decisions settled, and this document is a snapshot.

---

## Project at a glance

**Product:** Shotblocks — a Cinema 4D plugin for camera animation.

**Core mental model:** A timeline-based shot sequencer. Users drag cameras from C4D's Object Manager onto the Shotblocks timeline to create shots. Each shot is a reference to a camera observed over a frame range. Users optionally apply a Shotblocks tag to a camera to unlock procedural rig behaviors (spring-damper, autofocus, noise, framing rules, presets).

**The signature verb is "slate"** — non-destructive alignment of shots to audio beats using motion-energy peaks. The product is named after **"blocking"** (the film-craft term for iteratively figuring out where shots land); slate is a punctuated action within that broader activity.

**Sole target for v0:** Cinema 4D 2026.2.0 on Windows. No macOS, no older versions. macOS comes after v0 ships. Older C4D versions are not on the roadmap.

**The active task is v0:** the smallest possible plugin shell that registers and loads, to validate plumbing assumptions before any feature work begins. See `.agent/tasks/active/v0-plugin-shell.md`.

---

## Reading order for a fresh session

1. `.agent/router.md` — the routing entry point
2. `.agent/constitution.md` — the 11 non-negotiable principles
3. `.agent/context/glossary.md` — vocabulary
4. `.agent/tasks/current-task.md` → `.agent/tasks/active/v0-plugin-shell.md` — what's in flight
5. `.agent/context/architecture.md` — system shape
6. `.agent/context/dev-environment.md` — how to actually run and test the plugin
7. This document, for the conversational context that doesn't fit in the docs

---

## Key architectural decisions and their reasoning

### Cameras are user-owned; Shotblocks directs them

Earlier drafts had Shotblocks generating cameras as a custom `ObjectData` plugin. We flipped this. Users create cameras in C4D's Object Manager the standard way; Shotblocks references them on its timeline. The Shotblocks tag is opt-in — apply it to a camera to unlock procedural behaviors; without it, the camera plays back its own animation as a shot. This means Shotblocks scales from "sequence cameras I already animated" to "full procedural authoring," with the user picking where they live on that spectrum.

### The Shotblocks tag has two modes

**Additive mode** (default for animated cameras): the user's keyframes are baseline; the procedural pipeline produces *deltas* added on top. The user's animation is never modified. Disabling the tag immediately reveals the original undisturbed.

**Replace mode** (default for unanimated cameras, or opt-in): the procedural pipeline drives the camera entirely; user keyframes are ignored.

Mode is per-tag, per-camera. All shots referencing a given camera see the same mode. Switching modes prompts the user when it would override their animation.

### Hard cuts only — but composition is fine

The constitutional principle "hard cuts only — transitions live in the NLE" applies to **boundaries between shots**, not to what happens inside a single shot. This distinction came up in the last open thread (see below). A single shot can have complex internal behavior; the cut to the next shot is a hard cut.

### Drag is primary; hotkeys are optional accelerators

The full plugin must be operable with the mouse alone. Hotkeys (S for slate, I/O for play range, B for bake, etc.) exist as accelerators but are never the only path to any operation. This was a deliberate correction from an earlier draft that put hotkeys at the center.

### Color encodes Shotblocks state, not arbitrary categories

In NLEs, clip color encodes layer type (footage vs precomp vs adjustment). Shotblocks doesn't have those types. Shotblocks uses color to encode *state*: replace-mode tagged camera (saturated blue), additive-mode tagged camera (muted teal-green), untagged passthrough (neutral gray), orphaned (desaturated dark red, dashed border). This is the most useful axis to read at a glance.

### The verb stays "slate" even though the product is "Shotblocks"

"Slate" is the punctuated commit-action; "Shotblocks" / "blocking out" is the broader activity. They're related but distinct, and the verb stays slate because:
- Slating is the signature single-shot interaction that distinguishes Shotblocks from any other camera-animation tool
- The metaphor (slating commits a take) is precise and meaningful
- "Block" doesn't work as a verb in the right register ("I'll block this shot" sounds like collision, not commitment)

---

## Patterns that repeated and matter

### "I'm confident about this C4D specific" has been wrong four times

Across the original conversation, confident statements about C4D specifics turned out to be wrong:

1. **Drag-to-apply tags** — I claimed users drag tags onto objects; actually tags are applied via right-click → Tags menu, or the Tags menu in the menu bar. Dragging is for moving existing tags between objects.

2. **Plugin Cafe ID registration** — I claimed it was a heavy gating step requiring registration and approval. Actually, the testing range (1000001-1000010) works for development without registration, and the legacy Plugin Cafe ID generator still exists at the old URL for real IDs before public release. The process is lighter than I'd said.

3. **Plugin install path** — I claimed plugins could live in `Plugins/` inside the install directory. Actually that's been deprecated since R20; plugins live in user prefs (`%APPDATA%\Maxon\Cinema 4D 2026\plugins\` on Windows).

4. **C4D version naming** — I doubted "C4D 2026.2.0" was a real version. It is — Maxon shifted to year-leading numbering in fall 2025.

**The takeaway:** any specific claim about C4D's API surface, conventions, paths, or versions should be verified against real C4D 2026.2.0 before being relied on. The v0 task exists specifically to convert assumptions into observations. When the deploy-and-test loop reveals a stale claim in the docs, *update the docs in place*. The relevant context files (`c4d-conventions.md`, `c4d-plugin-development.md`, `c4d-api.md`, `dev-environment.md`) have "verify against current SDK" caveats at the top for this reason.

### Decisions evolved, sometimes multiple times

The project went through these renames before settling:
- camera-rig-plugin (working name)
- Smash Cut (briefly considered)
- Slated (settled on, full design built around it)
- Shotblocks (final, after recognizing the double meaning of "blocking" + "block on timeline")

The verb "slate" survived all renames because it captures a precise meaning. The product name moved to better describe the *activity* users spend time on (blocking out shots) rather than the punctuated single-action (slating).

The version target narrowed from "C4D 2024+ with R23 fallback" to "C4D 2026.2.0 on Windows only" as we recognized that single-target scoping accelerates iteration and forces honest verification.

### The author's working style is detour-friendly

The original developer (you) takes detours, sometimes follows interesting threads instead of sticking to a plan, and produces work that way. The project does **not** have a rigid roadmap. The constitution holds the north star; the active task holds what's in flight; detours are explicit and conscious. There's no `product.md` with a milestone Gantt chart, and that's deliberate.

What this means for the next session: don't push a sequenced roadmap onto the developer. If they want to detour into design work, audio prototyping, or preset exploration before finishing the current task, that's valid as long as the existing task gets paused consciously rather than abandoned.

---

## Open threads not yet resolved

### The big one: layered preset composition (mid-discussion when we paused)

We were discussing whether multiple presets can be applied to a single shot. The conversation landed at: **yes, presets can be layered within a single shot, each with its own sub-range and intensity envelope**. This stays consistent with hard-cuts-only (which is about shot boundaries, not shot interiors).

The mental model: a shot is a small composition. Inside, multiple preset layers can be active simultaneously, with sub-timeline editing for their start/end points. Where layers overlap in time, their effects sum (additive composition). Some presets are inherently additive (translations, rotations, noise); others are replacement (look-at, framing rules) and only one of each replacement type can be active at a time.

**Architectural implications:**
- Each preset must be designed as a *delta function over time* rather than an absolute camera path
- Shots persist a list of layered preset instances, each with sub-range and envelope
- The inspector for a selected shot needs a sub-timeline view for editing layers
- Bake-down evaluates the layered composition per frame
- Slate aligns the shot as a unit; doesn't reshuffle layers within

**The question we didn't resolve:** is this a v1 feature or v2?

My recommendation was deferring to v2 — ship v1 with one-preset-per-shot plus a few hand-composed compound presets (crane move, subject-orbit-with-rise), validate the system works, then add user composition in v2 as a headline feature. The case against deferring: layered composition might be the thing that makes Shotblocks distinctive enough to ship.

**The next session should pick up here.** Before doing v0 code, it's worth deciding whether v1 includes layered composition or not — because if it does, several preset designs need to be authored as delta functions rather than absolute paths, and the shot data model needs to carry layer state from the start. Easier to design with this in mind than retrofit.

### Smaller open threads

Listed in `.agent/open-questions.md`:
- Resource files (`.res`) vs programmatic descriptions for the tag's Attribute Manager UI
- Persistence approach (scene hook vs hidden helper object vs document attachment)
- Audio decoder choice (depends on licensing decision in `.agent/licensing.md`)
- Tag execution priority constant name in 2026.2.0 (assumed `EXECUTIONPRIORITY_EXPRESSION` — verify)
- Plugin menu placement (Extensions vs Plugins as the top-level menu)
- Default operator personality (no default picked yet)
- Default motion-energy action weights (currently 0.3/0.5/0.2 favoring rotation — validate against real shots)
- Preset library — first 12 to ship in v1 (depends partly on the layered-composition question above)

### MCP server question (deferred)

The user asked whether to install a C4D MCP server (e.g., ttiimmaacc/cinema4d-mcp) so the AI can directly observe C4D state during testing. My recommendation was **defer until after v0**:

- v0 is specifically about verifying our assumptions about C4D plugin mechanics; adding another plugin in the loop would make it harder to disambiguate "our plugin broke" from "the MCP plugin conflicts"
- The existing C4D MCPs are designed for prompt-driven scene creation, not plugin development debugging
- Setup cost > savings during v0
- Post-v0 (during feature work), the MCP becomes genuinely useful because the iteration loop is about Python logic rather than plugin plumbing

This wasn't filed in `open-questions.md` yet — should be, when the v0 task is done. The next session should remember to revisit MCP integration before starting v1 feature work.

---

## Brainstorm: preset library candidates (not yet committed)

Late in the conversation we brainstormed ~25 preset ideas across six categories. None are committed to the v1 shipping list yet — that decision waits on the layered-composition question. The full list:

**Linear translations:** Push in, Pull out, Dolly (lateral), Boom up/down, Truck through

**Rotations:** Pan, Tilt, Whip pan, Roll

**Compound moves:** Orbit, Arc, Dolly-zoom (Vertigo), Parallax slide, Crane move

**Subject-driven:** Track and follow, Reveal, Push to face, Subject orbit with rise

**Motion-graphics-specific:** Rack-zoom, Snap-to, Stutter, Float

**Handheld / operator-driven:** Handheld idle, Walk-with, Search

The motion-graphics-specific category (rack-zoom, snap-to, stutter, float) is the most Shotblocks-distinctive — these are the presets that lean into the motion-designer audience and would lead a demo reel.

The proposed v1 shipping list (if layered composition is deferred to v2): orbit, push in, pull out, dolly, dolly-zoom, handheld idle, snap-to, float. Eight presets covering five categories.

If layered composition is in v1, presets need to be authored as delta functions, and the shipping list shifts to atomic primitives (push, pan, tilt, boom, orbit-rotation) plus a few demo compounds (crane move, subject-orbit-with-rise) pre-composed from the primitives to demonstrate the system.

---

## Things the next session should NOT do

These come up as tempting but were considered and rejected in the original conversation:

- **Don't add user personas, competitive analysis, marketing copy, pricing strategy, or success metrics docs.** Premature for a project this size; bureaucratic noise.
- **Don't build a sequenced roadmap document.** The developer is detour-friendly; a roadmap creates false commitment and reduces enjoyment of the work.
- **Don't write speculative cross-platform compatibility code.** Windows + C4D 2026.2.0 only until v0 ships.
- **Don't introduce a `c4d_compat.py` module** until there's a second version to be compatible with.
- **Don't merge the Shotblocks timeline with C4D's native Timeline window.** They serve different purposes (native = F-curve editor per parameter; ours = shot sequencer).
- **Don't integrate Shotblocks with C4D's Take System.** Takes are scene-level; our alt takes are shot-level. The vocabulary collision is unfortunate but the semantics genuinely differ.
- **Don't reproduce frame thumbnails inside shot blocks like FCP does.** Our shots aren't recorded media; pretend frames would be misleading. Shot blocks show metadata (camera name, preset icon), not pretend content.
- **Don't try to "fix" the C4D restart cost during iteration.** Use the Script Manager for fragments; restart for real changes. The deploy-and-test loop is the canonical path.

---

## Things the next session SHOULD do

- **Verify any C4D specific claim against real C4D 2026.2.0 before relying on it.** Don't trust the docs blindly — they have caveats at the top for a reason. The pattern has repeated.
- **Update the relevant `.agent/` docs in place when the deploy-and-test loop reveals stale assumptions.** Continuous correction is what keeps the doc set trustworthy.
- **Resolve the layered-composition question early.** It affects preset authoring and shot data model. Don't write preset code without knowing the answer.
- **Pick up the v0 task** (`.agent/tasks/active/v0-plugin-shell.md`) when ready to code. The "Done when" checklist is concrete.
- **Resolve open questions by direct observation in C4D 2026.2.0** during v0 and migrate the answers out of `open-questions.md` into the relevant context docs.
- **Maintain the constitution's voice.** Direct, sentence case, verb-led for actions. No emoji, no celebration, no "✨ amazing!" — this is a pro tool, not a hype product.

---

## Working with the developer

A few things worth knowing about how the developer (the human you'll be working with) operates:

- Detours are normal and often good. Don't push a rigid plan.
- They appreciate honest pushback when something seems off. Don't reflexively agree.
- They value clarity over comprehensiveness. A short useful answer beats a long thorough one.
- They've corrected confident-but-wrong claims about C4D several times. Be willing to say "I'm not sure — let me verify" rather than improvising plausible-sounding C4D facts.
- They make naming and scoping decisions iteratively. The current state (Shotblocks, 2026.2.0 Windows, v0 first) emerged from a series of refinements. Future decisions will likely do the same.

---

## Final note

The architecture is good. The docs are reasonable. The next step is real code, and real code will surface things the docs got wrong. That's the point. Don't be precious about the docs — they're scaffolding, not scripture. The deploy-and-test loop will tell us what's actually true, and the docs should evolve to match.

When in doubt: read the constitution. When still in doubt: ask the developer.
