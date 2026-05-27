import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { send } from '../lib/host';
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

  // Fetch the list of installed camera types on first open. C++ walks
  // the known camera plugin IDs (Ocamera 5103, Orscamera 1057516, ...)
  // and returns the ones that resolve in this C4D session — so RS
  // Camera only appears when Redshift is loaded. See plan-4 R1.
  useEffect(() => {
    if (!open) return;
    if (availableCameraTypes.length > 0) return;
    void (async () => {
      try {
        const ack = await send({ kind: 'get-camera-types' }) as {
          ok?: boolean;
          types?: { id: number; label: string }[];
        };
        if (ack && ack.ok && Array.isArray(ack.types)) {
          useStore.getState().setAvailableCameraTypes(ack.types);
          // If the persisted defaultCameraType isn't in the available
          // list (e.g. user uninstalled Redshift since save), fall back
          // to the first type — Standard is always first.
          const current = useStore.getState().defaultCameraType;
          if (!ack.types.some((t) => t.id === current) && ack.types.length > 0) {
            useStore.getState().setDefaultCameraType(ack.types[0].id);
          }
        }
      } catch {
        // Non-fatal — dropdown shows empty until a future open retries.
      }
    })();
  }, [open, availableCameraTypes.length]);

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
