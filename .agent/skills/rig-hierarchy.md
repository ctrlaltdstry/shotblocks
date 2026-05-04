# Rig Hierarchy

The standard rig structure. Mirrors physical camera rigs.

```
world_null              — placement and worldspace anchor
  └─ boom_null          — vertical / crane height (translates Y)
      └─ pan_null       — horizontal rotation (rotates Y)
          └─ tilt_null  — vertical rotation (rotates X)
              └─ camera — focal length, focus, sensor
```

## Why this structure

Each null has one job. Animating one should not bleed into others.

- Want a crane up → animate boom_null Y
- Want a pan → animate pan_null Y rotation
- Want a tilt → animate tilt_null X rotation
- Want a dolly → animate world_null position
- Want a zoom (vs dolly) → animate camera focal length

## Why not collapse it

You could put everything on the camera. But then a "crane up while panning" requires animating two channels in coordinated ways, and the spring-damper on each channel interferes. With separate nulls, each channel is independent and damping behaves correctly.

## Generating it

The Shotblocks tag builds this hierarchy when applied to a camera. The user sees their original camera in the Object Manager; the tag inserts the boom/pan/tilt/world nulls underneath as children of the camera. Hide the nulls from the Object Manager by default, expose them via a toggle for advanced users who want to manually animate them.

When the tag is removed, the hierarchy is cleaned up and the camera returns to its previous state.

## Where each behavior runs

The Shotblocks tag is the only user-visible tag. Internally, it runs a pipeline of behaviors each frame, applied to specific nulls in the rig hierarchy:

- **Spring-damper** → applied per-null (each null can have its own damping parameters in the tag's settings)
- **Look-at** → drives pan_null and tilt_null toward the configured target
- **Autofocus** → drives the camera's focus distance based on target or raycast
- **Noise profile** → typically applied at world_null for whole-rig shake; at camera level for lens-only shake (configurable)
- **Framing rule** → influences look-at's target offset (e.g., rule-of-thirds places the subject at the upper third instead of dead-center)

These are subsystems of the Shotblocks tag, not separate tags the user manages. The user sees one tag; the implementation internally orchestrates the behaviors in the correct order each frame.
