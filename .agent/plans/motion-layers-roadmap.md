# Motion Layers — Roadmap (Release v2)

The full sequence of plans that ship the motion-layers feature. Each plan is its own spec document; this is the index.

> **Release positioning:** Motion layers is **Release v2**. It depends on **Release v1** (timeline polish + camera workflow + render workflow + user manual) AND **Release v1.5** (object-visibility clips) shipping first. See [`release-roadmap.md`](release-roadmap.md) for the cross-version index, [`v1-release-roadmap.md`](v1-release-roadmap.md) for the v1 plan sequence, and [`v1.5-release-roadmap.md`](v1.5-release-roadmap.md) for v1.5.
>
> **Do not start any motion-layers plan until v1.5 ships.** Reason: Plan 1 (Foundation) extends the helper-BaseObject persistence and conflict-detection surfaces that v1 Plan 1 (Orphan + edge cases) hardens and v1.5 extends further with object-clip semantics. Building motion layers on an unstable foundation means double-fixing.

**North Star:** the simplest camera-animation tool in Cinema 4D. Direct manipulation on the timeline, named primitives (no parameter dialing), pills as the unit of behavior. Anything trending toward GorillaCam/Signal parameter density is deferred or cut.

**Primary verb:** "where is the camera looking." Targeting ships first because it's the highest-leverage thing the tool does.

## Architectural reference docs (read before any plan)

- `.agent/layer-model.md` — composition math (SUM vs CROSSFADE), pure-function-of-frame model, stateful end-holds, easing
- `.agent/motion-layers-inspector.md` — full parameter spec for all four pill types, design notes
- `.agent/research/camera-animation-prior-art.md` — verified survey of how Cinemachine, Cavalry, GorillaCam, etc. handle this

---

## Plan sequence

| # | Plan | Status | Spec | One-liner |
|---|---|---|---|---|
| 1 | **Foundation** | ready to start | [motion-layers-plan-1-foundation.md](motion-layers-plan-1-foundation.md) | Pill data model, persistence, sub-lane UI, empty inspector shell — no evaluation yet |
| 2 | **Targeting evaluation** | drafted as concept | _not yet written_ | Drag-from-OM creates Targeting pill; per-frame eval makes camera look at target with blend in/out; orphan state when target missing |
| 3 | **Targeting inspector** | drafted as concept | _not yet written_ | Full Targeting parameter surface: Influence, Blend in/out, Aim offset, Camera up mode, Lead amount, Banking on roll — each wired to the evaluator |
| 4 | **Targeting polish** | drafted as concept | _not yet written_ | Multi-target handoff (CROSSFADE between two Targeting pills), Hold after end, Mute/Solo, multi-select "Mixed" labels, per-action undo refinement |
| 5 | **Library + recipes UI** | drafted as concept | _not yet written_ | Left-panel library, pre-built Targeting recipes, save user recipes, recipes persist with scene |
| 6 | **Movement evaluation** | concept | _not yet written_ | 13 named primitives (Push, Pull, Crane Up/Down, Truck L/R, Orbit L/R, Sway L/R, Tilt U/D, Roll CW/CCW); SUM composition; conflict detection vs camera rotation/position keyframes |
| 7 | **Movement inspector + library** | concept | _not yet written_ | Distance, Speed shape, library entries in left panel |
| 8 | **Lens** | concept | _not yet written_ | Focal length / Focus distance / Aperture; CROSSFADE composition; Snap on start for zoom-cuts; conflict detection vs FOV keyframes |
| 9 | **Texture** | concept | _not yet written_ | 5 named styles (Handheld, Vibration, Breathing, Earthquake, Subtle Drift); Amount/Speed/Seed/Envelope/Axis lock |
| 10 | **Bake + render integration** | concept | _not yet written_ | "Bake to keyframes" inspector button; auto-bake on render; per-shot render setup; full-sequence render |

---

## Why this order

**Targeting first (Plans 2–4)** because it's the primary verb. Once a user can drop an object onto a shot and the camera looks at it, the tool already does its most valuable thing. Everything after that is texture and polish.

**Library + recipes (Plan 5)** before Movement so the library infrastructure exists before there are 13+ Movement entries to fill it with. Targeting doesn't need a static library (the library is the user's OM), but it benefits from recipes (e.g., "follow with lead").

**Movement → Lens → Texture (Plans 6–9)** in decreasing user-frequency order. Movement is the second-most-used verb after Targeting. Lens is occasional but high-impact (zoom). Texture is "spice" — important but not load-bearing.

**Bake + render (Plan 10)** last because nothing before it produces a renderable result anyway (v2 doesn't render to disk today). When render lands, all four pill types need to bake; doing it once at the end is cheaper than doing it after each type.

---

## Release positioning

This is the **Release v2** roadmap. **Release v1** (the timeline tool without motion layers) and **Release v1.5** (object-visibility clips) ship first — see [`release-roadmap.md`](release-roadmap.md) for the cross-version index, [`v1-release-roadmap.md`](v1-release-roadmap.md), and [`v1.5-release-roadmap.md`](v1.5-release-roadmap.md).

The release split exists because:
- v1 is a complete, useful tool on its own (timeline, audio scrubbing, render workflow, docs). Worth a release boundary.
- v1.5 is a single new conceptual primitive (object-visibility clips) — narrowly scoped, useful on its own, but needs a stable v1 underneath.
- v2 is a major feature addition (motion layers) that benefits from landing on top of a stable v1 + v1.5 foundation.
- Splitting limits the scope of any single release to something verifiable in one pass.

## Ship cadence

Plans ship when they're verified-working, not on a calendar. The order below is "the order I'd do them in if I had unlimited time." Real cadence depends on what gets blocked, what reveals new ambiguity, what design ideas appear during implementation.

## Living document

This roadmap is expected to change. Plans 6–10 are concept-only and will likely shift as Plans 1–5 ship and reveal what we actually need. Each plan, once written, should link back here; this index updates as plans land.

When a plan is fully written, change its Status from "concept" / "drafted as concept" → "ready to start"; once a plan is shipped (last commit lands), change to "shipped" and link the final commit range.
