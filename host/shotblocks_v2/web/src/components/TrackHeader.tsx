import type { CSSProperties } from 'react';
import type { Track } from '../store';

/** Track header rendered inside the headers column. Visual is the same
 *  as the legacy timeline.html — twirl, lock, chip, eye/MS row, label. */
export function TrackHeader({ track, side }: { track: Track; side: 'video' | 'audio' }) {
  const isVideo = side === 'video';
  return (
    <div className={'track-header ' + (isVideo ? 'is-video' : 'is-audio')} data-track={(isVideo ? 'V' : 'A') + track.id}>
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
