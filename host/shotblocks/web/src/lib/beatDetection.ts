// Beat detection orchestration — wires the Beat Detection button to
// the envelope peak detector (lib/onsets.ts).
//
// For every audio media currently on the timeline it decodes the
// buffer, runs detectPeaks, and writes the result onto all clips
// sharing that mediaId. Detection is per-MEDIA (not per-clip): splits
// share one mediaId, so one analysis paints every sibling.
//
// Peaks are stored as media-space audio sample positions; the
// renderer and snap convert to doc frames.

import { useStore } from '../store';
import { getAudioBuffer } from './audioStore';
import { detectPeaks } from './onsets';

let detectAudioCtx: AudioContext | null = null;

function ensureCtx(): AudioContext {
  if (!detectAudioCtx) {
    const Ctor: typeof AudioContext =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    detectAudioCtx = new Ctor();
  }
  return detectAudioCtx;
}

/** Run prominent-peak detection over every audio media on the
 *  timeline. Idempotent re-run: re-detecting overwrites prior peaks.
 *  Sets the `detectingBeats` busy flag for the duration. */
export async function runBeatDetection(): Promise<void> {
  const store = useStore.getState();
  if (store.detectingBeats) return;

  // Collect distinct mediaIds across all audio clips.
  const mediaIds = new Set<number>();
  for (const t of store.audioTracks) {
    for (const c of t.clips) mediaIds.add(c.mediaId ?? c.id);
  }
  if (mediaIds.size === 0) {
    console.warn('[beats] no audio clips to analyse');
    return;
  }

  store.setDetectingBeats(true);
  const ctx = ensureCtx();
  try {
    for (const mediaId of mediaIds) {
      const buf = await getAudioBuffer(mediaId, ctx);
      if (!buf) {
        console.warn('[beats] no decoded buffer for media', mediaId);
        continue;
      }
      // Yield to the event loop so the UI can paint the busy state
      // before the synchronous biquad/envelope passes block.
      await new Promise((r) => setTimeout(r, 0));
      const t0 = performance.now();
      const { peaks, grid, songParts } = detectPeaks(buf);
      const elapsed = (performance.now() - t0).toFixed(0);
      const bpm = grid
        ? (60 / (grid.periodSamples / buf.sampleRate)).toFixed(1)
        : 'none';
      console.log(
        `[beats] media ${mediaId}: ${peaks.length} peaks, grid ${bpm} bpm ` +
        `(conf ${grid ? grid.confidence.toFixed(2) : '-'}), ` +
        `${songParts.length} song parts in ${elapsed}ms`,
      );
      useStore.getState().setClipAudioPeaks(
        mediaId, peaks, buf.sampleRate, grid, songParts);
    }
  } catch (e) {
    console.warn('[beats] detection failed', e);
  } finally {
    // Reveal the grid once analysis completes (FCP: enabling beat
    // detection shows the grid).
    useStore.getState().setBeatGridVisible(true);
    useStore.getState().setDetectingBeats(false);
  }
}
