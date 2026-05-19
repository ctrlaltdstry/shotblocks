import { useEffect, useRef } from 'react';
import { pickLevel } from '../lib/peaks';
import { useStore, type Clip } from '../store';

/** Renders an audio clip's waveform as a filled min/max envelope.
 *
 *  Multi-resolution: the clip carries a pyramid of peak levels (fine
 *  → coarse). At each zoom we pick the coarsest level whose buckets
 *  are still ≤1 CSS pixel wide — that keeps detail crisp at every
 *  zoom without level-snap artifacts. Past the finest level (zoom-in)
 *  bars naturally widen with the zoom (one bucket = one wider bar)
 *  which is smooth. Mirrors how Premiere / Resolve / Pro Tools handle
 *  waveform rendering from their sidecar peak files.
 *
 *  Intersection-clipped: at high horizontal zoom a clip's DOM box can
 *  grow to tens of thousands of CSS pixels. We position + size the
 *  canvas to cover only the intersection of the clip's box with the
 *  lane viewport, so the canvas backing-store stays bounded.
 *
 *  rAF-throttled redraw: every store change schedules a redraw via
 *  requestAnimationFrame; multiple changes in the same frame coalesce
 *  to one paint. No idle debounce — the pyramid renderer is cheap
 *  enough to keep up with continuous zoom drags.
 */
export function WaveformCanvas({ clip }: { clip: Clip }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Subscribe to h so the canvas relayouts on scroll / zoom.
  const hMin = useStore((s) => s.h.vMin);
  const hMax = useStore((s) => s.h.vMax);

  const rafIdRef = useRef<number | null>(null);

  // Re-layout / redraw on peaks change (pyramid attached), zoom, or
  // clip frame-range change (trim).
  useEffect(() => {
    scheduleLayoutAndDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.peakLevels, hMin, hMax, clip.inFrame, clip.outFrame]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const clipEl = canvas.parentElement?.closest('.shot-block') as HTMLElement | null;
    if (!clipEl) {
      scheduleLayoutAndDraw();
      return;
    }
    const ro = new ResizeObserver(() => scheduleLayoutAndDraw());
    ro.observe(clipEl);
    const laneEl = clipEl.closest('.lane') as HTMLElement | null;
    if (laneEl) ro.observe(laneEl);
    scheduleLayoutAndDraw();
    return () => {
      ro.disconnect();
      if (rafIdRef.current != null) cancelAnimationFrame(rafIdRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Cheap pass — repositions the canvas via CSS so it stays glued to
   *  the visible portion of the clip during drags. No bitmap work. */
  function layoutOnly() {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const clipEl = canvas.parentElement?.closest('.shot-block') as HTMLElement | null;
    const laneEl = clipEl?.closest('.lane') as HTMLElement | null;
    if (!clipEl || !laneEl) return null;

    const clipRect = clipEl.getBoundingClientRect();
    const laneRect = laneEl.getBoundingClientRect();
    const leftPx  = Math.max(0, laneRect.left  - clipRect.left);
    const rightPx = Math.min(clipRect.width, laneRect.right - clipRect.left);
    const visW    = Math.max(0, rightPx - leftPx);

    canvas.style.left  = leftPx + 'px';
    canvas.style.right = 'auto';
    canvas.style.width = visW + 'px';
    return { leftPx, visW, clipFullW: clipRect.width };
  }

  function scheduleLayoutAndDraw() {
    if (rafIdRef.current != null) return;
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      doFullRedraw();
    });
  }

  function doFullRedraw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const layout = layoutOnly();
    if (!layout) return;
    const { leftPx, visW, clipFullW } = layout;

    if (visW < 1 || clipFullW < 1) {
      canvas.width = 1;
      canvas.height = 1;
      return;
    }

    const cssH = canvas.getBoundingClientRect().height;
    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.max(1, Math.floor(visW * dpr));
    const targetH = Math.max(1, Math.floor(cssH * dpr));
    if (canvas.width  !== targetW) canvas.width  = targetW;
    if (canvas.height !== targetH) canvas.height = targetH;

    draw(leftPx, visW, targetW, targetH, clipFullW);
  }

  function draw(
    visibleLeftCssPx: number,
    visibleCssW: number,
    w: number,
    h: number,
    clipFullW: number,
  ) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, w, h);
    if (!clip.peakLevels || clip.peakLevels.length === 0) return;

    // The pyramid maps the whole file across the clip's full CSS width
    // (1:1 — clip.inFrame..outFrame corresponds to sample 0..length,
    // until we add a media-offset concept for trims). Pick the level
    // whose bucket width is ~1 CSS pixel at the current zoom.
    // cssPxPerSample = clipFullW / (totalSamples). Total samples is
    // bucketCount(finestLevel) * finestLevel.sps; use that as the
    // canonical length, which matches what we computed at decode.
    const finest = [...clip.peakLevels].sort((a, b) => a.sps - b.sps)[0];
    const finestPeaks = atobLen(finest.b64) / 2;
    const totalSamples = finestPeaks * finest.sps;
    const cssPxPerSample = clipFullW / Math.max(1, totalSamples);
    const picked = pickLevel(clip.peakLevels, cssPxPerSample);
    if (!picked) return;

    const { peaks } = picked;
    const bucketCount = peaks.length / 2;
    const cssPxPerBucket = cssPxPerSample * picked.sps;
    const bucketsPerCssPx = 1 / cssPxPerBucket;

    const mid = h / 2;
    ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('color') || '#ffffff';

    const absMax = clip.peakAbsMax && clip.peakAbsMax > 0 ? clip.peakAbsMax : 127;
    const DB_FLOOR = -60;
    const halfH = h * 0.45;
    function ampToY(v: number): number {
      const aLin = Math.abs(v) / absMax;
      if (aLin <= 0) return 0;
      const db = 20 * Math.log10(aLin);
      if (db <= DB_FLOOR) return 0;
      return (1 - db / DB_FLOOR) * halfH;
    }

    // Build one upper + lower point per VISIBLE BUCKET (not per pixel
    // column). Adjacent points are connected by quadratic Bézier
    // curves through bucket midpoints so peaks land at bucket centers
    // and valleys curve smoothly between them. Same shape Premiere /
    // Logic / Audition draw at high zoom.
    //
    // Visible bucket range: derive from the canvas's CSS-space extent
    // mapped back to bucket indices.
    const leftCssX  = visibleLeftCssPx;
    const rightCssX = visibleLeftCssPx + visibleCssW;
    const firstBucket = Math.max(0, Math.floor(leftCssX * bucketsPerCssPx));
    const lastBucket  = Math.min(bucketCount - 1, Math.ceil(rightCssX * bucketsPerCssPx));
    if (lastBucket < firstBucket) return;

    // For each bucket compute its center x in backing-pixel space + the
    // top/bot y. Pre-allocate; we'll walk twice (top then bottom).
    const n = lastBucket - firstBucket + 1;
    if (n < 1) return;
    const xs = new Float32Array(n);
    const tys = new Float32Array(n);
    const bys = new Float32Array(n);
    const backingPxPerCssPx = w / visibleCssW;
    for (let i = 0; i < n; i++) {
      const b = firstBucket + i;
      // bucket center in CSS-x within the clip
      const cssCx = (b + 0.5) / bucketsPerCssPx;
      // → backing-x within the canvas (subtract the canvas's CSS-left
      // offset into the clip, then scale by DPR)
      xs[i] = (cssCx - visibleLeftCssPx) * backingPxPerCssPx;
      const lo = peaks[b * 2];
      const hi = peaks[b * 2 + 1];
      tys[i] = mid - ampToY(hi);
      bys[i] = mid + ampToY(lo);
    }

    // Trace as one filled polygon. Top edge: quadratic Bézier through
    // bucket midpoints (control point at the midpoint, curve passes
    // through it). Bottom edge: same in reverse.
    //
    // The canonical "smooth polyline" trick: for each pair of points
    // (p[i], p[i+1]), draw a quadratic with control p[i] and endpoint
    // (p[i]+p[i+1])/2. That makes the curve pass through every
    // averaged-midpoint and curve smoothly through the original
    // points, giving rounded peaks + valleys with no stair-stepping.
    ctx.beginPath();
    // Top envelope, left to right.
    ctx.moveTo(xs[0], tys[0]);
    for (let i = 0; i < n - 1; i++) {
      const mxX = (xs[i] + xs[i + 1]) / 2;
      const mxY = (tys[i] + tys[i + 1]) / 2;
      ctx.quadraticCurveTo(xs[i], tys[i], mxX, mxY);
    }
    ctx.quadraticCurveTo(xs[n - 1], tys[n - 1], xs[n - 1], tys[n - 1]);
    // Bottom envelope, right to left.
    ctx.lineTo(xs[n - 1], bys[n - 1]);
    for (let i = n - 1; i > 0; i--) {
      const mxX = (xs[i] + xs[i - 1]) / 2;
      const mxY = (bys[i] + bys[i - 1]) / 2;
      ctx.quadraticCurveTo(xs[i], bys[i], mxX, mxY);
    }
    ctx.quadraticCurveTo(xs[0], bys[0], xs[0], bys[0]);
    ctx.closePath();
    ctx.fill();
  }

  return (
    <canvas
      ref={canvasRef}
      className="waveform-canvas"
    />
  );
}

/** Decoded byte length of a base64 string without actually decoding.
 *  base64 packs every 4 chars into 3 bytes; padding '=' chars at the
 *  end count down. */
function atobLen(b64: string): number {
  if (!b64) return 0;
  let pad = 0;
  if (b64.endsWith('==')) pad = 2;
  else if (b64.endsWith('=')) pad = 1;
  return (b64.length * 3) / 4 - pad;
}
