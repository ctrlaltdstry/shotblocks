import { useRef, useState } from 'react';
import { useStore } from '../store';
import type { Track } from '../store';
import { ShotBlock } from './ShotBlock';
import { useElementSize } from '../useElementSize';

type CursorMode = 'default' | 'trim' | 'roll';

/** A single lane row. Renders its clips using the Figma-spec
 *  <ShotBlock>, picking the thin layout when the lane is short.
 *
 *  Edge-hover follows the standard NLE trim/roll model — see memory
 *  v2-nle-trim-model. Clips render edge-to-edge with no visual gap.
 *  Each clip has 8px inward trim hit zones at its left and right
 *  edges. At a seam where two clips touch, the right-trim zone of
 *  clip A overlaps the left-trim zone of clip B. That overlap is
 *  divided into THIRDS:
 *    - First third (toward A):  trim A's right edge only.
 *    - Middle third (the seam): rolling edit — both edges move
 *      together. Set on BOTH clips so the user sees both brackets.
 *    - Last third (toward B):   trim B's left edge only.
 *
 *  The lane sets a `cursor` value on itself so the cursor shape tells
 *  the user the mode (ew-resize for trim, col-resize for roll). */
const THIN_THRESHOLD_PX = 32;
const EDGE_PX = 8;

export function Lane({ track, side }: { track: Track; side: 'video' | 'audio' }) {
  const laneRef = useRef<HTMLDivElement | null>(null);
  const { height: laneHeight } = useElementSize(laneRef);
  const h = useStore((s) => s.h);
  const setEdgeHover = useStore((s) => s.setEdgeHover);
  const [cursorMode, setCursorMode] = useState<CursorMode>('default');
  const visibleSpan = Math.max(1, h.vMax - h.vMin);
  const thin = laneHeight > 0 && laneHeight < THIN_THRESHOLD_PX;
  const trackId = (side === 'video' ? 'V' : 'A') + track.id;

  function onPointerMove(ev: React.PointerEvent<HTMLDivElement>) {
    const rect = ev.currentTarget.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const pxPerFrame = rect.width / visibleSpan;
    if (pxPerFrame <= 0) return;

    // Sort by inFrame so "next" / "prev" really mean adjacent in
    // time (not adjacent in the unsorted clips array — drops happen
    // in any order, so the array is insertion-order, not time-order).
    const sorted = [...track.clips].sort((a, b) => a.inFrame - b.inFrame);
    const edges = new Set<string>();
    let mode: CursorMode = 'default';

    // First pass: is the cursor inside an "isolated" trim hit zone
    // (not overlapped with a neighbor's zone)? An isolated trim zone
    // is the right side of a clip whose right edge isn't shared with
    // a neighbor's left edge (or vice versa).
    for (let i = 0; i < sorted.length; i++) {
      const clip = sorted[i];
      const leftPx  = (clip.inFrame  - h.vMin) * pxPerFrame;
      const rightPx = (clip.outFrame - h.vMin) * pxPerFrame;
      const next = sorted[i + 1];
      const nextAdjacent = next && (next.inFrame - clip.outFrame) <= 1;

      // SEAM CASE: if this clip's right edge meets the next clip's
      // left edge, treat the full overlap zone [rightPx - EDGE_PX,
      // rightPx + EDGE_PX] as a unit and split into thirds. This zone
      // straddles both clips so we have to detect it BEFORE the
      // individual right-trim / left-trim checks so neither one
      // claims part of it.
      if (nextAdjacent && x >= rightPx - EDGE_PX && x <= rightPx + EDGE_PX) {
        const seamStart = rightPx - EDGE_PX;
        const seamEnd   = rightPx + EDGE_PX;
        const t1 = seamStart + (seamEnd - seamStart) / 3;
        const t2 = seamStart + (seamEnd - seamStart) * 2 / 3;
        if (x < t1) {
          edges.add(clip.id + ':right');
          mode = 'trim';
        } else if (x < t2) {
          edges.add(clip.id + ':right');
          edges.add(next!.id + ':left');
          mode = 'roll';
        } else {
          edges.add(next!.id + ':left');
          mode = 'trim';
        }
        break;
      }

      // ISOLATED right-trim (no adjacent next clip).
      if (x >= rightPx - EDGE_PX && x <= rightPx) {
        edges.add(clip.id + ':right');
        mode = 'trim';
        break;
      }

      // ISOLATED left-trim (no adjacent prev clip; adjacent seams
      // were handled by the previous iteration's seam block).
      if (x >= leftPx && x <= leftPx + EDGE_PX) {
        const prev = sorted[i - 1];
        const prevAdjacent = prev && (clip.inFrame - prev.outFrame) <= 1;
        if (!prevAdjacent) {
          edges.add(clip.id + ':left');
          mode = 'trim';
          break;
        }
      }
    }

    setEdgeHover(edges);
    setCursorMode(mode);
  }
  function onPointerLeave() {
    setEdgeHover(new Set());
    setCursorMode('default');
  }

  // Cursor: ew-resize for single-edge trim, col-resize for rolling edit.
  const cursor = cursorMode === 'trim' ? 'ew-resize'
              : cursorMode === 'roll' ? 'col-resize'
              : undefined;

  return (
    <div
      ref={laneRef}
      className="lane"
      data-track={trackId}
      data-side={side}
      style={cursor ? { cursor } : undefined}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      {track.clips.map((clip) => {
        const lanePctLeft  = ((clip.inFrame  - h.vMin) / visibleSpan) * 100;
        const lanePctRight = ((clip.outFrame - h.vMin) / visibleSpan) * 100;
        // Each clip is its own rounded rectangle. Adjacent clips show
        // a small visible cutout at the seam where their rounded
        // corners curve away from each other — accepted per user
        // direction; preserves the "each clip is a complete object"
        // visual.
        return (
          <ShotBlock
            key={clip.id}
            clip={clip}
            side={side}
            thin={thin}
            style={{
              left:  lanePctLeft + '%',
              right: (100 - lanePctRight) + '%',
            }}
          />
        );
      })}
    </div>
  );
}
