import type { CSSProperties, MouseEvent } from 'react';
import { useStore, type Track } from '../store';

/** Track header rendered inside the headers column. Visual is the same
 *  as the legacy timeline.html — twirl, lock, chip, eye/MS row, label.
 *
 *  Right-click opens the track-header context menu (Delete Track).
 *  V1 / A1 base tracks always exist; their Delete Track item is
 *  disabled. The menu component reads targetTrackId off store.contextMenu
 *  to decide which variant to render. */
export function TrackHeader({ track, side }: { track: Track; side: 'video' | 'audio' }) {
  const isVideo = side === 'video';
  const trackId = (isVideo ? 'V' : 'A') + track.id;
  function onContextMenu(ev: MouseEvent) {
    ev.preventDefault();
    ev.stopPropagation();
    useStore.getState().setContextMenu({
      x: ev.clientX,
      y: ev.clientY,
      targetClipId: null,
      targetTrackId: trackId,
    });
  }
  return (
    <div
      className={'track-header ' + (isVideo ? 'is-video' : 'is-audio')}
      data-track={trackId}
      onContextMenu={onContextMenu}
    >
      <div className="track-header__twirl">
        <span className="icon icon--triangle" style={{ '--icon-w': '8px', '--icon-h': '10px', '--icon-rot': '90deg' } as CSSProperties} />
      </div>
      <div className="track-header__lock-wrap">
        <span className={'icon ' + (isVideo ? 'icon--lock' : 'icon--lock-locked')} style={{ '--icon-w': '12px', '--icon-h': '12px' } as CSSProperties} />
      </div>
      <div className="track-header__chip-wrap">
        <div className="track-header__chip">{(isVideo ? 'V' : 'A') + track.id}</div>
      </div>
      <div className="track-header__right">
        <div className="track-header__right-col">
          {isVideo ? (
            <span className="icon icon--eye" style={{
              '--icon-w': '18px', '--icon-h': '18px',
              backgroundColor: 'var(--color-timeline-primary-highlight)',
            } as CSSProperties} />
          ) : (
            <div className="track-header__icons-row"><span>M</span><span className="s">S</span></div>
          )}
          <div className="track-header__label-wrap">
            <div className="track-header__label">{track.name}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
