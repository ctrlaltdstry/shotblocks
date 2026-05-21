import { useStore, type Clip } from '../store';

/** Small green dots on an audio clip's TOP edge, one per detected
 *  beat — the connector between the clip and the beat-grid lines
 *  running behind it (Final Cut Pro shows exactly this).
 *
 *  Only BAR downbeats get a dot (every 4th tracked beat), matching the
 *  grid's solid bar lines — a dot per interim beat would be as dense
 *  as the wall we removed. Positions map the media-space peak samples
 *  into the clip's visible window; beats trimmed outside the window
 *  are skipped. */
export function BeatDots({ clip }: { clip: Clip }) {
  const fps = useStore((s) => s.fps);
  const peaks = clip.audioPeaks;
  const sr = clip.audioPeaksSampleRate;
  if (!peaks || !peaks.length || !sr || sr <= 0 || fps <= 0) return null;

  const clipDuration = Math.max(1, clip.outFrame - clip.inFrame);
  const offset = clip.mediaOffsetFrames ?? 0;
  const fpr = fps / sr;

  // Bar downbeats are every 4th beat from the grid's barOffset.
  const barOffset = clip.audioBeatGrid?.barOffset ?? 0;
  const dots: number[] = [];
  for (let i = barOffset; i < peaks.length; i += 4) {
    // Media sample → doc frame → fraction across the clip's width.
    const docFrame = clip.inFrame + (peaks[i] * fpr - offset);
    if (docFrame < clip.inFrame || docFrame > clip.outFrame) continue;
    dots.push(((docFrame - clip.inFrame) / clipDuration) * 100);
  }
  if (!dots.length) return null;

  return (
    <div className="beat-dots">
      {dots.map((pct, i) => (
        <span key={i} className="beat-dot" style={{ left: pct + '%' }} />
      ))}
    </div>
  );
}
