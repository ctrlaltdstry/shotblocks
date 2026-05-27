# Motion Layers — Inspector Parameter Spec

Full inspector parameter spec for all four pill types. Written to inform Figma UI mockups. Reflects design decisions from the motion-layers exploration session.

**Ship order:** Targeting → Movement → Lens → Texture. Targeting is the primary verb ("where is the camera looking"). Each type listed below is fully spec'd, but only Targeting ships in v1.

**Design rule:** simplest camera-animation tool in Cinema 4D. Anything trending toward GorillaCam/Signal parameter density is flagged `[v2 of this type]` and deferred.

---

## Universal section (top of inspector, every pill)

| Param | Type | Default | Notes |
|---|---|---|---|
| **Name** | text | library entry name | Editable. Shows in pill body. |
| **Color** | swatch | per-type default | Targeting=green, Movement=blue, Lens=purple, Texture=orange. User can override per pill. |
| **Ease in** | curve picker | "Smooth" preset | Presets: Linear / Smooth / Snappy / Custom. Custom opens bezier editor. |
| **Ease out** | curve picker | "Smooth" preset | Same widget. |
| **Hold after end** | toggle + frames | on, ∞ (Movement/Lens); off (Texture/Targeting) | When on, last frame's delta persists past pill end. |
| **Mute** | icon toggle | off | Pill inactive but visible. |
| **Solo** | icon toggle | off | Mutes all other pills in shot. |

---

## Targeting (ships first)

The "where is my camera looking" pill. Drag an object from the OM onto a shot → Targeting pill appears, filling the shot, camera looks at the object.

| Param | Type | Default | Notes |
|---|---|---|---|
| **Target** | object picker | the drag source | Drag-from-OM or "+" picker. Shows orphan state if object deleted/missing. |
| **Influence** | 0–100% slider | 100% | How strongly the look-at pulls camera off base orientation. 100% = full look-at; 50% = blend between base and target. |
| **Blend in** | frames | 12 | Time camera takes to swing onto the target at pill start. 0 = snap instantly. |
| **Blend out** | frames | 12 | Time camera takes to swing back to base at pill end. 0 = snap instantly. |
| **Aim offset** | XY (degrees) | 0, 0 | "Look slightly above/beside the target." Useful for headroom or leading. |
| **Camera up mode** | dropdown | "World up" | **World up** (standard) / **Target's up** (roll camera to align with target's local Y) / **Path tangent** [v2] |
| **Lead amount** | frames | 0 | Look-ahead at moving target's position. 0 = current frame. |
| **Banking on roll** | toggle | off | If Camera up mode = Target's up, smooths roll change with extra easing. Prevents sudden roll flips when target spins. |

**Multi-target handoff** (one shot, multiple Targeting pills) — the CROSSFADE rule handles this:
- Pill 1 (target A) ends at frame 30; Pill 2 (target B) starts at frame 25 → frames 25–30 = camera swings from A to B
- No new params needed; the overlap zone *is* the transition

**Library entries for Targeting:**
- No fixed library. Each Targeting pill is created by dragging an object from the OM. The "library" is the user's scene.

---

## Movement (ships second)

Camera-local moves. Each library entry is one named primitive (Push, Pull, Crane Up, etc.) — one pill = one motion. Layer pills to combine (Push + Crane Up = diagonal rise).

| Param | Type | Default | Notes |
|---|---|---|---|
| **Distance** | number | 110cm (Push/Pull) / 50cm (Crane/Truck) / 30° (Orbit/Sway/Tilt/Roll) | Unit depends on pill type. Negative flips direction. |
| **Direction** | read-only label | per pill type | E.g., "+Z (camera local)". User changes direction by picking different library entry, not by editing. |
| **Speed shape** | dropdown | "Symmetric" | **Symmetric** / **Front-loaded** / **Back-loaded** / **Custom** (use ease in/out curves). Quick semantic shortcut over the bezier widget. |

**Library entries for Movement** (the small named set — 13 total):
- Push In / Pull Out (camera-local Z)
- Crane Up / Crane Down (camera-local Y)
- Truck Left / Truck Right (camera-local X)
- Orbit Left / Orbit Right (around target — needs target picker if no Targeting pill present)
- Sway Left / Sway Right (yaw)
- Tilt Up / Tilt Down (pitch)
- Roll CW / Roll CCW (Z rotation)

Library is browsable, not configurable. Direction is encoded in the pill type, not edited in the inspector.

`[v2 of Movement]`: subject-relative magnitude, world-space reference frame, custom XYZ vector pills — only if needed.

---

## Lens (ships third)

CROSSFADE composition — each Lens pill sets a new ambient value that the next Lens pill blends *from*.

| Param | Type | Default | Notes |
|---|---|---|---|
| **Property** | dropdown | "Focal length" | **Focal length** (mm) / **Focus distance** (cm) / **Aperture** (f-stop) / **Lens distortion** [v2] |
| **Target value** | number | varies by property | The value the lens reaches at pill end. |
| **Start value** | "Live" or number | "Live" | "Live" = picks up whatever the lens is at pill start (continuity). Override with a number for snap-zooms. |
| **Snap on start** | toggle | off | If on, ignores ease in — value jumps instantly to "Start value" at pill begin. For zoom-cuts. |

**Library entries for Lens:**
- Zoom In / Zoom Out (focal length deltas)
- Rack Focus (focus distance, target via picker)
- Stop Up / Stop Down (aperture)
- Snap Zoom (Zoom In with Snap on start = on)

`[v2 of Lens]`: Distortion property, breathing simulation, anamorphic squeeze, "physical lens" presets (24mm / 35mm / 50mm / 85mm).

---

## Texture (ships fourth)

SUM composition with stateful-ish behavior. Pure procedural — same seed = same shake every time.

| Param | Type | Default | Notes |
|---|---|---|---|
| **Style** | dropdown | "Handheld" | **Handheld** (low-freq position drift + rotation jitter) / **Vibration** (high-freq small position) / **Breathing** (very slow Y + rotation) / **Earthquake** (high amp all axes) / **Custom** [v2] |
| **Amount** | 0–100% slider | 50% | One slider drives the whole intensity. Internally maps to multi-axis amplitudes via the style preset. |
| **Speed** | 0–100% slider | 50% | Frequency multiplier vs the style preset's baseline. |
| **Seed** | int + "randomize" button | 0 | For repeatability. Different seed = different specific motion, same character. |
| **Envelope** | toggle + curve | off | When off, full amplitude across pill life. When on, opens small curve widget (amplitude over pill time, 0–1). Default curve = ramp-up-then-ramp-down bell shape. |
| **Axis lock** | three toggles (X / Y / Z) | all on | Quick way to limit shake to e.g., Y only (head-bob) or X/Z (no vertical). Position only; rotation always uses all axes per style. |

**Library entries for Texture** (5 total):
- Handheld
- Vibration
- Breathing
- Earthquake
- Subtle Drift

User adjusts Amount / Speed in inspector. Style + Amount + Speed is most of the surface.

`[v2 of Texture]`: Custom style (per-axis amplitude + frequency + octave sliders), Perlin vs simplex toggle, follow-audio amplitude (drive Amount from RMS of audio track).

---

## Design notes

**Targeting has more params than Movement.** Because Targeting *is* the primary verb and needs the up-mode + blend controls to handle the cases you'd hit (handing off between targets, target rotating, etc.). Movement gets just 3 params because the library entry encodes most of the decision.

**No frame-of-reference dropdowns anywhere.** Everything is camera-local for Movement, world for Targeting up vectors, pill-internal for Texture. No "what does Z mean here" question for the user.

**Distance/value defaults are picked to do *something visible*.** Drag Push onto a shot, hit play — you see a 110cm push. Drag Zoom In onto a shot — focal length climbs. The user gets feedback before touching a parameter.

**Bezier curve editor stays hidden unless asked.** Universal Ease uses preset names (Smooth / Snappy / Linear) — the bezier widget is the "Custom" option behind a click. Most users never see it.

**Vocabulary:** "Blend in / Blend out" (After Effects camera-constraint convention), not "Slerp in / Slerp out" (mathematical term, not used in motion design).
