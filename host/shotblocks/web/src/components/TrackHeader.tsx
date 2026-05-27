import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { useStore, type Track } from '../store';

/** Per-track "chip" — the active chip on a side marks that track as
 *  the write target for cursorless inserts (Add Camera button, paste).
 *  One active per side; default V1/A1. See plan-4 commit 3 + R4.
 *
 *  Visual (Figma 478:3133 inactive / 478:3144 active):
 *   - 36x63 flat rect, 4px radius, no border/shadow
 *   - Inactive: grey-16 bg + grey-24 text (faint plate)
 *   - Active:   primary-highlight bg + white text
 *   - Text:     track id ("V1", "A2", ...) Inter Semi-Bold 10px
 *  Click an inactive chip to activate it. Click an active chip = no-op
 *  (setActiveChip in the store short-circuits).  */
function ChipButton({ trackId }: { trackId: string }) {
  const active = useStore((s) =>
    trackId.startsWith('V') ? s.activeVChip === trackId
    : trackId.startsWith('A') ? s.activeAChip === trackId
    : false);
  return (
    <button
      type="button"
      className={'track-header__chip' + (active ? ' is-active' : '')}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        useStore.getState().setActiveChip(trackId);
      }}
    >
      {trackId}
    </button>
  );
}

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

  // Inline rename. `editing` holds the in-progress text while the
  // label is an <input>; the store only ever sees the committed name.
  const [editing, setEditing] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Focus + select-all only when editing STARTS (null -> non-null).
  // Keying off `editing` itself would re-select on every keystroke,
  // so each typed char would replace the whole field.
  const isEditing = editing !== null;
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);
  function beginRename() {
    setEditing(track.name);
  }
  function commitRename() {
    if (editing === null) return;
    useStore.getState().setTrackName(trackId, editing);
    setEditing(null);
  }
  function onRenameKey(ev: React.KeyboardEvent<HTMLInputElement>) {
    if (ev.key === 'Enter') { ev.preventDefault(); commitRename(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); setEditing(null); }
  }

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
       <div className="track-header__controls">
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
        <ChipButton trackId={trackId} />
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
       </div>
        <div className="track-header__label-wrap">
          {editing !== null ? (
            <input
              ref={inputRef}
              className="track-header__label-input"
              value={editing}
              onChange={(e) => setEditing(e.target.value)}
              onKeyDown={onRenameKey}
              onBlur={commitRename}
              onPointerDown={(e) => e.stopPropagation()}
            />
          ) : (
            <div
              className="track-header__label"
              title="Rename track"
              onDoubleClick={beginRename}
              onClick={beginRename}
            >
              {track.name}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
