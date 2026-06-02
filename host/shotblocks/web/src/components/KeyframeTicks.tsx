import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { useStore, keyColKey, parseKeyCol, type Clip } from '../store';
import { flushKeyframeColumnShifts } from '../usePersistence';

// Past this many px of movement, a dot pointer-press becomes a column
// DRAG (shift the keys) rather than a click (select). Matches the clip
// drag threshold feel.
const DOT_DRAG_THRESHOLD_PX = 3;

/** Read-only keyframe-dot strip for a video ShotBlock. Renders one
 *  semi-transparent dot per DOCUMENT frame where the clip's referenced
 *  camera (or any of its tags) has a keyframe — a dope-sheet-style
 *  "where is there motion activity" glance, never interactive.
 *
 *  A CHILD of the clip (like BeatDots) so it rides the clip's CSS
 *  transform during a drag with no lag and stays in the clip's stacking
 *  context. Frames come from C++ on every `cameras` push (deduped +
 *  sorted + capped), keyed by objectId in `cameraKeyTimes`. We clip them
 *  to this clip's [inFrame, outFrame) window and position by frame-
 *  fraction — the same basis BeatDots / the waveform use, so dots line
 *  up exactly with the playhead at those frames.
 *
 *  Edge containment: dots are centred on their frame (left:% + the CSS
 *  translateX(-50%)), but a key sitting exactly on the clip's in- or
 *  out-point would then straddle the clip edge and get clipped to a half
 *  dot. So a boundary key is anchored by its EDGE instead — first-frame
 *  key pins flush-left (left:0, no shift), last-frame key pins flush-
 *  right (right:0) — so it shows as a whole dot just inside the clip.
 *
 *  Live retime preview: while this clip is being Alt-retimed
 *  (`retimingClipId === clip.id`), the camera's REAL keyTimes haven't
 *  moved yet (C++ rescales them only on drag-release), so the normal
 *  absolute mapping would drift as the window stretches. But retime
 *  PRESERVES each key's fraction-of-clip — so we snapshot the dot
 *  fractions when the retime starts and hold them while the clip
 *  stretches around them. On release the rescaled-keys echo clears
 *  retimingClipId and the absolute mapping resumes at the SAME fractions
 *  — seamless, no snap.
 *
 *  Hidden on thin clips (the strip would collide with the flipped thin
 *  layout) and when the clip has no keys in view. */
export function KeyframeTicks({ clip, thin }: { clip: Clip; thin: boolean }) {
  // Re-render on horizontal zoom so the fractions stay correct as the
  // clip's pixel width changes (positions are %-based, but reading h
  // keeps this subscribed to the same redraw cadence as the lane).
  const h = useStore((s) => s.h);
  void h;
  const keyTimes = useStore((s) =>
    clip.objectId > 0 ? s.cameraKeyTimes.get(clip.objectId) : undefined,
  );
  const retiming = useStore((s) => s.retimingClipId === clip.id);
  // True while THIS clip is being body-dragged. The clip glides via a CSS
  // transform; the dots, being children, ride it. But they ALSO recompute
  // their frame-fraction from the store's in/out, which updates in
  // discrete steps during the drag (ripple/group commit live, and the
  // commit re-renders the clip's left/right). For a frame on each step the
  // recomputed dot %-positions and the still-transformed clip disagree →
  // flash. Fix: while dragging, FREEZE each dot at the fraction it had at
  // drag-start (same mechanism as the retime preview) so the dots ride the
  // transform with the clip and never recompute mid-drag. Measured: the
  // keyframe DATA never blips (keyTimes stays steady) — only the position
  // mechanism desyncs, so freezing the fractions is sufficient.
  const dragging = useStore((s) => s.dragClip?.clipId === clip.id);
  // Selected keyframe-column frames on THIS clip's camera. Subscribe to
  // the whole set, derive the frames for our objectId (cheap; the set is
  // small). A dot renders selected when its frame is in here.
  const selectedColumns = useStore((s) => s.selectedKeyColumns);
  const selectedFramesSet = (() => {
    const out = new Set<number>();
    if (clip.objectId > 0) {
      for (const key of selectedColumns) {
        const { objectId, frame } = parseKeyCol(key);
        if (objectId === clip.objectId) out.add(frame);
      }
    }
    return out;
  })();
  // Dot-drag (column shift) state. Ref-based per react-drag-state-in-ref.
  // The live preview delta is mirrored into state so the dragged dot
  // re-renders translated; `dragFrame` marks which dot is being dragged.
  const dotDrag = useRef<{
    frame: number;            // the grabbed dot (anchor for the click-vs-drag)
    frames: number[];         // ALL selected columns on this clip being dragged
    startClientX: number; pxPerFrame: number;
    active: boolean; pointerId: number; deltaFrames: number;
  } | null>(null);
  // Set of frames currently mid-drag (for the live translate), and the
  // group delta. Empty when no drag active.
  const [dragFrames, setDragFrames] = useState<Set<number>>(new Set());
  const [dragDeltaFrames, setDragDeltaFrames] = useState(0);
  // Echo-hold after a column-shift release: the dot's frame in keyTimes
  // doesn't update until C++'s `cameras` echo lands a frame or two later,
  // so without this the dot snaps back to its OLD position for that gap
  // and flickers. We keep rendering the dragged dot at its NEW position
  // (held px offset) until keyTimes changes identity (the echo). Same
  // mechanism as the clip-move's frozenKeyTimes hold.
  const pendingShift = useRef<{
    frames: Set<number>; deltaPx: number; keyTimesAtRelease: number[] | undefined;
  } | null>(null);

  // Snapshot of each in-window dot's fraction-of-clip, captured when a
  // gesture (retime or body-drag) begins and held for its duration. null
  // when no gesture is active.
  const frozenFractions = useRef<number[] | null>(null);
  // The keyTimes array reference at freeze-start. Held positions persist
  // until `keyTimes` changes identity (the shifted-keys echo from C++),
  // bridging the gap between the local in/out commit on release and the
  // keys catching up — without it the dots flash at the stale-key spot.
  const frozenKeyTimes = useRef<number[] | undefined | null>(null);
  // Wall-clock when the freeze began. The echo wait is BOUNDED: a move
  // with zero net shift, or a shared camera (C++ skips the shift), never
  // produces a keyTimes echo — without a cap the dots would stay frozen
  // forever (and non-interactive). In those cases the frozen fractions
  // already equal the live ones (nothing moved), so unfreezing after the
  // cap is visually seamless.
  const frozenSince = useRef<number>(0);

  if (thin || !keyTimes || keyTimes.length === 0) {
    frozenFractions.current = null;
    frozenKeyTimes.current = null;
    return null;
  }

  // Echo wait is bounded so a no-shift / shared-camera move can't freeze
  // the dots forever. 500ms comfortably covers the C++ round-trip.
  const ECHO_WAIT_MS = 500;

  // --- Hold the drag-start fractions during a retime OR a body-drag, and
  // across the release until the shifted keys actually arrive ---
  //
  // A move shifts the camera's keys via a C++ round-trip (flushKeyframe-
  // Shifts → save → `cameras` echo), which lands a FRAME OR TWO AFTER the
  // clip's in/out already updated locally. Measured: on release the window
  // jumps to the new position while `keyTimes` still holds the OLD frames
  // for one render → the absolute mapping computes a wrong (often
  // negative) position → the dots flash, then snap right when the echo
  // lands. So we must NOT unfreeze the instant `dragging` goes false; we
  // hold the frozen fractions until `keyTimes` changes identity (the new
  // array = the echo arrived). Move preserves each key's fraction-of-clip,
  // so the frozen fractions are already the correct final positions — the
  // handoff is seamless. Mirrors the retime preview's echo handoff.
  const echoPending =
    frozenKeyTimes.current !== null
    && keyTimes === frozenKeyTimes.current
    && (Date.now() - frozenSince.current) < ECHO_WAIT_MS;
  if (retiming || dragging || echoPending) {
    if (frozenFractions.current === null) {
      // Capture once at gesture start, from the clip's current window.
      const dur = Math.max(1, clip.outFrame - clip.inFrame);
      const fr: number[] = [];
      for (const f of keyTimes) {
        if (f < clip.inFrame || f > clip.outFrame) continue;
        fr.push((f - clip.inFrame) / dur);
      }
      frozenFractions.current = fr;
      frozenKeyTimes.current = keyTimes;   // identity to watch for the echo
      frozenSince.current = Date.now();
    }
    const fracs = frozenFractions.current;
    if (fracs.length === 0) return null;
    return (
      <div className="keyframe-dots" aria-hidden="true">
        {fracs.map((fr, i) => {
          // Same edge-containment as the static path, but keyed off the
          // held fraction so the boundary dots stay pinned as the clip
          // stretches.
          const style: CSSProperties =
            fr <= 0 ? { left: 0, transform: 'none' }
            : fr >= 1 ? { right: 0, left: 'auto', transform: 'none' }
            : { left: fr * 100 + '%' };
          return <span key={i} className="keyframe-dot" style={style} />;
        })}
      </div>
    );
  }
  frozenFractions.current = null;
  frozenKeyTimes.current = null;
  frozenSince.current = 0;

  const clipDuration = Math.max(1, clip.outFrame - clip.inFrame);
  // Keys inside the clip's window. Keys outside simply don't draw (a clip
  // trimmed past its keys shows fewer dots — truthful). Each dot carries
  // its own anchor style so the two boundary cases stay fully contained,
  // plus its DOCUMENT frame so it can be selected (a dot = the keyframe
  // column at that frame on this clip's camera).
  const dots: { frame: number; style: CSSProperties }[] = [];
  for (const f of keyTimes) {
    if (f < clip.inFrame || f > clip.outFrame) continue;
    if (f === clip.inFrame) {
      // Flush-left: cancel the centring shift so the dot sits just inside
      // the left edge instead of straddling it.
      dots.push({ frame: f, style: { left: 0, transform: 'none' } });
    } else if (f === clip.outFrame) {
      // Flush-right: anchor by the right edge, same reason.
      dots.push({ frame: f, style: { right: 0, left: 'auto', transform: 'none' } });
    } else {
      dots.push({ frame: f, style: { left: ((f - clip.inFrame) / clipDuration) * 100 + '%' } });
    }
  }
  if (dots.length === 0) return null;

  function onDotPointerDown(frame: number, ev: ReactPointerEvent) {
    // Alt-press is the keyframe MARQUEE gesture (handled by useMarquee on
    // the lanes-area). Don't consume it here — let it fall through so a
    // marquee can start even when the press happens to land on a dot.
    if (ev.altKey) return;

    // A dot press is EITHER a click (select the column) OR a drag (shift
    // the selected columns). We resolve selection immediately on down,
    // then watch for movement past the threshold to promote to a drag.
    // Stop the event so it never reaches the clip body (clip drag / sel).
    ev.stopPropagation();
    ev.preventDefault();

    // Selection semantics (mirrors clip / level-keyframe selection):
    //   Shift-click → toggle this column in/out of the set.
    //   plain click on an UNSELECTED dot → select just this one.
    //   plain click on an ALREADY-SELECTED dot → keep the set (so you can
    //     drag the whole group; a no-move click leaves it as-is).
    const st = useStore.getState();
    const key = keyColKey(clip.objectId, frame);
    const cur = st.selectedKeyColumns;
    if (ev.shiftKey) {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key); else next.add(key);
      st.setSelectedKeyColumns(next);
    } else if (!cur.has(key)) {
      st.setSelectedKeyColumns(new Set([key]));
    }

    // pxPerFrame from the clip's rendered width (the dots' offsetParent
    // spans the clip). Measured at down so the drag math is exact.
    const dotsEl = ev.currentTarget.parentElement;          // .keyframe-dots
    const clipEl = dotsEl?.parentElement;                    // .shot-block
    const rect = clipEl?.getBoundingClientRect();
    const dur = Math.max(1, clip.outFrame - clip.inFrame);
    const pxPerFrame = rect && rect.width > 0 ? rect.width / dur : 0;
    if (pxPerFrame <= 0) return;

    // The drag group = this clip's selected columns (re-read the set after
    // the selection update above). A drag moves them all together. The
    // grabbed dot is always included (it was just selected). Columns on
    // OTHER clips/cameras in the selection are not moved by this drag —
    // group-drag is per-camera, owned by each clip's KeyframeTicks.
    const after = useStore.getState().selectedKeyColumns;
    const frames: number[] = [];
    for (const k of after) {
      const pc = parseKeyCol(k);
      if (pc.objectId === clip.objectId) frames.push(pc.frame);
    }
    if (!frames.includes(frame)) frames.push(frame);

    dotDrag.current = {
      frame, frames, startClientX: ev.clientX, pxPerFrame,
      active: false, pointerId: ev.pointerId, deltaFrames: 0,
    };
    try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch { /* noop */ }
  }

  function onDotPointerMove(ev: ReactPointerEvent) {
    const d = dotDrag.current;
    if (!d || d.pointerId !== ev.pointerId) return;
    const dxPx = ev.clientX - d.startClientX;
    if (!d.active) {
      if (Math.abs(dxPx) < DOT_DRAG_THRESHOLD_PX) return;
      d.active = true;
      setDragFrames(new Set(d.frames));
    }
    // Snap to whole frames. Clamp the GROUP delta so EVERY dragged column
    // stays inside the clip window (the lowest selected frame can't go
    // below inFrame, the highest can't exceed outFrame).
    const raw = Math.round(dxPx / d.pxPerFrame);
    const lo = Math.min(...d.frames);
    const hi = Math.max(...d.frames);
    const minDelta = clip.inFrame - lo;
    const maxDelta = clip.outFrame - hi;
    d.deltaFrames = Math.max(minDelta, Math.min(maxDelta, raw));
    setDragDeltaFrames(d.deltaFrames);
  }

  function onDotPointerEnd(ev: ReactPointerEvent) {
    const d = dotDrag.current;
    if (!d || d.pointerId !== ev.pointerId) return;
    try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
    dotDrag.current = null;
    const wasActive = d.active;
    const delta = d.deltaFrames;
    // Commit only a real drag (not a click) with a non-zero move. Moves
    // EVERY column in the drag group by the same delta.
    if (wasActive && delta !== 0) {
      let refCount = 0;
      const st = useStore.getState();
      for (const t of st.videoTracks)
        for (const c of t.clips)
          if (c.objectId === clip.objectId) refCount++;
      // Hold all dragged dots at their NEW positions until the shifted-keys
      // echo lands (keyTimes changes identity), bridging the C++ round-trip
      // so they don't flicker back. The live drag state clears now; the
      // echo-hold takes over the preview.
      pendingShift.current = {
        frames: new Set(d.frames), deltaPx: delta * d.pxPerFrame, keyTimesAtRelease: keyTimes,
      };
      flushKeyframeColumnShifts(
        d.frames.map((f) => ({ objectId: clip.objectId, frame: f, deltaFrames: delta, refCount })),
      );
      // Re-anchor the selection to the moved columns' NEW frames so they
      // stay selected after the echo refreshes the dots. Preserve any
      // selected columns on OTHER cameras (this drag didn't move them).
      const next = new Set<string>();
      for (const k of st.selectedKeyColumns) {
        if (parseKeyCol(k).objectId !== clip.objectId) next.add(k);
      }
      for (const f of d.frames) next.add(keyColKey(clip.objectId, f + delta));
      st.setSelectedKeyColumns(next);
    }
    setDragFrames(new Set());
    setDragDeltaFrames(0);
  }

  // Live drag offset in px for the dragged dots (group delta × pxPerFrame).
  const dragPx = dotDrag.current && dragFrames.size > 0
    ? dragDeltaFrames * dotDrag.current.pxPerFrame : 0;

  // Echo-hold: after release, keyTimes still has the dots at their OLD
  // frames until C++'s echo lands. Clear the hold once keyTimes changes
  // identity; until then keep the dragged dots at their new (held)
  // position so they don't flicker back.
  const ps = pendingShift.current;
  const heldFrames = ps && keyTimes === ps.keyTimesAtRelease ? ps.frames : null;
  const heldPx = ps ? ps.deltaPx : 0;
  if (ps && keyTimes !== ps.keyTimesAtRelease) {
    pendingShift.current = null;   // echo arrived; dots are at their real frames
  }

  return (
    <div className="keyframe-dots">
      {dots.map(({ frame, style }) => {
        // Overlay a translateX on dots being dragged (live) OR held
        // post-release until the echo lands. The base style's transform
        // handles centring (translate(-50%)) for interior dots / 'none'
        // for edge dots — compose the px offset after it so both apply.
        const isDragged = dragFrames.has(frame);
        const isHeld = !!heldFrames && heldFrames.has(frame);
        const px = isDragged ? dragPx : isHeld ? heldPx : 0;
        const composed: CSSProperties = (isDragged || isHeld)
          ? {
              ...style,
              transform:
                (style.transform && style.transform !== 'none'
                  ? `${style.transform} `
                  : '') + `translateX(${px}px)`,
            }
          : style;
        return (
          <span
            key={frame}
            className={'keyframe-dot is-interactive'
              + (selectedFramesSet.has(frame) || isDragged || isHeld ? ' is-selected' : '')
              + (isDragged || isHeld ? ' is-dragging' : '')}
            style={composed}
            data-kf-obj={clip.objectId}
            data-kf-frame={frame}
            onPointerDown={(ev) => onDotPointerDown(frame, ev)}
            onPointerMove={onDotPointerMove}
            onPointerUp={onDotPointerEnd}
            onPointerCancel={onDotPointerEnd}
          />
        );
      })}
    </div>
  );
}
