"""Quick-zoom behavior for the Shotblocks rig.

Pure functions over floats. No `c4d` import. Models the
documentary / verité / news-camera snap-zoom: operator notices
something interesting, ramps the lens in fast (~0.25s), holds at
the zoomed framing for a beat, then pulls back over a slightly
slower ramp — sometimes all the way to the original framing,
sometimes settling at a partial pull-back.

Architecture: **deterministic Poisson schedule.** Given a seed, a
zoom rate, and a time range, the schedule is fully determined —
scrubbing or looping playback produces zooms at the same moments
every time. Computed on the fly (no precomputed table) by walking
forward from t=0 using the seeded RNG to draw inter-event intervals
and per-event durations.

We cache the schedule on the tag's runtime state and extend it
lazily as time advances. The schedule is recomputed if any of the
relevant parameters change (rate, strength, hold, ramp times,
return probability, seed) — a hash of the param set serves as the
cache key.

Output: a single **multiplier on the camera's focal length**.
Idle = 1.0 (no change to focal length). At zoom peak = `strength`.
Composes cleanly with keyframed focal animation via multiplication.
"""

import math
import random


# Each scheduled zoom event:
#   start_t:   when the snap-in begins (sec from t=0)
#   peak_t:    end of snap-in, beginning of hold
#   pullback_t end of hold, beginning of pull-back
#   end_t:     end of pull-back
#   strength:  multiplier at peak (and at the partial pull-back if
#              return_to is < 1.0)
#   return_to: 1.0 = full return to base, less = partial settle
#   settle_strength: the resting multiplier after end_t, until the
#                    next event starts. 1.0 most of the time; if
#                    return_to < 1.0, this is the partial value.
#
# Events are simple dicts so they're trivial to inspect and to
# extend later (motion-energy-coupled triggering, etc.).


def make_schedule_state():
    """Empty schedule state, stashed on the tag's runtime dict. The
    tag-side caller extends it lazily as playback advances past
    the last event's end time.
    """
    return {
        "events": [],
        "cursor_t": 0.0,    # time we've populated the schedule up to
        "cache_key": None,  # param-hash; schedule rebuilt if changed
    }


def cache_key(rate, strength, hold, ramp_in, ramp_out, return_prob, seed):
    """Hashable tuple of params that affect the schedule. When this
    changes, the schedule must be regenerated."""
    return (round(rate, 4), round(strength, 4), round(hold, 4),
            round(ramp_in, 4), round(ramp_out, 4),
            round(return_prob, 4), int(seed))


def sample_zoom_multiplier(state, t_now, rate, strength, hold,
                           ramp_in, ramp_out, return_prob, seed):
    """Return the focal-length multiplier at time `t_now` (seconds
    from t=0). Lazily extends the schedule on `state` as needed.

    Stateless from the caller's perspective in the sense that
    sampling the same `t_now` twice returns the same value — the
    schedule is fully determined by the params + seed, the `state`
    dict is just a memoization cache.

    Returns 1.0 when no event is active and `return_to` for the
    most-recent event was 1.0; otherwise returns the partial
    settle value from the most-recent event.
    """
    key = cache_key(rate, strength, hold, ramp_in, ramp_out, return_prob, seed)
    if state["cache_key"] != key:
        # Params changed (or first sample). Reset.
        state["events"]   = []
        state["cursor_t"] = 0.0
        state["cache_key"] = key

    # Backward scrub: if the user jumped to a time before the start
    # of our most-recent event, we still want the answer — the
    # schedule starting from t=0 is deterministic, so any cached
    # events still apply. We just need to make sure we have events
    # populated up through `t_now`.
    _extend_schedule_to(state, t_now,
                        rate, strength, hold,
                        ramp_in, ramp_out, return_prob, seed)

    # Find the most recent event whose start_t <= t_now.
    events = state["events"]
    active = None
    settle = 1.0   # resting value if no event has fired yet
    # Walk backward (most events will be near the cursor).
    for ev in reversed(events):
        if ev["start_t"] <= t_now:
            active = ev
            break
    if active is None:
        return 1.0

    if t_now >= active["end_t"]:
        return active["settle_strength"]

    return _eval_event(active, t_now)


def _extend_schedule_to(state, t_target,
                        rate, strength, hold,
                        ramp_in, ramp_out, return_prob, seed):
    """Populate events until the schedule covers up to `t_target`."""
    if rate <= 0.0:
        return
    rng = _rng_at(state["cursor_t"], seed)
    settle_prev = state["events"][-1]["settle_strength"] if state["events"] else 1.0

    cursor = state["cursor_t"]
    safety = 0
    # Cap so we never loop forever on a pathological rate.
    while cursor < t_target and safety < 10000:
        # Inter-arrival from Poisson: exponentially distributed.
        # rng.expovariate is parameterized by 1/mean — here mean is
        # 1/rate seconds, so we pass `rate` directly.
        gap = rng.expovariate(max(0.001, rate))
        start_t = cursor + gap
        if start_t > t_target + 60.0:
            # Don't speculatively schedule far past the request.
            break

        # Per-event jitter on durations (±30% lognormal-ish) so the
        # rhythm doesn't feel mechanical.
        ev_strength = strength * rng.uniform(0.75, 1.10)
        # Clamp so we never drop below 1.0 (a zoom OUT would feel
        # like a separate effect and isn't what the user asked for).
        if ev_strength < 1.05:
            ev_strength = 1.05
        ev_ramp_in  = ramp_in  * rng.uniform(0.7, 1.3)
        ev_ramp_out = ramp_out * rng.uniform(0.7, 1.3)
        ev_hold     = hold     * rng.uniform(0.6, 1.4)

        return_full = rng.random() < return_prob
        if return_full:
            return_to = 1.0
        else:
            # Partial pull-back: settle somewhere between base and
            # peak, biased toward a 30-60% pull-back.
            return_to = rng.uniform(0.3, 0.7)
        settle_strength = 1.0 + (ev_strength - 1.0) * (1.0 - return_to)

        peak_t     = start_t + ev_ramp_in
        pullback_t = peak_t  + ev_hold
        end_t      = pullback_t + ev_ramp_out

        state["events"].append({
            "start_t":         start_t,
            "peak_t":          peak_t,
            "pullback_t":      pullback_t,
            "end_t":           end_t,
            "strength":        ev_strength,
            "settle_target":   settle_strength,
            "settle_strength": settle_strength,
            "settle_prev":     settle_prev,
        })
        settle_prev = settle_strength
        cursor = end_t
        safety += 1

    state["cursor_t"] = cursor


def _eval_event(ev, t):
    """Compute the multiplier at time `t` for an event we know is
    active (start_t <= t < end_t).

    Four phases:
      [start_t .. peak_t):     ramp from settle_prev → strength
      [peak_t .. pullback_t):  hold at strength
      [pullback_t .. end_t):   ramp from strength → settle_strength
      (>= end_t):              handled by caller (returns settle)
    """
    if t < ev["peak_t"]:
        u = _safe_div(t - ev["start_t"], ev["peak_t"] - ev["start_t"])
        return _lerp(ev["settle_prev"], ev["strength"], _ease_in_out(u))
    if t < ev["pullback_t"]:
        return ev["strength"]
    u = _safe_div(t - ev["pullback_t"], ev["end_t"] - ev["pullback_t"])
    return _lerp(ev["strength"], ev["settle_strength"], _ease_in_out(u))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _rng_at(t_cursor, seed):
    """Seed an RNG deterministically from (seed, cursor). The cursor
    is conceptually "where the previous event ended"; folding it
    into the seed means each event is independent but reproducible.

    Python's `random.Random()` only accepts int/float/str/bytes as
    seed in 3.12+ (tuples no longer work), so we fold (seed, cursor)
    into a single int via the built-in hash, masked to 32 bits.
    """
    millis = int(t_cursor * 1000.0)
    combined = hash((int(seed), millis)) & 0xFFFFFFFF
    return random.Random(combined)


def _safe_div(a, b):
    return a / b if abs(b) > 1e-9 else 0.0


def _lerp(a, b, t):
    return a + (b - a) * t


def _ease_in_out(t):
    """Smoothstep — eases the start and end of each ramp so the
    snap-in/pull-out feels operator-driven, not linear-tween."""
    if t <= 0.0:
        return 0.0
    if t >= 1.0:
        return 1.0
    return t * t * (3.0 - 2.0 * t)
