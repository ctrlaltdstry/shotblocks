// Shared layout math for the beat grid: which lines/dots survive the
// level-of-detail thinning at the current zoom, and their X positions.
//
// Used by both BeatGrid (the lines, drawn BEHIND the clips) and
// BeatDotsOverlay (the connector dots, drawn ABOVE the clips). They
// must agree exactly — same X, same bar LOD stride — or the dots
// drift off the lines. Keeping the math here, called by both, is what
// guarantees that.

import { audioBeatLines, audioSongPartLines, type State } from '../store';

// Minimum on-screen spacing (CSS px) a tier's lines must keep. Below
// it the tier thins: interim beats drop out; bars decimate by powers
// of 2 (every 2nd, 4th, 8th …). Mirrors FCP.
export const MIN_INTERIM_SPACING_PX = 9;
export const MIN_BAR_SPACING_PX = 22;

export interface BeatGridLayout {
  /** X (CSS px from the overlay's left) of every interim+bar line to
   *  draw, with its tier. Already LOD-filtered. */
  lines: { x: number; isBar: boolean }[];
  /** X of every song-part heavy line to draw. */
  songParts: number[];
  /** X of every bar line that survived LOD — the connector-dot
   *  positions, identical to the bar entries in `lines`. */
  barXs: number[];
}

/** The bar-line LOD stride for the current zoom: bars are drawn every
 *  Nth bar (1, 2, 4, 8 …) so the displayed bar gap stays comfortable.
 *  `width` is the timeline's pixel width. Shared so the per-clip dots
 *  and the BeatGrid lines decimate identically. */
export function computeBarStride(state: State, width: number): number {
  const h = state.h;
  const visibleSpan = Math.max(1, h.vMax - h.vMin);
  const pxPerFrame = width / visibleSpan;
  const fps = state.fps > 0 ? state.fps : 30;
  // Beat spacing in px, from the grid's tempo period if known.
  let beatFrames = 0;
  for (const t of state.audioTracks) {
    for (const c of t.clips) {
      const g = c.audioBeatGrid;
      const sr = c.audioPeaksSampleRate;
      if (g && sr && g.periodSamples > 0) {
        beatFrames = (g.periodSamples / sr) * fps;
        break;
      }
    }
    if (beatFrames) break;
  }
  if (beatFrames <= 0) return 1;
  const baseBarSpacing = beatFrames * pxPerFrame * 4;
  let stride = 1;
  while (baseBarSpacing * stride < MIN_BAR_SPACING_PX && stride < 1024) {
    stride *= 2;
  }
  return stride;
}

/** Compute the LOD-resolved beat-grid layout for the current zoom.
 *  `width` is the overlay's pixel width; the visible frame window is
 *  read from `state.h`. `inFrameOverride` substitutes a clip's live
 *  drag position so its lines travel with it mid-drag. */
export function computeBeatGridLayout(
  state: State,
  width: number,
  inFrameOverride?: Map<number, number>,
): BeatGridLayout {
  const h = state.h;
  const lines = audioBeatLines(state, inFrameOverride);
  const songPartFrames = audioSongPartLines(state, inFrameOverride);

  const visibleSpan = Math.max(1, h.vMax - h.vMin);
  const pxPerFrame = width / visibleSpan;

  // Beat on-screen spacing — drives the LOD gates.
  let beatSpacingPx = Infinity;
  if (lines.length >= 2) {
    beatSpacingPx = Math.abs(lines[1].frame - lines[0].frame) * pxPerFrame;
  }
  const showInterim = beatSpacingPx >= MIN_INTERIM_SPACING_PX;
  // Bars decimate by a power of 2 until the displayed bar gap clears
  // MIN_BAR_SPACING_PX. Base bar spacing is 4x the beat spacing.
  let barStride = 1;
  const baseBarSpacing = beatSpacingPx * 4;
  while (baseBarSpacing * barStride < MIN_BAR_SPACING_PX && barStride < 1024) {
    barStride *= 2;
  }

  const outLines: { x: number; isBar: boolean }[] = [];
  const barXs: number[] = [];
  let barIndex = -1;
  for (const ln of lines) {
    if (ln.isBar) barIndex++;
    if (ln.frame < h.vMin || ln.frame > h.vMax) continue;
    if (ln.isBar) {
      if (barIndex % barStride !== 0) continue;
    } else if (!showInterim) {
      continue;
    }
    const x = (ln.frame - h.vMin) * pxPerFrame;
    outLines.push({ x, isBar: ln.isBar });
    if (ln.isBar) barXs.push(x);
  }

  const songParts: number[] = [];
  for (const frame of songPartFrames) {
    if (frame < h.vMin || frame > h.vMax) continue;
    songParts.push((frame - h.vMin) * pxPerFrame);
  }

  return { lines: outLines, songParts, barXs };
}
