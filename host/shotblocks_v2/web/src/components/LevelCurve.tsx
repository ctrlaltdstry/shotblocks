import { useRef, useState } from 'react';
import { useStore, type Clip, type LevelKeyframe } from '../store';
import { cubicBezierEase, evaluateLevel } from '../lib/levelCurve';

/** Pen-tool volume-automation overlay for an audio clip — the curve
 *  line plus its diamond keyframe nodes, drawn over the waveform.
 *
 *  Lag-free layout. Everything is positioned in clip-relative
 *  FRACTIONS, never measured pixels — so it follows the clip's
 *  width/transform natively (the browser does the layout) and never
 *  lags the waveform during a zoom. The curve is an SVG with a fixed
 *  1000x1000 viewBox + preserveAspectRatio="none", CSS-stretched to
 *  the clip; the diamond nodes are DOM divs positioned by left/top %
 *  so they stay square (the stretched SVG would squish them).
 *
 *  Coordinate model. A node's `af` is a MEDIA-space doc-frame; the
 *  clip is a fixed window onto that media:
 *    xFrac(af) = (af - mediaOffsetFrames) / clipDurationFrames   (0..1)
 *  Gain 1 (unity) maps to the vertical CENTRE; gain 0 to CURVE_BOTTOM
 *  (a small inset up from the bottom). The top half is headroom.
 *
 *  With the Pen tool the SVG takes pointer events: a press on a node
 *  drags it; a press ON the curve line adds a node and drags it. With
 *  any other tool the SVG is pointer-events:none so normal clip
 *  gestures pass through. */

/** viewBox extent — curve coordinates are 0..VB on both axes. */
const VB = 1000;
/** Gain 0 maps here (fraction of height); a small inset keeps the
 *  bottom diamond off the clip edge. */
const CURVE_BOTTOM = 0.94;
/** Node hit radius in px — generous so a normal click on the small
 *  diamond reliably GRABS it rather than missing and adding a new
 *  (merging) node, which made the grabbed node jump. */
const NODE_HIT_PX = 14;
/** A click adds a node only within this many px of the curve line. */
const LINE_HIT_PX = 16;

export function LevelCurve({ clip }: { clip: Clip }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const activeTool = useStore((s) => s.activeTool);
  // Re-render on zoom so the curve path recomputes its sampled
  // polyline (positions are fractional, but the path string is built
  // once per render — cheap, and keeps it identical to the waveform).
  const hMin = useStore((s) => s.h.vMin);
  const hMax = useStore((s) => s.h.vMax);
  void hMin; void hMax;

  const penActive = activeTool === 'pen';
  const kfs = clip.levelKeyframes ?? [];

  const [hoverKf, setHoverKf] = useState(-1);
  const [selectedKf, setSelectedKf] = useState(-1);

  // --- coordinate mapping (fractions, 0..1) -------------------------
  const clipDur = Math.max(1, clip.outFrame - clip.inFrame);
  const mediaOffset = clip.mediaOffsetFrames ?? 0;
  function afToFrac(af: number): number {
    return (af - mediaOffset) / clipDur;
  }
  function fracToAf(fx: number): number {
    return mediaOffset + fx * clipDur;
  }
  /** gain 0..1 -> y fraction 0..1 (unity at centre 0.5). */
  function gainToFrac(g: number): number {
    return 0.5 + (1 - g) * (CURVE_BOTTOM - 0.5);
  }
  /** y fraction -> gain. RAW (unclamped) on purpose: the drag adds a
   *  grab offset before clamping, so clamping here would let a node
   *  grabbed off-centre get stuck short of unity (the offset would
   *  subtract from an already-capped value). The store clamps the
   *  final gain to 0..1. */
  function fracToGain(fy: number): number {
    return 1 - (fy - 0.5) / (CURVE_BOTTOM - 0.5);
  }

  // --- drag state ---------------------------------------------------
  // grabAf/grabGain: the offset between the cursor and the node at
  // grab time. Applied on every move so the node tracks the cursor
  // 1:1 without snapping (the cursor is rarely dead-on the node, and
  // the store rounds `af` to whole frames — without this offset the
  // first move would leap the node to the nearest frame boundary).
  const drag = useRef<
    { index: number; pointerId: number; grabAf: number; grabGain: number } | null
  >(null);

  /** Pointer position as clip-relative fractions, from the SVG's live
   *  rect (measured per gesture, not per render — so no lag). */
  function localFrac(ev: React.PointerEvent): { fx: number; fy: number; rw: number; rh: number } {
    const r = svgRef.current!.getBoundingClientRect();
    return {
      fx: r.width > 0 ? (ev.clientX - r.left) / r.width : 0,
      fy: r.height > 0 ? (ev.clientY - r.top) / r.height : 0,
      rw: r.width,
      rh: r.height,
    };
  }

  /** Index of the nearest node within NODE_HIT_PX of (fx,fy), or -1.
   *  Distances are compared in PIXELS via the live rect size. */
  function hitNode(fx: number, fy: number, rw: number, rh: number): number {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < kfs.length; i++) {
      const dxPx = (afToFrac(kfs[i].af) - fx) * rw;
      const dyPx = (gainToFrac(kfs[i].gain) - fy) * rh;
      const d = Math.hypot(dxPx, dyPx);
      if (d < bestD) { bestD = d; best = i; }
    }
    return bestD <= NODE_HIT_PX ? best : -1;
  }

  function onPointerDown(ev: React.PointerEvent<SVGSVGElement>) {
    if (!penActive || ev.button !== 0) return;
    ev.stopPropagation();
    ev.preventDefault();
    const { fx, fy, rw, rh } = localFrac(ev);
    const store = useStore.getState();
    let index = hitNode(fx, fy, rw, rh);
    let grabAf = 0;
    let grabGain = 0;
    if (index < 0) {
      // Not on a node — only add one if the click lands ON the curve
      // line. The new node lands exactly on the line (no kink), so
      // the cursor→node offset is zero.
      const lineGain = evaluateLevel(kfs, fracToAf(fx));
      const lineFy = gainToFrac(lineGain);
      if (Math.abs(lineFy - fy) * rh > LINE_HIT_PX) return;
      index = store.addLevelKeyframe(clip.id, fracToAf(fx), lineGain) ?? -1;
      if (index < 0) return;
    } else {
      // Grabbed an existing node — capture the cursor→node offset so
      // the drag tracks 1:1 (kfs[] is current here; no add happened).
      const node = kfs[index];
      grabAf = fracToAf(fx) - node.af;
      grabGain = fracToGain(fy) - node.gain;
    }
    drag.current = { index, pointerId: ev.pointerId, grabAf, grabGain };
    setSelectedKf(index);
    svgRef.current!.setPointerCapture(ev.pointerId);
  }
  function onPointerMove(ev: React.PointerEvent<SVGSVGElement>) {
    const d = drag.current;
    const { fx, fy, rw, rh } = localFrac(ev);
    if (d) {
      useStore.getState().moveLevelKeyframe(
        clip.id, d.index,
        fracToAf(fx) - d.grabAf, fracToGain(fy) - d.grabGain);
      return;
    }
    const hov = hitNode(fx, fy, rw, rh);
    if (hov !== hoverKf) setHoverKf(hov);
  }
  function onPointerEnd(ev: React.PointerEvent<SVGSVGElement>) {
    if (!drag.current) return;
    drag.current = null;
    try { svgRef.current!.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
  }
  function onPointerLeave() {
    if (!drag.current && hoverKf !== -1) setHoverKf(-1);
  }
  function onContextMenu(ev: React.MouseEvent<SVGSVGElement>) {
    if (!penActive) return;
    const r = svgRef.current!.getBoundingClientRect();
    const fx = r.width > 0 ? (ev.clientX - r.left) / r.width : 0;
    const fy = r.height > 0 ? (ev.clientY - r.top) / r.height : 0;
    const idx = hitNode(fx, fy, r.width, r.height);
    if (idx < 0) return;   // not on a node — leave the default menu
    ev.preventDefault();
    ev.stopPropagation();
    setSelectedKf(idx);
    useStore.getState().setContextMenu({
      x: ev.clientX, y: ev.clientY,
      targetClipId: null, targetTrackId: null,
      targetLevelKf: { clipId: clip.id, index: idx },
    });
  }

  // --- curve path (in 0..VB viewBox units) --------------------------
  const path = buildPath(kfs, afToFrac, gainToFrac);

  return (
    <>
      <svg
        ref={svgRef}
        className={'level-curve' + (penActive ? ' is-pen' : '')}
        viewBox={`0 0 ${VB} ${VB}`}
        preserveAspectRatio="none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onPointerLeave={onPointerLeave}
        onContextMenu={onContextMenu}
      >
        {/* Resting unity line — flat, dead-centre, on a clip with no
            curve yet. Brightens while the Pen tool is active. */}
        {kfs.length === 0 && (
          <line
            className="level-curve__unity"
            x1={0} y1={gainToFrac(1) * VB}
            x2={VB} y2={gainToFrac(1) * VB}
            vectorEffect="non-scaling-stroke"
          />
        )}
        {path && (
          <path
            className="level-curve__line"
            d={path}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {/* Diamond nodes — DOM divs positioned by %, so they stay square
          (the preserveAspectRatio=none SVG would squish SVG shapes)
          and follow the clip's width with zero lag. */}
      {kfs.map((k, i) => (
        <div
          key={i}
          className={'level-curve__node'
            + (i === hoverKf ? ' is-hover' : '')
            + (i === selectedKf ? ' is-selected' : '')}
          style={{
            left: (afToFrac(k.af) * 100) + '%',
            top: (gainToFrac(k.gain) * 100) + '%',
          }}
        />
      ))}
    </>
  );
}

/** Build the SVG path (0..VB viewBox units): a flat lead-in to the
 *  first node, bezier-shaped segments between nodes, a flat lead-out.
 *  Mirrors evaluateLevel's shape. */
function buildPath(
  kfs: LevelKeyframe[],
  afToFrac: (af: number) => number,
  gainToFrac: (g: number) => number,
): string {
  if (kfs.length === 0) return '';
  const X = (af: number) => (afToFrac(af) * VB).toFixed(2);
  const Y = (g: number) => (gainToFrac(g) * VB).toFixed(2);
  const seg: string[] = [];
  seg.push(`M 0 ${Y(kfs[0].gain)} L ${X(kfs[0].af)} ${Y(kfs[0].gain)}`);
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (a.interp === 'hold') {
      seg.push(`L ${X(b.af)} ${Y(a.gain)} L ${X(b.af)} ${Y(b.gain)}`);
      continue;
    }
    const ax = afToFrac(a.af), ay = gainToFrac(a.gain);
    const bx = afToFrac(b.af), by = gainToFrac(b.gain);
    const STEPS = 16;
    for (let s = 1; s <= STEPS; s++) {
      const t = s / STEPS;
      const prog = cubicBezierEase(a.ease[0], a.ease[1], a.ease[2], a.ease[3], t);
      const x = (ax + (bx - ax) * t) * VB;
      const y = (ay + (by - ay) * prog) * VB;
      seg.push(`L ${x.toFixed(2)} ${y.toFixed(2)}`);
    }
  }
  seg.push(`L ${VB} ${Y(kfs[kfs.length - 1].gain)}`);
  return seg.join(' ');
}
