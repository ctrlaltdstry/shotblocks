# Workflow: Adding or Changing a Rig Behavior

Rig behaviors are tags: spring-damper, look-at, autofocus, noise profile, framing rule. Adding a new one means a new TagData class.

## 1. Confirm it's a behavior, not a preset

A behavior is a per-frame transformation of rig state (smoothing, aiming, focusing, shaking, framing). A preset is a parameter configuration over time. If you're adding "a new way the camera moves," that's likely a preset. If you're adding "a new way the camera reacts to its inputs," that's a behavior.

## 2. Define the math

Document it in `domain.md` if it's not already there. Spring-damper, dolly-zoom, framing rules — all have entries. Add a `skills/<name>.md` if the math is involved.

## 3. Implement as a TagData

In `src/rig/tags/<name>.py`:
- Parameter description (Resource file or Python description)
- `Init` for caching references
- `Execute` for the per-frame work — keep this tight, this is hot code
- Document priority (where does it sit in the tag execution order?)

## 4. Performance check

- No scene traversal in `Execute`
- Math vectorized where possible
- Profile against a typical scene; viewport must stay interactive

## 5. Wire into shot state

If this behavior is per-shot configurable (most are), add the parameters to the Shot data class and to the inspector panel. Sequencer's interpolation logic must know how to blend the parameter across transitions.

## 6. Test

- Behavior in isolation on a single static shot
- Behavior interpolated across a transition
- Bake-down with the behavior active — curves still clean?

## 7. Update pitfalls.md if you found one
