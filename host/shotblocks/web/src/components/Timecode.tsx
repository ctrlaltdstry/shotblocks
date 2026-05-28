import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { send } from '../lib/host';

function pad2(n: number): string { return (n < 10 ? '0' : '') + n; }

function formatTimecode(frame: number, fps: number): string {
  if (!fps || fps <= 0) return '00:00:00:00';
  const f = Math.max(0, frame | 0);
  const ff = f % fps;
  const ts = Math.floor(f / fps);
  const ss = ts % 60;
  const mm = Math.floor(ts / 60) % 60;
  const hh = Math.floor(ts / 3600);
  return pad2(hh) + ':' + pad2(mm) + ':' + pad2(ss) + ':' + pad2(ff);
}

// Drag sensitivity: pixels of horizontal travel per one frame of scrub.
// ~4px/frame feels controllable (After Effects-style scrubbable number).
const PX_PER_FRAME = 4;

/** Live readout in the topbar. Reads currentFrame + fps directly from
 *  the store; re-renders only when one of those two values changes.
 *
 *  Interactions:
 *   - Ctrl/Cmd-click: toggle HH:MM:SS:FF timecode ↔ raw frame number.
 *   - Click-drag horizontally: scrub the playhead. We accumulate raw
 *     movementX deltas (not absolute X) and hide the cursor for the
 *     drag's duration, so the scrub keeps responding even after the OS
 *     cursor clamps at the screen edge — Figma/Blender-style pseudo-
 *     infinite drag. (Pointer Lock would be truly infinite but WebView2
 *     shows an unsuppressable "press Esc" banner, so we avoid it.)
 *     Routes through the same seek + scrub-begin/end path the ruler
 *     uses, so the whole timeline moves together. */
export function Timecode() {
  const currentFrame = useStore((s) => s.currentFrame);
  const scrubFrame = useStore((s) => s.scrubFrame);
  const frame = scrubFrame ?? currentFrame;
  const fps = useStore((s) => s.fps);
  const [showFrames, setShowFrames] = useState(false);

  // Drag state in a ref — re-renders (every tick) would reset let-vars.
  // accumPx is the running sum of movementX deltas across the drag.
  // skipNextDelta suppresses the synthetic movementX produced right
  // after a cursor warp (else the wrap would jump the scrub).
  const drag = useRef({ active: false, accumPx: 0, startFrame: 0, moved: false, lastSent: -1, skipNextDelta: false });

  // movementX works on plain pointermove without pointer lock; it's the
  // delta since the previous event. Subscribe on document so the drag
  // keeps tracking even when the pointer leaves the small timecode box.
  // When the OS cursor nears a screen edge we ask C++ to warp it to the
  // opposite edge (SetCursorPos) so the drag is infinite — Figma-style,
  // but without Pointer Lock's unsuppressable WebView2 banner.
  const EDGE_MARGIN = 40; // px from the screen edge that triggers a wrap.
  useEffect(() => {
    function onPointerMove(e: PointerEvent) {
      if (!drag.current.active) return;
      // The warp's synthetic delta lands on the next event — skip it.
      if (drag.current.skipNextDelta) {
        drag.current.skipNextDelta = false;
      } else {
        drag.current.accumPx += e.movementX;
      }
      const docFrames = useStore.getState().docFrames;
      if (Math.abs(drag.current.accumPx) > 2) drag.current.moved = true;
      const delta = Math.round(drag.current.accumPx / PX_PER_FRAME);
      const f = Math.max(0, Math.min(docFrames, drag.current.startFrame + delta));
      useStore.getState().setScrubFrame(f);
      if (f !== drag.current.lastSent) {
        drag.current.lastSent = f;
        send({ kind: 'seek', frame: f }).catch(() => {});
      }

      // Edge wrap: if the cursor reached either screen edge, teleport it
      // to the opposite side (keeping a margin) and keep dragging. screenX
      // is in OS-screen pixels, which is what SetCursorPos expects.
      const sw = window.screen.availWidth;
      if (e.screenX <= EDGE_MARGIN) {
        drag.current.skipNextDelta = true;
        send({ kind: 'warp-cursor', x: sw - EDGE_MARGIN - 2, y: e.screenY }).catch(() => {});
      } else if (e.screenX >= sw - EDGE_MARGIN) {
        drag.current.skipNextDelta = true;
        send({ kind: 'warp-cursor', x: EDGE_MARGIN + 2, y: e.screenY }).catch(() => {});
      }
    }
    function endDrag() {
      if (!drag.current.active) return;
      drag.current.active = false;
      document.body.classList.remove('is-timecode-scrubbing');
      send({ kind: 'scrub-end' }).catch(() => {});
      // Don't clear scrubFrame — setTick clears it once C++'s tick echo
      // catches up (same handoff as the ruler scrub).
    }
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', endDrag);
    document.addEventListener('pointercancel', endDrag);
    // Recover if the page loses focus mid-drag (e.g. Win+Shift+S).
    window.addEventListener('blur', endDrag);
    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', endDrag);
      document.removeEventListener('pointercancel', endDrag);
      window.removeEventListener('blur', endDrag);
    };
  }, []);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    // Ctrl/Cmd-click is the display toggle, not a scrub.
    if (e.ctrlKey || e.metaKey) return;
    const s = useStore.getState();
    drag.current = {
      active: true,
      accumPx: 0,
      startFrame: s.scrubFrame ?? s.currentFrame,
      moved: false,
      lastSent: -1,
      skipNextDelta: false,
    };
    // Hide the cursor for the drag so its clamping at the screen edge
    // isn't visible — the scrub value keeps responding regardless.
    document.body.classList.add('is-timecode-scrubbing');
    send({ kind: 'scrub-begin' }).catch(() => {});
    e.preventDefault();
  }

  function onClick(e: React.MouseEvent<HTMLDivElement>) {
    // Toggle only on a Ctrl/Cmd-click that wasn't a drag.
    if ((e.ctrlKey || e.metaKey) && !drag.current.moved) {
      setShowFrames((v) => !v);
    }
  }

  const text = showFrames
    ? String(Math.max(0, frame | 0))
    : formatTimecode(frame, fps);
  return (
    <div
      className="topbar__timecode"
      title="Drag to scrub · Ctrl-click to toggle timecode / frames"
      onPointerDown={onPointerDown}
      onClick={onClick}
    >
      {text}
    </div>
  );
}
