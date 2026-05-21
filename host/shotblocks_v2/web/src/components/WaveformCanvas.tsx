import { useEffect, useRef } from 'react';
import { pickLevel } from '../lib/peaks';
import { useStore, type Clip } from '../store';
import { registerWaveformRedraw, getSlipPreviewOffset } from '../lib/slipPreview';

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
  // Always points at the CURRENT render's doFullRedraw. The mount
  // effect's ResizeObserver callback is created once and frozen; if
  // it called doFullRedraw directly it would forever use the FIRST
  // render's stale `clip` prop. Routing every redraw through this ref
  // means RO-triggered redraws (resize after a split / trim) use the
  // latest `clip`. This is the fix for "whole waveform crammed into
  // the clip after a cut" — the stale closure paired an old
  // clip.outFrame with the freshly-resized DOM box.
  const redrawRef = useRef<() => void>(() => {});

  // Re-layout / redraw on peaks change (pyramid attached), zoom,
  // clip frame-range change (trim), or media-window change (slip).
  useEffect(() => {
    scheduleLayoutAndDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.peakLevels, hMin, hMax, clip.inFrame, clip.outFrame,
      clip.mediaOffsetFrames, clip.mediaDurationFrames]);

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
    // Register an imperative redraw so a slip drag can repaint THIS
    // clip's waveform without a React re-render (which would break
    // the WebView2 cursor). The slip preview module calls this.
    const unregister = registerWaveformRedraw(clip.id, () => {
      redrawRef.current();
    });
    return () => {
      unregister();
      ro.disconnect();
      if (rafIdRef.current != null) cancelAnimationFrame(rafIdRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.id]);

  /** Cheap pass — repositions the canvas via CSS so it stays glued to
   *  the visible portion of the clip during drags. No bitmap work. */
  function layoutOnly() {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const contentEl = canvas.parentElement as HTMLElement | null;
    const clipEl = contentEl?.closest('.shot-block') as HTMLElement | null;
    const laneEl = contentEl?.closest('.lane') as HTMLElement | null;
    if (!contentEl || !clipEl || !laneEl) return null;

    // The canvas's CSS left/width are relative to its offset parent
    // (.shot-block__content). But the content box sub-pixel-rounds
    // ~1px WIDER than the actual clip (.shot-block) — so sizing the
    // canvas to the content box overhangs the clip edge. Clamp to the
    // CLIP's rect (the true edge), expressed in content-box space.
    const contentRect = contentEl.getBoundingClientRect();
    const clipRect = clipEl.getBoundingClientRect();
    const laneRect = laneEl.getBoundingClientRect();

    // Clip edges in content-box coordinate space.
    const clipLeft  = clipRect.left  - contentRect.left;
    const clipRight = clipRect.right - contentRect.left;

    // Visible window = (lane ∩ clip), in content-box space.
    const leftPx  = Math.max(clipLeft,  laneRect.left  - contentRect.left);
    const rightPx = Math.min(clipRight, laneRect.right - contentRect.left);
    const visW    = Math.max(0, rightPx - leftPx);

    canvas.style.left  = leftPx + 'px';
    canvas.style.right = 'auto';
    canvas.style.width = visW + 'px';
    // `leftPx` positions the canvas in content-box space, but draw()
    // wants the visible window's offset relative to the CLIP's left
    // edge — subtract clipLeft so the waveform media-window mapping
    // lines up with the clip, not the content box.
    return { leftPx: leftPx - clipLeft, visW, clipFullW: clipRect.width };
  }

  // Keep the redraw ref pointed at THIS render's doFullRedraw, so any
  // queued frame (incl. one scheduled by the frozen RO callback) runs
  // the latest closure with the current `clip`.
  redrawRef.current = doFullRedraw;

  function scheduleLayoutAndDraw() {
    // Cancel any pending frame and reschedule — at most one pending,
    // and it always runs the latest doFullRedraw via redrawRef.
    if (rafIdRef.current != null) cancelAnimationFrame(rafIdRef.current);
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      redrawRef.current();
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

    // MEDIA-WINDOW MAPPING. The clip is a window onto a fixed media
    // timeline. `clipFullW` is the clip's VISIBLE width in CSS px, and
    // it covers `clipDurationFrames` doc-frames. The peak pyramid maps
    // across the WHOLE media (`mediaDurationFrames`), not the clip —
    // so cutting / trimming a clip reveals a different part of the
    // same waveform instead of rescaling the whole thing.
    //
    // mediaOffsetFrames = how far into the media the clip's left edge
    // sits. We compute a media-space pixel scale, then offset every
    // bucket X back by the window's start so the visible slice lands
    // correctly under the clip box.
    const clipDurationFrames = Math.max(1, clip.outFrame - clip.inFrame);
    const mediaDurationFrames = Math.max(clipDurationFrames, clip.mediaDurationFrames ?? clipDurationFrames);
    // During a slip drag the live offset comes from the slip-preview
    // module (no store commit → no React re-render → cursor stays).
    // Outside a drag it falls back to the committed store value.
    const slipPreview = getSlipPreviewOffset(clip.id);
    const mediaOffsetFrames = slipPreview != null ? slipPreview : (clip.mediaOffsetFrames ?? 0);
    // CSS px per doc-frame is fixed by the clip's own visible mapping;
    // the media just extends that scale across its full length.
    const cssPxPerFrame = clipFullW / clipDurationFrames;
    const mediaFullW = mediaDurationFrames * cssPxPerFrame;
    // Pixel offset of the visible window's left edge within the media.
    const windowLeftPx = mediaOffsetFrames * cssPxPerFrame;

    // The pyramid maps the whole file across `mediaFullW`. Pick the
    // level whose bucket width is ~1 CSS pixel at the current zoom.
    const finest = [...clip.peakLevels].sort((a, b) => a.sps - b.sps)[0];
    const finestPeaks = atobLen(finest.b64) / 2;
    const totalSamples = finestPeaks * finest.sps;
    const cssPxPerSample = mediaFullW / Math.max(1, totalSamples);
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
    // Visible bucket range: the canvas's CSS-space extent is in
    // CLIP space; bucket positions are in MEDIA space. Shift the
    // visible window by `windowLeftPx` to get the media-space span,
    // then map to bucket indices.
    const leftCssX  = visibleLeftCssPx + windowLeftPx;
    const rightCssX = visibleLeftCssPx + windowLeftPx + visibleCssW;
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
      // bucket center in MEDIA-space CSS-x
      const cssCxMedia = (b + 0.5) / bucketsPerCssPx;
      // → CLIP-space CSS-x (subtract the window's media offset)
      const cssCxClip = cssCxMedia - windowLeftPx;
      // → backing-x within the canvas (subtract the canvas's CSS-left
      // offset into the clip, then scale by DPR)
      xs[i] = (cssCxClip - visibleLeftCssPx) * backingPxPerCssPx;
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
