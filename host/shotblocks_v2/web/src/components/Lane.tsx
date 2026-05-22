import { useEffect, useRef, useState } from 'react';
import { useStore, magneticSnap, audioPeakDocFrames, SNAP_PIXEL_RADIUS } from '../store';
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
/** Hit zone width for trim/roll detection at clip edges. Matches Python
 *  EDGE_HIT_PX = 24 (sb_canvas.py:217). At a seam between two clips this
 *  zone is shared (16px straddles both); see the seam-handling logic
 *  below. */
const EDGE_PX = 24;

export function Lane({ track, side }: { track: Track; side: 'video' | 'audio' }) {
  const laneRef = useRef<HTMLDivElement | null>(null);
  const { height: laneHeight } = useElementSize(laneRef);
  const h = useStore((s) => s.h);
  const setEdgeHover = useStore((s) => s.setEdgeHover);
  const setSelectedClip = useStore((s) => s.setSelectedClip);
  const resizeClip = useStore((s) => s.resizeClip);
  const setSnapIndicatorFrames = useStore((s) => s.setSnapIndicatorFrames);
  const [cursorMode, setCursorMode] = useState<CursorMode>('default');
  const visibleSpan = Math.max(1, h.vMax - h.vMin);
  const thin = laneHeight > 0 && laneHeight < THIN_THRESHOLD_PX;
  const trackId = (side === 'video' ? 'V' : 'A') + track.id;

  // Trim drag state. Ref-based (memory: react-drag-state-in-ref) — a
  // re-render would reset let-vars and break drag mid-stream. Captures
  // the clip + edge + original frames at pointer-down; pointermove
  // computes the new edge frame and calls resizeClip with snap applied.
  const trimRef = useRef<{
    active: boolean;
    clipId: number;
    edge: 'left' | 'right';
    origInFrame: number;
    origOutFrame: number;
    startClientX: number;
    pxPerFrame: number;
  } | null>(null);

  // Rolling-edit drag state. Two adjacent clips at a seam — leftClip's
  // outFrame == rightClip's inFrame. Pointermove computes the new seam
  // frame; rollEdit moves both edges simultaneously, clamped to keep
  // MIN_DURATION on each side.
  const rollRef = useRef<{
    active: boolean;
    leftClipId: number;
    rightClipId: number;
    origSeamFrame: number;
    startClientX: number;
    pxPerFrame: number;
  } | null>(null);

  const rollEdit = useStore((s) => s.rollEdit);

  function onPointerMove(ev: React.PointerEvent<HTMLDivElement>) {
    // While trimming or rolling, route to that handler — hover
    // detection pauses so the cursor doesn't switch modes mid-drag.
    if (trimRef.current && trimRef.current.active) {
      onTrimPointerMove(ev);
      return;
    }
    if (rollRef.current && rollRef.current.active) {
      onRollPointerMove(ev);
      return;
    }
    // Trim / roll edge-hover detection belongs to the SELECT tool only.
    // Skip it when:
    //  - the track is locked — no edits, so no trim/roll affordance.
    //  - the razor or slip tool is active — those tools own the seam
    //    with their own behavior (cut / slip); showing a trim or roll
    //    cursor there would promise an action the click doesn't do.
    //  - a slip drag or body drag is in progress — the dragged clip's
    //    edges sweep under the cursor and would flip the mode (and the
    //    cursor) every frame.
    const tool = useStore.getState().activeTool;
    if (track.locked
        || tool !== 'select'
        || useStore.getState().slipDragging
        || useStore.getState().dragClip) {
      if (cursorMode !== 'default') setCursorMode('default');
      return;
    }
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

      // Per-clip edge hit zone, capped so left/right zones never
      // overlap by more than half the clip width. Floor of 6px keeps
      // handles grabbable even on very narrow clips (a 16px-wide clip
      // gets 6px edges + 4px body — body shrinks but doesn't
      // vanish). Diverges from Python sb_canvas.py:1342 which caps
      // at clip_width/3 with floor 1px — that minimum was unusable
      // in the React UI at v2's higher MIN_CLIP_FRAMES.
      const clipWidth = rightPx - leftPx;
      const edgeZoneFloor = 6;
      const edgeZone = Math.min(
        EDGE_PX,
        Math.max(edgeZoneFloor, Math.floor(clipWidth / 3)),
        Math.floor(clipWidth / 2),   // never let two zones overlap each other
      );

      // SEAM CASE: if this clip's right edge meets the next clip's
      // left edge, treat the full overlap zone [rightPx - edgeZone,
      // rightPx + edgeZone] as a unit and split into thirds. This zone
      // straddles both clips so we have to detect it BEFORE the
      // individual right-trim / left-trim checks so neither one
      // claims part of it.
      if (nextAdjacent && x >= rightPx - edgeZone && x <= rightPx + edgeZone) {
        const seamStart = rightPx - edgeZone;
        const seamEnd   = rightPx + edgeZone;
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
      if (x >= rightPx - edgeZone && x <= rightPx) {
        edges.add(clip.id + ':right');
        mode = 'trim';
        break;
      }

      // ISOLATED left-trim (no adjacent prev clip; adjacent seams
      // were handled by the previous iteration's seam block).
      if (x >= leftPx && x <= leftPx + edgeZone) {
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
  function onPointerDown(ev: React.PointerEvent<HTMLDivElement>) {
    // A locked track accepts no trim / roll gesture (cursorMode is
    // already pinned to 'default' above, but guard the start too).
    if (track.locked) return;
    // Rolling-edit drag start. The seam case has edgeHover containing
    // BOTH clipA:right and clipB:left (set by the seam-third-detection
    // in onPointerMove above). We move both edges together; rollEdit
    // in the store clamps and updates the seam frame.
    if (cursorMode === 'roll' && ev.button === 0) {
      const state = useStore.getState();
      const edges = state.edgeHover;
      let leftClipId = -1;
      let rightClipId = -1;
      for (const key of edges) {
        const [idStr, side] = key.split(':');
        const cid = parseInt(idStr, 10);
        if (!track.clips.some((c) => c.id === cid)) continue;
        if (side === 'right') leftClipId  = cid;  // A's right edge → A is on the LEFT of the seam
        if (side === 'left')  rightClipId = cid;  // B's left edge → B is on the RIGHT of the seam
      }
      if (leftClipId >= 0 && rightClipId >= 0) {
        const leftClip  = track.clips.find((c) => c.id === leftClipId);
        const rightClip = track.clips.find((c) => c.id === rightClipId);
        if (leftClip && rightClip && leftClip.outFrame === rightClip.inFrame) {
          const rect = ev.currentTarget.getBoundingClientRect();
          const pxPerFrame = rect.width / visibleSpan;
          if (pxPerFrame > 0) {
            rollRef.current = {
              active: true,
              leftClipId,
              rightClipId,
              origSeamFrame: leftClip.outFrame,
              startClientX: ev.clientX,
              pxPerFrame,
            };
            try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch { /* noop */ }
            ev.preventDefault();
            ev.stopPropagation();
            return;
          }
        }
      }
    }
    // Trim-drag start. The current `edgeHover` set (already maintained
    // by onPointerMove above) tells us which clip + which edge the
    // cursor is on. The isolated-trim case has exactly one edge in
    // hover; the rolling-edit case (handled above) has two.
    if (cursorMode === 'trim' && ev.button === 0) {
      const state = useStore.getState();
      const edges = state.edgeHover;
      let clipId = -1;
      let edge: 'left' | 'right' | null = null;
      for (const key of edges) {
        const [idStr, side] = key.split(':');
        if (side === 'left' || side === 'right') {
          // Only start a trim if this edge belongs to a clip in OUR track.
          const cid = parseInt(idStr, 10);
          if (track.clips.some((c) => c.id === cid)) {
            clipId = cid;
            edge = side;
            break;
          }
        }
      }
      if (clipId >= 0 && edge) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          const rect = ev.currentTarget.getBoundingClientRect();
          const pxPerFrame = rect.width / visibleSpan;
          if (pxPerFrame > 0) {
            trimRef.current = {
              active: true,
              clipId,
              edge,
              origInFrame: clip.inFrame,
              origOutFrame: clip.outFrame,
              startClientX: ev.clientX,
              pxPerFrame,
            };
            try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch { /* noop */ }
            // Select the clip we're trimming (visual feedback during drag).
            setSelectedClip(clipId);
            ev.preventDefault();
            ev.stopPropagation();
            return;
          }
        }
      }
    }
    // Empty-area click + marquee selection are owned by useMarquee
    // on .lanes-area (the parent container). Lane's pointer-down only
    // needs to handle trim/roll start above this point.
  }

  function onTrimPointerMove(ev: React.PointerEvent<HTMLDivElement>) {
    const t = trimRef.current;
    if (!t || !t.active) return;
    const dxPx = ev.clientX - t.startClientX;
    const dxFrames = Math.round(dxPx / Math.max(0.0001, t.pxPerFrame));
    // Raw cursor-driven edge target frame, before snap.
    const rawWant = t.edge === 'left'
      ? t.origInFrame + dxFrames
      : t.origOutFrame + dxFrames;

    // Snap to edit points across the WHOLE timeline — every clip's
    // in/out on both sides (video + audio), all tracks — excluding the
    // clip being trimmed itself (self-snap). Global snapping, matching
    // body-drag and roll. Plus the playhead.
    const state = useStore.getState();
    const editPoints: number[] = [];
    for (const trk of [...state.videoTracks, ...state.audioTracks]) {
      for (const c of trk.clips) {
        if (c.id === t.clipId) continue;
        editPoints.push(c.inFrame, c.outFrame);
      }
    }
    editPoints.push(state.scrubFrame ?? state.currentFrame);
    for (const f of audioPeakDocFrames(state)) editPoints.push(f);
    // Snap gating (Premiere model): active when the Snap toggle is on
    // OR Shift is held — Shift force-enables snap for this trim even
    // with the toggle off. snapFrames=0 short-circuits magneticSnap.
    const snapActive = state.snapEnabled || ev.shiftKey;
    const snapFrames = snapActive ? Math.max(1, SNAP_PIXEL_RADIUS / t.pxPerFrame) : 0;
    // For a single-edge snap, snap the edge's want-frame directly to
    // the nearest edit point; treat duration as 0 so magneticSnap
    // doesn't try to also snap the OTHER edge.
    const snap = magneticSnap(rawWant, 0, editPoints, snapFrames);
    setSnapIndicatorFrames(snap.targets);
    // Cmd/Ctrl held during trim → ripple mode (push same-track
    // neighbors aside instead of overwriting them). Live: tapping the
    // modifier mid-drag toggles the mode, mirroring Premiere/Resolve.
    const mode = (ev.ctrlKey || ev.metaKey) ? 'ripple' : 'replace';
    resizeClip(t.clipId, trackId, t.edge, snap.inFrame, mode);
  }

  function onTrimPointerEnd(ev: React.PointerEvent<HTMLDivElement>) {
    const t = trimRef.current;
    if (!t || !t.active) return;
    t.active = false;
    trimRef.current = null;
    setSnapIndicatorFrames([]);
    try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
  }

  function onRollPointerMove(ev: React.PointerEvent<HTMLDivElement>) {
    const r = rollRef.current;
    if (!r || !r.active) return;
    const dxPx = ev.clientX - r.startClientX;
    const dxFrames = Math.round(dxPx / Math.max(0.0001, r.pxPerFrame));
    const rawSeam = r.origSeamFrame + dxFrames;

    // Snap the seam to edit points across the WHOLE timeline — every
    // clip's in/out on BOTH sides (video + audio), plus the playhead.
    // Exclude BOTH seam clips since they move together (self-snap).
    //
    // Why both sides, not just this side: a roll between the only two
    // clips on a track excludes both of them, leaving nothing on that
    // side to catch on. The user expects the seam to still snap to
    // clip edges elsewhere (e.g. the video clips above an audio roll).
    const state = useStore.getState();
    const editPoints: number[] = [];
    for (const trk of [...state.videoTracks, ...state.audioTracks]) {
      for (const c of trk.clips) {
        if (c.id === r.leftClipId || c.id === r.rightClipId) continue;
        editPoints.push(c.inFrame, c.outFrame);
      }
    }
    editPoints.push(state.scrubFrame ?? state.currentFrame);
    for (const f of audioPeakDocFrames(state)) editPoints.push(f);
    // Same gating as trim (Premiere model) — snap active when the Snap
    // toggle is on OR Shift is held. Roll has no ripple mode.
    const snapActive = state.snapEnabled || ev.shiftKey;
    const snapFrames = snapActive ? Math.max(1, SNAP_PIXEL_RADIUS / r.pxPerFrame) : 0;
    const snap = magneticSnap(rawSeam, 0, editPoints, snapFrames);
    setSnapIndicatorFrames(snap.targets);
    rollEdit(r.leftClipId, r.rightClipId, trackId, snap.inFrame);
  }

  function onRollPointerEnd(ev: React.PointerEvent<HTMLDivElement>) {
    const r = rollRef.current;
    if (!r || !r.active) return;
    r.active = false;
    rollRef.current = null;
    setSnapIndicatorFrames([]);
    try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
  }

  // Mirror roll-edit hover into the store so useToolCursor (global)
  // can force the roll cursor through the C++ host — needed for the
  // post-drag stale-cursor case. Only the seam-owning lane is ever
  // 'roll'; off-seam lanes are 'default' and set false (idempotent).
  useEffect(() => {
    if (cursorMode === 'roll') {
      useStore.getState().setRollEditActive(true);
      return () => useStore.getState().setRollEditActive(false);
    }
  }, [cursorMode]);

  // Cursor: ew-resize for single-edge trim; the custom roll-edit
  // cursor (data-URI, matching the C++ roll.cur) for a rolling edit.
  const ROLL_CURSOR =
    'url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAACOElEQVR4nO1WPYsTURQ99zIzJOTDLFgEkigGEdRSsp1r7MQ+/gOxEFH8wiosg1VSKrNotcoWrm4KswpW/oWgEtDOHyA2CQlxlXFPfCNhcSZ+TARlDgzz4M7cc9575973gAQJEvyDEAA3AXT5FpFgfKPRaMjC2dPpdJ6Eg8FgxxDPjnMLFwCgQjLf9/1AQDBW1fIiiQ8CyKrqgQgB/CYDIFYhWQBXyuXyCwBrqnooTAAAxu7zWxG5ZP79Iyw7jrPuuu6b0Wj0mSSWZZ0IEyAi09hkMvnSbDZfAXgI4OTvEO8HcKtWq73s9/sffQNDeCpiBb7HiF6v94E5WCEAluayfssznfWjdrvd50z8GQSEEQK6swII5vA87102m90QkeVIAblczt6d/d1Op/PejxnMCeBOoVCwQgXYts0av53JZJ57nvc2rhVotVp9x3G2RcSN7BX5fN4WkdN0O4Bt7h/3cY+ArQgBW7MC6B/jAcbWTG57nhVsVT0K4JqIbFIIHc2ZGKefixAwjY3H4x3XdV87jvMMwBOakDmLxeJc8inq9bpYlrVPRM7QE0xaKpXYBx6r6kpEI2IVbJqe8ZR7LiJnU6nUkjlDfhlcjSMALpuaXg1q/UcCGBOR1d2G9ADARVU9XK1Ww033kxCaU0SOsR3P64SqyrPiuDFb/Kej6ffd4XD4KRAQjE1s4aiYJe7uedbjPoTCwKW9AOAegOsArooIx+f/1n2AFcKGVeGbD/fdNLHF34gSJPjv8BWapcIsthuGngAAAABJRU5ErkJggg==") 16 16, col-resize';
  const cursor = cursorMode === 'trim' ? 'ew-resize'
              : cursorMode === 'roll' ? ROLL_CURSOR
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
      onPointerDown={onPointerDown}
      onPointerUp={(ev) => { onTrimPointerEnd(ev); onRollPointerEnd(ev); }}
      onPointerCancel={(ev) => { onTrimPointerEnd(ev); onRollPointerEnd(ev); }}
    >
      {track.clips.map((clip) => {
        const lanePctLeft  = ((clip.inFrame  - h.vMin) / visibleSpan) * 100;
        const lanePctRight = ((clip.outFrame - h.vMin) / visibleSpan) * 100;
        return (
          <ShotBlock
            key={clip.id}
            clip={clip}
            side={side}
            trackId={trackId}
            thin={thin}
            style={{
              left:  lanePctLeft + '%',
              right: (100 - lanePctRight) + '%',
            }}
          />
        );
      })}
      {track.locked && <div className="lane__locked-overlay" />}
    </div>
  );
}
