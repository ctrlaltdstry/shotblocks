# Dolly Zoom Math

The Hitchcock / Vertigo effect: subject's apparent size on the sensor stays constant while the camera dollies and the focal length compensates.

## The relationship

Apparent size of a subject on the sensor:

```
size_on_sensor = (subject_world_height * focal_length) / distance
```

To hold `size_on_sensor` constant as `distance` changes:

```
focal_length(distance) = (size_on_sensor_initial * distance) / subject_world_height
```

## Implementation

1. At shot start, record:
   - `distance_initial`
   - `focal_length_initial`
   - `subject_world_height` (estimated from subject bounding box if not given)
2. Compute `size_on_sensor_initial = (subject_world_height * focal_length_initial) / distance_initial`
3. Each frame, given the new `distance`, solve for `focal_length`

## Edge cases

- If the user animates focal length manually, treat their value as the new "initial" and recompute the lock factor
- Negative or zero distance (subject behind camera) → clamp distance to a small positive value
- Extreme distances → focal length may go beyond reasonable lens range; clamp and warn
