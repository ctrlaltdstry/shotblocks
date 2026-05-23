import { useStore } from '../store';

/** Right-side slide-in Inspector panel.
 *
 *  Opened from the utilities-strip gear icon. For now it hosts global
 *  settings; it's built to grow into selected-shot properties + the
 *  layered-preset sub-timeline (see .agent/Camera Presets and Motion
 *  Layers.md). The panel is an absolute-positioned overlay on the
 *  right edge so opening it doesn't reflow the timeline grid; it
 *  slides via translateX.
 */
export function Inspector() {
  const c4dAudioFollows = useStore((s) => s.c4dAudioFollows);

  return (
    <div className="inspector">
      <div className="inspector__header">
        <span className="inspector__title">Inspector</span>
        <div
          className="inspector__close"
          title="Close"
          onClick={() => useStore.getState().setInspectorOpen(false)}
        >
          &times;
        </div>
      </div>

      <div className="inspector__body">
        <div className="inspector__section">
          <div className="inspector__section-title">Audio</div>
          <label className="inspector__row">
            <span className="inspector__row-label">
              Audio follows C4D timeline
            </span>
            <input
              type="checkbox"
              className="inspector__checkbox"
              checked={c4dAudioFollows}
              onChange={(e) => useStore.getState().setC4dAudioFollows(e.target.checked)}
            />
          </label>
          <div className="inspector__hint">
            When off, audio plays only while working in the Shotblocks
            timeline — scrubbing or playing C4D's native timeline stays
            silent. The playhead stays in sync either way.
          </div>
        </div>
      </div>
    </div>
  );
}
