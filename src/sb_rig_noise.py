"""Noise profiles for the Shotblocks rig.

Pure functions over floats and tuples. No `c4d` import. The caller
(the tag's `Execute`) decides where in the pipeline each band of
noise lands.

Architecture: **two-band layered value-noise.** Each channel
(rotation H/P/B and position X/Y/Z) is described by a (pre, post)
pair of `LayeredNoise` configs.

- `*_pre` lands **before** the spring step. Low-frequency drift
  lives here so the spring shapes it into believable weight —
  operator postural sway feels like the camera has mass.
- `*_post` lands **after** the spring step. High-frequency tremor
  survives the spring's low-pass — without this split the spring
  eats every frequency above its corner.

Why value-noise (and not sum-of-sines): a small sum of pure sines
produces a periodic, even-amplitude oscillation — perceptually it
reads as a mechanical shake, not a hand. Value-noise summed across
several octaves (fractal Brownian motion / fBm) produces aperiodic
"big slow moves with smaller faster moves on top," which is what
real handheld actually looks like — bursty asymmetric drifts, not
constant tremor.

The sample function is **stateless** — given (profile, frame, fps,
seed) it always returns the same NoiseSample. No "previous + delta"
accumulation, ever. This is what makes scrubbing and looping
deterministic.

Position amplitudes are unitless **viewport fractions** (0.005 =
half a percent of viewport). The tag-side integration converts to
world units via the camera's FOV and a reference distance.
"""

from math import pi, sin


# ---------------------------------------------------------------------------
# Profile ids — match the SHOTBLOCKS_NOISE_PROFILE_* cycle constants
# in tshotblocks.h.
# ---------------------------------------------------------------------------

PROFILE_OFF      = 0
PROFILE_HANDHELD = 1


# ---------------------------------------------------------------------------
# Channel ids — used to derive deterministic per-channel seeds so
# different channels don't share an identical noise pattern.
# ---------------------------------------------------------------------------

_CHAN_RH, _CHAN_RP, _CHAN_RB = 0, 1, 2
_CHAN_PX, _CHAN_PY, _CHAN_PZ = 3, 4, 5


# ---------------------------------------------------------------------------
# 1D value-noise with cosine interpolation.
#
# Standard recipe: hash each integer time step to a value in
# [-1, +1], smoothly interpolate between adjacent steps. The
# perceptual character is set by the base frequency (how fast
# the integer steps go by in real seconds) and the smoothness
# of the interpolation.
#
# We use cosine interpolation (smoother than linear, much cheaper
# than cubic). Determinism is via the global `seed` + the channel's
# per-octave seed offset folded into the hash.
# ---------------------------------------------------------------------------

def _hash_to_unit(i, seed):
    """Hash integer `i` to a float in [-1, +1] deterministically.

    Built from Python's `hash()` so the same `(i, seed)` always
    returns the same value across calls. The bitmask keeps the
    result in 32-bit range so the division is stable.
    """
    h = hash((i, seed)) & 0xFFFFFFFF
    return (h / 0xFFFFFFFF) * 2.0 - 1.0


def _value_noise_1d(t, seed):
    """Sample 1D value-noise at fractional time `t`.

    Integer steps in `t` are independent random samples in
    [-1, +1]; the value between them is cosine-interpolated.
    Returns roughly in [-1, +1] (the cosine interpolation is
    monotonic between the endpoint samples so it can't overshoot).
    """
    import math
    i = math.floor(t)
    f = t - i
    a = _hash_to_unit(int(i),     seed)
    b = _hash_to_unit(int(i) + 1, seed)
    # Cosine interpolation: smooth at the integer boundaries
    # (continuous first derivative), no overshoot.
    mu = (1.0 - math.cos(f * pi)) * 0.5
    return a * (1.0 - mu) + b * mu


def _fbm(t, octaves, base_hz, lacunarity, gain, seed):
    """Fractal Brownian motion: sum of `octaves` value-noise layers
    at geometrically increasing frequencies and decreasing
    amplitudes.

    The output range is roughly [-1, +1] when `gain < 0.5` and
    `lacunarity > 2.0` (the geometric series of amplitudes is
    bounded). For gain ~0.5 the theoretical bound is 2 but in
    practice samples stay well under 1.5 because the noise terms
    don't all peak together.

    Critically: octaves at incommensurate frequencies produce
    aperiodic interference. That's where the "big slow moves with
    smaller faster moves layered on top" perceptual character
    comes from — exactly what we couldn't get from a small sum of
    pure sines.
    """
    total = 0.0
    amp = 1.0
    hz = base_hz
    for octave_idx in range(octaves):
        # Each octave gets its own seed slice so the layers don't
        # have correlated patterns (which would visibly defeat the
        # purpose of layering).
        layer_seed = (seed, octave_idx)
        total += amp * _value_noise_1d(t * hz, hash(layer_seed))
        amp *= gain
        hz *= lacunarity
    return total


# ---------------------------------------------------------------------------
# Layered-noise channel config.
#
#   pre / post: each is a dict of fBm parameters. None disables
#   that band for that channel.
#
#   base_hz:    frequency of the first (lowest) octave, in Hz.
#               This sets the dominant timescale of the channel.
#   amplitude:  scalar applied to the fBm output. For rotation,
#               radians. For position, viewport fraction.
#   octaves:    number of layered samples. 4-6 is the sweet spot
#               for handheld — enough for visible variability,
#               not so many it averages back to silence.
#   lacunarity: frequency multiplier per octave. 2.0 is standard.
#               Slightly off integer multiples (e.g. 2.13) help
#               avoid faint periodicity from frequency alignment.
#   gain:       amplitude multiplier per octave. 0.5 gives the
#               classic fBm rolloff; lower = more dominant low-freq
#               (slower-feeling motion), higher = more equal-octave
#               (busier).
# ---------------------------------------------------------------------------

# Handheld profile.
#
# Calibration intent (ranges from motor-control / cinematography
# reference):
# - Rotation drift: dominant around 0.5-1.5 Hz, amplitude up to
#   ±0.5° (~0.009 rad). This is operator postural sway, breathing,
#   slow lean.
# - Rotation tremor: 4-8 Hz physiological band, amplitude ~0.1°
#   (~0.0017 rad). This is muscle tremor visible as micro-jitter.
# - Position translation: a half-percent of viewport drift, dominated
#   by Y (vertical bob) and X (lateral sway); Z mostly slow drift.
# - Pitch larger than heading larger than bank — operators nod more
#   than they pan-drift.
#
# Per-channel amplitudes are bigger than the old sine values
# because fBm's *peak* is roughly equal to its `amplitude` field
# (rare moments), but its *RMS* is much less (~0.3×). So sized to
# the peak we want to allow.
#
# Lacunarity values are slightly above 2.0 to avoid integer-
# octave alignment that produces faint periodicity. Gain is
# 0.5 for rotation drift (clean low-freq dominance) and
# 0.55 for tremor (busier, less monotonic micro-jitter).

_HANDHELD = {
    # Tuning notes (after several rounds with the user):
    # - Base frequencies were halved from the earlier pass so the
    #   dominant timescale reads as "operator drift" not "jittery
    #   shake." Lacunarity reduced from ~2.1 to ~1.65 so the higher
    #   octaves carry less amplitude relative to the base —
    #   visually this puts more weight on the low frequencies.
    # - Tremor base freq reduced too; 4-6 Hz read as "too fast" in
    #   playback. 2-2.5 Hz feels like real muscle/hand tremor.
    # - Amplitudes preserved; the user dials magnitude via Strength
    #   (which now ranges 0..3.0).
    _CHAN_RH: {  # heading, radians
        "pre":  dict(base_hz=0.30, amplitude=0.035,  octaves=5, lacunarity=1.65, gain=0.62),
        "post": dict(base_hz=2.20, amplitude=0.0050, octaves=4, lacunarity=1.75, gain=0.55),
    },
    _CHAN_RP: {  # pitch, radians (larger than heading — operators nod)
        "pre":  dict(base_hz=0.38, amplitude=0.045,  octaves=5, lacunarity=1.65, gain=0.62),
        "post": dict(base_hz=2.50, amplitude=0.0060, octaves=4, lacunarity=1.72, gain=0.55),
    },
    _CHAN_RB: {  # bank, radians
        "pre":  dict(base_hz=0.22, amplitude=0.020,  octaves=4, lacunarity=1.65, gain=0.62),
        "post": dict(base_hz=1.80, amplitude=0.0028, octaves=3, lacunarity=1.75, gain=0.55),
    },
    _CHAN_PX: {  # lateral sway
        "pre":  dict(base_hz=0.28, amplitude=0.010,  octaves=5, lacunarity=1.65, gain=0.60),
        "post": dict(base_hz=2.80, amplitude=0.0012, octaves=4, lacunarity=1.70, gain=0.55),
    },
    _CHAN_PY: {  # vertical bob (largest position channel)
        "pre":  dict(base_hz=0.35, amplitude=0.013,  octaves=5, lacunarity=1.65, gain=0.60),
        "post": dict(base_hz=3.00, amplitude=0.0016, octaves=4, lacunarity=1.72, gain=0.55),
    },
    _CHAN_PZ: {  # forward/back drift only
        "pre":  dict(base_hz=0.18, amplitude=0.006,  octaves=4, lacunarity=1.65, gain=0.60),
        "post": None,
    },
}


_ZERO3 = (0.0, 0.0, 0.0)
_ZERO_SAMPLE = {
    "rot_pre":  _ZERO3,
    "rot_post": _ZERO3,
    "pos_pre":  _ZERO3,
    "pos_post": _ZERO3,
}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def sample_profile(profile_id, frame, fps, seed,
                   walking=False, step_rate_hz=1.8, speed=1.0):
    """Sample the named noise profile at integer `frame`. Returns a
    NoiseSample dict:

        {
          "rot_pre":  (dh, dp, db) radians,             BEFORE spring
          "rot_post": (dh, dp, db) radians,             AFTER  spring
          "pos_pre":  (dx, dy, dz) viewport fractions,  BEFORE spring
          "pos_post": (dx, dy, dz) viewport fractions,  AFTER  spring
        }

    Position values are unitless viewport fractions; the caller
    converts to world units using the camera's FOV and a reference
    distance.

    `seed` perturbs the noise everywhere so two tags using the same
    profile produce visibly different shake.

    When `walking=True`, a periodic walk-cycle layer is added on top
    of the aperiodic handheld noise: vertical bob and pitch nod at
    2× `step_rate_hz` (head goes up and dips forward on each
    footstrike — twice per stride), lateral sway and bank lean at
    1× step rate (weight shift, one cycle per stride). Heading is
    unaffected — the operator's gaze stays forward through the
    walk. The walk cycle lands in the `*_pre` bands so the spring
    can shape it into a believable bounce with weight.
    """
    if profile_id == PROFILE_HANDHELD:
        return _sample_handheld(frame, fps, seed, walking, step_rate_hz, speed)
    return _ZERO_SAMPLE


def zero_sample():
    """The all-zeros NoiseSample. Useful as a sentinel in callers
    that want to unconditionally add a sample value."""
    return _ZERO_SAMPLE


# ---------------------------------------------------------------------------
# Implementation
# ---------------------------------------------------------------------------

def _sample_handheld(frame, fps, seed, walking, step_rate_hz, speed):
    # `speed` multiplies time — 0.5 = slower (lazier) noise, 2.0 =
    # faster. Applied to the fBm noise's `t` and NOT to the walk
    # cycle (the walk cycle has its own Step Rate control).
    raw_t = float(frame) / max(1.0, float(fps))
    t = raw_t * max(0.01, float(speed))
    rh_pre, rh_post = _eval_channel(_CHAN_RH, t, seed)
    rp_pre, rp_post = _eval_channel(_CHAN_RP, t, seed)
    rb_pre, rb_post = _eval_channel(_CHAN_RB, t, seed)
    px_pre, px_post = _eval_channel(_CHAN_PX, t, seed)
    py_pre, py_post = _eval_channel(_CHAN_PY, t, seed)
    pz_pre, pz_post = _eval_channel(_CHAN_PZ, t, seed)

    if walking and step_rate_hz > 0.0:
        # Walk cycle uses real time (not the speed-scaled time), so
        # Step Rate is the user's single control over walking tempo.
        wp_x, wp_y, wr_p, wr_b = _walk_cycle(raw_t, step_rate_hz, seed)
        # Walk lands POST-spring so it reads as a clean periodic
        # gait signature (the spring's low-pass would otherwise eat
        # the 2× footstrike frequency and smear the bob).
        px_post += wp_x
        py_post += wp_y
        rp_post += wr_p
        rb_post += wr_b

    return {
        "rot_pre":  (rh_pre,  rp_pre,  rb_pre),
        "rot_post": (rh_post, rp_post, rb_post),
        "pos_pre":  (px_pre,  py_pre,  pz_pre),
        "pos_post": (px_post, py_post, pz_post),
    }


# ---------------------------------------------------------------------------
# Walk cycle.
#
# Phenomenology (what real walking-with-a-camera looks like):
# - Vertical bob: head goes up and down TWICE per stride — once
#   per footstrike. So bob frequency = 2 × step rate.
# - Lateral sway: weight shifts foot-to-foot ONCE per stride.
#   Sway frequency = 1 × step rate.
# - Pitch nod: small forward nod on each footstrike, same frequency
#   as vertical bob (2× step rate), phase-aligned so the head dips
#   forward exactly when it dips down.
# - Bank lean: body leans toward the planted foot. Same frequency
#   as lateral sway (1× step rate), phase-aligned with sway.
# - Heading: gaze stays forward through the walk; no walking-induced
#   heading component.
#
# Amplitudes are sized so Walking=True feels physically credible at
# default Step Rate (1.8 Hz) without overwhelming the underlying
# noise. Position values are viewport fractions (the caller converts
# to world units); rotations are radians.
# ---------------------------------------------------------------------------

def _walk_cycle(t, step_rate_hz, seed):
    """Sample the walk cycle at time `t`. Returns
    (pos_x_sway, pos_y_bob, rot_pitch_nod, rot_bank_lean).

    All four are pre-spring; the spring smooths them into a
    weighty bounce/sway. Returns viewport fractions for position,
    radians for rotation.

    `seed` jitters the phase so two tags with different seeds
    don't bob in perfect sync.
    """
    # Stable per-tag phase offset so two tags don't lock together.
    phase = _hash_to_unit(0, hash((seed, "walk_phase"))) * pi
    # Footstrike frequency (head bobs once per foot).
    fs_hz = 2.0 * step_rate_hz
    # Stride frequency (one full cycle per left-right pair).
    sd_hz = step_rate_hz
    fs = 2.0 * pi * fs_hz * t + phase
    sd = 2.0 * pi * sd_hz * t + phase

    # Walk amplitudes — sized for visibility now that the walk
    # cycle lands POST-spring (no damping in the way). Bigger than
    # the earlier pre-spring values that were getting attenuated.
    #
    # Vertical bob: dominant signature. Head drops on footstrike and
    # rises between. Negative cosine puts the trough at footstrike.
    bob   = -0.025 * _cos(fs)   # ~2.5% viewport peak
    # Lateral sway: quadrature with bob; sine of stride frequency.
    sway  =  0.018 * _sin(sd)   # ~1.8% viewport peak
    # Pitch nod: forward dip on footstrike — same phase as bob.
    nod   = -0.025 * _cos(fs)   # ~1.4° peak, in phase with bob
    # Bank lean: body leans toward planted foot — same phase as sway.
    lean  =  0.017 * _sin(sd)   # ~1.0° peak, in phase with sway

    return sway, bob, nod, lean


def _sin(x):
    import math
    return math.sin(x)


def _cos(x):
    import math
    return math.cos(x)


def _eval_channel(channel_id, t, seed):
    """Evaluate one channel's two bands. Returns (pre, post)."""
    cfg = _HANDHELD[channel_id]
    pre_cfg  = cfg["pre"]
    post_cfg = cfg["post"]
    # Fold channel id and band marker into the seed so different
    # channels (and the two bands within a channel) sample
    # independent noise patterns from the same global seed.
    pre  = _fbm_with(pre_cfg,  t, hash((seed, channel_id, "pre")))  if pre_cfg  else 0.0
    post = _fbm_with(post_cfg, t, hash((seed, channel_id, "post"))) if post_cfg else 0.0
    return pre, post


def _fbm_with(cfg, t, seed):
    return cfg["amplitude"] * _fbm(
        t,
        octaves=cfg["octaves"],
        base_hz=cfg["base_hz"],
        lacunarity=cfg["lacunarity"],
        gain=cfg["gain"],
        seed=seed,
    )
