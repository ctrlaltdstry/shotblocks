import { useRef, useState } from 'react';
import { useStore, type Clip, type LevelKeyframe, type LevelTangent } from '../store';
import { useElementSize } from '../useElementSize';
import { evaluateLevel } from '../lib/levelCurve';

/** Pen-tool volume-automation overlay for an audio clip — the curve
 *  line, its diamond keyframe nodes, and (on a single selected node)
 *  the bezier tangent handles.
 *
 *  Lag-free layout. Everything is positioned in clip-relative
 *  FRACTIONS, never measured pixels — so it follows the clip's
 *  width/transform natively and never lags the waveform on zoom. The
 *  curve is an SVG with a fixed 1000x1000 viewBox +
 *  preserveAspectRatio="none", CSS-stretched to the clip; the nodes /
 *  handles are DOM divs positioned by left/top % so they stay square.
 *
 *  Interaction — modelled on Premiere Pro / Adobe Audition / Pro Tools
 *  envelope automation. With the Pen tool active (or Alt held):
 *
 *   - press on a NODE   -> drag it. If the node is part of a multi-
 *                          selection, the whole group moves together
 *                          (Pro Tools Trimmer model). A plain press
 *                          replaces the selection with just this node;
 *                          Shift-press toggles it in/out of the
 *                          selection.
 *   - press on a HANDLE -> reshape the bezier (single-selection only).
 *   - press elsewhere   -> begin a MARQUEE. Drag a rectangle; on
 *                          release every node inside is selected
 *                          (Shift-release = additive). The press can
 *                          be anywhere in the lane, INCLUDING over the
 *                          curve line — adding a node happens only on
 *                          a click (release without dragging past the
 *                          slop) when the press was on the line. A
 *                          click off the line clears the selection.
 *
 *  Per-node bezier (After Effects model): inTan shapes the segment
 *  arriving from the previous node, outTan the segment leaving to the
 *  next. Tangents are segment-normalized (see store).
 *
 *  Selection lives in the store (levelKfSelection) so Delete and the
 *  context menu can act on it. */

const VB = 1000;
const CURVE_BOTTOM = 0.94;
const NODE_HIT_PX = 14;
const HANDLE_HIT_PX = 18;
const HANDLE_LEN_PX = 34;
/** A click (no-drag release) within this many px of the curve line
 *  adds a node at that point. */
const LINE_HIT_PX = 16;
/** Px the pointer must travel before a press becomes a marquee drag
 *  (below this it's a click — adds a node on the line, or clears). */
const DRAG_SLOP_PX = 4;

type HandleSide = 'in' | 'out';

export function LevelCurve({ clip }: { clip: Clip }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const { width: svgW, height: svgH } = useElementSize(svgRef);
  const activeTool = useStore((s) => s.activeTool);
  const hMin = useStore((s) => s.h.vMin);
  const hMax = useStore((s) => s.h.vMax);
  void hMin; void hMax;

  // Alt held — store-owned so useToolCursor sees the same value (the
  // App-level useAltKey hook drives it). Plus altRmbZooming, set by
  // useAltRightZoom; the pen tool must be suppressed while that
  // gesture is in flight so Alt+RMB stays a zoom, not a pen invite.
  const altHeld = useStore((s) => s.altHeld);
  const altRmbZooming = useStore((s) => s.altRmbZooming);
  const penActive = (activeTool === 'pen' || altHeld) && !altRmbZooming;
  const kfs = clip.levelKeyframes ?? [];

  // The level-keyframe selection (store-owned). `sel` is THIS clip's
  // selected indices; empty when the selection belongs to another
  // clip or nothing is selected.
  const levelKfSelection = useStore((s) => s.levelKfSelection);
  const sel = levelKfSelection && levelKfSelection.clipId === clip.id
    ? levelKfSelection.indices : [];
  const selSet = new Set(sel);

  const [hoverKf, setHoverKf] = useState(-1);
  const [marquee, setMarquee] = useState<
    { x0: number; y0: number; x1: number; y1: number } | null
  >(null);

  // --- coordinate mapping (fractions, 0..1) -------------------------
  const clipDur = Math.max(1, clip.outFrame - clip.inFrame);
  const mediaOffset = clip.mediaOffsetFrames ?? 0;
  const afToFrac = (af: number) => (af - mediaOffset) / clipDur;
  const fracToAf = (fx: number) => mediaOffset + fx * clipDur;
  const gainToFrac = (g: number) => 0.5 + (1 - g) * (CURVE_BOTTOM - 0.5);
  const fracToGain = (fy: number) => 1 - (fy - 0.5) / (CURVE_BOTTOM - 0.5);

  function setSelection(indices: number[]) {
    useStore.getState().setLevelKfSelection(
      indices.length ? { clipId: clip.id, indices } : null);
  }

  // --- drag state ---------------------------------------------------
  // `pending` = press tracked; resolves to a drag once the pointer
  // moves past DRAG_SLOP_PX, or to a click on release without slop.
  const drag = useRef<
    | {
        kind: 'pending';
        pointerId: number; x0: number; y0: number;
        // The pre-resolved gesture target. On slop-exceeded:
        //   target.kind === 'node'   -> start a node-drag (group if
        //                               the node is in a multiselection
        //                               and shiftKey wasn't held).
        //   target.kind === 'handle' -> start a handle drag.
        //   target.kind === 'empty'  -> start a marquee.
        target:
          | { kind: 'node'; index: number }
          | { kind: 'handle'; side: HandleSide }
          | { kind: 'empty' };
        shiftKey: boolean;
        // On a click (no slop) on the line, this is the gain at the
        // click frame — used to add the new node ON the line.
        lineGain: number | null;
      }
    | {
        kind: 'node-drag';
        pointerId: number; index: number; group: number[];
        anchorStartAf: number; anchorStartGain: number;
        grabAf: number; grabGain: number;
        // For group drags the store action is RELATIVE (k.af + dA), so
        // each move must send only the NEW incremental delta — the
        // cumulative delta would compound every frame. Track what we
        // already applied so the next move sends `total - prev`.
        prevDAf: number; prevDGain: number;
      }
    | { kind: 'handle-drag'; pointerId: number; side: HandleSide; index: number }
    | {
        kind: 'marquee-drag';
        pointerId: number; x0: number; y0: number; shiftKey: boolean;
        baseSet: Set<number>;
      }
    | null
  >(null);

  function localFrac(ev: React.PointerEvent) {
    const r = svgRef.current!.getBoundingClientRect();
    return {
      fx: r.width > 0 ? (ev.clientX - r.left) / r.width : 0,
      fy: r.height > 0 ? (ev.clientY - r.top) / r.height : 0,
      rw: r.width,
      rh: r.height,
    };
  }

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

  /** Tangent handles — shown only when exactly ONE node is selected. */
  function selectedHandles(): { side: HandleSide; hx: number; hy: number }[] {
    const out: { side: HandleSide; hx: number; hy: number }[] = [];
    if (sel.length !== 1) return out;
    const idx = sel[0];
    if (idx < 0 || idx >= kfs.length || svgW <= 0 || svgH <= 0) return out;
    const node = kfs[idx];
    const nx = afToFrac(node.af);
    const ny = gainToFrac(node.gain);
    const place = (side: HandleSide, ctlXFrac: number, ctlYFrac: number) => {
      let dx = ctlXFrac - nx;
      let dy = ctlYFrac - ny;
      const lenPx = Math.hypot(dx * svgW, dy * svgH);
      const clamped = Math.max(HANDLE_LEN_PX, Math.min(HANDLE_LEN_PX * 2.4, lenPx));
      if (lenPx > 1e-4) {
        const k = clamped / lenPx;
        dx *= k; dy *= k;
      } else {
        dx = (side === 'out' ? 1 : -1) * (HANDLE_LEN_PX / svgW);
        dy = 0;
      }
      out.push({ side, hx: nx + dx, hy: ny + dy });
    };
    if (idx < kfs.length - 1 && node.interp !== 'hold') {
      const b = kfs[idx + 1];
      place('out',
        afToFrac(node.af + node.outTan.tx * (b.af - node.af)),
        gainToFrac(node.gain + node.outTan.ty * (b.gain - node.gain)));
    }
    if (idx > 0 && kfs[idx - 1].interp !== 'hold') {
      const z = kfs[idx - 1];
      place('in',
        afToFrac(node.af - node.inTan.tx * (node.af - z.af)),
        gainToFrac(node.gain - node.inTan.ty * (node.gain - z.gain)));
    }
    return out;
  }

  function hitHandle(fx: number, fy: number, rw: number, rh: number): HandleSide | null {
    for (const h of selectedHandles()) {
      if (Math.hypot((h.hx - fx) * rw, (h.hy - fy) * rh) <= HANDLE_HIT_PX) {
        return h.side;
      }
    }
    return null;
  }

  function setHandleFromFrac(side: HandleSide, fx: number, fy: number) {
    if (sel.length !== 1) return;
    const idx = sel[0];
    const node = kfs[idx];
    const af = fracToAf(fx);
    const gain = fracToGain(fy);
    let tan: LevelTangent;
    if (side === 'out') {
      const b = kfs[idx + 1];
      if (!b) return;
      const spanAf = b.af - node.af;
      const spanGain = b.gain - node.gain;
      tan = {
        tx: clamp01(spanAf !== 0 ? (af - node.af) / spanAf : 0),
        ty: spanGain !== 0 ? (gain - node.gain) / spanGain : 0,
      };
    } else {
      const z = kfs[idx - 1];
      if (!z) return;
      const spanAf = node.af - z.af;
      const spanGain = node.gain - z.gain;
      tan = {
        tx: clamp01(spanAf !== 0 ? (node.af - af) / spanAf : 0),
        ty: spanGain !== 0 ? (node.gain - gain) / spanGain : 0,
      };
    }
    useStore.getState().setLevelKeyframeTangent(clip.id, idx, side, tan);
  }

  function onPointerDown(ev: React.PointerEvent<SVGSVGElement>) {
    if (!penActive || ev.button !== 0) return;
    ev.stopPropagation();
    ev.preventDefault();
    const { fx, fy, rw, rh } = localFrac(ev);

    // Decide what the press is OVER. The actual gesture (drag vs click)
    // is resolved on the first move past slop, or on release.
    const handleSide = hitHandle(fx, fy, rw, rh);
    const nodeIdx = handleSide ? -1 : hitNode(fx, fy, rw, rh);
    let lineGain: number | null = null;
    if (handleSide === null && nodeIdx < 0) {
      const g = evaluateLevel(kfs, fracToAf(fx));
      if (Math.abs(gainToFrac(g) - fy) * rh <= LINE_HIT_PX) lineGain = g;
    }

    drag.current = {
      kind: 'pending',
      pointerId: ev.pointerId,
      x0: fx, y0: fy,
      target: handleSide
        ? { kind: 'handle', side: handleSide }
        : nodeIdx >= 0
          ? { kind: 'node', index: nodeIdx }
          : { kind: 'empty' },
      shiftKey: ev.shiftKey,
      lineGain,
    };
    svgRef.current!.setPointerCapture(ev.pointerId);
  }

  function onPointerMove(ev: React.PointerEvent<SVGSVGElement>) {
    const d = drag.current;
    const { fx, fy, rw, rh } = localFrac(ev);

    if (!d) {
      const hov = hitNode(fx, fy, rw, rh);
      if (hov !== hoverKf) setHoverKf(hov);
      return;
    }

    // Resolve a pending press into a drag once the pointer moves past
    // the slop. The PRESS already captured what was under it.
    if (d.kind === 'pending') {
      const moved = Math.hypot((fx - d.x0) * rw, (fy - d.y0) * rh);
      if (moved < DRAG_SLOP_PX) return;
      if (d.target.kind === 'handle') {
        // Reshape: the press was on a handle of the (single) selected node.
        const idx = sel[0] ?? -1;
        drag.current = { kind: 'handle-drag', pointerId: d.pointerId, side: d.target.side, index: idx };
        useStore.getState().setLevelCurveDragging(true);
      } else if (d.target.kind === 'node') {
        // Group-drag if the node was part of a multi-selection AND
        // shift wasn't held; otherwise single (selecting just it).
        const idx = d.target.index;
        const inMulti = selSet.has(idx) && sel.length > 1 && !d.shiftKey;
        const group = inMulti ? [...sel] : [idx];
        if (!inMulti) {
          if (d.shiftKey) {
            // Shift-drag a node starts a single drag of that node, but
            // toggles it into the selection rather than replacing.
            const nextSel = selSet.has(idx)
              ? sel.filter((i) => i !== idx)
              : [...sel, idx];
            setSelection(nextSel);
          } else {
            setSelection([idx]);
          }
        }
        drag.current = {
          kind: 'node-drag',
          pointerId: d.pointerId, index: idx, group,
          anchorStartAf: kfs[idx].af, anchorStartGain: kfs[idx].gain,
          grabAf: fracToAf(d.x0) - kfs[idx].af,
          grabGain: fracToGain(d.y0) - kfs[idx].gain,
          prevDAf: 0, prevDGain: 0,
        };
        useStore.getState().setLevelCurveDragging(true);
      } else {
        // Empty / line — start a marquee. Shift extends the existing
        // selection (additive); plain replaces it on release.
        drag.current = {
          kind: 'marquee-drag',
          pointerId: d.pointerId,
          x0: d.x0, y0: d.y0,
          shiftKey: d.shiftKey,
          baseSet: new Set(sel),
        };
      }
      // Re-dispatch this move into the new state.
      return onPointerMove(ev);
    }

    if (d.kind === 'handle-drag') {
      setHandleFromFrac(d.side, fx, fy);
      return;
    }
    if (d.kind === 'node-drag') {
      const wantAf = fracToAf(fx) - d.grabAf;
      const wantGain = fracToGain(fy) - d.grabGain;
      if (d.group.length > 1) {
        // moveLevelKeyframesBy adds dA to each node's CURRENT af, so
        // the move param must be the incremental delta since the
        // previous frame — not the cumulative delta (that would
        // compound every frame and the group would race the cursor).
        const totalDAf = wantAf - d.anchorStartAf;
        const totalDGain = wantGain - d.anchorStartGain;
        const stepDAf = totalDAf - d.prevDAf;
        const stepDGain = totalDGain - d.prevDGain;
        if (stepDAf !== 0 || stepDGain !== 0) {
          useStore.getState().moveLevelKeyframesBy(
            clip.id, d.group, stepDAf, stepDGain);
          d.prevDAf = totalDAf;
          d.prevDGain = totalDGain;
        }
      } else {
        useStore.getState().moveLevelKeyframe(clip.id, d.index, wantAf, wantGain);
      }
      return;
    }
    if (d.kind === 'marquee-drag') {
      setMarquee({ x0: d.x0, y0: d.y0, x1: fx, y1: fy });
    }
  }

  function onPointerEnd(ev: React.PointerEvent<SVGSVGElement>) {
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'pending') {
      // No drag — this was a click. Resolve by what the press was over.
      if (d.target.kind === 'node') {
        const idx = d.target.index;
        if (d.shiftKey) {
          // Shift-click toggles the node in/out of the selection.
          setSelection(selSet.has(idx)
            ? sel.filter((i) => i !== idx)
            : [...sel, idx]);
        } else {
          setSelection([idx]);
        }
      } else if (d.target.kind === 'handle') {
        // Click on a handle without dragging — no-op (the selection /
        // handle visibility already reflect the state).
      } else if (d.lineGain !== null) {
        // Click on the curve line → add a node and select it.
        const added = useStore.getState().addLevelKeyframe(
          clip.id, fracToAf(d.x0), d.lineGain) ?? -1;
        if (added >= 0) setSelection([added]);
      } else if (!d.shiftKey) {
        // Click on empty space (off the line) → clear the selection.
        setSelection([]);
      }
    } else if (d.kind === 'marquee-drag' && marquee) {
      const lo = { x: Math.min(marquee.x0, marquee.x1), y: Math.min(marquee.y0, marquee.y1) };
      const hi = { x: Math.max(marquee.x0, marquee.x1), y: Math.max(marquee.y0, marquee.y1) };
      const picked: number[] = [];
      for (let i = 0; i < kfs.length; i++) {
        const x = afToFrac(kfs[i].af);
        const y = gainToFrac(kfs[i].gain);
        if (x >= lo.x && x <= hi.x && y >= lo.y && y <= hi.y) picked.push(i);
      }
      // Shift-release: additive — union with the pre-drag selection.
      // Plain release: replace.
      const next = d.shiftKey
        ? Array.from(new Set([...d.baseSet, ...picked]))
        : picked;
      setSelection(next);
    }
    drag.current = null;
    setMarquee(null);
    useStore.getState().setLevelCurveDragging(false);
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
    // Right-clicking a node outside the selection makes it the
    // selection; right-clicking inside keeps the group (standard NLE
    // convention).
    if (!selSet.has(idx)) setSelection([idx]);
    useStore.getState().setContextMenu({
      x: ev.clientX, y: ev.clientY,
      targetClipId: null, targetTrackId: null,
      targetLevelKf: { clipId: clip.id, index: idx },
    });
  }

  const path = buildPath(kfs, afToFrac, gainToFrac);
  const handles = penActive ? selectedHandles() : [];
  const selNode = sel.length === 1 ? kfs[sel[0]] : null;
  const mRect = marquee ? {
    left: Math.min(marquee.x0, marquee.x1) * 100,
    top: Math.min(marquee.y0, marquee.y1) * 100,
    width: Math.abs(marquee.x1 - marquee.x0) * 100,
    height: Math.abs(marquee.y1 - marquee.y0) * 100,
  } : null;

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
      {kfs.map((k, i) => (
        <div
          key={i}
          className={'level-curve__node'
            + (i === hoverKf ? ' is-hover' : '')
            + (selSet.has(i) ? ' is-selected' : '')}
          style={{
            left: (afToFrac(k.af) * 100) + '%',
            top: (gainToFrac(k.gain) * 100) + '%',
          }}
        />
      ))}
      {handles.map((h) => (
        <div
          key={h.side}
          className="level-curve__handle"
          style={{ left: (h.hx * 100) + '%', top: (h.hy * 100) + '%' }}
        />
      ))}
      {mRect && (
        <div
          className="level-curve__marquee"
          style={{
            left: mRect.left + '%', top: mRect.top + '%',
            width: mRect.width + '%', height: mRect.height + '%',
          }}
        />
      )}
    </>
  );
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

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
