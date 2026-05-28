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
      // Hold the play-range cursor for the whole drag — the pointer
      // can leave the small chevron handle's box mid-drag.
      useStore.getState().setRangeHandleDragging(true);
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
        useStore.getState().setRangeHandleDragging(false);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
      }
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    };
  }

  /** Press on the range grip (the |||) — slides the WHOLE range
   *  (in + out together, length preserved, clamped to doc bounds).
   *  The grip is a small dedicated target; the rest of the blue tint
   *  is pure playhead-scrub surface (pointer-events:none), so there's
   *  no scrub-vs-range ambiguity. Ports Python `_drag_range_body`. */
  function onGripPointerDown(ev: React.PointerEvent<HTMLDivElement>) {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    ev.preventDefault();
    const px = pxPerFrame();
    if (px <= 0) return;

    const startClientX = ev.clientX;
    const startIn = playRangeIn;
    const startOut = playRangeOut;
    const length = startOut - startIn;

    function move(mv: PointerEvent) {
      const delta = Math.round((mv.clientX - startClientX) / px);
      const maxIn = Math.max(0, docFrames - length);
      const newIn = Math.max(0, Math.min(maxIn, startIn + delta));
      commit(newIn, newIn + length);
    }
    function up() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  const px = pxPerFrame();
  const xIn  = (playRangeIn  - h.vMin) * px;
  const xOut = (playRangeOut - h.vMin) * px;

  // Geometry for the gray handle SVG (Figma 538:3418/3421),
  // viewBox 0 0 11.077 50, preserveAspectRatio="none". A single merged
  // shape: a 3px bar on the RIGHT (viewBox x=8.077..11.077) with a
  // chevron pointing LEFT (apex near x=0.63).
  //
  // We anchor the bar's INNER edge to the in/out frame column:
  //   IN handle  — bar's LEFT edge (viewBox x≈8.077) sits at xIn
  //                → handleLeft = xIn − 8.077. Chevron sticks out to
  //                the LEFT of the range (outside it). ✓
  //   OUT handle — mirrored via scaleX(−1). The bar maps to mirror-x
  //                0..3; its RIGHT edge (inside-of-range) sits at xOut
  //                → handleLeft = xOut − 3. Chevron points RIGHT,
  //                sticking out to the right (outside). ✓
  const HANDLE_W = 11.077;
  const BAR_INNER = 8.077; // viewBox x of the bar's inner (left) edge.
  const inHandleStyle: CSSProperties = {
    left: (xIn - BAR_INNER) + 'px',
    width: HANDLE_W + 'px',
  };
  const outHandleStyle: CSSProperties = {
    left: (xOut - (HANDLE_W - BAR_INNER)) + 'px',
    width: HANDLE_W + 'px',
    transform: 'scaleX(-1)',
  };

  const rangeW = Math.max(0, xOut - xIn);
  const middleStyle: CSSProperties = {
    left: xIn + 'px',
    width: rangeW + 'px',
  };
  // The ||| grip — a small fixed-width drag target centered on the
  // range. Only this moves the range; the blue tint is pure scrub
  // surface. Hidden when the range is too narrow to hold it.
  const GRIP_W = 18;
  const gripFits = rangeW >= GRIP_W + 8;
  const gripStyle: CSSProperties = {
    left: (xIn + rangeW / 2 - GRIP_W / 2) + 'px',
    width: GRIP_W + 'px',
  };

  // When the range covers the entire document, treat that as "no
  // play range defined" — the user gets just the two thin blue bars
  // at the doc edges to grab and pull inward. No blue tint over
  // the ruler. Matches the Figma design's no-play-range state.
  const rangeIsFullDoc = playRangeIn <= 0 && playRangeOut >= docFrames;

  return (
    <>
      {/* Blue tint — VISUAL fill only (pointer-events:none), so the
          playhead can still be scrubbed anywhere inside the range.
          Hidden when range == full doc. */}
      {!rangeIsFullDoc && (
        <div
          className="range-bar__middle"
          style={middleStyle}
        />
      )}
      {/* Range grip — the ||| handle centered on the range. The ONLY
          range-move target; the blue tint stays pure scrub surface so
          the playhead and the range never fight for the same press.
          Three vertical lines drawn via CSS. Hidden on a narrow range. */}
      {!rangeIsFullDoc && gripFits && (
        <div
          className="range-bar__grip"
          style={gripStyle}
          onPointerDown={onGripPointerDown}
          title="Drag to move the play range"
        >
          <span /><span /><span />
        </div>
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
