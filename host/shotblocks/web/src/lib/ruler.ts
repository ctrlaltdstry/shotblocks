// Tick/label math for the ruler. Pure functions, no DOM, easy to unit
// test later. Splitting these out so both the ruler and the playhead
// can use the same px-per-frame derivation.

/** Minimum horizontal gap (px) between adjacent ruler labels. Drives both
 *  the frame-step pick AND the proximity cull of the forced start/end
 *  labels so numbers never overlap. */
const MIN_LABEL_PX = 36;

export function pickFrameStep(pxPerFrame: number): number {
  const candidates = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];
  for (const s of candidates) {
    if (s * pxPerFrame >= MIN_LABEL_PX) return s;
  }
  return candidates[candidates.length - 1];
}

export interface RulerLayout {
  /** Tick line specs, in px from the ruler's left edge. */
  ticks: Array<{ x: number; isMajor: boolean }>;
  /** Number labels, in px from left edge. First/last carry alignment hints. */
  labels: Array<{ x: number; text: string; align: 'left' | 'center' | 'right' }>;
}

export function computeRulerLayout(
  widthPx: number,
  vMin: number,
  vMax: number,
): RulerLayout {
  const docFrames = Math.max(1, vMax - vMin);
  const pxPerFrame = widthPx / docFrames;
  const step = pickFrameStep(pxPerFrame);
  const minorStep = Math.max(1, (step / 4) | 0);

  const ticks: RulerLayout['ticks'] = [];
  const firstTick = Math.ceil(vMin / minorStep) * minorStep;
  const lastTick = Math.floor(vMax / minorStep) * minorStep;
  for (let f = firstTick; f <= lastTick; f += minorStep) {
    ticks.push({ x: (f - vMin) * pxPerFrame, isMajor: f % step === 0 });
  }

  // Labels: the regular step grid, plus the start and end of the visible
  // window so the exact bounds are always marked. The forced start/end can
  // land very close to an adjacent grid label (e.g. vMax=1992 next to grid
  // 1984) and the two would overlap. Cull by pixel proximity: the forced
  // endpoints win (they're the meaningful "edge" markers), so a grid label
  // within MIN_LABEL_PX of an endpoint is dropped.
  // No floor at 0 — the doc range can start negative (v2 mirrors C4D's
  // ruler), so the left-edge label must be able to read e.g. -30.
  const startFrame = Math.ceil(vMin);
  const endFrame = Math.floor(vMax);
  const gridFrames: number[] = [];
  const firstLabel = Math.ceil(vMin / step) * step;
  const lastLabel = Math.floor(vMax / step) * step;
  for (let f = firstLabel; f <= lastLabel; f += step) {
    if (f === startFrame || f === endFrame) continue; // endpoint covers it
    gridFrames.push(f);
  }
  const xOf = (f: number) => (f - vMin) * pxPerFrame;
  const startX = xOf(startFrame);
  const endX = widthPx - 1; // end label pinned to the right edge
  const keptGrid = gridFrames.filter((f) => {
    const x = xOf(f);
    return Math.abs(x - startX) >= MIN_LABEL_PX
        && Math.abs(x - endX) >= MIN_LABEL_PX;
  });

  const labels: RulerLayout['labels'] = [];
  labels.push({ x: startX, text: String(startFrame), align: 'left' });
  for (const f of keptGrid) {
    labels.push({ x: xOf(f), text: String(f), align: 'center' });
  }
  // Only emit the end label if it isn't the same frame as the start
  // (a degenerate 1-frame window).
  if (endFrame !== startFrame) {
    labels.push({ x: endX, text: String(endFrame), align: 'right' });
  }

  return { ticks, labels };
}
