// Tick/label math for the ruler. Pure functions, no DOM, easy to unit
// test later. Splitting these out so both the ruler and the playhead
// can use the same px-per-frame derivation.

export function pickFrameStep(pxPerFrame: number): number {
  const candidates = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];
  const minLabelPx = 36;
  for (const s of candidates) {
    if (s * pxPerFrame >= minLabelPx) return s;
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

  // Labels at step + the start and end of the visible window.
  const labels: RulerLayout['labels'] = [];
  const labelFrames = new Set<number>();
  labelFrames.add(Math.max(0, Math.ceil(vMin)));
  const firstLabel = Math.ceil(vMin / step) * step;
  const lastLabel = Math.floor(vMax / step) * step;
  for (let f = firstLabel; f <= lastLabel; f += step) labelFrames.add(f);
  labelFrames.add(Math.floor(vMax));
  const sorted = [...labelFrames].sort((a, b) => a - b);
  for (const f of sorted) {
    const x = (f - vMin) * pxPerFrame;
    const isFirst = f === sorted[0];
    const isLast = f === sorted[sorted.length - 1];
    labels.push({
      x: isLast ? widthPx - 1 : x,
      text: String(f),
      align: isFirst ? 'left' : isLast ? 'right' : 'center',
    });
  }

  return { ticks, labels };
}
