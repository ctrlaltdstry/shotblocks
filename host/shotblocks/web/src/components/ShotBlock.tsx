import { useRef, type CSSProperties } from 'react';
import { useStore, SNAP_PIXEL_RADIUS, EDGE_INTERACTIVE_MIN_PX, type Clip } from '../store';
import { useClipDrag } from '../useClipDrag';
import { WaveformCanvas } from './WaveformCanvas';
import { LevelCurve } from './LevelCurve';
import { BeatDots } from './BeatDots';

/** Shot block (a clip rendered inside a Lane). Visual matrix per
 *  Figma node 173:1827: state × type × height.
 *
 *  Modifiers:
 *    .is-video / .is-audio        — color family + icon
 *    .is-selected                 — adds the white outline
 *    .is-orphaned                 — orphan-red color + camera-off icon
 *    .is-locked                   — grey + locked styling
 *    .is-thin                     — flips layout (icon to the right,
 *                                   label fills row) for lanes <32px tall
 *
 *  Edge highlights (yellow brackets) are computed by the parent Lane
 *  and stored in `state.edgeHover` as a Set of `${clipId}:left|right`
 *  keys. Lane lookup happens at the lane level so when two clips
 *  share a seam BOTH light up — single source of truth. */
export function ShotBlock({
  clip,
  side,
  trackId,
  thin,
  widthPx,
  style,
}: {
  clip: Clip;
  side: 'video' | 'audio';
  trackId: string;
  thin: boolean;
  widthPx: number;
  style?: CSSProperties;
}) {
  const edgeHover = useStore((s) => s.edgeHover);
  const hoverLeft  = edgeHover.has(clip.id + ':left');
  const hoverRight = edgeHover.has(clip.id + ':right');
  const dragClip = useStore((s) => s.dragClip);
  const isDragging = dragClip?.clipId === clip.id;
  const isSelected = useStore((s) => s.selectedClipIds.has(clip.id));
  const beatGridVisible = useStore((s) => s.beatGridVisible);
  // Orphan flag — two cases:
  //   - video: clip's objectId resolves to a deleted BaseObject (C++
  //     EVMSG_CHANGE push flagged it).
  //   - audio: clip's mediaId couldn't be loaded from the C++ helper
  //     (bytes missing or decode failed). Rare in practice — embedded
  //     bytes don't usually go missing — but handled for resilience.
  const isOrphan = useStore((s) => {
    if (side === 'video') {
      return clip.objectId > 0 && s.orphanObjectIds.has(clip.objectId);
    }
    const mediaId = clip.mediaId ?? clip.id;
    return s.orphanMediaIds.has(mediaId);
  });
  // Live OM name for video clips; falls back to the persisted
  // sourceName when the camera isn't currently in C++'s
  // _cameraLinks (orphan / not yet announced). Audio clips don't
  // participate in the OM rename flow — sourceName is authoritative.
  const liveName = useStore((s) =>
    side === 'video' && clip.objectId > 0 ? s.cameraNames.get(clip.objectId) : undefined
  );
  const displayName = liveName ?? clip.sourceName;
  const ref = useRef<HTMLDivElement | null>(null);
  const onClipPointerDown = useClipDrag(clip, trackId, side, ref);

  // Razor cut-line preview: when the razor tool is active and the
  // cursor is over this clip, publish the pointer's viewport X to the
  // store so the App-level CutLineOverlay can render a vertical line
  // spanning ruler + lanes-area. Lets the user see exactly which
  // frame they'll cut on, on every track. Pointer-leave clears.
  //
  // When snap is active (Snap toggle on OR Shift held), the preview
  // line pulls to the playhead within SNAP_PIXEL_RADIUS so the visual
  // matches where the cut lands — see the razor-snap branch in
  // useClipDrag.
  function onRazorPointerMove(ev: React.PointerEvent<HTMLDivElement>) {
    const s = useStore.getState();
    if (s.activeTool !== 'razor') return;
    // Razor only cuts audio clips. Don't preview the cut line over a
    // video clip — the user would see the highlight and expect a cut
    // to happen, which won't (see razor branch in useClipDrag).
    if (side === 'video') return;
    let hoverX = ev.clientX;
    if (s.snapEnabled || ev.shiftKey) {
      const laneEl = ev.currentTarget.closest('.lane') as HTMLElement | null;
      if (laneEl) {
        const r = laneEl.getBoundingClientRect();
        const span = Math.max(1, s.h.vMax - s.h.vMin);
        const pxPerFrame = r.width / span;
        const playhead = s.scrubFrame ?? s.currentFrame;
        const playheadX = r.left + (playhead - s.h.vMin) * pxPerFrame;
        if (Math.abs(ev.clientX - playheadX) <= SNAP_PIXEL_RADIUS) hoverX = playheadX;
      }
    }
    // Publish the hovered clip's vertical extent so the cut-line
    // overlay can brighten just the segment over this clip — the
    // part of the line that will actually slice.
    const blockRect = ev.currentTarget.getBoundingClientRect();
    s.setRazorHoverX(hoverX, { top: blockRect.top, bottom: blockRect.bottom });
  }
  function onRazorPointerLeave() {
    if (useStore.getState().razorHoverX != null) {
      useStore.getState().setRazorHoverX(null);
    }
  }

  // Right-click → context menu. If the clip isn't part of the current
  // selection, replace the selection with this clip first (NLE
  // convention: right-click doesn't act on a phantom selection).
  function onContextMenu(ev: React.MouseEvent) {
    ev.preventDefault();
    ev.stopPropagation();
    const sNow = useStore.getState();
    if (!sNow.selectedClipIds.has(clip.id)) {
      sNow.setSelectedClip(clip.id);
    }
    sNow.setContextMenu({ x: ev.clientX, y: ev.clientY, targetClipId: clip.id, targetTrackId: null });
  }

  // Selection is store-driven. Orphan is derived live from
  // orphanObjectIds (Commit 1's BaseLink snapshot). The legacy
  // clip.state values for 'selected' / 'orphaned-selected' are
  // ignored here — they were never authoritative.
  const cls = [
    'shot-block',
    side === 'video' ? 'is-video' : 'is-audio',
    isSelected && 'is-selected',
    isOrphan && 'is-orphaned',
    (clip.state === 'locked' || clip.locked) && 'is-locked',
    thin && 'is-thin',
    hoverLeft  && 'is-edge-left',
    hoverRight && 'is-edge-right',
    isDragging && 'is-dragging',
  ].filter(Boolean).join(' ');

  // Icon class follows state + side:
  //   video, non-orphan  -> camera
  //   video, orphan      -> camera-off
  //   audio, non-orphan  -> waveform
  //   audio, orphan      -> camera-off (no waveform-off icon yet)
  let iconClass = 'icon icon--block-camera';
  if (side === 'audio') {
    iconClass = isOrphan ? 'icon icon--block-camera-off' : 'icon icon--block-waveform';
  } else if (isOrphan) {
    iconClass = 'icon icon--block-camera-off';
  }

  // Label visibility — the .shot-block__label band uses a negative
  // horizontal margin (margin: 0 -14px) to span the clip's full width.
  // Combined with its own 13px+13px padding, the label's intrinsic
  // min-content width is ~54px. When the clip is narrower than that,
  // the label can't fit and forces the (absolute, inset:0, min-width:0)
  // content box to render WIDER than the clip — the clip-path then
  // clips to the wrong box, so text leaks past the clip's edge.
  // CSS clamps couldn't beat this (verified via CDP: a 6px clip
  // produced a 28px content box even with width:100%). Hiding the
  // label below the same threshold the edge-zones use matches NLE
  // convention (Premiere/FCP show no label on tiny clips). The native
  // title tooltip is gated on the same flag so it doesn't float
  // outside the clip rect.
  const labelFits = widthPx >= EDGE_INTERACTIVE_MIN_PX;
  return (
    <div
      ref={ref}
      className={cls}
      style={style}
      title={labelFits ? displayName : undefined}
      data-clip={clip.id}
      onPointerDown={onClipPointerDown}
      onPointerMove={onRazorPointerMove}
      onPointerLeave={onRazorPointerLeave}
      onContextMenu={onContextMenu}
    >
      {/* Content (label + icon) inside its own overflow:hidden frame
          so it gets clipped by the clip's rounded corners when the
          clip is narrow. The clip itself keeps overflow:visible so
          the bracket / selected overlays can extend 1px past its
          border (see memory clip-state-overlay-pattern). */}
      <div className="shot-block__content">
        {side === 'audio' && !isOrphan && (clip.waveformVisible ?? true) && clip.peakLevels && clip.peakLevels.length > 0 && (
          <WaveformCanvas clip={clip} />
        )}
        {labelFits && <div className="shot-block__label">{displayName}</div>}
        {side === 'video' && (
          <div className="shot-block__icon-wrap">
            <span className={iconClass} />
          </div>
        )}
        {side === 'audio' && !isOrphan && (
          <button
            className={'audio-waveform-toggle'
              + ((clip.waveformVisible ?? true) ? ' is-on' : ' is-off')}
            title={labelFits ? ((clip.waveformVisible ?? true) ? 'Hide waveform' : 'Show waveform') : undefined}
            onPointerDown={(e) => { e.stopPropagation(); }}
            onClick={(e) => {
              e.stopPropagation();
              useStore.getState().toggleClipWaveform(clip.id);
            }}
          >
            <span className="icon icon--block-waveform" />
          </button>
        )}
        {/* LevelCurve renders LAST so its pen-tool hit area covers the
            whole clip — incl. the strip under the label band, where
            the curve line actually sits. */}
        {side === 'audio' && <LevelCurve clip={clip} />}
      </div>
      {/* Beat-grid connector dots — a CHILD of the clip so they ride
          the clip's transform during a drag (no lag, no z-order
          glitch) and travel between tracks with it. */}
      {side === 'audio' && beatGridVisible && <BeatDots clip={clip} />}
      {/* Edge-hover brackets — always in the DOM at opacity 0; fade
          in via .is-edge-left / .is-edge-right on parent. Yellow
          three-sided rounded rectangles per Figma node 193:1166. */}
      <div className="shot-block__bracket shot-block__bracket--left" />
      <div className="shot-block__bracket shot-block__bracket--right" />
      {/* Selected-outline overlay — white 1px stroke covering the
          clip's own border. Toggled via .is-selected. */}
      <div className="shot-block__selected-outline" />
    </div>
  );
}
