import { useStore } from '../store';
import { send } from '../lib/host';
import { runBeatDetection } from '../lib/beatDetection';

/** Loop toggle in the utilities strip. Drives C4D's loop preview
 *  mode via JS→C++ 'set-loop'. Grey when off, primary-highlight
 *  blue when on. Matches the standard utilities-strip styling. */
function LoopToggle() {
  const on = useStore((s) => s.loopEnabled);
  return (
    <div
      className={'utilstrip__icon' + (on ? ' is-active' : '')}
      title={on ? 'Loop: on' : 'Loop: off'}
      onClick={() => {
        const next = !useStore.getState().loopEnabled;
        useStore.getState().setLoopEnabled(next);
        // Fire-and-forget; C++ will EVMSG_CHANGE → state-changed →
        // doc-info round-trip if anything else cares.
        void send({ kind: 'set-loop', enabled: next });
      }}
    >
      <span className="icon icon--loop" style={{ '--icon-w': '16px', '--icon-h': '16px' } as React.CSSProperties} />
    </div>
  );
}

/** Snap toggle in the utilities strip. Magnetic snap during clip
 *  body/trim/roll drags is gated on this flag. Default OFF, mirroring
 *  Python's `_snap_enabled = False` (sb_canvas.py:420). Holding Shift
 *  during a drag force-enables snap even when this toggle is off
 *  (Premiere model); Cmd/Ctrl during a drag is ripple mode. */
function SnapToggle() {
  const on = useStore((s) => s.snapEnabled);
  return (
    <div
      className={'utilstrip__icon' + (on ? ' is-active' : '')}
      title={on ? 'Snap: on' : 'Snap: off'}
      onClick={() => useStore.getState().setSnapEnabled(!useStore.getState().snapEnabled)}
    >
      <span className="icon icon--snap" style={{ '--icon-w': '14px', '--icon-h': '14px' } as React.CSSProperties} />
    </div>
  );
}

/** Beat Detection button in the utilities strip. Mirrors Final Cut
 *  Pro's "Enable/Disable Beat Detection" toggle:
 *    - First click → analyses every audio clip + shows the grid.
 *    - Later clicks → toggle the green grid on/off. The analysis
 *      result is kept, so re-enabling is instant (no re-analyse).
 *  `is-active` reflects whether the grid is currently shown. */
function BeatDetectionButton() {
  const busy = useStore((s) => s.detectingBeats);
  const gridVisible = useStore((s) => s.beatGridVisible);
  // Has detection ever produced peaks? (cheap scan)
  const hasPeaks = useStore((s) =>
    s.audioTracks.some((t) => t.clips.some((c) => c.audioPeaks && c.audioPeaks.length)));
  const active = gridVisible && hasPeaks;
  return (
    <div
      className={'utilstrip__icon' + ((active || busy) ? ' is-active' : '')}
      title={
        busy ? 'Detecting beats…'
          : active ? 'Beat Detection: on'
          : hasPeaks ? 'Beat Detection: off'
          : 'Beat Detection'
      }
      onClick={() => {
        if (busy) return;
        if (!hasPeaks) {
          // Never analysed — run detection (it shows the grid on done).
          void runBeatDetection();
        } else {
          // Already have results — just toggle the grid visibility.
          useStore.getState().setBeatGridVisible(!gridVisible);
        }
      }}
    >
      <span className="icon icon--beat-detection" style={{ '--icon-w': '13px', '--icon-h': '13px' } as React.CSSProperties} />
    </div>
  );
}

/** Inspector toggle — the utilities-strip gear icon. Opens / closes
 *  the right-side Inspector panel. (Gear icon kept for now; a custom
 *  icon comes later.) */
function InspectorToggle() {
  const open = useStore((s) => s.inspectorOpen);
  return (
    <div
      className={'utilstrip__icon' + (open ? ' is-active' : '')}
      title="Inspector"
      onClick={() => useStore.getState().setInspectorOpen(!useStore.getState().inspectorOpen)}
    >
      <span className="icon icon--settings" style={{ '--icon-w': '15px', '--icon-h': '15px' } as React.CSSProperties} />
    </div>
  );
}

/** Top utility strip — the row of small toggle icons living above the
 *  ruler. Loop / Snap / Beat Detection / Markers (placeholder) /
 *  Inspector. Each toggle is its own subcomponent so it only re-renders
 *  on changes to its own slice of state. */
export function UtilityStrip() {
  return (
    <div className="utilstrip">
      <LoopToggle />
      <SnapToggle />
      <BeatDetectionButton />
      <div className="utilstrip__icon" title="Markers">
        <span className="icon icon--markers" style={{ '--icon-w': '10px', '--icon-h': '13px' } as React.CSSProperties} />
      </div>
      <InspectorToggle />
    </div>
  );
}
