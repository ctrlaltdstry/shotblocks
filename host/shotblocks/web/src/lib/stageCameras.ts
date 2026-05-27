import type { Track } from '../store';
import { activeClipAt } from '../useActiveClipRouter';

/** Plan 4.1 — compute the camera-boundary event list that drives the
 *  hidden Stage object's STAGEOBJECT_CLINK animation track.
 *
 *  At every distinct clip-edge frame (any clip's inFrame or outFrame),
 *  emit one event with the top-track-wins camera at that frame. The
 *  C++ side translates each event into a CKey with STEP interpolation
 *  on the Stage's camera-link parameter.
 *
 *  objectId === 0 means "no camera here" — a gap. C4D's renderer falls
 *  back to whatever was the active scene camera before the Stage took
 *  over (or stays on the previous Stage-assigned camera, since STEP
 *  interpolation holds the previous value across gaps; we explicitly
 *  emit a 0-event so the gap is recorded as a deliberate clear).
 *
 *  Why JS computes this (not C++): JS already owns top-track-wins
 *  resolution via activeClipAt, used live by useActiveClipRouter.
 *  Reusing the same function guarantees the rendered output matches
 *  what scrubbing shows. */
export interface CameraEvent {
  frame: number;
  objectId: number;
}

export function computeStageEvents(videoTracks: Track[]): CameraEvent[] {
  // Collect every distinct boundary frame across all video clips on
  // all visible video tracks. Hidden (eye-off) tracks contribute no
  // events — same rule as activeClipAt (their clips don't participate
  // in camera routing).
  const frames = new Set<number>();
  for (const t of videoTracks) {
    if (!t.visible) continue;
    for (const c of t.clips) {
      frames.add(c.inFrame);
      frames.add(c.outFrame);
    }
  }
  // Sort ascending; resolve each frame via the same top-track-wins
  // resolver the live router uses.
  const sorted = [...frames].sort((a, b) => a - b);
  const events: CameraEvent[] = [];
  // activeClipAt expects a slimmer shape than Track; we already pass
  // the live tracks but cast for the shared resolver.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tracksForResolver = videoTracks as any;
  for (const f of sorted) {
    const active = activeClipAt(f, tracksForResolver);
    const objectId = active ? Math.max(0, active.clip.objectId | 0) : 0;
    events.push({ frame: f, objectId });
  }
  // De-duplicate consecutive events that resolve to the same camera —
  // a STEP track doesn't need a key when the value doesn't change.
  const deduped: CameraEvent[] = [];
  for (const e of events) {
    const prev = deduped[deduped.length - 1];
    if (!prev || prev.objectId !== e.objectId) deduped.push(e);
  }
  return deduped;
}
