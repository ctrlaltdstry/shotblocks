import { useRef, type CSSProperties } from 'react';
import { useStore } from '../store';
import { send } from '../lib/host';
import rangeHandleUrl from '../icons/range-handle.svg';

/** Play-range bar overlaid on the ruler. Mirrors Python's
 *  `_draw_range_bar` (sb_canvas.py:1180-ish) semantics but uses the
 *  v2 Figma design: full-ruler-height chevron handles in primary-
 *  highlight blue, a translucent-blue tint over the range middle.
 *
 *  - In handle (left): chevron points left, 3px vertical bar on the
 *    inner edge marks the in frame.
 *  - Out handle (right): same SVG mirrored via scaleX(-1).
 *  - Middle (between handles): translucent blue tint over the ruler;
 *    drag to slide the whole range.
 *  - Double-click on the middle clears the range to the full doc.
 *
 *  The store carries playRangeIn / playRangeOut; edits go to C++ via
 *  'set-play-range' which writes C4D's LoopMinTime / LoopMaxTime.
 *  C++ re-broadcasts doc-info, round-tripping the new range back via
 *  setDocInfo. Optimistic local update keeps the UI snappy. */
export function RangeBar({ rulerRef }: { rulerRef: React.RefObject<HTMLDivElement | null> }) {
  const h = useStore((s) => s.h);
  const playRangeIn  = useStore((s) => s.playRangeIn);
  const playRangeOut = useStore((s) => s.playRangeOut);
  const docFrames    = useStore((s) => s.docFrames);
  const setPlayRange = useStore((s) => s.setPlayRange);

  const visibleSpan = Math.max(1, h.vMax - h.vMin);
  const dragRef = useRef<{ mode: 'in' | 'out'; startClientX: number; startIn: number; startOut: number } | null>(null);

  function pxPerFrame(): number {
    const w = rulerRef.current?.getBoundingClientRect().width ?? 0;
    return w / visibleSpan;
  }
  function commit(inFrame: number, outFrame: number) {
    inFrame  = Math.max(0, Math.min(docFrames, inFrame));
    outFrame = Math.max(inFrame + 1, Math.min(docFrames, outFrame));
    setPlayRange(inFrame, outFrame);
    void send({ kind: 'set-play-range', inFrame, outFrame });
  }

  function onPointerDown(mode: 'in' | 'out') {
    return (ev: React.PointerEvent<HTMLDivElement>) => {
      if (ev.button !== 0) return;
      ev.stopPropagation();
      ev.preventDefault();
      dragRef.current = {
        mode,
        startClientX: ev.clientX,
        startIn: playRangeIn,
        startOut: playRangeOut,
      };
      function move(mv: PointerEvent) {
        const d = dragRef.current;
        if (!d) return;
        const px = pxPerFrame();
        if (px <= 0) return;
        const dFrames = Math.round((mv.clientX - d.startClientX) / px);
        if (d.mode === 'in') {
          commit(d.startIn + dFrames, d.startOut);
        } else {
          commit(d.startIn, d.startOut + dFrames);
        }
      }
      function up() {
        dragRef.current = null;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
      }
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    };
  }

  const px = pxPerFrame();
  // Handle positions: the chevron-tip points outward. The 3px bar
  // sits on the INNER edge of the handle (at x=9..12 in the 16-wide
  // SVG, scaled to 12/16 = 75% across). For the in handle (left),
  // the bar's right edge should land on xIn. For the out handle
  // (right, mirrored), the bar's left edge should land on xOut.
  //
  // HANDLE_W is the visual width of the chevron SVG; we offset so the
  // inner 3px bar is exactly at the in/out frame column.
  const HANDLE_W = 16;
  const xIn  = (playRangeIn  - h.vMin) * px;
  const xOut = (playRangeOut - h.vMin) * px;

  // Geometry. In the 16×39 handle SVG (preserveAspectRatio="none"),
  // the 3-px blue bar lives at viewBox x=9..12 and the chevron
  // points LEFT with its apex around viewBox x=1.5 and base at x=12.
  //
  // We anchor the bar's INNER edge to the in/out frame column:
  //   IN handle  — bar's LEFT edge (viewBox x=9) sits at xIn
  //                → handleLeft = xIn − 9.
  //                Chevron renders at (xIn − 8)..(xIn + 3) — its base
  //                overlaps the bar, apex sticks out to the LEFT of
  //                the range (outside it). ✓
  //   OUT handle — mirrored via scaleX(−1). Mirrored bar is at
  //                viewBox-mirror x=(16−12)..(16−9) = 4..7. Its
  //                RIGHT edge (the inside-of-range edge after
  //                mirroring) sits at xOut → handleLeft = xOut − 7.
  //                Chevron (mirrored to x=4..15) points RIGHT, apex
  //                sticks out to the RIGHT of the range (outside). ✓
  //
  // At doc boundaries (xIn=0 or xOut=rulerW), the bar still sits
  // visibly at the ruler edge, marking the no-play-range state with
  // just the two thin blue bars (matches the Figma design).
  const inHandleStyle: CSSProperties = {
    left: (xIn - 9) + 'px',
    width: HANDLE_W + 'px',
  };
  const outHandleStyle: CSSProperties = {
    left: (xOut - 7) + 'px',
    width: HANDLE_W + 'px',
    transform: 'scaleX(-1)',
  };

  const middleStyle: CSSProperties = {
    left: xIn + 'px',
    width: Math.max(0, xOut - xIn) + 'px',
  };

  // When the range covers the entire document, treat that as "no
  // play range defined" — the user gets just the two thin blue bars
  // at the doc edges to grab and pull inward. No blue tint over
  // the ruler. Matches the Figma design's no-play-range state.
  const rangeIsFullDoc = playRangeIn <= 0 && playRangeOut >= docFrames;

  return (
    <>
      {/* Translucent blue tint middle. Purely visual — clicks pass
          through to the underlying ruler so the user can still scrub
          the playhead while a range is active. To re-position the
          range, drag a handle, press I/O, or use the right-click
          range-to-selection / clear-range menu. Hidden when range
          covers the full doc. */}
      {!rangeIsFullDoc && (
        <div
          className="range-bar__middle"
          style={middleStyle}
        />
      )}
      {/* In handle — chevron points left, blue bar at inner edge. */}
      <div
        className="range-bar__handle range-bar__handle--in"
        style={inHandleStyle}
        onPointerDown={onPointerDown('in')}
        title="Drag to set play-range in"
      >
        <img src={rangeHandleUrl} alt="" />
      </div>
      {/* Out handle — same SVG mirrored. */}
      <div
        className="range-bar__handle range-bar__handle--out"
        style={outHandleStyle}
        onPointerDown={onPointerDown('out')}
        title="Drag to set play-range out"
      >
        <img src={rangeHandleUrl} alt="" />
      </div>
    </>
  );
}
