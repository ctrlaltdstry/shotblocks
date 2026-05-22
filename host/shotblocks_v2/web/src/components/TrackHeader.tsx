import type { CSSProperties, MouseEvent } from 'react';
import { useStore, type Track } from '../store';

/** Track header rendered inside the headers column. Layout matches the
 *  Figma track-header components (nodes 120:431 video / 120:697 audio):
 *  a 65px row with a lock toggle, a per-side control (eye for video,
 *  M/S for audio), and the track-name label.
 *
 *  Lock is wired; the eye / M/S controls are visual-only for now.
 *  (The motion-layer twirl lives on the clip, not here.)
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
  function toggleLock(ev: MouseEvent) {
    ev.stopPropagation();
    useStore.getState().setTrackFlag(trackId, 'locked', !track.locked);
  }
  function toggleVisible(ev: MouseEvent) {
    ev.stopPropagation();
    useStore.getState().setTrackFlag(trackId, 'visible', !track.visible);
  }
  function toggleMute(ev: MouseEvent) {
    ev.stopPropagation();
    useStore.getState().setTrackFlag(trackId, 'muted', !track.muted);
  }
  function toggleSolo(ev: MouseEvent) {
    ev.stopPropagation();
    useStore.getState().setTrackFlag(trackId, 'solo', !track.solo);
  }
  return (
    <div
      className={'track-header ' + (isVideo ? 'is-video' : 'is-audio')
        + (track.locked ? ' is-locked' : '')}
      data-track={trackId}
      onContextMenu={onContextMenu}
    >
      <div className="track-header__row">
        <button
          type="button"
          className={'track-header__lock track-header__btn'
            + (track.locked ? ' is-on' : '')}
          title={track.locked ? 'Unlock track' : 'Lock track'}
          aria-pressed={track.locked}
          onClick={toggleLock}
          onMouseDown={(e) => e.preventDefault()}
        >
          <span
            className={'icon ' + (track.locked ? 'icon--locked' : 'icon--lock')}
            style={{ '--icon-w': '12px', '--icon-h': '13.2px' } as CSSProperties}
          />
        </button>
        {isVideo ? (
          <button
            type="button"
            className={'track-header__eye track-header__btn'
              + (track.visible ? '' : ' is-off')}
            title={track.visible ? 'Hide track' : 'Show track'}
            aria-pressed={!track.visible}
            onClick={toggleVisible}
            onMouseDown={(e) => e.preventDefault()}
          >
            {track.visible ? (
              <span
                className="icon icon--eye"
                style={{ '--icon-w': '18px', '--icon-h': '12.94px' } as CSSProperties}
              />
            ) : (
              <span
                className="icon icon--hidden"
                style={{ '--icon-w': '18px', '--icon-h': '9.56px' } as CSSProperties}
              />
            )}
          </button>
        ) : (
          <div className="track-header__ms">
            <button
              type="button"
              className={'track-header__ms-m track-header__btn'
                + (track.muted ? ' is-on' : '')}
              title={track.muted ? 'Unmute track' : 'Mute track'}
              aria-pressed={track.muted}
              onClick={toggleMute}
              onMouseDown={(e) => e.preventDefault()}
            >
              M
            </button>
            <button
              type="button"
              className={'track-header__ms-s track-header__btn'
                + (track.solo ? ' is-on' : '')}
              title={track.solo ? 'Unsolo track' : 'Solo track'}
              aria-pressed={track.solo}
              onClick={toggleSolo}
              onMouseDown={(e) => e.preventDefault()}
            >
              S
            </button>
          </div>
        )}
        <div className="track-header__label-wrap">
          <div className="track-header__label">{track.name}</div>
        </div>
      </div>
    </div>
  );
}
