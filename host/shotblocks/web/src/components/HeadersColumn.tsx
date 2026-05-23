import { useRef } from 'react';
import { useStore } from '../store';
import { TrackHeader } from './TrackHeader';
import { VaSplitter } from './VaSplitter';

/** Drag handle on the headers / timeline seam — widens or narrows the
 *  track-headers column. Clamped in the store to [HEADERS_MIN_W,
 *  HEADERS_MAX_W]. A thin invisible strip; the col-resize cursor is
 *  the affordance. */
function HeadersResizeHandle() {
  const drag = useRef<{ startX: number; startW: number } | null>(null);
  function onPointerDown(ev: React.PointerEvent<HTMLDivElement>) {
    if (ev.button !== 0) return;
    drag.current = {
      startX: ev.clientX,
      startW: useStore.getState().headersWidth,
    };
    ev.currentTarget.setPointerCapture(ev.pointerId);
    // Suppress the body's grid-column transition for the duration of
    // the drag — otherwise every setHeadersWidth animates 160ms and
    // the column lags choppily behind the cursor.
    document.body.classList.add('is-resizing-headers');
    ev.preventDefault();
    ev.stopPropagation();
  }
  function onPointerMove(ev: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    useStore.getState().setHeadersWidth(d.startW + (ev.clientX - d.startX));
  }
  function onPointerEnd(ev: React.PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    drag.current = null;
    document.body.classList.remove('is-resizing-headers');
    try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
  }
  return (
    <div
      className="headers__resize"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    />
  );
}

/** Headers column — video on top (rendered reversed: Vn..V1), audio
 *  below, V/A splitter between. Driven entirely by store. */
export function HeadersColumn({
  stackRef,
  videosRef,
}: {
  stackRef: React.RefObject<HTMLDivElement | null>;
  videosRef: React.RefObject<HTMLDivElement | null>;
}) {
  const videoTracks = useStore((s) => s.videoTracks);
  const audioTracks = useStore((s) => s.audioTracks);
  const videosOrdered = [...videoTracks].reverse();
  return (
    <div className="headers">
      <div className="stack" ref={stackRef}>
        <div className="stack__videos" id="headers-videos" ref={videosRef}>
          {/* Spacer matches the lanes-side spawn buffer so the two
              stacks stay 1:1 aligned at all zoom/scroll positions. */}
          <div className="lane-spacer" data-side="video" />
          {videosOrdered.map((t) => (
            <TrackHeader key={t.id} track={t} side="video" />
          ))}
        </div>
        <VaSplitter />
        <div className="stack__audios" id="headers-audios">
          {audioTracks.map((t) => (
            <TrackHeader key={t.id} track={t} side="audio" />
          ))}
          <div className="lane-spacer" data-side="audio" />
        </div>
      </div>
      <HeadersResizeHandle />
    </div>
  );
}
