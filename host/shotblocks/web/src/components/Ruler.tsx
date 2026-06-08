import { useRef, type CSSProperties } from 'react';
import { useStore, magneticSnap, audioPeakDocFrames, cameraKeyframeSnapFrames, SNAP_PIXEL_RADIUS } from '../store';
import { useElementSize } from '../useElementSize';
import { computeRulerLayout } from '../lib/ruler';
import { send, seekToHost } from '../lib/host';
import playheadHandleUrl from '../icons/playhead-handle.svg';
import markerUrl from '../icons/marker.svg';
import { RangeBar } from './RangeBar';

/** Ruler row content: numbers + ticks + the playhead handle (which
 *  needs to be clipped to the ruler's overflow). Click + drag scrubs. */
export function Ruler() {
  const innerRef = useRef<HTMLDivElement | null>(null);
  const { width } = useElementSize(innerRef);
  const h = useStore((s) => s.h);
  const currentFrame = useStore((s) => s.currentFrame);
  const scrubFrame = useStore((s) => s.scrubFrame);
  const setScrubFrame = useStore((s) => s.setScrubFrame);
  const docMin = useStore((s) => s.docMin);
  const docMax = useStore((s) => s.docMax);
  const markers = useStore((s) => s.markers);
  const markersVisible = useStore((s) => s.markersVisible);

  // Render the scrub-preview frame if active, otherwise the C++ tick frame.
  // Decouples visible playhead from C++'s tick echo rate (which is slower
  // than the user's pointermove rate).
  const displayFrame = scrubFrame ?? currentFrame;

  const layout = computeRulerLayout(width, h.vMin, h.vMax);
  const visibleSpan = Math.max(1, h.vMax - h.vMin);
  const pxPerFrame = width / visibleSpan;

  // Playhead handle position (clipped by ruler-row's overflow:hidden).
  const handleVisible = displayFrame >= h.vMin && displayFrame <= h.vMax;
  const handleX = (displayFrame - h.vMin) * pxPerFrame;

  // Scrubbing. C++ owns the time; we send {kind:"seek", frame} and let
  // C++ broadcast tick back to us. Visually instant because we don't
  // wait for the round-trip — the next tick arrives within 1 frame.
  //
  // `drag` lives in a ref so it survives re-renders. (Plain let-vars
  // get reset on every render of this component, which happens every
  // ~40ms while the C4D timeline ticks; without the ref, only the
  // very first pointermove after a pointerdown would see dragging=true.)
  const drag = useRef({ active: false, lastSent: -1 });

  function frameFromClientX(clientX: number): number {
    const rect = innerRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const f = Math.round(h.vMin + (x / rect.width) * visibleSpan);
    return Math.max(docMin, Math.min(docMax, f));
  }
  /** Magnetically pull a raw scrub frame to nearby clip edit points.
   *  Snap is active when the Snap toggle is on OR Shift is held
   *  (Premiere model — Shift force-enables snap for this scrub). Edit
   *  points are every clip's in/out across BOTH sides — Python's
   *  `_drag_playhead` snaps the playhead to shot ins/outs + audio
   *  edges (sb_canvas_drag.py:549). The playhead is the moving thing,
   *  so it isn't its own target. Publishes the yellow indicator lines
   *  as a side effect. */
  function snapScrub(rawFrame: number, shiftKey: boolean): number {
    const s = useStore.getState();
    if (!s.snapEnabled && !shiftKey) {
      s.setSnapIndicatorFrames([]);
      return rawFrame;
    }
    const editPoints: number[] = [];
    for (const t of s.videoTracks) {
      for (const c of t.clips) editPoints.push(c.inFrame, c.outFrame);
    }
    for (const t of s.audioTracks) {
      for (const c of t.clips) editPoints.push(c.inFrame, c.outFrame);
    }
    // Beat positions are snap targets only when the grid is visible
    // (user-confirmed UX: invisible lines shouldn't snap).
    if (s.beatGridVisible) {
      for (const f of audioPeakDocFrames(s)) editPoints.push(f);
    }
    if (s.markersVisible) {
      for (const f of s.markers) editPoints.push(f);
    }
    // Park the playhead on any visible camera's keyframe dots too
    // (deduped) — most useful place to land exactly on a key.
    for (const f of cameraKeyframeSnapFrames(s)) editPoints.push(f);
    const snapFrames = Math.max(1, SNAP_PIXEL_RADIUS / Math.max(0.0001, pxPerFrame));
    // duration=0 → snap the single playhead frame directly to the
    // nearest edit point, no "other edge" to also align.
    const snap = magneticSnap(rawFrame, 0, editPoints, snapFrames);
    s.setSnapIndicatorFrames(snap.targets);
    return snap.inFrame;
  }
  function seek(clientX: number, ev: React.PointerEvent) {
    const raw = frameFromClientX(clientX);
    const f = Math.max(docMin, Math.min(docMax, snapScrub(raw, ev.shiftKey)));
    // Always update the optimistic preview — even when we skip the
    // outbound send, the local playhead must follow the cursor.
    setScrubFrame(f);
    if (f === drag.current.lastSent) return;
    drag.current.lastSent = f;
    // Coalesced seek: at most one request in flight, latest frame wins.
    // A per-pointermove fetch flooded the browser's connection pool and
    // C4D ran frames behind (see seekToHost).
    seekToHost(f);
    ev.preventDefault();
  }
  function onPointerDown(ev: React.PointerEvent<HTMLDivElement>) {
    if (ev.button !== 0) return;
    drag.current.active = true;
    // Tell C++ a scrub started. If v2 playback is running it freezes
    // transport so the playhead holds wherever this scrub puts it
    // (no-op if not playing). scrub-end resumes from the drop point.
    send({ kind: 'scrub-begin' }).catch(() => {});
    try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch { /* noop */ }
    seek(ev.clientX, ev);
  }
  function onPointerMove(ev: React.PointerEvent<HTMLDivElement>) {
    if (!drag.current.active) return;
    seek(ev.clientX, ev);
  }
  function onPointerEnd(ev: React.PointerEvent<HTMLDivElement>) {
    if (!drag.current.active) return;
    drag.current.active = false;
    // Resume playback (if it was frozen by scrub-begin) from the drop
    // point. C++ re-anchors its playback clock to the current frame.
    send({ kind: 'scrub-end' }).catch(() => {});
    // Don't clear scrubFrame here — setTick clears it once C++'s tick
    // echo catches up to the seeked frame. Clearing now would drop
    // the optimistic playhead back to the stale currentFrame and
    // make it visibly jump back a few frames.
    useStore.getState().setSnapIndicatorFrames([]);
    try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
  }

  // Right-click on the ruler → context menu. Hit-tests the cursor
  // against rendered markers (within MARKER_HIT_RADIUS px); if a
  // marker is hit the menu shows "Delete marker", otherwise it
  // shows "Delete all markers" (disabled when no markers exist).
  const MARKER_HIT_RADIUS = 8;
  function onContextMenu(ev: React.MouseEvent<HTMLDivElement>) {
    ev.preventDefault();
    ev.stopPropagation();
    const rect = innerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cursorFrame = frameFromClientX(ev.clientX);
    const radiusFrames = MARKER_HIT_RADIUS / Math.max(0.0001, pxPerFrame);
    let hitFrame: number | null = null;
    for (const m of markers) {
      if (Math.abs(m - cursorFrame) <= radiusFrames) {
        // Pick the closest if multiple are in range.
        if (hitFrame == null || Math.abs(m - cursorFrame) < Math.abs(hitFrame - cursorFrame)) {
          hitFrame = m;
        }
      }
    }
    useStore.getState().setContextMenu({
      x: ev.clientX,
      y: ev.clientY,
      targetClipId: null,
      targetTrackId: null,
      targetRulerMarker: { frame: hitFrame },
    });
  }

  return (
    <div
      ref={innerRef}
      className="ruler-row__inner"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onContextMenu={onContextMenu}
    >
      {/* Negative-frame tint: a subtle purple wash over the ruler region
          left of frame 0, so it's obvious at a glance when the doc starts
          before 0 (v2 mirrors C4D's ruler, MinTime can be negative). Spans
          from the left edge to the x of frame 0; only when any negative
          frames are visible. Pointer-events:none so it never eats a scrub. */}
      {h.vMin < 0 && (
        <div
          className="ruler__neg-zone"
          style={{ left: 0, width: ((0 - h.vMin) * pxPerFrame) + 'px' }}
        />
      )}
      {/* Play-range dim used to render here too, but it darkens the
          ruler in a way that fights the chrome design. The dim still
          shows on the lanes area below (mounted in App.tsx). */}
      <RangeBar rulerRef={innerRef} />
      <div className="ruler__numbers">
        {layout.labels.map((lbl) => {
          const style: CSSProperties = { left: lbl.x + 'px' };
          if (lbl.align === 'left') style.transform = 'none';
          else if (lbl.align === 'right') style.transform = 'translateX(-100%)';
          return <div key={lbl.text + ':' + lbl.x} className="ruler__number" style={style}>{lbl.text}</div>;
        })}
      </div>
      <div className="ruler__ticks">
        {layout.ticks.map((t, i) => (
          <div
            key={i}
            className={'ruler__tick ' + (t.isMajor ? 'is-major' : 'is-minor')}
            style={{ left: t.x + 'px' }}
          />
        ))}
      </div>
      {markersVisible && markers.map((m) => {
        if (m < h.vMin || m > h.vMax) return null;
        const x = (m - h.vMin) * pxPerFrame;
        return (
          <img
            key={m}
            className="ruler__marker"
            src={markerUrl}
            alt=""
            data-marker-frame={m}
            style={{ left: x + 'px' }}
          />
        );
      })}
      {handleVisible && (
        <img
          className="ruler__handle"
          src={playheadHandleUrl}
          alt=""
          style={{ left: handleX + 'px' }}
        />
      )}
    </div>
  );
}

