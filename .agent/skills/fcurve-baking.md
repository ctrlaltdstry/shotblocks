# F-Curve Baking and Reduction

The bake-down operation converts the procedural rig to a standard C4D camera with editable curves. The reduction is what makes the output usable.

## Naïve bake (do not ship)

Step every frame, record values, set a key per frame. Result: thousands of keys, unusable for further editing.

## Reduced bake

Fit a smaller set of keys to the recorded data within a tolerance.

## Algorithm options

### Ramer-Douglas-Peucker (RDP)
Polyline simplification. Recursively keep the point with maximum perpendicular distance to the chord between endpoints, until all remaining points are within tolerance.

Pros: simple, well-known, fast
Cons: produces linear segments; for camera curves you want smooth interpolation

### Bezier curve fitting
Fit cubic Bezier segments to the data with a tolerance. Subdivide segments where the fit error exceeds tolerance.

Pros: produces curves that look like hand-animated work
Cons: more complex; tangent handling matters

### Recommendation for v1
RDP for first pass to get a sparse set of points, then fit Bezier tangents at each retained point based on local curvature. Hybrid approach.

## Tolerance

User-configurable per channel:
- Position: in scene units (e.g., 0.1 cm)
- Rotation: in degrees (e.g., 0.1°)
- Focal length: in mm (e.g., 0.5)
- Focus: in scene units

Default tolerances should produce ~10-20 keys for a typical 5-second shot. Too tight = too many keys. Too loose = visible motion change.

## Validation

After baking, render a frame from the procedural rig and the baked camera at the same time. They should match to within tolerance. Difference larger than tolerance = bake bug.
