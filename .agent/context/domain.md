# Domain

The cinematography and motion concepts this plugin encodes. This is reference material — when implementing a feature, check here for the right model before improvising.

## Camera rig hierarchy

Industry-standard rig structure, mirrored from physical camera rigs:

```
world_null              — placement and worldspace anchor
  └─ boom_null          — vertical / crane height
      └─ pan_null       — horizontal rotation (Y axis)
          └─ tilt_null  — vertical rotation (X axis)
              └─ camera — focal length, focus, sensor
```

Each null has one job. Animating boom height should not affect pan or tilt. Animating pan should not affect tilt. This separation is what makes cinematographic moves (a crane up while panning, a tilt down while pushing in) feel correct.

## Spring-damper motion

Camera position and rotation animate via critically-damped springs by default. The math:

```
acceleration = stiffness * (target - current) - damping * velocity
velocity += acceleration * dt
current += velocity * dt
```

Stiffness controls how quickly the camera reacts to target changes. Damping controls overshoot. Critical damping (no overshoot, fastest settle) is `damping = 2 * sqrt(stiffness)`.

Apply per-axis with separate parameters for translation and rotation. Pan and tilt typically want different damping values — pans whip, tilts settle.

## Dolly zoom (Vertigo / Hitchcock effect)

The subject's apparent size on the sensor stays constant while the camera dollies in/out and the focal length compensates. The relationship:

```
subject_height_on_sensor = (subject_world_height * focal_length) / distance_to_subject

To hold this constant:
focal_length = (subject_height_on_sensor * distance_to_subject) / subject_world_height
```

In practice: lock the initial framing, record `subject_height_on_sensor`, then as the user animates `distance_to_subject`, solve for `focal_length` each frame.

## Lens reference

Standard focal lengths and their character (35mm full-frame equivalent):

- **14mm** — extreme wide, dramatic distortion, "scale" feel
- **24mm** — wide, environmental, common for establishing
- **35mm** — natural wide, documentary feel
- **50mm** — "normal," matches human single-eye perspective
- **85mm** — short telephoto, classic portrait, compresses pleasantly
- **135mm** — telephoto, strong compression, isolates subject

Sensor-size presets adjust effective focal length:
- **Super 35** — crop factor ~1.4× vs full frame
- **Full frame** — reference (1.0×)
- **Micro 4/3** — crop factor ~2.0×

## Composition rules

For subject-aware framing:

- **Rule of thirds** — subject placed on a third-line, eyes on upper third for portraits
- **Centered** — subject dead-center, used for symmetry / formal compositions
- **Headroom** — gap above subject's head proportional to shot tightness (close-up: tight; wide: loose)
- **Leading space** — gap in direction of subject's motion or gaze, opposite to trailing space
- **Nose room** — when subject faces a direction, more space on that side than behind

## Shot types and their behavior

- **Orbit** — pan-null rotates around target at fixed radius and height
- **Dolly** — translation along camera local Z, no rotation change
- **Crane / Boom** — boom-null height animates, often combined with tilt to keep subject framed
- **Pan** — pan-null rotation, fixed position
- **Tilt** — tilt-null rotation, fixed position
- **Whip pan** — extreme-velocity pan, intentionally motion-blurred. A *shot type*, not a transition. The plugin authors the whip as a shot; if the user wants to use it as a transition between scenes, they cut directly from the whip's tail to the next shot, and any further blending happens downstream in their NLE.
- **Push-in / Pull-out** — dolly toward / away from subject, no zoom
- **Dolly zoom** — dolly + counter-zoom, locks subject size (see math above)
- **Reveal** — camera move that exposes a subject hidden by foreground (rack focus, dolly past, tilt up)
- **Parallax** — translation perpendicular to subject, foreground moves faster than background

## Cut on action

A foundational editorial principle: cuts placed at moments of visible motion are smoother and more deliberate than cuts placed during stillness. The viewer's eye is occupied by the motion and does not register the cut as an interruption. Walter Murch's "In the Blink of an Eye" is the canonical reference.

The plugin's slate engine applies this principle algorithmically. Because the rig is procedural, the plugin can compute the camera's motion energy directly from rig state — no footage analysis required. Action frames are local maxima of the motion-energy curve.

## Motion energy

The plugin computes a per-frame scalar value for each shot:

```
motion_energy(frame) = w_t * |translational_velocity|
                     + w_r * |rotational_velocity|
                     + w_a * |acceleration|
```

Where `w_t`, `w_r`, `w_a` are user-configurable weights. Defaults favor rotational velocity (pans and whips read more strongly to the eye than slow translations) but the weights are exposed because different scene types want different emphasis.

**Action frames** are local maxima of `motion_energy` — frames where the camera is doing the most visually. A shot may have one dominant action frame (a single push-in's closest approach) or several (an orbit with multiple close-approach moments).

**Low-energy frames** are local minima. Useful as cut-out points, since cutting from a low-energy frame is unobtrusive.

The slate engine prefers to align action frames to beats and place cut points at low-energy frames. A well-slated shot reaches its peak motion exactly on the beat and cuts during the calm moments around it.

## Noise profiles (handheld and mounted reference)

Each profile is a tuned set of frequency and amplitude per axis:

- **Tripod with operator** — very low frequency (~0.5 Hz), tiny amplitude, mostly tilt
- **Handheld 35mm walking** — mid frequency (~1.5 Hz), moderate amplitude on all axes, slight forward drift
- **Shoulder-mount running** — higher frequency (~2.5 Hz), large amplitude on Y, sync to footstep cadence
- **Drone in light wind** — low frequency (~0.8 Hz), moderate amplitude, mostly translation, slight yaw drift
- **Car mount on asphalt** — high frequency (~5+ Hz), small amplitude, dominated by Y axis with road-bump impulses
- **Steadicam** — very low frequency, small amplitude, smooth drift, the "floating" feel

Reference data ideally sourced from real gyro recordings; otherwise tuned by ear against reference footage.

## Beat sync behavior

When a preset has "sync to markers" enabled:

- **Push-in** — velocity curve quantized so closest-approach frame falls on a downbeat
- **Orbit** — angular velocity adjusted so a full revolution completes over N beats (user-configurable)
- **Pan** — endpoints snap to beat markers; easing preserved
- **Shake / noise** — amplitude envelope sidechained to audio amplitude or a frequency band

## Energy-reactive framing

For simulation work, the camera reads scene state and adjusts:

- **Particle count in frustum** → drives shake amplitude
- **Average velocity of nearby objects** → drives push/pull tendency
- **Bounding box of active sim** → drives auto-frame target
- **Kinetic energy of sim** → drives lens-breathing intensity

Damping on these reactions is critical — raw scene state is too noisy to drive the camera directly.
