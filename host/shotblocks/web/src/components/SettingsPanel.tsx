import { useEffect, useRef } from 'react';
import { useStore } from '../store';

/** Centered modal hosting global preferences. Opened by the utility-
 *  strip gear icon. Dismissed by backdrop click, Escape, or the
 *  close button.
 *
 *  v1 content is just the "Audio follows C4D timeline" toggle (moved
 *  here from the Inspector so the Inspector can specialize on render
 *  settings). More preferences will fold in as they come up.
 */
export function SettingsPanel() {
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettingsOpen);
  const c4dAudioFollows = useStore((s) => s.c4dAudioFollows);
  const ref = useRef<HTMLDivElement | null>(null);

  // Escape to dismiss. Outside-click is handled by the backdrop's
  // own onClick (clicks on the panel itself stop propagation).
  useEffect(() => {
    if (!open) return;
    function onKey(ev: KeyboardEvent) {
      if (ev.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <div
      className="settings-backdrop"
      onClick={() => setOpen(false)}
    >
      <div
        ref={ref}
        className="settings-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-panel__header">
          <span className="settings-panel__title">Settings</span>
          <div
            className="settings-panel__close"
            title="Close"
            onClick={() => setOpen(false)}
          >
            &times;
          </div>
        </div>

        <div className="settings-panel__body">
          <div className="settings-panel__section">
            <div className="settings-panel__section-title">Audio</div>
            <label className="settings-panel__row">
              <span className="settings-panel__row-label">
                Audio follows C4D timeline
              </span>
              <input
                type="checkbox"
                className="settings-panel__checkbox"
                checked={c4dAudioFollows}
                onChange={(e) => useStore.getState().setC4dAudioFollows(e.target.checked)}
              />
            </label>
            <div className="settings-panel__hint">
              When off, audio plays only while working in the Shotblocks
              timeline — scrubbing or playing C4D's native timeline stays
              silent. The playhead stays in sync either way.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
