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
# Minimum frame gap between two adjacent same-track shots. With a
# gap of 1, shots A and B abut as: A.out_frame == N → B.in_frame
# == N + 2 (frame N+1 is empty between them). The single empty
# frame renders as a small visual gap at most zooms, and editorially
# avoids two clips "sharing" a boundary frame. Snap targets, ripple,
# and overlap-trim all respect this constant.
CLIP_GAP_FRAMES = 0


def _make_shot(shot_id, in_frame, out_frame, cam_name, track):
    return {
        "id":        shot_id,
        "in_frame":  in_frame,
        "out_frame": out_frame,
        "cam_name":  cam_name,
        "track":     track,
        # v10: per-shot rig overrides. Empty by default; the editing
        # UI lands in v11. Keys (any optional):
        #   damping_pos, damping_rot, damping_focal, damping_focus  (float)
        #   mode_override: "additive" | "replace" | None
        # The dialog reads this at active-shot transitions and pushes
        # non-None values into the tag's runtime cache via
        # sb_rig_tag.push_overrides().
        "rig_state": {},
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

def _collect_edit_points(shots, exclude_id=None, extra_points=None):
    """All cross-track edit points: every shot's in_frame and its
    cut-after frame (`out_frame + 1 + CLIP_GAP_FRAMES`). The cut-after
    point is where the *next* clip's in_frame would land — accounting
    for the required `CLIP_GAP_FRAMES` empty frames between adjacent
    clips. Excludes the dragged shot to avoid self-snapping.

    `extra_points` is an optional iterable of additional snap targets
    the caller wants treated as edit points — e.g. the playhead
    frame, the play-range in/out, or any future user-defined markers."""
    pts = set()
    for s in shots:
        if s["id"] == exclude_id:
            continue
        pts.add(s["in_frame"])
        pts.add(s["out_frame"] + 1 + CLIP_GAP_FRAMES)
    if extra_points:
        for p in extra_points:
            pts.add(int(p))
    return pts


def _magnetic_snap_position(shots, target_id, want_in, want_out, snap_frames,
                            extra_points=None):
    """Magnetically pull (want_in, want_out) toward the nearest edit point
    if either edge is within `snap_frames` of one. Edit points come from ALL
    tracks (Resolve/Premiere convention). Returns (snapped_in, snapped_out,
    snapped_targets) where `snapped_targets` is a sorted tuple of the
    edit-point frames that the result aligned with — used by the canvas
    to draw snap-indicator lines. Outside the threshold, returns the
    inputs unchanged with an empty targets tuple."""
    if snap_frames <= 0:
        return want_in, want_out, ()
    edit_points = _collect_edit_points(shots, exclude_id=target_id,
                                       extra_points=extra_points)
    if not edit_points:
        return want_in, want_out, ()

    best_offset = 0
    best_dist   = snap_frames + 1
    # Dragged shot's "cut after" is (out + 1 + CLIP_GAP_FRAMES): the
    # frame the NEXT clip would start at if abutting (with gap).
    drag_cut_after = want_out + 1 + CLIP_GAP_FRAMES
    for ep in edit_points:
        # Align dragged shot's IN to this edit point
        d = ep - want_in
        if abs(d) < best_dist:
            best_dist, best_offset = abs(d), d
        # Align dragged shot's "cut after" to this edit point
        d = ep - drag_cut_after
        if abs(d) < best_dist:
            best_dist, best_offset = abs(d), d

    if best_dist <= snap_frames:
        new_in  = want_in  + best_offset
        new_out = want_out + best_offset
        new_cut_after = new_out + 1 + CLIP_GAP_FRAMES
        # Report every edit point the snapped shot's IN or
        # cut-after lands on, so the canvas can draw an indicator
        # at each.
        targets = []
        if new_in in edit_points:
            targets.append(new_in)
        if new_cut_after in edit_points and new_cut_after != new_in:
            targets.append(new_cut_after)
        return new_in, new_out, tuple(sorted(targets))
    return want_in, want_out, ()


def _magnetic_snap_edge(shots, target_id, edge_frame, snap_frames,
                        extra_points=None):
    """Pull a single resize edge to the nearest cross-track edit point within
    `snap_frames`. `edge_frame` is the frame the moved edge would land on
    (treat both 'left in_frame' and 'right (out_frame + 1)' as edit-point
    candidates — the caller passes whichever one to align). Returns
    (snapped_edge_frame, snapped_targets) where snapped_targets is a tuple
    containing the snap target frame, or empty if no snap occurred."""
    if snap_frames <= 0:
        return edge_frame, ()
    edit_points = _collect_edit_points(shots, exclude_id=target_id,
                                       extra_points=extra_points)
    if not edit_points:
        return edge_frame, ()
    best = edge_frame
    best_dist = snap_frames + 1
    for ep in edit_points:
        d = abs(ep - edge_frame)
        if d <= snap_frames and d < best_dist:
            best_dist, best = d, ep
    if best != edge_frame:
        return best, (best,)
    return edge_frame, ()


# ---------------------------------------------------------------------------
# Same-track overlap resolution (snap / ripple / replace)
# ---------------------------------------------------------------------------

def _resolve_position(shots, target_id, want_in, want_track, mode, snap_frames=0,
                      extra_points=None):
    """Resolve a body-drag move. Returns (new_shot_list, snap_targets)
    where snap_targets is a tuple of edit-point frames the snap aligned
    with (empty when no snap occurred or mode != 'snap')."""
    shots = [dict(s) for s in shots]
    target = next((s for s in shots if s["id"] == target_id), None)
    if target is None:
        return shots, ()

    duration = target["out_frame"] - target["in_frame"]
    target["track"] = max(0, min(MAX_TRACKS - 1, want_track))
    target["in_frame"]  = max(0, want_in)
    target["out_frame"] = target["in_frame"] + duration

    snap_targets = ()
    if mode == "snap":
        # Cross-track magnetic snap; falls through to replace if same-track
        # overlap remains after snapping (i.e., user dragged past the snap zone).
        new_in, new_out, snap_targets = _magnetic_snap_position(
            shots, target_id, target["in_frame"], target["out_frame"],
            snap_frames, extra_points=extra_points)
        target["in_frame"]  = new_in
        target["out_frame"] = new_out
        shots = _replace_overlap(shots, target)
    elif mode == "ripple":
        shots = _ripple_around(shots, target)
    elif mode == "replace":
        shots = _replace_overlap(shots, target)

    return shots, snap_targets


def _resolve_resize(shots, target_id, edge, want_frame, mode, snap_frames=0,
                    extra_points=None):
    """Resolve an edge-drag resize. Returns (new_shot_list, snap_targets)."""
    shots = [dict(s) for s in shots]
    target = next((s for s in shots if s["id"] == target_id), None)
    if target is None:
        return shots, ()

    if edge == "left":
        target["in_frame"] = max(0, min(want_frame, target["out_frame"] - MIN_SHOT_FRAMES))
    else:
        target["out_frame"] = max(want_frame, target["in_frame"] + MIN_SHOT_FRAMES)

    snap_targets = ()
    if mode == "snap":
        if edge == "left":
            snapped, snap_targets = _magnetic_snap_edge(
                shots, target_id, target["in_frame"], snap_frames,
                extra_points=extra_points)
            target["in_frame"] = max(0, min(snapped, target["out_frame"] - MIN_SHOT_FRAMES))
        else:
            # The "cut after" is out_frame + 1 + CLIP_GAP_FRAMES —
            # the next clip's in_frame would land here if abutting
            # with the required gap. Snap that to an edit point,
            # then convert back to out_frame.
            cut_after = target["out_frame"] + 1 + CLIP_GAP_FRAMES
            snapped, snap_targets = _magnetic_snap_edge(
                shots, target_id, cut_after, snap_frames,
                extra_points=extra_points)
            target["out_frame"] = max(
                target["in_frame"] + MIN_SHOT_FRAMES,
                snapped - 1 - CLIP_GAP_FRAMES)
        shots = _replace_overlap(shots, target)
    elif mode == "ripple":
        shots = _ripple_around(shots, target)
    elif mode == "replace":
        shots = _replace_overlap(shots, target)

    return shots, snap_targets


def _ripple_around(shots, target):
    """Push same-track shots later/earlier so target's range is clear.
    Preserves each pushed shot's duration."""
    out = [s for s in shots if s["id"] == target["id"] or _shot_track(s) != _shot_track(target)]
    # Sort same-track shots (excluding target) by in_frame
    same = sorted(
        [s for s in shots if s["id"] != target["id"] and _shot_track(s) == _shot_track(target)],
        key=lambda s: s["in_frame"])

    # Cursor tracks "the frame the next shot's in_frame can land
    # on" — `out_frame + 1 + CLIP_GAP_FRAMES` keeps the required
    # empty frame(s) between adjacent shots.
    cursor = target["out_frame"] + 1 + CLIP_GAP_FRAMES
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
            cursor = s["out_frame"] + 1 + CLIP_GAP_FRAMES
        out.append(s)

    if not pushed_right:
        # Try pushing earlier shots leftward instead. Symmetric:
        # cursor tracks the frame the next earlier shot's out_frame
        # can land on — `in_frame - 1 - CLIP_GAP_FRAMES`.
        cursor = target["in_frame"] - 1 - CLIP_GAP_FRAMES
        out = [s for s in shots if s["id"] == target["id"] or _shot_track(s) != _shot_track(target)]
        for s in sorted(same, key=lambda x: -x["in_frame"]):
            if s["out_frame"] <= target["out_frame"]:
                if s["out_frame"] > cursor:
                    dur = s["out_frame"] - s["in_frame"]
                    s = dict(s)
                    s["out_frame"] = max(MIN_SHOT_FRAMES - 1, cursor)
                    s["in_frame"]  = max(0, s["out_frame"] - dur)
                    cursor = s["in_frame"] - 1 - CLIP_GAP_FRAMES
                else:
                    cursor = s["in_frame"] - 1 - CLIP_GAP_FRAMES
            out.append(s)

    return out


def _resolve_group_move(shots, target_ids, anchor_id,
                        delta_frames, delta_track,
                        mode, snap_frames=0, extra_points=None):
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
        return [dict(s) for s in shots], ()
    selected = [s for s in shots if s["id"] in target_ids]
    if not selected:
        return [dict(s) for s in shots], ()

    min_in  = min(s["in_frame"] for s in selected)
    min_trk = min(_shot_track(s) for s in selected)
    max_trk = max(_shot_track(s) for s in selected)
    if min_in + delta_frames < 0:
        delta_frames = -min_in
    if min_trk + delta_track < 0:
        delta_track = -min_trk
    if max_trk + delta_track > MAX_TRACKS - 1:
        delta_track = MAX_TRACKS - 1 - max_trk

    snap_targets = ()
    if mode == "snap" and snap_frames > 0:
        anchor = next((s for s in selected if s["id"] == anchor_id), selected[0])
        non_selected = [s for s in shots if s["id"] not in target_ids]
        a_new_in  = anchor["in_frame"]  + delta_frames
        a_new_out = anchor["out_frame"] + delta_frames
        snapped_in, _, snap_targets = _magnetic_snap_position(
            non_selected, anchor_id, a_new_in, a_new_out, snap_frames,
            extra_points=extra_points)
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
    return out, snap_targets


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
        # Trims leave a CLIP_GAP_FRAMES-frame gap between the
        # trimmed clip and the target so adjacent clips never share
        # a boundary frame (and visually never touch).
        if s["in_frame"] < target["in_frame"] and s["out_frame"] <= target["out_frame"]:
            # Trim trailing edge
            s["out_frame"] = target["in_frame"] - 1 - CLIP_GAP_FRAMES
        elif s["in_frame"] >= target["in_frame"] and s["out_frame"] > target["out_frame"]:
            # Trim leading edge
            s["in_frame"] = target["out_frame"] + 1 + CLIP_GAP_FRAMES
        else:
            # Target sits inside s — split or trim trailing (simpler: trim trailing)
            s["out_frame"] = target["in_frame"] - 1 - CLIP_GAP_FRAMES
        if s["out_frame"] - s["in_frame"] >= MIN_SHOT_FRAMES:
            out.append(s)
    return out
