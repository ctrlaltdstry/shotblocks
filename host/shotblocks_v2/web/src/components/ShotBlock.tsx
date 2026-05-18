import { useRef, type CSSProperties } from 'react';
import { useStore, type Clip } from '../store';
import { useClipDrag } from '../useClipDrag';

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
  style,
}: {
  clip: Clip;
  side: 'video' | 'audio';
  trackId: string;
  thin: boolean;
  style?: CSSProperties;
}) {
  const edgeHover = useStore((s) => s.edgeHover);
  const hoverLeft  = edgeHover.has(clip.id + ':left');
  const hoverRight = edgeHover.has(clip.id + ':right');
  const dragClip = useStore((s) => s.dragClip);
  const isDragging = dragClip?.clipId === clip.id;
  const isSelected = useStore((s) => s.selectedClipIds.has(clip.id));
  const ref = useRef<HTMLDivElement | null>(null);
  useClipDrag(clip, trackId, side, ref);

  // Razor cut-line preview: when the razor tool is active and the
  // cursor is over this clip, publish the pointer's viewport X to the
  // store so the App-level CutLineOverlay can render a vertical line
  // spanning ruler + lanes-area. Lets the user see exactly which
  // frame they'll cut on, on every track. Pointer-leave clears.
  function onRazorPointerMove(ev: React.PointerEvent<HTMLDivElement>) {
    if (useStore.getState().activeTool !== 'razor') return;
    useStore.getState().setRazorHoverX(ev.clientX);
  }
  function onRazorPointerLeave() {
    if (useStore.getState().razorHoverX != null) {
      useStore.getState().setRazorHoverX(null);
    }
  }

  // Selection is store-driven, not clip-state-driven. The legacy
  // clip.state values for 'selected' / 'orphaned-selected' are kept as
  // a compatibility hint (orphan + selected still need the red color),
  // but the actual is-selected class comes from selectedClipIds.
  const cls = [
    'shot-block',
    side === 'video' ? 'is-video' : 'is-audio',
    isSelected && 'is-selected',
    (clip.state === 'orphaned' || clip.state === 'orphaned-selected') && 'is-orphaned',
    (clip.state === 'locked' || clip.locked) && 'is-locked',
    thin && 'is-thin',
    hoverLeft  && 'is-edge-left',
    hoverRight && 'is-edge-right',
    isDragging && 'is-dragging',
  ].filter(Boolean).join(' ');

  // Icon class follows state + side:
  //   video, non-orphan  -> camera
  //   video, orphan      -> camera-off
  //   audio (always)     -> waveform
  let iconClass = 'icon icon--block-camera';
  if (side === 'audio') iconClass = 'icon icon--block-waveform';
  else if (clip.state === 'orphaned' || clip.state === 'orphaned-selected') {
    iconClass = 'icon icon--block-camera-off';
  }

  return (
    <div
      ref={ref}
      className={cls}
      style={style}
      title={clip.sourceName}
      data-clip={clip.id}
      onPointerMove={onRazorPointerMove}
      onPointerLeave={onRazorPointerLeave}
    >
      {/* Content (label + icon) inside its own overflow:hidden frame
          so it gets clipped by the clip's rounded corners when the
          clip is narrow. The clip itself keeps overflow:visible so
          the bracket / selected overlays can extend 1px past its
          border (see memory clip-state-overlay-pattern). */}
      <div className="shot-block__content">
        <div className="shot-block__label">{clip.sourceName}</div>
        <div className="shot-block__icon-wrap">
          <span className={iconClass} />
        </div>
      </div>
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
