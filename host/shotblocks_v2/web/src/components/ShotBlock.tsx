import type { CSSProperties } from 'react';
import type { Clip } from '../store';

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
 *  `left` / `width` come from caller (computed against the horizontal
 *  visible window). */
export function ShotBlock({
  clip,
  side,
  thin,
  style,
}: {
  clip: Clip;
  side: 'video' | 'audio';
  thin: boolean;
  style?: CSSProperties;
}) {
  const cls = [
    'shot-block',
    side === 'video' ? 'is-video' : 'is-audio',
    clip.state === 'selected' && 'is-selected',
    clip.state === 'orphaned' && 'is-orphaned',
    clip.state === 'orphaned-selected' && 'is-orphaned is-selected',
    (clip.state === 'locked' || clip.locked) && 'is-locked',
    thin && 'is-thin',
  ].filter(Boolean).join(' ');

  // Icon class follows state + side:
  //   video unselected/selected     -> camera
  //   video orphan / orphan-sel     -> camera-off
  //   audio (always)                -> waveform
  let iconClass = 'icon icon--block-camera';
  if (side === 'audio') iconClass = 'icon icon--block-waveform';
  else if (clip.state === 'orphaned' || clip.state === 'orphaned-selected') {
    iconClass = 'icon icon--block-camera-off';
  }

  return (
    <div className={cls} style={style} title={clip.sourceName} data-clip={clip.id}>
      <div className="shot-block__label">{clip.sourceName}</div>
      <div className="shot-block__icon-wrap">
        <span className={iconClass} />
      </div>
    </div>
  );
}
