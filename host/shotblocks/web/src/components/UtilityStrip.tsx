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
      data-tooltip="Loop (⇧L)"
      data-tooltip-pos="below"
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
      data-tooltip="Snap (N)"
      data-tooltip-pos="below"
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
      data-tooltip={busy ? 'Detecting beats…' : 'Beat Detection'}
      data-tooltip-pos="below"
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

/** Markers visibility toggle — the utilities-strip Markers icon.
 *  Show/hide the purple ruler pins. Markers stay in state when
 *  hidden — this is purely a UI gate. Default ON. */
function MarkersToggle() {
  const on = useStore((s) => s.markersVisible);
  return (
    <div
      className={'utilstrip__icon' + (on ? ' is-active' : '')}
      data-tooltip="Markers (⇧M)"
      data-tooltip-pos="below"
      onClick={() => useStore.getState().setMarkersVisible(!useStore.getState().markersVisible)}
    >
      <span className="icon icon--markers" style={{ '--icon-w': '10px', '--icon-h': '13px' } as React.CSSProperties} />
    </div>
  );
}

/** Settings gear — opens a centered modal hosting global preferences
 *  (audio behavior, etc.). The inspector is decoupled from this icon
 *  and is always-open in its own column. */
function SettingsButton() {
  const open = useStore((s) => s.settingsOpen);
  return (
    <div
      className={'utilstrip__icon' + (open ? ' is-active' : '')}
      data-tooltip="Settings"
      data-tooltip-pos="below"
      onClick={() => useStore.getState().setSettingsOpen(!useStore.getState().settingsOpen)}
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
      <MarkersToggle />
      <SettingsButton />
    </div>
  );
}
