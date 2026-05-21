import { useRef, type CSSProperties } from 'react';
import { useStore, magneticSnap, SNAP_PIXEL_RADIUS } from '../store';
import { useElementSize } from '../useElementSize';
import { computeRulerLayout } from '../lib/ruler';
import { send } from '../lib/host';
import playheadHandleUrl from '../icons/playhead-handle.svg';
import { RangeBar } from './RangeBar';
import { RangeDim } from './RangeDim';

/** Ruler row content: numbers + ticks + the playhead handle (which
 *  needs to be clipped to the ruler's overflow). Click + drag scrubs. */
export function Ruler() {
  const innerRef = useRef<HTMLDivElement | null>(null);
  const { width } = useElementSize(innerRef);
  const h = useStore((s) => s.h);
  const currentFrame = useStore((s) => s.currentFrame);
  const scrubFrame = useStore((s) => s.scrubFrame);
  const setScrubFrame = useStore((s) => s.setScrubFrame);
  const docFrames = useStore((s) => s.docFrames);

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
    return Math.max(0, Math.min(docFrames, f));
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
    const snapFrames = Math.max(1, SNAP_PIXEL_RADIUS / Math.max(0.0001, pxPerFrame));
    // duration=0 → snap the single playhead frame directly to the
    // nearest edit point, no "other edge" to also align.
    const snap = magneticSnap(rawFrame, 0, editPoints, snapFrames);
    s.setSnapIndicatorFrames(snap.targets);
    return snap.inFrame;
  }
  function seek(clientX: number, ev: React.PointerEvent) {
    const raw = frameFromClientX(clientX);
    const f = Math.max(0, Math.min(docFrames, snapScrub(raw, ev.shiftKey)));
    // Always update the optimistic preview — even when we skip the
    // outbound send, the local playhead must follow the cursor.
    setScrubFrame(f);
    if (f === drag.current.lastSent) return;
    drag.current.lastSent = f;
    send({ kind: 'seek', frame: f }).catch(() => {});
    ev.preventDefault();
  }
  function onPointerDown(ev: React.PointerEvent<HTMLDivElement>) {
    if (ev.button !== 0) return;
    drag.current.active = true;
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
    // Don't clear scrubFrame here — setTick clears it once C++'s tick
    // echo catches up to the seeked frame. Clearing now would drop
    // the optimistic playhead back to the stale currentFrame and
    // make it visibly jump back a few frames.
    useStore.getState().setSnapIndicatorFrames([]);
    try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
  }

  return (
    <div
      ref={innerRef}
      className="ruler-row__inner"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <RangeDim />
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

