# Shotblocks Release Roadmap

The cross-version index. Each release has its own detailed roadmap; this is the map of how they fit together and what's in each.

**Read this first** if you're trying to understand "what ships when." Each release roadmap below has the per-plan detail.

---

## Releases at a glance

| Release | Theme | Status | Roadmap |
|---|---|---|---|
| **v1** | Timeline tool, complete and polished. Camera shot sequencing, audio, render workflow, manual. | in progress | [v1-release-roadmap.md](v1-release-roadmap.md) |
| **v1.2** | Live Aim. Mouse-driven live camera aim, recorded to editable keyframes. Phase 1 of live performance capture; pure Python, quick follow-up to v1. | concept (research done) | [live-performance-roadmap.md](live-performance-roadmap.md) |
| **v1.5** | Object-visibility clips. Extends the timeline to control non-camera object visibility via clip in/out points. One new conceptual primitive on a stable v1 base. | not started | [v1.5-release-roadmap.md](v1.5-release-roadmap.md) |
| **v2** | Motion layers. Procedural camera animation via Targeting / Movement / Lens / Texture pills on sub-lanes. | not started | [motion-layers-roadmap.md](motion-layers-roadmap.md) |

Releases ship in order: **v1 → v1.2 → v1.5 → v2**. Each depends on the prior shipping. Cross-release work is allowed (e.g. drafting plans during v1 stabilization), but no plan begins implementation until the prior release ships.

v1.2 is a **point release** — a small, Python-only follow-up that ships right behind v1 on the same stable base, so live-aim feels bundled with v1 without holding v1's ship date or reopening "complete" v1. The **game-controller** half of live performance capture (Phase 2, C++/XInput) is deferred to a later increment once the mouse model is proven; see [live-performance-roadmap.md](live-performance-roadmap.md).

---

## Why the v1.5 split exists

Originally the roadmap was v1 → v2. v1.5 was carved out mid-v1 to hold object-visibility clips, which arrived as a deliberate scope idea after v1's contents were already locked.

Two reasons it gets its own release rather than folding into v1 or v2:

- **It introduces one new conceptual primitive** (a non-camera clip type) — different enough from v1's polish work that bundling it into v1 would push the v1 ship date.
- **It's narrowly scoped** — one new behavior, no new evaluators or composition math. Different in kind from v2's motion-layers work, which is a major feature surface.

The v1.5 framing also lets us make a one-off commitment explicit: object visibility is the *only* non-camera/non-audio behavior. Not the start of "Shotblocks for everything." See `v1.5-release-roadmap.md` for the scoping principles.

---

## What's in each release, in one line

### v1 — Timeline complete

Camera shot sequencing, audio scrubbing with waveforms + beats, markers, in/out range, render-queue integration, the camera workflow (chips + in-timeline camera creation + selection-follows-playhead), and the bundled user manual.

### v1.2 — Live Aim

Turn on the Shotblocks Operator tool and steer a camera's aim live by moving the mouse in the viewport; hit record and the performance bakes to editable keyframes. Camera position stays driven by whatever the user already has (spline/keyframes) — only the aim is performed. Reuses the rig's existing look-at + spring-damper for a smoothed, cinematic feel. Pure Python; no game controller yet (that's a later increment).

### v1.5 — Object visibility

Drop a 3D object from the OM onto the timeline; clip in/out points control the object's render visibility. New clip style (color + icon) to distinguish from camera clips. Per-track type (object tracks vs camera tracks; no intermix). Take-over-and-warn behavior when an object already has visibility animation.

### v2 — Motion layers

Procedural camera animation. Four pill types — Targeting, Movement, Lens, Texture — composed on sub-lanes under each camera clip. Library of named primitives ("Push", "Orbit L", "Handheld") so users don't dial parameters. Bake-to-keyframes for render.

---

## How to read the per-release roadmaps

Each release roadmap follows the same shape:

- **Plan sequence** — numbered plans in ship order, with status and one-line summary
- **Order rationale** — why this order
- **What this release is NOT** — explicit non-goals so scope doesn't drift
- **Cross-plan decisions already locked in** — design calls made up-front so they don't get re-litigated per plan
- **Living document** notice — these roadmaps are expected to change as plans reveal new ambiguity

Plan documents themselves live alongside the roadmap (`v1-plan-1-*.md`, etc.). Each plan is a detailed spec for one shippable unit of work.

---

## Living document

Add a new release row above when scope is identified that warrants a new release boundary. Don't fold "small new feature ideas" into existing releases without thinking about whether they push that release's ship date.
