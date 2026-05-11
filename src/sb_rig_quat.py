"""Quaternion helpers for stable rotation interpolation.

Pure functions over tuples — no `c4d` import. Used by the look-at
behavior to slerp between the user's keyframed rotation and the
look-at rotation in additive mode, where Euler interpolation would
gimbal-lock or wrap badly.

A quaternion is represented as a 4-tuple `(w, x, y, z)` with the
real part first.

Why quaternions:
  - HPB Euler can't slerp safely: linear interpolation between two
    HPB triples can pass through singularities and produces visually
    wrong intermediate poses.
  - Spring smoothing on HPB still works fine for *one* rotation
    being chased — we keep that part in HPB (per v10) — but the
    *target* must be computed via quaternions and converted back to
    HPB just before the spring step.

The C4D conventions we honor:
  - HPB Euler order = ZYX intrinsic. H = heading (Y), P = pitch (X),
    B = bank (Z). Rotations are applied B → P → H when composing.
  - Right-handed coordinates; camera looks down -Z.
"""

from math import sin, cos, atan2, asin, sqrt, copysign, pi


# ---------------------------------------------------------------------------
# Constructors / conversions
# ---------------------------------------------------------------------------

def identity():
    return (1.0, 0.0, 0.0, 0.0)


def from_hpb(h, p, b):
    """Convert HPB Euler (radians) to a quaternion.

    C4D order: rotate around Y (heading), then X (pitch), then Z
    (bank). Equivalent to q = q_h * q_p * q_b composed on a vector
    as q*v*q^-1.
    """
    ch, sh = cos(h * 0.5), sin(h * 0.5)
    cp, sp = cos(p * 0.5), sin(p * 0.5)
    cb, sb = cos(b * 0.5), sin(b * 0.5)
    # q_h = (ch, 0, sh, 0); q_p = (cp, sp, 0, 0); q_b = (cb, 0, 0, sb)
    # q = q_h * q_p * q_b
    # Compute q_h * q_p first:
    w1 = ch * cp
    x1 = ch * sp
    y1 = sh * cp
    z1 = -sh * sp
    # Then (q_h*q_p) * q_b:
    w = w1 * cb - z1 * sb
    x = x1 * cb + y1 * sb
    y = y1 * cb - x1 * sb
    z = z1 * cb + w1 * sb
    return (w, x, y, z)


def to_hpb(q):
    """Convert a (normalized) quaternion back to HPB Euler.

    Inverse of `from_hpb`: extracts (H, P, B) such that
    R = R_y(H) · R_x(P) · R_z(B). Pitch is clamped to [-pi/2, pi/2];
    near gimbal lock the heading absorbs the residual rotation
    (bank set to zero).
    """
    w, x, y, z = q
    # Convert quaternion to rotation-matrix elements we need. Full
    # 3x3 derivation lifted from Hamilton convention with our
    # composition order. Matrix R = R_y(H) · R_x(P) · R_z(B) has:
    #   R[1][2] = -sin(P)
    #   R[1][0] =  cos(P)·sin(B)
    #   R[1][1] =  cos(P)·cos(B)
    #   R[0][2] =  sin(H)·cos(P)
    #   R[2][2] =  cos(H)·cos(P)
    r12 = 2.0 * (y * z - w * x)        # -sin(P)
    r10 = 2.0 * (x * y + w * z)        #  cos(P)·sin(B)
    r11 = 1.0 - 2.0 * (x * x + z * z)  #  cos(P)·cos(B)
    r02 = 2.0 * (x * z + w * y)        #  sin(H)·cos(P)
    r22 = 1.0 - 2.0 * (x * x + y * y)  #  cos(H)·cos(P)

    sp = max(-1.0, min(1.0, -r12))
    p = asin(sp)
    if abs(sp) > 0.99999:
        # Gimbal: pitch is +/- pi/2. cos(P) ~ 0; bank/heading are
        # entangled. Roll the residual into heading, set bank = 0.
        # Use the alternate elements that survive:
        #   R[0][1] = sin(H)·sin(P)·cos(B) - cos(H)·sin(B)
        #   R[2][1] = cos(H)·sin(P)·cos(B) + sin(H)·sin(B)
        # With sp = ±1 and B = 0: simplifies to atan2 of the two.
        r01 = 2.0 * (x * y - w * z)
        r21 = 2.0 * (y * z + w * x)
        h = atan2(-r21, r01) if sp > 0 else atan2(r21, -r01)
        b = 0.0
    else:
        h = atan2(r02, r22)
        b = atan2(r10, r11)
    return (h, p, b)


def from_basis(right, up, forward):
    """Quaternion from three orthonormal column vectors that form a
    rotation matrix. `forward` is the +Z column for our convention;
    the look-at code negates the aim vector before calling.
    """
    rx, ry, rz = right
    ux, uy, uz = up
    fx, fy, fz = forward
    # Standard matrix-to-quat (Shepperd, Shoemake) — picks the
    # largest diagonal element to avoid sqrt-of-small-numbers
    # instability.
    trace = rx + uy + fz
    if trace > 0.0:
        s = 0.5 / sqrt(trace + 1.0)
        w = 0.25 / s
        x = (uz - fy) * s
        y = (fx - rz) * s
        z = (ry - ux) * s
    elif rx > uy and rx > fz:
        s = 2.0 * sqrt(1.0 + rx - uy - fz)
        w = (uz - fy) / s
        x = 0.25 * s
        y = (ux + ry) / s
        z = (fx + rz) / s
    elif uy > fz:
        s = 2.0 * sqrt(1.0 + uy - rx - fz)
        w = (fx - rz) / s
        x = (ux + ry) / s
        y = 0.25 * s
        z = (fy + uz) / s
    else:
        s = 2.0 * sqrt(1.0 + fz - rx - uy)
        w = (ry - ux) / s
        x = (fx + rz) / s
        y = (fy + uz) / s
        z = 0.25 * s
    return _normalize((w, x, y, z))


# ---------------------------------------------------------------------------
# Operations
# ---------------------------------------------------------------------------

def _normalize(q):
    w, x, y, z = q
    n = sqrt(w * w + x * x + y * y + z * z)
    if n < 1e-12:
        return identity()
    inv = 1.0 / n
    return (w * inv, x * inv, y * inv, z * inv)


def slerp(qa, qb, t):
    """Spherical-linear interpolate from qa to qb by `t` in [0..1].

    Picks the shorter great-circle arc by flipping qb's sign if the
    dot product is negative (quaternions q and -q represent the
    same rotation; the slerp formula picks the long way around
    without this).
    """
    if t <= 0.0:
        return qa
    if t >= 1.0:
        return qb
    aw, ax, ay, az = qa
    bw, bx, by, bz = qb
    dot = aw * bw + ax * bx + ay * by + az * bz
    if dot < 0.0:
        bw, bx, by, bz = -bw, -bx, -by, -bz
        dot = -dot
    # Linear blend when nearly aligned — slerp formula loses
    # precision as theta → 0.
    if dot > 0.9995:
        rw = aw + t * (bw - aw)
        rx = ax + t * (bx - ax)
        ry = ay + t * (by - ay)
        rz = az + t * (bz - az)
        return _normalize((rw, rx, ry, rz))
    theta_0 = _safe_acos(dot)
    theta   = theta_0 * t
    sin_theta_0 = sin(theta_0)
    sin_theta   = sin(theta)
    sa = cos(theta) - dot * sin_theta / sin_theta_0
    sb = sin_theta / sin_theta_0
    return (sa * aw + sb * bw,
            sa * ax + sb * bx,
            sa * ay + sb * by,
            sa * az + sb * bz)


def _safe_acos(x):
    if x >= 1.0:
        return 0.0
    if x <= -1.0:
        return pi
    # Math.acos via atan2 form for slightly better precision near
    # the endpoints, though either is fine.
    return atan2(sqrt(1.0 - x * x), x)
