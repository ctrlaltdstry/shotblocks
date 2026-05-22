import { useRef, useState } from 'react';
import { useStore, type Clip, type LevelKeyframe, type LevelTangent } from '../store';
import { useElementSize } from '../useElementSize';
import { evaluateLevel } from '../lib/levelCurve';

/** Pen-tool volume-automation overlay for an audio clip — the curve
 *  line, its diamond keyframe nodes, and (on the selected node) the
 *  bezier tangent handles.
 *
 *  Lag-free layout. Everything is positioned in clip-relative
 *  FRACTIONS, never measured pixels — so it follows the clip's
 *  width/transform natively and never lags the waveform on zoom. The
 *  curve is an SVG with a fixed 1000x1000 viewBox +
 *  preserveAspectRatio="none", CSS-stretched to the clip; the nodes
 *  and handles are DOM divs positioned by left/top % so they stay
 *  square (the stretched SVG would squish SVG shapes).
 *
 *  Per-node bezier (After Effects model): the selected node shows one
 *  handle on each side — `inTan` shapes the segment arriving from the
 *  previous node, `outTan` the segment leaving to the next. Tangents
 *  are segment-normalized; see store LevelKeyframe / LevelTangent.
 *
 *  af model. A node's `af` is a MEDIA-space doc-frame; the clip is a
 *  fixed window onto that media: xFrac(af) = (af - mediaOffset) /
 *  clipDuration. Gain 1 (unity) maps to the vertical CENTRE, gain 0
 *  to CURVE_BOTTOM. */

/** viewBox extent — curve coordinates are 0..VB on both axes. */
const VB = 1000;
/** Gain 0 maps here (fraction of height); a small inset keeps the
 *  bottom diamond off the clip edge. */
const CURVE_BOTTOM = 0.94;
/** Node hit radius in px — generous so a normal click on the small
 *  diamond reliably GRABS it rather than missing + adding a node. */
const NODE_HIT_PX = 14;
/** Handle hit radius in px. Generous — the handle dot is small and a
 *  pointer click is rarely dead-on (measured ~10px aim error). */
const HANDLE_HIT_PX = 18;
/** Fixed on-screen length of a tangent handle, in px. The stored
 *  tangent sets the handle's DIRECTION (the curve shape); the handle
 *  is drawn this far from its node along that direction regardless of
 *  keyframe spacing or zoom — so handles never pile up on the node
 *  when nodes are close or the clip is zoomed wide. */
const HANDLE_LEN_PX = 34;
/** A click adds a node only within this many px of the curve line. */
const LINE_HIT_PX = 16;

type HandleSide = 'in' | 'out';

export function LevelCurve({ clip }: { clip: Clip }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  // Live SVG size — used ONLY to normalize the tangent handles to a
  // fixed pixel length (px<->fraction conversion). The curve + nodes
  // stay percentage-positioned and lag-free; a slight handle lag on
  // zoom is fine since handles only show on the selected node.
  const { width: svgW, height: svgH } = useElementSize(svgRef);
  const activeTool = useStore((s) => s.activeTool);
  // Re-render on zoom so the curve relayouts.
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
  const afToFrac = (af: number) => (af - mediaOffset) / clipDur;
  const fracToAf = (fx: number) => mediaOffset + fx * clipDur;
  /** gain 0..1 -> y fraction (unity at centre 0.5). */
  const gainToFrac = (g: number) => 0.5 + (1 - g) * (CURVE_BOTTOM - 0.5);
  /** y fraction -> gain. RAW (unclamped); the store clamps finally. */
  const fracToGain = (fy: number) => 1 - (fy - 0.5) / (CURVE_BOTTOM - 0.5);

  // --- drag state ---------------------------------------------------
  // A node drag carries grabAf/grabGain — the cursor->node offset at
  // grab time, applied each move so the node tracks the cursor 1:1.
  // A handle drag reshapes one tangent of the selected node.
  const drag = useRef<
    | { kind: 'node'; index: number; pointerId: number; grabAf: number; grabGain: number }
    | { kind: 'handle'; index: number; side: HandleSide; pointerId: number }
    | null
  >(null);

  /** Pointer position as clip-relative fractions + the live rect. */
  function localFrac(ev: React.PointerEvent) {
    const r = svgRef.current!.getBoundingClientRect();
    return {
      fx: r.width > 0 ? (ev.clientX - r.left) / r.width : 0,
      fy: r.height > 0 ? (ev.clientY - r.top) / r.height : 0,
      rw: r.width,
      rh: r.height,
    };
  }

  /** Nearest node within NODE_HIT_PX of (fx,fy), or -1. */
  function hitNode(fx: number, fy: number, rw: number, rh: number): number {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < kfs.length; i++) {
      const d = Math.hypot((afToFrac(kfs[i].af) - fx) * rw,
                           (gainToFrac(kfs[i].gain) - fy) * rh);
      if (d < bestD) { bestD = d; best = i; }
    }
    return bestD <= NODE_HIT_PX ? best : -1;
  }

  /** The selected node's tangent-handle screen positions (clip
   *  fractions). `in` exists when there's a previous node, `out` when
   *  there's a next node; a 'hold' segment contributes no handle.
   *
   *  The handle's DIRECTION comes from the tangent (the curve shape);
   *  its on-screen DISTANCE from the node is clamped to a fixed pixel
   *  band so it never collapses onto the node (when nodes are close /
   *  the clip is zoomed wide) nor flies off. The clamp is display-only
   *  — `setHandleFromFrac` maps the raw drag back to the real tangent. */
  function selectedHandles(): { side: HandleSide; hx: number; hy: number }[] {
    const out: { side: HandleSide; hx: number; hy: number }[] = [];
    if (selectedKf < 0 || selectedKf >= kfs.length) return out;
    if (svgW <= 0 || svgH <= 0) return out;
    const node = kfs[selectedKf];
    const nx = afToFrac(node.af);
    const ny = gainToFrac(node.gain);
    // Place a handle a clamped pixel distance along (dxFrac,dyFrac).
    const place = (side: HandleSide, ctlXFrac: number, ctlYFrac: number) => {
      let dx = ctlXFrac - nx;
      let dy = ctlYFrac - ny;
      // Length in px.
      const lenPx = Math.hypot(dx * svgW, dy * svgH);
      const clamped = Math.max(HANDLE_LEN_PX, Math.min(HANDLE_LEN_PX * 2.4, lenPx));
      if (lenPx > 1e-4) {
        const k = clamped / lenPx;
        dx *= k; dy *= k;
      } else {
        // Degenerate (flat, zero-length) — point straight out.
        dx = (side === 'out' ? 1 : -1) * (HANDLE_LEN_PX / svgW);
        dy = 0;
      }
      out.push({ side, hx: nx + dx, hy: ny + dy });
    };
    if (selectedKf < kfs.length - 1 && node.interp !== 'hold') {
      const b = kfs[selectedKf + 1];
      place('out',
        afToFrac(node.af + node.outTan.tx * (b.af - node.af)),
        gainToFrac(node.gain + node.outTan.ty * (b.gain - node.gain)));
    }
    if (selectedKf > 0 && kfs[selectedKf - 1].interp !== 'hold') {
      const z = kfs[selectedKf - 1];
      place('in',
        afToFrac(node.af - node.inTan.tx * (node.af - z.af)),
        gainToFrac(node.gain - node.inTan.ty * (node.gain - z.gain)));
    }
    return out;
  }

  /** Which selected-node handle side is within HANDLE_HIT_PX, or null. */
  function hitHandle(fx: number, fy: number, rw: number, rh: number): HandleSide | null {
    for (const h of selectedHandles()) {
      if (Math.hypot((h.hx - fx) * rw, (h.hy - fy) * rh) <= HANDLE_HIT_PX) {
        return h.side;
      }
    }
    return null;
  }

  /** Write the selected node's `in` or `out` tangent from a handle
   *  position (clip fractions). Inverts the handle->segment-normalized
   *  mapping; tx is clamped to [0,1] so a handle can't cross a node. */
  function setHandleFromFrac(side: HandleSide, fx: number, fy: number) {
    if (selectedKf < 0 || selectedKf >= kfs.length) return;
    const node = kfs[selectedKf];
    const af = fracToAf(fx);
    const gain = fracToGain(fy);
    let tan: LevelTangent;
    if (side === 'out') {
      const b = kfs[selectedKf + 1];
      if (!b) return;
      const spanAf = b.af - node.af;
      const spanGain = b.gain - node.gain;
      tan = {
        tx: clamp01(spanAf !== 0 ? (af - node.af) / spanAf : 0),
        ty: spanGain !== 0 ? (gain - node.gain) / spanGain : 0,
      };
    } else {
      const z = kfs[selectedKf - 1];
      if (!z) return;
      const spanAf = node.af - z.af;
      const spanGain = node.gain - z.gain;
      tan = {
        tx: clamp01(spanAf !== 0 ? (node.af - af) / spanAf : 0),
        ty: spanGain !== 0 ? (node.gain - gain) / spanGain : 0,
      };
    }
    useStore.getState().setLevelKeyframeTangent(clip.id, selectedKf, side, tan);
  }

  function onPointerDown(ev: React.PointerEvent<SVGSVGElement>) {
    if (!penActive || ev.button !== 0) return;
    ev.stopPropagation();
    ev.preventDefault();
    const { fx, fy, rw, rh } = localFrac(ev);
    const store = useStore.getState();
    // Tangent handles of the selected node take priority — they sit
    // near the curve and would otherwise be shadowed by add/line hits.
    const side = hitHandle(fx, fy, rw, rh);
    if (side) {
      drag.current = { kind: 'handle', index: selectedKf, side, pointerId: ev.pointerId };
      svgRef.current!.setPointerCapture(ev.pointerId);
      return;
    }
    let index = hitNode(fx, fy, rw, rh);
    let grabAf = 0;
    let grabGain = 0;
    if (index < 0) {
      // Not on a node — only add one if the click lands ON the curve
      // line. The new node lands exactly on the line (no kink).
      const lineGain = evaluateLevel(kfs, fracToAf(fx));
      if (Math.abs(gainToFrac(lineGain) - fy) * rh > LINE_HIT_PX) return;
      index = store.addLevelKeyframe(clip.id, fracToAf(fx), lineGain) ?? -1;
      if (index < 0) return;
    } else {
      // Grabbed an existing node — capture the cursor->node offset so
      // the drag tracks 1:1 (kfs[] is current; no add happened).
      grabAf = fracToAf(fx) - kfs[index].af;
      grabGain = fracToGain(fy) - kfs[index].gain;
    }
    drag.current = { kind: 'node', index, pointerId: ev.pointerId, grabAf, grabGain };
    setSelectedKf(index);
    svgRef.current!.setPointerCapture(ev.pointerId);
  }
  function onPointerMove(ev: React.PointerEvent<SVGSVGElement>) {
    const d = drag.current;
    const { fx, fy, rw, rh } = localFrac(ev);
    if (d) {
      if (d.kind === 'node') {
        useStore.getState().moveLevelKeyframe(
          clip.id, d.index,
          fracToAf(fx) - d.grabAf, fracToGain(fy) - d.grabGain);
      } else {
        setHandleFromFrac(d.side, fx, fy);
      }
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

  const path = buildPath(kfs, afToFrac, gainToFrac);
  const handles = penActive ? selectedHandles() : [];
  const selNode = selectedKf >= 0 && selectedKf < kfs.length ? kfs[selectedKf] : null;

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
        {/* Tangent connector lines — selected node to each handle. */}
        {selNode && handles.map((h) => (
          <line
            key={h.side}
            className="level-curve__handle-line"
            x1={afToFrac(selNode.af) * VB} y1={gainToFrac(selNode.gain) * VB}
            x2={h.hx * VB} y2={h.hy * VB}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      {/* Diamond nodes — DOM divs positioned by %, so they stay square
          and follow the clip width with zero lag. */}
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
      {/* Round bezier handle dots for the selected node's tangents. */}
      {handles.map((h) => (
        <div
          key={h.side}
          className="level-curve__handle"
          style={{ left: (h.hx * 100) + '%', top: (h.hy * 100) + '%' }}
        />
      ))}
    </>
  );
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Build the SVG curve path (0..VB viewBox units): a flat lead-in to
 *  the first node, a cubic per segment (or a step for 'hold'), a flat
 *  lead-out. The cubic control points come from each node's tangents,
 *  matching evaluateLevel. */
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
    const spanAf = b.af - a.af;
    const spanGain = b.gain - a.gain;
    const p1af = a.af + a.outTan.tx * spanAf;
    const p1g  = a.gain + a.outTan.ty * spanGain;
    const p2af = b.af - b.inTan.tx * spanAf;
    const p2g  = b.gain - b.inTan.ty * spanGain;
    seg.push(`C ${X(p1af)} ${Y(p1g)} ${X(p2af)} ${Y(p2g)} ${X(b.af)} ${Y(b.gain)}`);
  }
  seg.push(`L ${VB} ${Y(kfs[kfs.length - 1].gain)}`);
  return seg.join(' ');
}
