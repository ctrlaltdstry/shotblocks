# Live camera control: SDK + prior-art research

Research pass for the **live performance-capture** feature idea — driving a camera's
aim (and later, full 6DOF flight) live with the mouse or a game controller, and
recording the performance as editable keyframes. Verified against the on-disk C4D
2026 SDK (`c:/Dev/c4d_sdk_2026/`) and current web sources (accessed 2026-05-28).

This doc is the evidence base. The phased plan that builds on it is
[../plans/live-performance-roadmap.md](../plans/live-performance-roadmap.md).
The competitive landscape it sits in is
[camera-animation-prior-art.md](camera-animation-prior-art.md) (GorillaCam etc.).

**The headline finding:** Phase 1 (mouse drives a look-at point, record to
keyframes) is reachable from **pure Python** — no C++ build cycle. The keyframe
machinery and the screen→world projection are both in the Python `c4d` module,
and the project already constructs the exact DescIDs it needs. Live game-controller
input (Phase 2+) is the part that forces C++, because gamepad polling is a Win32
API the Python tag can't reach.

---

## 1. Capturing live viewport mouse input

**A custom tool (`ToolData`) is the input surface.** The rig tag is a `TagData` and
its `Execute` never sees mouse events; catching viewport mouse movement needs a
tool plugin (like C4D's own Move/Rotate tools). `RegisterPyToolPlugin` exists, so
**this can be a Python tool** — no C++ required for Phase 1.

Relevant `ToolData` virtuals (`c4d_tooldata.h`):

- **`GetCursorInfo(doc, data, bd, x, y, bc)`** (`:354`) — fires on plain mouse-move
  **with no button held**. This is the "aim follows cursor" hook. `x`/`y` are
  view-relative pixels. The SDK example `pickobject.cpp:139-189` caches the cursor
  and unprojects to world on every hover. Mouse-leave arrives as
  `bc.GetId() == BFM_CURSORINFO_REMOVE`.
- **`MouseInput(doc, data, bd, win, msg)`** (`:254`) — fires once on click; the
  continuous stream comes from a `win->MouseDragStart / MouseDrag / MouseDragEnd`
  loop. `MouseDrag` returns **deltas**, not absolute coords — accumulate yourself.
  `MOUSEDRAGFLAGS::NOMOVE` makes the loop tick every frame even when the cursor is
  stationary (otherwise it only fires on actual movement). Verbatim drag-loop
  shape in `liquidtool.cpp:44`.
- Reading the event: `msg.GetFloat(BFM_INPUT_X / BFM_INPUT_Y)`, button via
  `msg.GetInt32(BFM_INPUT_CHANNEL)` (`MOUSELEFT=1, RIGHT=2, MIDDLE=3, MOVE=101`),
  modifiers via `BFM_INPUT_QUALIFIER` (`gui.h:708-743`).
- Registration: `RegisterToolPlugin(id, str, info, icon, help, dat)` (`:547`).
  For hover/highlight behavior pass `PLUGINFLAG_TOOL_OBJECTHIGHLIGHT (1<<12)`.

**The one gotcha:** `ToolData` has **no per-frame tick callback.** Continuous motion
arrives only via (a) the held-button MouseDrag loop or (b) repeated `GetCursorInfo`
on actual movement. If the camera needs to keep easing toward a target while the
cursor sits still, that easing has to be driven from a separate timer
(`GeDialog`/`MessageData`), capturing the latest target in `GetCursorInfo`.

### 1a. Pen tablets (Wacom) — fully supported, and the better-fit device

Mike works primarily with a Wacom pen. Verified against the SDK: the pen is not just
compatible, it's the more natural device for absolute-position aim.

- **Pen data is first-class.** `gui.h:733-741` exposes `BFM_INPUT_PRESSURE ('iprs')`,
  `BFM_INPUT_TILT`, `BFM_INPUT_ORIENTATION`, `BFM_INPUT_P_ROTATION`,
  `BFM_INPUT_FINGERWHEEL` alongside `BFM_INPUT_X/Y`. A pen reports through the mouse
  device with these channels populated (no separate stylus device id). Inside a drag
  loop the same data comes via the `PEN*` enum in the `MouseDrag` channels container
  (`c4d_tooldata.h:169-180`). `GeIsTabletMode()` (`c4d_gui.h:3573`) tells you a tablet
  is the active device.
- **Absolute vs relative — the crux.** A pen is **absolute** (pen position → screen
  location); a mouse is **relative** (deltas). `GetCursorInfo`'s x/y are absolute
  view-local (`c4d_tooldata.h:349`), so it's inherently pen-correct — which is *why*
  `GetCursorInfo` is the chosen primary aim path. The drag path's `MouseDrag` returns
  **deltas** (`c4d_gui.h:1036`); it's only pen-safe if you seed an absolute start from
  `BFM_INPUT_X/Y` and accumulate `+= dx/dy` — the SDK's own `drawpoly.cpp:127-179` and
  `liquidtool.cpp:46-84` do exactly this. Aiming directly from raw deltas would drift
  on an absolute pen.
- **Pressure as optional input.** `msg.GetFloat(BFM_INPUT_PRESSURE)` (or `PENPRESSURE`
  from the drag container) → aim sensitivity (light=fine, hard=fast slew), or a
  record-engage threshold. Pressure-as-sensitivity is the safer first mapping.
- **Jitter threshold.** Tablets are noisier at rest; C4D uses `MOUSEMOVE_DELTA_TABLET
  = 6.0` vs `MOUSEMOVE_DELTA_MOUSE = 2.0` (`c4d_gui.h:1084-1085`). Gate any
  ignore-micro-movement filter on `GeIsTabletMode()`.
- **Windows Ink risk (document for users).** Consistent Maxon + community guidance:
  uncheck Wacom "Use Windows Ink" for C4D (classic WinTab path). With Ink **on**,
  pen-proximity hover events can silently stop reaching C4D while a mouse still works —
  which would make hover-aim mysteriously dead on the pen only. Two build-time
  empirical checks (per measure-don't-guess): does `GetCursorInfo` fire on pen hover?
  does `BFM_INPUT_PRESSURE` read nonzero? Sources: Maxon C4D troubleshooting guide;
  renderbreak.com Wacom-quirks; Wacom Windows-Ink KBs (couldn't fetch directly — 403 —
  corroborated across multiple snippets/community sources; verify exact menu path on
  the user's driver version).

---

## 2. Screen pixel → world-space aim point

One SDK-blessed call does it. All projection methods live on `BaseView` (parent of
`BaseDraw`) in `c4d_basedraw.h`; reachable in Python as `c4d.BaseView` methods.

**World point at a chosen distance in front of the camera:**

```
worldPt = bd.SW(c4d.Vector(mouseX, mouseY, distance))   # SW = Screen→World, :425
```

`distance` is world units of orthogonal depth from the view plane. This is exactly
how `snaptool.cpp:98` and `liquidtool.cpp:105` place objects under the cursor.

**World ray (for picking a surface):**

```
camPos = bd.GetMg().off                                  # camera world pos, :311
rayDir = ~(bd.SW(c4d.Vector(mx, my, 1.0)) - camPos)      # normalized direction
```

To hit a known plane/line instead, `bd.ProjectPointOnPlane(p, normal, mx, my)`
(`:596`) and `ProjectPointOnLine` (`:582`) cast the through-pixel ray and return
the world intersection, with an `err` out-param for behind-camera / no-hit.

Other useful BaseDraw bits: `GetSceneCamera(doc)` (`:845`) for the actual camera
object, `GetFrame(&l,&t,&r,&b)` (`:291`) for viewport pixel dimensions,
`doc.GetActiveBaseDraw()` to get the `bd`.

**Threading:** these need a valid `BaseDraw` and the main thread — fine for a tool
(tools run main-thread), would NOT be reachable from the C++ plugin's loopback-HTTP
worker thread without marshalling.

For "aim a camera at the mouse," `SW(Vector(mx, my, focusDistance))` with a chosen
focus distance is the simplest idiom: the mouse picks a world point, the existing
look-at math (already in `sb_rig_tag.py`) aims at it.

---

## 3. Recording the performance → keyframes

Full `CTrack`/`CCurve`/`CKey` API, **fully Python-reachable** (`c4d.CTrack`,
`c4d.CCurve`, `c4d.CKey` — in the SDK since R12). The project already builds the
exact PSR DescIDs it needs in `src/sb_rig_tag.py:756-767`.

**The DescIDs** (confirmed `description/obase.h`, and matching the tag's own code):
`ID_BASEOBJECT_REL_POSITION (903)` + `VECTOR_X/Y/Z`, `ID_BASEOBJECT_REL_ROTATION
(904)` + `VECTOR_X/Y/Z`. Rotation H/P/B map to VECTOR_X/Y/Z respectively. Use the
**REL_ (local)** channels — aligns with the project's hard rule that pose writes go
through local channels, not world matrices.

**Bake one value V onto channel C at frame F, as one undo step (Python):**

```python
posX = c4d.DescID(c4d.DescLevel(c4d.ID_BASEOBJECT_REL_POSITION, c4d.DTYPE_VECTOR, 0),
                  c4d.DescLevel(c4d.VECTOR_X, c4d.DTYPE_REAL, 0))
t = c4d.BaseTime(F, doc.GetFps())

doc.StartUndo()
track = op.FindCTrack(posX)
if track is None:
    track = c4d.CTrack(op, posX)
    op.InsertTrackSorted(track)
    doc.AddUndo(c4d.UNDOTYPE_NEWOBJ, track)    # NEWOBJ registers AFTER insert
else:
    doc.AddUndo(c4d.UNDOTYPE_CHANGE, track)    # CHANGE registers BEFORE editing
curve = track.GetCurve()
key = curve.AddKey(t)["key"]                   # Python AddKey returns {'key','nidx'}
key.SetValue(curve, V)
key.SetInterpolation(curve, c4d.CINTERPOLATION_SPLINE)
doc.EndUndo()
c4d.EventAdd()
```

**Undo timing** (matches MEMORY note "undo registers AT AddUndo time"):
`UNDOTYPE_NEWOBJ` must be added **after** the track is inserted; `UNDOTYPE_CHANGE`
**before** editing an existing track. Allocate each channel's track once outside the
per-frame loop; loop only `AddKey`/`SetValue`; wrap the whole bake in one
`StartUndo`/`EndUndo`.

**Smoothness for a dense bake:** with keys on every frame, tangent shape barely
matters — `CINTERPOLATION_LINEAR` avoids inter-key wobble; `SPLINE` +
`curve.SetKeyDefault(doc, kidx)` gives C4D's default eased tangents if you want it.

**Why bake-to-keyframes is the right target:** it renders correctly (sidesteps the
known rig render-frozen bug, because after baking it's plain animation), it's
editable in C4D's own timeline afterward, and it's exactly what every competitor
does under the hood (§5). The cost: baked keys on the REL channels will *fight* a
live rig tag writing the same channels each Execute — so the bake either replaces
the rig's role for that channel, or the rig reads the baked curve as its target
(the additive-mode pattern the tag already supports). A design decision for the
plan, not an API limit.

---

## 4. Reading a game controller (Phase 2+, forces C++)

**Recommendation: raw XInput for Xbox controllers in Phase 2; SDL (zlib) only if
broad controller support is later requested.**

- **XInput** is a Windows **system API** — header `xinput.h` + `Xinput.lib` are in
  the Windows SDK the C++ plugin already builds against. **Zero dependencies, zero
  licensing surface** (same category as kernel32 — MIT-clean). Target XInput 1.4
  (in-box on Win8+); avoid the legacy 1.3 redistributable.
- **Poll-based, not event-based.** One `XInputGetState(0, &state)` per frame; cheap.
  Read `sThumbLX/LY/RX/RY` (−32768..32767), `bLeftTrigger/bRightTrigger` (0..255),
  `wButtons` bitmask. Apply a **radial deadzone** (constants
  `XINPUT_GAMEPAD_LEFT_THUMB_DEADZONE=7849`, `RIGHT=8689`, trigger threshold 30).
  `dwPacketNumber` lets you skip processing when nothing changed. Poll the connected
  pad every frame, but **rescan disconnected slots only every few seconds** (Win
  device-discovery on an empty slot is the expensive case).
- **Coverage:** raw XInput sees **only** Xbox 360 / One / Series pads (USB +
  Xbox-wireless). It does **not** see PlayStation/Nintendo/generic pads — those are
  DirectInput/HID. PS users' fallback is DS4Windows (user-side shim that presents
  the pad as a virtual Xbox controller).
- **Bluetooth vs USB:** over USB an Xbox pad is XInput immediately and reliably.
  Over **Bluetooth on Win11** it often binds to a generic "Bluetooth LE XInput"
  driver — a documented, multi-year, unresolved Windows driver quirk; binding is
  inconsistent and the driver choice doesn't persist across reboots. **Document
  "USB (or the Xbox Wireless USB dongle) recommended; Bluetooth may work."** Neither
  XInput nor SDL fixes this — it's below both, in the Windows controller stack.
- **Broad support later:** **SDL2/SDL3 GameController API** is the standard one-dep
  path — unifies XInput + DirectInput + PlayStation + Bluetooth behind a uniform
  Xbox-style mapping (with independent triggers, which raw DirectInput can't do).
  **SDL 2.0+ is zlib-licensed → MIT-compatible** (verified libsdl.org/license.php);
  attribution appreciated, not required; static/dynamic both fine. **Caveat: SDL
  1.2 was LGPL — pull SDL2/SDL3 only.** The Phase-2 abstraction (read sticks/
  triggers/buttons → deadzone → drive camera) maps 1:1 onto SDL, so the backend can
  be swapped without reworking the camera-drive logic.

---

## 5. Existing C4D camera-controller tools — what to learn from

All of these ultimately **record live (or procedural) input to native keyframes.**
The Tag-on-camera + bake pattern is universal — which validates the approach here.
(GorillaCam detail also in [camera-animation-prior-art.md](camera-animation-prior-art.md).)

| Tool | Architecture | Input | Records via | 2026? | The catch |
|---|---|---|---|---|---|
| **DirectControl** | Tag, built on **DirectX 9** | game controllers (DX9) | pos+angle keyframes; also trackless live-recall | R21+ claimed, 2026 unverified | DX9 is dead legacy; 3Dconnexion incompatible; device-detection complaints. The genre Mike found painful |
| **Control4D** | Plugin on **SDL + PortMidi** | joystick/gamepad/MIDI | strong baker: hierarchies, frame-step, transport-on-controller | **dormant** (last real update ~2017; author admits needed rewrite) | abandoned; dead-zone bugs, keystroke interception, CPU pinning |
| **Camera GripTools / griptools.io** | grew into a **standalone node app** ↔ C4D nodes | HID/MIDI/OSC/TrackIR/AR phone | "Sample Recorder" node, auto frame-step | unverified | conceptual heaviness — a node-graph signal-routing app to fly a camera |
| **VirtuCamera 2** | phone app + Python host plugin (PyVirtuCamera) | phone 6DOF motion (ARKit) | live stream → bake to keyframes | **✅ confirmed** | gamepad/joystick **planned, not shipped**; needs real-world-scale setup; Wi-Fi dependency; no precise tactile control |
| **GorillaCam** | procedural **Tag**, no live input | none (params/presets) | Quick Bake to keys | R20+/Maxon One | can't *perform* a move, only tune randomness; $468/yr subscription-only |

**Recurring failure modes to avoid:**
1. **Brittle legacy input backends** (DX9, 2010-era SDL) → device support rots, plugin dies with the API.
2. **Abandonment** — this niche is littered with unmaintained tools. A clear "works on C4D 2026, Windows, maintained" is itself a competitive feature.
3. **Conceptual heaviness** (griptools' node graph; GorillaCam's preset/randomizer maze) — a simple goal buried under setup.
4. **Hidden config gates** (VirtuCamera's scale step, Control4D's deadzone) — the move feels wrong until you find the knob nobody mentioned.
5. **Perform-OR-tune, never perform-then-refine.** The live tools (DirectControl/VirtuCamera) let you perform but not edit; GorillaCam lets you tune but not direct. **Nobody blends a performed pass with editable, snap-able refinement.**

**Where Shotblocks wins** (and why this is on-brand per
[../constitution.md](../constitution.md) and the GorillaCam-positioning memory):
- **Modern input** (ToolData/XInput, not DX9), gamepad **now** vs VirtuCamera's "planned."
- **Perform-then-refine** — capture a live pass to keyframes, then non-destructively
  reshape it (this is exactly the slate / editable-after layer the incumbents lack).
- **Camera-aware, not a generic HID router** — no 16-channel mapping screen; one
  obvious mapping because the plugin already knows it's about cameras. The existing
  look-at + spring-damper math turns a twitchy live input into a weighty, cinematic
  glide for free.
- **Sensible auto deadzone / auto scale with a visible override** — no hidden gate.

---

## Sources

SDK facts: on-disk headers under `c:/Dev/c4d_sdk_2026/frameworks/cinema.framework/source/`
(`c4d_tooldata.h`, `c4d_basedraw.h`, `c4d_canimation.h`, `description/obase.h`) and
example tools (`pickobject.cpp`, `liquidtool.cpp`, `snaptool.cpp`, `morphmixer.cpp`).

XInput: Microsoft Learn — [XInputGetState](https://learn.microsoft.com/en-us/windows/win32/api/xinput/nf-xinput-xinputgetstate),
[Getting Started with XInput](https://learn.microsoft.com/en-us/windows/win32/xinput/getting-started-with-xinput),
[XInput vs DirectInput](https://learn.microsoft.com/en-us/windows/win32/xinput/xinput-and-directinput),
[XInput Versions](https://github.com/MicrosoftDocs/win32/blob/docs/desktop-src/xinput/xinput-versions.md),
[Bluetooth LE XInput quirk](https://learn.microsoft.com/en-us/answers/questions/4352960/).
SDL license: [libsdl.org/license.php](https://www.libsdl.org/license.php).
Tools: [DirectControl](https://c4dplugin.com/product-dc) ([3Dconnexion issue](http://answers.c4dplugin.com/480/incompatibility-with-3d-conexion)),
[Control4D](http://www.kvbarnum.com/control4d/) ([Renderosity](https://www.renderosity.com/forums/threads/2816025)),
[griptools.io](https://www.griptools.io/),
[VirtuCamera 2](https://80.lv/articles/virtucamera-2-is-finally-here) ([DigitalProduction](https://digitalproduction.com/2026/05/01/virtucamera-2-the-weird-byte-goes-android/)),
[GorillaCam](https://greyscalegorilla.com/plugins/gorillacam) ([GSG subscription](https://www.cgchannel.com/2021/04/greyscalegorilla-goes-subscription-only/)).
