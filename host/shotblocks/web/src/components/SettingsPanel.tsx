import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { ensureCameraTypes } from '../lib/cameraTypes';
import { InspectorDropdown } from './Inspector';

/** Centered modal hosting global preferences. Opened by the utility-
 *  strip gear icon. Dismissed by backdrop click, Escape, or the
 *  close button.
 */
export function SettingsPanel() {
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettingsOpen);
  const c4dAudioFollows = useStore((s) => s.c4dAudioFollows);
  const availableCameraTypes = useStore((s) => s.availableCameraTypes);
  const defaultCameraType = useStore((s) => s.defaultCameraType);
  const ref = useRef<HTMLDivElement | null>(null);

  // Ensure the installed camera types are fetched (idempotent). Usually
  // already done eagerly after hydration; this is a retry path if that
  // fetch failed (e.g. C++ wasn't ready yet).
  useEffect(() => {
    if (!open) return;
    void ensureCameraTypes();
  }, [open]);

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
            data-tooltip="Close"
            data-tooltip-pos="below"
            onClick={() => setOpen(false)}
          >
            &times;
          </div>
        </div>

        <div className="settings-panel__body">
          <div className="settings-panel__section">
            <div className="settings-panel__section-title">Defaults</div>
            <div className="settings-panel__row">
              <span className="settings-panel__row-label">
                Default camera type
              </span>
              <InspectorDropdown
                value={
                  availableCameraTypes.find((t) => t.id === defaultCameraType)?.label
                    ?? 'Standard Camera'
                }
                options={availableCameraTypes.map((t) => ({
                  value: String(t.id),
                  label: t.label,
                }))}
                onSelect={(v) => useStore.getState().setDefaultCameraType(parseInt(v, 10))}
              />
            </div>
            <div className="settings-panel__hint">
              Used by the in-timeline Add Camera button. Renderer-aware:
              only camera types whose plugin is loaded in this C4D
              session appear here (e.g. RS Camera is hidden when
              Redshift isn't installed).
            </div>
          </div>
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
