/** What a pointermove resolved to inside a lane stack:
 *   - existing: an existing lane (and its trackId).
 *   - spawn: a not-yet-created lane (V<max+1> / A<max+1>) — the user
 *     pushed past the outermost track or hit its outer spawn band.
 *   - null: pointer off any valid lane on the source side. */
export type LaneTarget =
  | { kind: 'existing'; trackId: string }
  | { kind: 'spawn'; trackId: string }
  | null;

/** Resolve which lane (or spawn-slot) the pointer is over, restricted
 *  to the source clip's side (video↔video, audio↔audio — see memory
 *  v2-audio-source-is-file-only).
 *
 *  Spawn rule: dragging the pointer above the topmost track on the
 *  video side or below the bottommost on the audio side resolves to a
 *  new track one step out (V<max+1> or A<max+1>). Per memory
 *  project_v2_auto_track_lifecycle, tracks are implicit — no add UI. */
export function resolveLane(
  clientX: number,
  clientY: number,
  side: 'video' | 'audio',
): LaneTarget {
  const stack = document.getElementById(
    side === 'video' ? 'lanes-videos' : 'lanes-audios',
  );
  if (!stack) return null;
  const stackRect = stack.getBoundingClientRect();

  // Compute spawn id for this side, so we can return it whether the
  // cursor is past the stack edge or just hovering the outermost lane.
  const lanes = Array.from(stack.querySelectorAll<HTMLElement>('.lane'));
  const ids = lanes
    .map((l) => parseInt((l.getAttribute('data-track') || '').slice(1), 10))
    .filter((n) => Number.isFinite(n));
  const maxId = ids.length ? Math.max(...ids) : 0;
  const spawnId = (side === 'video' ? 'V' : 'A') + (maxId + 1);

  // Resolve which lane the cursor is hovering, if any. We can't use
  // elementsFromPoint because the dragged ShotBlock has its
  // pointer-events set to none during drag — and even with that
  // working, lane lookup by bounding-rect is simpler and more direct.
  let hoverLane: HTMLElement | null = null;
  if (clientX >= stackRect.left && clientX <= stackRect.right) {
    for (const lane of lanes) {
      if (lane.getAttribute('data-side') !== side) continue;
      const r = lane.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) {
        hoverLane = lane;
        break;
      }
    }
  }

  // Cursor inside a lane: check whether we should spawn instead.
  // Spawn rule: when hovering the OUTERMOST track on this side (the
  // V<maxId> for video, A<maxId> for audio), only a THIN band at the
  // lane's outer edge (farthest from the V/A splitter) resolves to a
  // new track. A narrow band — not the whole outer half — so a normal
  // horizontal drag through the lane never accidentally spawns; the
  // user has to deliberately push to the outer edge to create V2.
  if (hoverLane) {
    const trackId = hoverLane.getAttribute('data-track');
    if (!trackId) return null;
    const trackNum = parseInt(trackId.slice(1), 10);
    if (trackNum === maxId) {
      const r = hoverLane.getBoundingClientRect();
      // Spawn band: the outer 22% of the lane, capped at 14px so it
      // stays a thin trigger even on tall lanes.
      const band = Math.min(14, r.height * 0.22);
      // Video: V1 is at the BOTTOM of its stack (closest to splitter),
      // V<max> is at the TOP. So the spawn band is at the lane TOP.
      // Audio: A1 is at the TOP of its stack (closest to splitter),
      // A<max> is at the BOTTOM. So the spawn band is at the lane BOTTOM.
      if (side === 'video' && clientY < r.top + band) {
        return { kind: 'spawn', trackId: spawnId };
      }
      if (side === 'audio' && clientY > r.bottom - band) {
        return { kind: 'spawn', trackId: spawnId };
      }
    }
    return { kind: 'existing', trackId };
  }

  // Cursor outside the stack horizontally → reject.
  if (clientX < stackRect.left || clientX > stackRect.right) return null;

  // Cursor past the outer edge of the stack (above lanes-videos top
  // or below lanes-audios bottom) — also a spawn target. Lets the
  // user "throw" the clip well past the lane to commit a spawn.
  if (side === 'video' && clientY < stackRect.top) {
    return { kind: 'spawn', trackId: spawnId };
  }
  if (side === 'audio' && clientY > stackRect.bottom) {
    return { kind: 'spawn', trackId: spawnId };
  }
  return null;
}
