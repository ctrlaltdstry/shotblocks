"""Shotblocks shot-model helpers.

Pure-function module — no `c4d` import, no canvas references. Operates on
plain dicts representing shots:

    {"id": int, "in_frame": int, "out_frame": int, "cam_name": str, "track": int}

The functions here implement track resolution, edit-point collection,
magnetic snap, and the same-track overlap policies (snap / ripple / replace)
that the canvas applies during drag/resize.
"""


# Model constraints
MAX_TRACKS      = 4    # hard cap on track count
MIN_SHOT_FRAMES = 1    # smallest legal shot duration


def _make_shot(shot_id, in_frame, out_frame, cam_name, track):
    return {
        "id":        shot_id,
        "in_frame":  in_frame,
        "out_frame": out_frame,
        "cam_name":  cam_name,
        "track":     track,
    }


def _shot_track(shot):
    return shot.get("track", 0)


def _shots_on_track(shots, track):
    return [s for s in shots if _shot_track(s) == track]


def _max_used_track(shots):
    if not shots:
        return -1
    return max(_shot_track(s) for s in shots)


def _displayed_lane_count(shots):
    """Lanes to draw: used + 1 preview, capped at MAX_TRACKS, min 1."""
    used = _max_used_track(shots) + 1
    return max(1, min(MAX_TRACKS, used + 1))


def _active_shot_at(shots, frame):
    """Highest-track shot covering `frame`, or None.
    Documents the resolver semantics; not yet wired to camera output (v5+)."""
    candidates = [s for s in shots
                  if s["in_frame"] <= frame <= s["out_frame"]]
    if not candidates:
        return None
    candidates.sort(key=lambda s: (_shot_track(s), s["id"]), reverse=True)
    return candidates[0]


# ---------------------------------------------------------------------------
# Magnetic snap (cross-track edit-point alignment)
# ---------------------------------------------------------------------------

def _collect_edit_points(shots, exclude_id=None):
    """All cross-track edit points: every shot's in_frame and (out_frame + 1).
    For hard cuts, those are the same set of values where one clip yields to
    the next. Excludes the dragged shot to avoid self-snapping."""
    pts = set()
    for s in shots:
        if s["id"] == exclude_id:
            continue
        pts.add(s["in_frame"])
        pts.add(s["out_frame"] + 1)
    return pts


def _magnetic_snap_position(shots, target_id, want_in, want_out, snap_frames):
    """Magnetically pull (want_in, want_out) toward the nearest edit point
    if either edge is within `snap_frames` of one. Edit points come from ALL
    tracks (Resolve/Premiere convention). Returns (snapped_in, snapped_out)
    with the shot's duration preserved. Outside the threshold, returns the
    inputs unchanged — the drag continues freely."""
    if snap_frames <= 0:
        return want_in, want_out
    edit_points = _collect_edit_points(shots, exclude_id=target_id)
    if not edit_points:
        return want_in, want_out

    best_offset = 0
    best_dist   = snap_frames + 1
    for ep in edit_points:
        # Align dragged shot's IN to this edit point
        d = ep - want_in
        if abs(d) < best_dist:
            best_dist, best_offset = abs(d), d
        # Align dragged shot's "cut after" (out + 1) to this edit point
        d = ep - (want_out + 1)
        if abs(d) < best_dist:
            best_dist, best_offset = abs(d), d

    if best_dist <= snap_frames:
        return want_in + best_offset, want_out + best_offset
    return want_in, want_out


def _magnetic_snap_edge(shots, target_id, edge_frame, snap_frames):
    """Pull a single resize edge to the nearest cross-track edit point within
    `snap_frames`. `edge_frame` is the frame the moved edge would land on
    (treat both 'left in_frame' and 'right (out_frame + 1)' as edit-point
    candidates — the caller passes whichever one to align). Returns the
    snapped edge frame."""
    if snap_frames <= 0:
        return edge_frame
    edit_points = _collect_edit_points(shots, exclude_id=target_id)
    if not edit_points:
        return edge_frame
    best = edge_frame
    best_dist = snap_frames + 1
    for ep in edit_points:
        d = abs(ep - edge_frame)
        if d <= snap_frames and d < best_dist:
            best_dist, best = d, ep
    return best


# ---------------------------------------------------------------------------
# Same-track overlap resolution (snap / ripple / replace)
# ---------------------------------------------------------------------------

def _resolve_position(shots, target_id, want_in, want_track, mode, snap_frames=0):
    """Resolve a body-drag move. Returns the new shot list."""
    shots = [dict(s) for s in shots]
    target = next((s for s in shots if s["id"] == target_id), None)
    if target is None:
        return shots

    duration = target["out_frame"] - target["in_frame"]
    target["track"] = max(0, min(MAX_TRACKS - 1, want_track))
    target["in_frame"]  = max(0, want_in)
    target["out_frame"] = target["in_frame"] + duration

    if mode == "snap":
        # Cross-track magnetic snap; falls through to replace if same-track
        # overlap remains after snapping (i.e., user dragged past the snap zone).
        new_in, new_out = _magnetic_snap_position(
            shots, target_id, target["in_frame"], target["out_frame"], snap_frames)
        target["in_frame"]  = new_in
        target["out_frame"] = new_out
        shots = _replace_overlap(shots, target)
    elif mode == "ripple":
        shots = _ripple_around(shots, target)
    elif mode == "replace":
        shots = _replace_overlap(shots, target)

    return shots


def _resolve_resize(shots, target_id, edge, want_frame, mode, snap_frames=0):
    """Resolve an edge-drag resize. `edge` is "left" or "right";
    `want_frame` is the desired new edge frame."""
    shots = [dict(s) for s in shots]
    target = next((s for s in shots if s["id"] == target_id), None)
    if target is None:
        return shots

    if edge == "left":
        target["in_frame"] = max(0, min(want_frame, target["out_frame"] - MIN_SHOT_FRAMES))
    else:
        target["out_frame"] = max(want_frame, target["in_frame"] + MIN_SHOT_FRAMES)

    if mode == "snap":
        if edge == "left":
            snapped = _magnetic_snap_edge(shots, target_id,
                                          target["in_frame"], snap_frames)
            target["in_frame"] = max(0, min(snapped, target["out_frame"] - MIN_SHOT_FRAMES))
        else:
            # The "cut after" is out_frame + 1 — snap that to an edit point,
            # then convert back to out_frame.
            snapped = _magnetic_snap_edge(shots, target_id,
                                          target["out_frame"] + 1, snap_frames)
            target["out_frame"] = max(target["in_frame"] + MIN_SHOT_FRAMES, snapped - 1)
        shots = _replace_overlap(shots, target)
    elif mode == "ripple":
        shots = _ripple_around(shots, target)
    elif mode == "replace":
        shots = _replace_overlap(shots, target)

    return shots


def _ripple_around(shots, target):
    """Push same-track shots later/earlier so target's range is clear.
    Preserves each pushed shot's duration."""
    out = [s for s in shots if s["id"] == target["id"] or _shot_track(s) != _shot_track(target)]
    # Sort same-track shots (excluding target) by in_frame
    same = sorted(
        [s for s in shots if s["id"] != target["id"] and _shot_track(s) == _shot_track(target)],
        key=lambda s: s["in_frame"])

    cursor = target["out_frame"] + 1
    pushed_right = False
    for s in same:
        if s["in_frame"] >= target["in_frame"]:
            # Ensure this shot starts no earlier than cursor
            if s["in_frame"] < cursor:
                dur = s["out_frame"] - s["in_frame"]
                s = dict(s)
                s["in_frame"]  = cursor
                s["out_frame"] = cursor + dur
                pushed_right = True
            cursor = s["out_frame"] + 1
        out.append(s)

    if not pushed_right:
        # Try pushing earlier shots leftward instead
        cursor = target["in_frame"] - 1
        out = [s for s in shots if s["id"] == target["id"] or _shot_track(s) != _shot_track(target)]
        for s in sorted(same, key=lambda x: -x["in_frame"]):
            if s["out_frame"] <= target["out_frame"]:
                if s["out_frame"] > cursor:
                    dur = s["out_frame"] - s["in_frame"]
                    s = dict(s)
                    s["out_frame"] = max(MIN_SHOT_FRAMES - 1, cursor)
                    s["in_frame"]  = max(0, s["out_frame"] - dur)
                    cursor = s["in_frame"] - 1
                else:
                    cursor = s["in_frame"] - 1
            out.append(s)

    return out


def _resolve_group_move(shots, target_ids, anchor_id,
                        delta_frames, delta_track,
                        mode, snap_frames=0):
    """Move every shot in target_ids by (delta_frames, delta_track) as a
    rigid group. anchor_id is the shot the user grabbed — used as the
    magnetic-snap reference in snap mode.

    Behaviour:
    - Replace (default): selected shots move as a unit; non-selected
      same-track shots they pass through are trimmed or removed.
    - Snap: magnetic snap is applied based on the anchor shot's edges
      against non-selected shots' edit points; the whole group then
      shifts by the snapped offset, then replace-trim runs.
    - Ripple is treated as replace for v1. Proper group-ripple semantics
      (push the rest of the timeline) is a future enhancement.

    Deltas are clamped so the group never moves below frame 0 or out of
    the [0, MAX_TRACKS-1] track range. Returns the new shot list.
    """
    target_ids = set(target_ids)
    if not target_ids:
        return [dict(s) for s in shots]
    selected = [s for s in shots if s["id"] in target_ids]
    if not selected:
        return [dict(s) for s in shots]

    min_in  = min(s["in_frame"] for s in selected)
    min_trk = min(_shot_track(s) for s in selected)
    max_trk = max(_shot_track(s) for s in selected)
    if min_in + delta_frames < 0:
        delta_frames = -min_in
    if min_trk + delta_track < 0:
        delta_track = -min_trk
    if max_trk + delta_track > MAX_TRACKS - 1:
        delta_track = MAX_TRACKS - 1 - max_trk

    if mode == "snap" and snap_frames > 0:
        anchor = next((s for s in selected if s["id"] == anchor_id), selected[0])
        non_selected = [s for s in shots if s["id"] not in target_ids]
        a_new_in  = anchor["in_frame"]  + delta_frames
        a_new_out = anchor["out_frame"] + delta_frames
        snapped_in, _ = _magnetic_snap_position(
            non_selected, anchor_id, a_new_in, a_new_out, snap_frames)
        delta_frames += (snapped_in - a_new_in)

    moved = []
    for s in selected:
        m = dict(s)
        m["in_frame"]  = s["in_frame"]  + delta_frames
        m["out_frame"] = s["out_frame"] + delta_frames
        m["track"]     = _shot_track(s) + delta_track
        moved.append(m)

    # Iteratively trim non-selected shots that collide with each moved
    # shot. Selected shots maintain their relative arrangement (the rigid
    # shift preserves the originally-valid layout), so they never collide
    # with each other in the final list.
    out = [dict(s) for s in shots if s["id"] not in target_ids]
    for m in moved:
        out.append(m)
        out = _replace_overlap(out, m)
    return out


def _replace_overlap(shots, target):
    """Trim or remove same-track shots whose range intersects target's range."""
    out = []
    for s in shots:
        if s["id"] == target["id"] or _shot_track(s) != _shot_track(target):
            out.append(s)
            continue
        # s is on same track, not the target itself
        if s["out_frame"] < target["in_frame"] or s["in_frame"] > target["out_frame"]:
            out.append(s)
            continue
        # Overlaps target — trim or drop
        if s["in_frame"] >= target["in_frame"] and s["out_frame"] <= target["out_frame"]:
            # Fully covered — drop
            continue
        s = dict(s)
        if s["in_frame"] < target["in_frame"] and s["out_frame"] <= target["out_frame"]:
            # Trim trailing edge
            s["out_frame"] = target["in_frame"] - 1
        elif s["in_frame"] >= target["in_frame"] and s["out_frame"] > target["out_frame"]:
            # Trim leading edge
            s["in_frame"] = target["out_frame"] + 1
        else:
            # Target sits inside s — split or trim trailing (simpler: trim trailing)
            s["out_frame"] = target["in_frame"] - 1
        if s["out_frame"] - s["in_frame"] >= MIN_SHOT_FRAMES:
            out.append(s)
    return out
