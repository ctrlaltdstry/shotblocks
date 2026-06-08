import { useRef } from 'react';
import { useStore } from '../store';
import { TrackHeader } from './TrackHeader';
import { VaSplitter } from './VaSplitter';
import addTrackPlusUrl from '../icons/add-track-plus.svg';
import addTrackPlusHoverUrl from '../icons/add-track-plus-hover.svg';

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

/** "+" add-track button that lives in the video spawn-buffer spacer, so
 *  it always sits centred just above the topmost video track header. The
 *  explicit, discoverable alternative to dragging a clip up to spawn a
 *  new track. Figma: 686:581 (default) / 686:582 (hover) — a 17px
 *  rounded square, faint grey border at rest, brand-purple (#824cee,
 *  same as Add Camera + clips) fill on hover. The
 *  plus is the verbatim Figma SVG export (grey at rest, white on hover);
 *  both states ship as assets and CSS swaps which is visible on hover. */
function AddTrackButton() {
  return (
    <button
      type="button"
      className="add-track-btn"
      data-tooltip="Add video track"
      data-tooltip-pos="below"
      aria-label="Add video track"
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        useStore.getState().addVideoTrack();
      }}
    >
      <img className="add-track-btn__plus add-track-btn__plus--default" src={addTrackPlusUrl} alt="" aria-hidden="true" />
      <img className="add-track-btn__plus add-track-btn__plus--hover" src={addTrackPlusHoverUrl} alt="" aria-hidden="true" />
    </button>
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
              stacks stay 1:1 aligned at all zoom/scroll positions. It
              also hosts the + button, which therefore always rides just
              above the topmost track header. */}
          <div className="lane-spacer" data-side="video">
            <AddTrackButton />
          </div>
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
