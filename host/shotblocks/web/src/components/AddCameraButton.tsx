import { useAddCamera } from '../useAddCamera';
import { send } from '../lib/host';

/** Persistent "Add camera" button — Figma node 468:3084.
 *
 *  82×32 Maxon-blue pill, 8px radius, Inter Semi-Bold 10px white.
 *  Floats bottom-right of the canvas area, 17px left of the Inspector
 *  panel's left edge, 16px above the canvas bottom. Sibling of the
 *  Inspector (not inside it) — positioned via absolute coords inside
 *  the `.body` grid container.
 *
 *  Click fires plan-4 commit 2's flow: C++ creates the camera +
 *  selects it in OM, JS adds a clip on V1 at the playhead. */
export function AddCameraButton() {
  const addCamera = useAddCamera();
  return (
    <>
      <button
        type="button"
        className="add-camera-button"
        // Same focus-blur pattern as TrackHeader buttons + DebugOverlay
        // Copy/Clear. Without this, the button retains keyboard focus
        // after click — Tab then cycles through the page, and a
        // subsequent Delete (to remove the just-created clip) targets
        // the button instead of reaching the timeline.
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => { e.stopPropagation(); void addCamera(); }}
      >
        Add camera
      </button>
      {/* SPIKE (plan-4.1) — dumps Stage CTrack structure to Console. */}
      <button
        type="button"
        className="add-camera-button"
        style={{ right: 410 }}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => { e.stopPropagation(); void send({ kind: 'dump-stage' }); }}
      >
        Dump stage
      </button>
    </>
  );
}
