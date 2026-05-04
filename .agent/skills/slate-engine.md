# Slate Engine

The signature interaction. Read this before touching any code in `src/sequencer/slate.py` or `src/sequencer/motion_energy.py`.

## What slate does

Aligns shots to the rhythm of the music using motion-energy peaks as the alignment signal. Bound to the `S` hotkey. Scales by selection — edge, single shot, multiple shots, all shots — using the same conceptual operation at each scale.

## The two signals

**Beat grid:** from the audio subsystem's onset/beat detection. A list of frame numbers where beats occur, with a downbeat flag per beat.

**Motion-energy curve:** per-shot, computed from the procedural rig's evaluated state. A per-frame scalar combining translational velocity, rotational velocity, and acceleration. Local maxima are action frames; local minima are low-energy frames good for cuts.

## Algorithm by selection size

### Edge slate

Input: one shot edge (in or out point) selected.

1. Find the nearest beat marker within a configurable threshold (default: 4 frames at 24fps).
2. If found, snap the edge to that frame.
3. If ripple-edit modifier is held, shift subsequent shots by the same delta.
4. If roll-edit modifier is held, shift the adjacent shot's matching edge by the same delta.

### Single-shot slate

Input: one shot.

1. Compute the motion-energy curve for the shot.
2. Find the primary action frame (global maximum of the curve, or a configurable secondary peak).
3. Identify the nearest beat that allows aligning the action frame within the shot's duration constraints (`min_duration`, `max_duration`, `max_position_drift`).
4. Compute the required time-shift: `delta = target_beat_frame - current_action_frame`.
5. Apply the shift by adjusting the shot's in and out points (preserving duration), or by retiming if the user has chosen retime mode.
6. Optionally adjust the cut points (in/out) to land on local minima of motion energy near the original positions, so cuts happen during calm moments.

### Multi-shot slate (v1, ships first)

Input: multiple shots selected.

Run single-shot slate on each shot independently, in timeline order. After each shot is slated, propagate the shift to subsequent shots only if it would otherwise cause overlap. Simple, predictable, ships fast.

### Multi-shot slate (v2, sequence-aware)

Input: multiple shots selected.

Optimize over the whole selection: assign each shot's action frame to a beat such that:
- Shot order is preserved
- No shots overlap
- All duration constraints are respected per shot
- Total alignment error (sum of |action_frame - target_beat|) is minimized
- Soft preference for downbeats over offbeats

Dynamic programming over the beat grid is the candidate approach. State: `(shot_index, last_used_beat)`. Transition: pick the next beat that satisfies constraints, accumulate cost. Reconstruct the optimal assignment by backtracking.

This is v2. Do not block v1 on it.

### All slate

Input: empty selection (or "all" hotkey variant).

Same as multi-shot slate applied to every shot on the timeline.

## User parameters

Exposed in a slate settings panel (or as inspector fields when the slate button is selected):

- **Beat target** — `every_beat` / `every_downbeat` / `every_other_downbeat` / `every_bar`
- **Rigidity** — `loose` (allow ±2 frames slack) / `tight` (exact beat alignment)
- **Action weighting** — three sliders: `w_translation`, `w_rotation`, `w_acceleration`. Defaults: 0.3, 0.5, 0.2.
- **Min duration** — shortest allowed shot length after slate (default: 0.5s)
- **Max duration** — longest allowed shot length after slate (default: original duration × 2)
- **Max position drift** — how far a shot is allowed to slide from its current position (default: 1 beat)
- **Cut placement** — `at_action` (cut on the action frame, hard-cut-on-action sensibility) / `before_action` (cut just before, conventional editing wisdom) / `at_calm` (cut on a low-energy frame near the original cut)

## Non-destructive contract

Every slate:
- Records the previous shot positions in the undo stack as a single coalesced action.
- Leaves all shots in normal editable state — no flag, no lock, no special status.
- Allows immediate further drag, resize, or slate without conflict.

If a user slates, drags, slates again — they get a slated version of the dragged version. The plugin does not "remember" the original positions and does not try to be clever about preserving slate intent across user edits.

## Confirmation, not animation

Slate is instant. The shots move to their new positions, the status line says what happened, and the user is immediately free to do the next thing. There is no clap, no flash, no shake, no sound by default.

The status message names the action explicitly:
- "aligned 1 edge to nearest beat"
- "slated 4 shots to downbeats"
- "slated sequence"
- "selection already aligned" (when no change was needed)
- "no valid alignment within constraints" (when slate could not run)

The status message is the *only* mandatory feedback. The visible change to the timeline is the primary signal that the action ran. The user invokes slate dozens of times per session and never waits.

A subtle, fast frame highlight on changed shots (a single-frame border color change, no animation) is acceptable if it helps with legibility on dense timelines. Anything more than that is wrong.

## Edge cases

- **No audio loaded.** Slate falls back to snapping to scene markers, manual markers, or shot edges. If none of those exist, slate does nothing and the status message says so.
- **Audio loaded but no beats detected.** Same fallback as no audio.
- **Shot has no clear action peak.** Use the midpoint of the shot as the alignment target. Status message warns: "no clear action frame, aligned shot center."
- **Selection includes shots that cannot be aligned within constraints.** Skip those shots, slate the rest, status message lists how many were skipped.
- **Beat grid is sparse relative to selection size.** Some shots will land on the same beat target if there aren't enough beats. The optimizer should prefer downbeats and distribute remaining shots; v1 may simply allow shared beats.

## Performance

- Motion-energy curve computation is the most expensive operation. Cache per-shot, invalidate when shot parameters change.
- For all-slate on a 100-shot timeline, total motion-energy computation should complete in under 2 seconds. If it exceeds this, parallelize across shots on a worker thread.
- The actual alignment math (DP or independent loop) is cheap once curves are cached.

## Tuning notes

- The default action-weighting (rotation 0.5, translation 0.3, acceleration 0.2) was chosen because rotation reads more strongly to the eye than translation at typical scene scales. Tune via real-world usage.
- The "at_action" cut-placement default produces music-video pacing. The "before_action" default produces more conventional editing. Pick one as the default based on which user persona is primary in v1; expose the other as a toggle.
- Loose rigidity is more forgiving and produces more natural-feeling sequences. Tight rigidity feels more deliberate and music-video-y. Default to loose; expose tight as a toggle.
