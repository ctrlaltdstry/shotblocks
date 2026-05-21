import { useRef, useState, useEffect } from 'react';
import { useStore, type Clip } from '../store';
import { MIN_BAR_SPACING_PX } from '../lib/beatGridLayout';

/** Beat-grid connector dots — rendered as CHILDREN of an audio
 *  ShotBlock so they ride the clip's CSS transform during a drag with
 *  zero lag, and stay in the clip's own stacking context (never
 *  underneath it). Positioned by frame-fraction within the clip — the
 *  same basis the waveform canvas uses — so they don't drift.
 *
 *    - solid dot per (LOD-surviving) BAR downbeat.
 *    - hollow ring per SONG-PART boundary (FCP-style — distinct).
 *
 *  Bar LOD: bars decimate by a power-of-2 stride so the on-screen gap
 *  stays comfortable, matching BeatGrid's lines. The stride is
 *  derived from this clip's own pixels-per-frame. */
export function BeatDots({ clip }: { clip: Clip }) {
  const fps = useStore((s) => s.fps);
  // Re-render on zoom so the LOD stride recomputes.
  const h = useStore((s) => s.h);
  void h;

  // Measure the clip's pixel width to get pixels-per-frame for LOD.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [clipPxW, setClipPxW] = useState(0);
  useEffect(() => {
    const el = rootRef.current?.parentElement;       // .shot-block
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setClipPxW(el.getBoundingClientRect().width);
    });
    ro.observe(el);
    setClipPxW(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  });

  const peaks = clip.audioPeaks;
  const sr = clip.audioPeaksSampleRate;
  if (!peaks || !peaks.length || !sr || sr <= 0 || fps <= 0) {
    return <div ref={rootRef} className="beat-dots" />;
  }

  const clipDuration = Math.max(1, clip.outFrame - clip.inFrame);
  const offset = clip.mediaOffsetFrames ?? 0;
  const barOffset = clip.audioBeatGrid?.barOffset ?? 0;
  const fpr = fps / sr;

  // LOD stride from this clip's pixels-per-frame.
  let barStride = 1;
  if (clipPxW > 0) {
    const pxPerFrame = clipPxW / clipDuration;
    const g = clip.audioBeatGrid;
    const beatFrames = g && g.periodSamples > 0 ? (g.periodSamples / sr) * fps : 0;
    if (beatFrames > 0) {
      const baseBarSpacing = beatFrames * pxPerFrame * 4;
      while (baseBarSpacing * barStride < MIN_BAR_SPACING_PX && barStride < 1024) {
        barStride *= 2;
      }
    }
  }

  // Bar dots — every (barStride)th bar within the clip's window.
  const barDots: number[] = [];
  let barIdx = -1;
  for (let i = barOffset; i < peaks.length; i += 4) {
    barIdx++;
    if (barIdx % barStride !== 0) continue;
    const docFrame = clip.inFrame + (peaks[i] * fpr - offset);
    if (docFrame < clip.inFrame || docFrame > clip.outFrame) continue;
    barDots.push(((docFrame - clip.inFrame) / clipDuration) * 100);
  }

  // Song-part dots.
  const songDots: number[] = [];
  const songParts = clip.audioSongParts;
  if (songParts) {
    for (const s of songParts) {
      const docFrame = clip.inFrame + (s * fpr - offset);
      if (docFrame < clip.inFrame || docFrame > clip.outFrame) continue;
      songDots.push(((docFrame - clip.inFrame) / clipDuration) * 100);
    }
  }

  return (
    <div ref={rootRef} className="beat-dots">
      {barDots.map((pct, i) => (
        <span key={'b' + i} className="beat-dot" style={{ left: pct + '%' }} />
      ))}
      {songDots.map((pct, i) => (
        <span
          key={'sp' + i}
          className="beat-dot beat-dot--songpart"
          style={{ left: pct + '%' }}
        />
      ))}
    </div>
  );
}
