import { useEffect } from 'react';
import { useStore } from './store';

/** Middle-mouse-button drag = pan, C4D viewport style. The Python
 *  version couldn't ship this — C4D's framework intercepts MMB
 *  events before they reach the GeUserArea (see sb_canvas.py:2190
 *  comment). In the WebView2 we get MMB events natively as
 *  pointer events with button === 1.
 *
 *  Behavior:
 *    - MMB press anywhere in ruler or lanes-area starts pan.
 *    - Horizontal cursor movement slides the h-window so the frame
 *      that was under the cursor at press time stays glued to the
 *      cursor (1:1 pan).
 *    - Vertical cursor movement slides the v-window on whichever
 *      side (V/A) the cursor started in. Same 1:1 glue.
 *    - Modifier keys are ignored — Alt+MMB pans the same as plain MMB.
 *
 *  We also call preventDefault on the auxclick / MMB-pointerdown to
 *  suppress WebView2's default "auto-scroll cursor" behavior. */
export function useMmbPan() {
  useEffect(() => {
    // Block the OS-level auto-scroll bubble that some Windows builds
    // show on MMB. preventDefault on `mousedown` for button 1 inhibits
    // it. We do this globally; nothing in v2 uses MMB for anything else.
    function onMouseDown(ev: MouseEvent) {
      if (ev.button === 1) ev.preventDefault();
    }
    function onAuxClick(ev: MouseEvent) {
      if (ev.button === 1) ev.preventDefault();
    }

    function onPointerDown(ev: PointerEvent) {
      if (ev.button !== 1) return;
      const target = ev.target as HTMLElement | null;
      if (!target) return;
      const ruler = target.closest('.ruler-row');
      const lanesArea = target.closest('.lanes-area');
      if (!ruler && !lanesArea) return;

      ev.preventDefault();
      ev.stopPropagation();

      const s0 = useStore.getState();
      const startClientX = ev.clientX;
      const startClientY = ev.clientY;

      // ---- Horizontal: frame-per-pixel snapshot at press time. ----
      const xRef = (lanesArea ?? ruler) as HTMLElement;
      const xRect = xRef.getBoundingClientRect();
      const hStart = s0.h;
      const hSpanStart = Math.max(1, hStart.vMax - hStart.vMin);
      const framesPerPx = hSpanStart / xRect.width;

      // ---- Vertical: which side, and track-units-per-pixel. ----
      let vSide: 'video' | 'audio' | null = null;
      let vStart: { min: number; max: number; vMin: number; vMax: number } | null = null;
      let vUnitsPerPx = 0;
      const stackVideos = document.getElementById('lanes-videos');
      const stackAudios = document.getElementById('lanes-audios');
      if (stackVideos) {
        const r = stackVideos.getBoundingClientRect();
        if (startClientY >= r.top && startClientY <= r.bottom && r.height > 0) {
          vSide = 'video';
          vStart = s0.vVideo;
          vUnitsPerPx = (vStart.vMax - vStart.vMin) / r.height;
        }
      }
      if (vSide === null && stackAudios) {
        const r = stackAudios.getBoundingClientRect();
        if (startClientY >= r.top && startClientY <= r.bottom && r.height > 0) {
          vSide = 'audio';
          vStart = s0.vAudio;
          vUnitsPerPx = (vStart.vMax - vStart.vMin) / r.height;
        }
      }

      function onMove(mv: PointerEvent) {
        const dx = mv.clientX - startClientX;
        const dy = mv.clientY - startClientY;

        // ---- Horizontal pan ----
        // Drag right (dx > 0) should bring EARLIER frames into view
        // (= h-window slides LEFT in frame-space). That's the
        // "grab the content" feel: the content follows your hand.
        const hShift = -dx * framesPerPx;
        let hMin = hStart.vMin + hShift;
        let hMax = hStart.vMax + hShift;
        if (hMin < hStart.min) { hMax += hStart.min - hMin; hMin = hStart.min; }
        if (hMax > hStart.max) { hMin -= hMax - hStart.max; hMax = hStart.max; }
        useStore.getState().setHVisible(hMin, hMax);

        // ---- Vertical pan ----
        // Hand-tool feel: content follows the cursor. Drag UP =
        // content slides UP = window shifts to expose what was below.
        //
        //   Video stack (bottom-up: V1 at the bottom, V<max> at the
        //   top): drag UP slides the pile UP, so lower-V-index tracks
        //   (V1, V2…) come into view → vMin/vMax DECREASE.
        //   Audio stack (top-down: A1 at the top, A<max> at the
        //   bottom): drag UP slides the pile UP, so higher-A-index
        //   tracks (A<max>) come into view → vMin/vMax INCREASE.
        //
        //   Drag UP = dy < 0 in screen coords. Video shift = +dy,
        //   audio shift = -dy.
        if (vSide && vStart) {
          const vShift = (vSide === 'video' ? dy : -dy) * vUnitsPerPx;
          let nMin = vStart.vMin + vShift;
          let nMax = vStart.vMax + vShift;
          if (nMin < vStart.min) { nMax += vStart.min - nMin; nMin = vStart.min; }
          if (nMax > vStart.max) { nMin -= nMax - vStart.max; nMax = vStart.max; }
          if (vSide === 'video') {
            useStore.getState().setVVideoVisible(nMin, nMax);
          } else {
            useStore.getState().setVAudioVisible(nMin, nMax);
          }
        }
      }

      function onUp() {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    }

    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('auxclick', onAuxClick, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('auxclick', onAuxClick, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, []);
}
