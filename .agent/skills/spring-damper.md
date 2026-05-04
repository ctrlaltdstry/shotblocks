# Spring-Damper Math

Reference for the spring-damper integration used throughout the rig.

## Continuous form

```
F = -k * (x - x_target) - c * v
a = F / m
```

Where:
- `x` = current position (or rotation)
- `x_target` = target value
- `v` = current velocity
- `k` = stiffness
- `c` = damping coefficient
- `m` = effective mass (often 1)

## Discrete (per-frame) form

Semi-implicit Euler — stable at typical frame rates:

```
a = -k * (x - x_target) - c * v
v += a * dt
x += v * dt
```

## Critical damping

No overshoot, fastest settle:

```
c_critical = 2 * sqrt(k * m)
```

## Tuning by feel

- For steady veteran personality: critically damped, moderate stiffness
- For nervous documentarian: slightly underdamped (`c < c_critical`), low stiffness
- For music video energetic: stiff, slightly underdamped, lots of overshoot

## Substepping at low framerate

When `dt > 1/30`, integrate in N sub-steps to avoid instability:

```
substeps = ceil(dt * 30)
sub_dt = dt / substeps
for i in range(substeps):
    a = -k * (x - x_target) - c * v
    v += a * sub_dt
    x += v * sub_dt
```

## Rotational form

Use angle-axis or quaternion for rotation. Linear interpolation of Euler angles will gimbal-lock. Same equations, but the "position" is a quaternion and "velocity" is an angular velocity vector.
