import { useRef, type CSSProperties } from 'react';
import { useStore, type Clip } from '../store';

/** Read-only keyframe-dot strip for a video ShotBlock. Renders one
 *  semi-transparent dot per DOCUMENT frame where the clip's referenced
 *  camera (or any of its tags) has a keyframe — a dope-sheet-style
 *  "where is there motion activity" glance, never interactive.
 *
 *  A CHILD of the clip (like BeatDots) so it rides the clip's CSS
 *  transform during a drag with no lag and stays in the clip's stacking
 *  context. Frames come from C++ on every `cameras` push (deduped +
 *  sorted + capped), keyed by objectId in `cameraKeyTimes`. We clip them
 *  to this clip's [inFrame, outFrame) window and position by frame-
 *  fraction — the same basis BeatDots / the waveform use, so dots line
 *  up exactly with the playhead at those frames.
 *
 *  Edge containment: dots are centred on their frame (left:% + the CSS
 *  translateX(-50%)), but a key sitting exactly on the clip's in- or
 *  out-point would then straddle the clip edge and get clipped to a half
 *  dot. So a boundary key is anchored by its EDGE instead — first-frame
 *  key pins flush-left (left:0, no shift), last-frame key pins flush-
 *  right (right:0) — so it shows as a whole dot just inside the clip.
 *
 *  Live retime preview: while this clip is being Alt-retimed
 *  (`retimingClipId === clip.id`), the camera's REAL keyTimes haven't
 *  moved yet (C++ rescales them only on drag-release), so the normal
 *  absolute mapping would drift as the window stretches. But retime
 *  PRESERVES each key's fraction-of-clip — so we snapshot the dot
 *  fractions when the retime starts and hold them while the clip
 *  stretches around them. On release the rescaled-keys echo clears
 *  retimingClipId and the absolute mapping resumes at the SAME fractions
 *  — seamless, no snap.
 *
 *  Hidden on thin clips (the strip would collide with the flipped thin
 *  layout) and when the clip has no keys in view. */
export function KeyframeTicks({ clip, thin }: { clip: Clip; thin: boolean }) {
  // Re-render on horizontal zoom so the fractions stay correct as the
  // clip's pixel width changes (positions are %-based, but reading h
  // keeps this subscribed to the same redraw cadence as the lane).
  const h = useStore((s) => s.h);
  void h;
  const keyTimes = useStore((s) =>
    clip.objectId > 0 ? s.cameraKeyTimes.get(clip.objectId) : undefined,
  );
  const retiming = useStore((s) => s.retimingClipId === clip.id);
  // Snapshot of each in-window dot's fraction-of-clip, captured when this
  // clip's retime begins and held for the drag. null when not retiming.
  const frozenFractions = useRef<number[] | null>(null);

  if (thin || !keyTimes || keyTimes.length === 0) {
    frozenFractions.current = null;
    return null;
  }

  // --- Live retime preview: hold the drag-start fractions ---
  if (retiming) {
    if (frozenFractions.current === null) {
      // Capture once at retime start, from the clip's pre-stretch window.
      const dur = Math.max(1, clip.outFrame - clip.inFrame);
      const fr: number[] = [];
      for (const f of keyTimes) {
        if (f < clip.inFrame || f > clip.outFrame) continue;
        fr.push((f - clip.inFrame) / dur);
      }
      frozenFractions.current = fr;
    }
    const fracs = frozenFractions.current;
    if (fracs.length === 0) return null;
    return (
      <div className="keyframe-dots" aria-hidden="true">
        {fracs.map((fr, i) => {
          // Same edge-containment as the static path, but keyed off the
          // held fraction so the boundary dots stay pinned as the clip
          // stretches.
          const style: CSSProperties =
            fr <= 0 ? { left: 0, transform: 'none' }
            : fr >= 1 ? { right: 0, left: 'auto', transform: 'none' }
            : { left: fr * 100 + '%' };
          return <span key={i} className="keyframe-dot" style={style} />;
        })}
      </div>
    );
  }
  frozenFractions.current = null;

  const clipDuration = Math.max(1, clip.outFrame - clip.inFrame);
  // Keys inside the clip's window. Keys outside simply don't draw (a clip
  // trimmed past its keys shows fewer dots — truthful). Each dot carries
  // its own anchor style so the two boundary cases stay fully contained.
  const dots: CSSProperties[] = [];
  for (const f of keyTimes) {
    if (f < clip.inFrame || f > clip.outFrame) continue;
    if (f === clip.inFrame) {
      // Flush-left: cancel the centring shift so the dot sits just inside
      // the left edge instead of straddling it.
      dots.push({ left: 0, transform: 'none' });
    } else if (f === clip.outFrame) {
      // Flush-right: anchor by the right edge, same reason.
      dots.push({ right: 0, left: 'auto', transform: 'none' });
    } else {
      dots.push({ left: ((f - clip.inFrame) / clipDuration) * 100 + '%' });
    }
  }
  if (dots.length === 0) return null;

  return (
    <div className="keyframe-dots" aria-hidden="true">
      {dots.map((style, i) => (
        <span key={i} className="keyframe-dot" style={style} />
      ))}
    </div>
  );
}
