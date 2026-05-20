import { useEffect } from 'react';
import { useStore } from './store';
import { send } from './lib/host';

/** Tells the C++ host when to force the slip cursor.
 *
 *  Why C++ owns this: the slip cursor wouldn't survive a drag — the
 *  page's CSS cursor stays correct, but C4D's dialog window (the
 *  HtmlViewerCustomGui's host) handles WM_SETCURSOR for its region and
 *  keeps resetting the cursor. JS / DOM tricks can't beat that. C++
 *  subclasses the C4D dialog window and, when the slip mode is on,
 *  answers WM_SETCURSOR with the slip cursor itself.
 *
 *  This hook decides the mode:
 *    - `slip`    when the Slip tool is active AND the pointer is over
 *                an audio clip (the only place slip applies).
 *    - `default` otherwise.
 *  Sends only on a real mode CHANGE — a few messages per session.
 */
export function useSlipCursor(): void {
  useEffect(() => {
    let mode: 'slip' | 'default' = 'default';

    function apply(next: 'slip' | 'default') {
      if (next === mode) return;
      mode = next;
      void send({ kind: 'set-cursor-mode', mode: next }).catch(() => {});
    }

    // `elementFromPoint` is flaky here — overlays (waveform canvas,
    // marquee/range/playhead layers) and mid-redraw transients can
    // make a single reading miss the audio clip even while the
    // pointer sits still on it. So: switch to `slip` instantly, but
    // only fall back to `default` after several CONSECUTIVE off-audio
    // readings. A lone bad reading can't flip the cursor.
    let offAudioStreak = 0;
    const OFF_AUDIO_NEEDED = 4;

    function pointerOverAudioClip(x: number, y: number): boolean {
      // Deterministic hit-test: is (x,y) inside any audio shot-block's
      // bounding rect? Avoids elementFromPoint's topmost-element
      // fragility entirely.
      const blocks = document.querySelectorAll('.shot-block.is-audio');
      for (const b of blocks) {
        const r = b.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          return true;
        }
      }
      return false;
    }

    function onMove(ev: PointerEvent) {
      const s = useStore.getState();
      if (s.activeTool !== 'slip') {
        offAudioStreak = OFF_AUDIO_NEEDED;
        apply('default');
        return;
      }
      if (s.slipDragging) {
        offAudioStreak = 0;
        apply('slip');
        return;
      }
      if (pointerOverAudioClip(ev.clientX, ev.clientY)) {
        offAudioStreak = 0;
        apply('slip');
      } else if (++offAudioStreak >= OFF_AUDIO_NEEDED) {
        apply('default');
      }
    }

    // React to store changes too — crucially, when a slip drag ENDS
    // (slipDragging false) with the pointer stationary, there's no
    // pointermove to re-evaluate. Re-evaluate here against the last
    // known pointer position.
    let lastX = 0, lastY = 0;
    function trackPos(ev: PointerEvent) { lastX = ev.clientX; lastY = ev.clientY; }
    function reevaluate() {
      const s = useStore.getState();
      if (s.activeTool !== 'slip') { apply('default'); return; }
      if (s.slipDragging) { apply('slip'); return; }
      if (pointerOverAudioClip(lastX, lastY)) apply('slip');
      else apply('default');
    }
    const unsub = useStore.subscribe((s, prev) => {
      if (s.activeTool !== prev.activeTool || s.slipDragging !== prev.slipDragging) {
        reevaluate();
      }
    });

    window.addEventListener('pointermove', trackPos, true);
    window.addEventListener('pointermove', onMove, true);
    return () => {
      window.removeEventListener('pointermove', trackPos, true);
      window.removeEventListener('pointermove', onMove, true);
      unsub();
      apply('default');
    };
  }, []);
}
