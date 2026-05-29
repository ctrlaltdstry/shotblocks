# Live Performance Roadmap (working title)

Drive a camera **live** — first with the mouse, later with a game controller — and
**record the performance as editable keyframes**. "Operate the camera like you're
playing a game, then keep the take," with the existing spring-damper smoothing
turning twitchy live input into a weighty, cinematic glide.

**Status: concept (research done), placed.** Phase 1 (mouse aim) is slotted as
**v1.2 "Live Aim"** — a point release right after v1 (see
[release-roadmap.md](release-roadmap.md)). Phase 2 (game controller) is a later,
unscheduled increment. This roadmap is NOT yet cleared to start implementation —
v1 ships first, and Phase 1's open questions (below) resolve into a detailed
`live-performance-plan-1-*.md` spec before any code.

**Grounded in:** [../research/live-camera-control.md](../research/live-camera-control.md)
(verified SDK + competitor research — read it before any implementation).
**Sits beside:** [../research/camera-animation-prior-art.md](../research/camera-animation-prior-art.md).

---

## The core idea

The incumbents (DirectControl, VirtuCamera, GorillaCam, Control4D) all either let you
**perform** a move (live, but not editable) or **tune** one (editable, but you can't
direct it) — never both. Shotblocks' wedge is **perform-then-refine**: capture a live
pass straight to keyframes, then reshape it non-destructively (the same editable-after
layer slate already embodies). Plus: modern input, gamepad *now* (vs VirtuCamera's
"planned"), and camera-aware mapping instead of a generic HID-channel router.

---

## Why its own roadmap, and how it's placed

It's a **new feature surface** that spans more than one release: a small Python-only
mouse phase and a larger C++ controller phase. Rather than fold it into an existing
milestone (which would reopen "complete" v1 or bloat v1.5), it ships as its own
**point release, v1.2 "Live Aim"**, right behind v1 on the same stable base — bundled
in spirit with v1, without holding v1's ship date. This mirrors why v1.5 was carved
out of v1 rather than stuffed into it.

- **v1.2 = Phase 1** (mouse aim → bake). Pure Python, point-release-sized.
- **Phase 2** (game controller, C++/XInput) is a **later unscheduled increment** —
  deferred until the mouse model proves the perform-then-refine thesis.

Ship order: **v1 → v1.2 → v1.5 → v2** (controller increment lands when ready).

---

## Phasing

Deliberately staged smallest-useful-first. **Phase 1 is reachable from pure Python**
— no C++ build cycle — and validates the whole "perform-then-refine" thesis with the
input device everyone already has (a mouse). Controller support is the payoff phase,
but it's also the one that forces C++, so it comes after the model is proven.

### Phase 1 — Mouse aim, record to keyframes (Python-only)

**Decided (this session):**
- **Mapping:** mouse moves a **look-at point** the camera aims at — reuses the tag's
  existing look-at + framing-offset machinery. Camera *position* stays whatever
  drives it (spline/keyframes); only the aim is performed.
- **Record target:** **keyframes on the camera** (REL rotation, or the aim point's
  position — see open Q). Renders correctly, editable in C4D's timeline, native.
- **Home:** **Python tool plugin** (`RegisterPyToolPlugin`). Research confirmed the
  whole path — `GetCursorInfo` for hover capture, `bd.SW()` for screen→world,
  `c4d.CTrack/CCurve/CKey` for the bake — is in the Python `c4d` module, and the rig
  tag already builds the exact PSR DescIDs. No C++ until Phase 2.

**Shape:**
1. A Shotblocks "Operator" tool. While active, `GetCursorInfo` captures the viewport
   cursor on every move; `bd.SW(Vector(mx, my, focusDist))` unprojects it to a world
   aim point. The rig tag's look-at aims the camera there → live, smoothed by the
   existing spring.
2. **Record:** capture the performed aim per frame and bake to keyframes (the Python
   recipe in the research doc — one undo step, track allocated once, keys per frame).
3. Non-destructive by construction: baked keys are plain animation the user can edit
   or delete; the rig tag's additive mode can read them as its target.

**Pen-tablet support (Wacom) — locked in.** Mike works primarily with a Wacom pen
for finer control, so Phase 1 must feel *right* on a pen, not merely tolerate it. The
pen is actually the better-suited device here (research:
[../research/live-camera-control.md](../research/live-camera-control.md) §1a):
- A pen reports **absolute** position; `GetCursorInfo` reports absolute view-local
  x/y (`c4d_tooldata.h:349`). "Where the pen points = where the camera aims" is a 1:1
  mapping — the precision Mike reaches for a pen to get. **`GetCursorInfo` is the
  primary aim path** partly *because* it's pen-correct (a mouse-style relative-delta
  path is the awkward one for an absolute pen).
- The drag path (`MouseInput` → `MouseDrag`) returns **deltas**; it's pen-safe only if
  deltas are accumulated onto an absolute start seeded from `BFM_INPUT_X/Y` (the SDK's
  own `drawpoly.cpp`/`liquidtool.cpp` pattern). **Never aim from raw deltas.**
- Pen **pressure/tilt/orientation** are readable for free (`gui.h:737-741`;
  `PEN*` channels in the drag container). Optional later enhancement:
  **pressure → aim sensitivity** (light = fine/slow, hard = faster slew) — the analog
  feel a pen is made for. Opt-in, not core.
- Gate any micro-movement filtering on `GeIsTabletMode()` with the tablet threshold
  (`MOUSEMOVE_DELTA_TABLET = 6.0` vs mouse `2.0`) so pen jitter isn't twitchy/laggy.
- **Setup requirement to document:** uncheck Wacom "Use Windows Ink" for C4D (classic
  WinTab path) — with Ink on, pen-hover events can silently stop reaching C4D while a
  mouse still works. Two build-time empirical checks (measure-don't-guess): does
  `GetCursorInfo` fire on pen-proximity hover? does `BFM_INPUT_PRESSURE` read nonzero?

**Open within Phase 1:**
- **Record trigger** (deferred by Mike): *arm-and-play* (hit Record, play the
  timeline, capture frame-by-frame against the real timeline — fits the timeline-first
  model and the beat grid) **vs** *free real-time* (perform in wall-clock, resample to
  frames after — more "live," but timing won't line up to beats as cleanly).
  Recommend prototyping arm-and-play first; it's simpler and on-brand. Resolve before
  building the record path.
- **What exactly gets keyed:** the camera's rotation channels directly, or a
  dedicated aim-target null's position (cleaner separation, but adds an object to the
  scene). The look-at-point decision leans toward keying a target point.
- **Idle easing:** `ToolData` has no per-frame tick. If the camera must keep easing
  while the cursor is still, that needs a `GeDialog`/`MessageData` timer capturing the
  latest `GetCursorInfo` target. May not be needed if recording is arm-and-play (the
  playback tick is the clock).

### Phase 2 — Game controller (Xbox), full game-style flycam (C++)

The payoff. Right stick → aim, left stick → dolly/truck, triggers → boom/roll, plus
an **orbit mode** (pivot around a point, fixed distance). Spring-damper smoothing
makes raw stick input feel like a real operator.

**Forces C++** — gamepad polling is a Win32 API the Python tag can't reach. Lives in
the C++ timeline plugin, alongside the existing playback timer and HTTP-bridge
machinery (mind the 600-line `Dispatch` cap — extract a handler).

**Decided by research:**
- **Input:** raw **XInput 1.4** (link `Xinput.lib`). Zero deps, MIT-clean (system
  API). Poll the connected pad each frame from the existing timer; rescan empty slots
  only every few seconds. Radial deadzone. Xbox-family only.
- **Connection:** document **USB (or Xbox Wireless dongle) recommended**; Bluetooth on
  Win11 has the documented "Bluetooth LE XInput" binding flakiness — not our bug.
- **Camera math:** free-fly + orbit + look is simple velocity integration on the pose
  — reuses the tag's pose/spring code. The hard part (look-at + spring feel) is
  already built.

**The architectural trap to respect:** *live free-fly accumulates state* and fights
the rig's deliberate statelessness, and a purely-live cam hits the same render-frozen
bug the rig has (renderer doesn't tick live input). **The design that works is
perform → bake → play back from keyframes**, exactly as Phase 1. Live-only is the
tempting wrong turn.

### Phase 3 — Broad controller support (optional, only if asked)

PlayStation/Nintendo/generic pads via **SDL2/SDL3** (zlib license → MIT-compatible;
**not** the LGPL SDL 1.2). One dependency, uniform mapping, independent triggers. The
Phase-2 abstraction (read sticks/triggers → deadzone → drive camera) maps 1:1 onto
SDL, so it's a backend swap, not a rewrite. Defer until broad support is actually
requested — Xbox-over-USB covers the common PC case.

---

## What this feature is NOT (scope fence)

- **Not a generic HID-to-parameter router.** It maps to *camera* controls only,
  opinionatedly. No 16-channel mapping screen (that's DirectControl's clunk).
- **Not a live-only tool.** Everything records to editable keyframes. No "perform and
  hope it renders." This is the explicit lesson from the render-frozen bug and from
  the live-only incumbents.
- **Not a phone/AR mocap path.** That's VirtuCamera's lane; we're tactile input
  (mouse, then controller).
- **Not motion-capture of position from the mouse in Phase 1.** Phase 1 is aim only;
  position stays driven by whatever the user already has.

---

## Cross-phase decisions locked in

- **Always record to native C4D keyframes** (REL/local channels). Renders correctly,
  editable, sidesteps the rig render-frozen bug. Universal among competitors.
- **Reuse the existing rig math** — look-at, framing offset, spring-damper. Live input
  becomes the *target*; the spring provides the feel. No new smoothing system.
- **Perform-then-refine is the product wedge** — don't ship a perform-only or
  tune-only tool; the editability after the pass is the differentiator.
- **Phase 1 stays Python; C++ enters only at Phase 2** (controller). Keeps the cheap,
  no-build dev loop for the thesis-validation phase.

---

## Release placement — decided

Settled 2026-05-28: **v1.2 "Live Aim"** point release after v1, **mouse-only**; the
game controller is a later increment. (Ship order v1 → v1.2 → v1.5 → v2.) Rationale
in [release-roadmap.md](release-roadmap.md). Phase 1's *internal* open questions
(record trigger, what-gets-keyed) are still open — resolve them into a detailed
`live-performance-plan-1-*.md` spec before implementation starts.

---

## Living document

Update phase status (concept → ready → shipped) as decisions resolve. When Phase 1's
open questions (record trigger, what-gets-keyed) are answered, fold them into the
locked-in list and write a detailed `live-performance-plan-1-*.md` spec alongside this
roadmap, following the project's plan-doc convention.
