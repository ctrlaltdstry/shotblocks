import { useEffect } from 'react';
import { useStore } from './store';
import { send } from './lib/host';

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
 *      cursor (1:1 pan). Same regardless of modifiers — time is a
 *      single global axis.
 *    - Vertical cursor movement has TWO modes:
 *        · default (plain MMB, or Alt+MMB) — REAPPORTIONS the
 *          video/audio split (the `vaShare` value the divider sits
 *          at): drag up reveals more video, down more audio.
 *        · Alt+Shift+MMB — pans ONE section's own scroll window
 *          (video or audio, whichever the cursor started in),
 *          leaving the other side and the V/A split untouched.
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
      // Two entry points:
      //   - Middle mouse button (button === 1): standard C4D-viewport
      //     pan gesture, works regardless of active tool.
      //   - Left mouse button (button === 0) WHEN the Hand tool is
      //     active: surfaces the same gesture for users who don't
      //     know the MMB shortcut. The Hand tool's whole purpose is
      //     to expose pan without modifier keys.
      const s0 = useStore.getState();
      const isMmb = ev.button === 1;
      const isHandLmb = ev.button === 0 && s0.activeTool === 'hand';
      if (!isMmb && !isHandLmb) return;
      const target = ev.target as HTMLElement | null;
      if (!target) return;
      const ruler = target.closest('.ruler-row');
      const lanesArea = target.closest('.lanes-area');
      if (!ruler && !lanesArea) return;

      ev.preventDefault();
      ev.stopPropagation();

      // Body class for the closed-hand cursor. Applied for both
      //   - Hand tool LMB pan (open-hand → closed-hand during drag)
      //   - MMB pan from any tool (closed-hand is the only state;
      //     MMB has no "hovering" idle moment to show open-hand).
      // CSS rule (body.is-hand-panning * { cursor: grabbing }) wins
      // over the per-element tool cursors via !important so the
      // gesture's cursor is correct regardless of where the pointer
      // wanders during the drag.
      document.body.classList.add('is-hand-panning');
      if (isHandLmb) {
        useStore.getState().setHandPanning(true);
      }
      // Also push the C++ cursor mode to hand-grab so the C++
      // WM_SETCURSOR layer matches CSS (same two-layer pattern as
      // slip / razor / etc.). Without this the C++ layer keeps
      // forcing the OS default while CSS shows closed-hand → flicker.
      void send({ kind: 'set-cursor-mode', mode: 'hand-grab' }).catch(() => {});

      const startClientX = ev.clientX;
      const startClientY = ev.clientY;

      // ---- Horizontal: frame-per-pixel snapshot at press time. ----
      const xRef = (lanesArea ?? ruler) as HTMLElement;
      const xRect = xRef.getBoundingClientRect();
      const hStart = s0.h;
      const hSpanStart = Math.max(1, hStart.vMax - hStart.vMin);
      const framesPerPx = hSpanStart / xRect.width;

      // ---- Vertical mode: Alt+Shift = pan one section; else the
      // V/A reapportion. Captured at press time. ----
      const sectionMode = ev.altKey && ev.shiftKey;

      // -- Default mode: V/A reapportion via `vaShare`. --
      const vaShareStart = s0.vaShare;
      const lanesAreaEl = document.getElementById('lanes-area');
      const regionPx = lanesAreaEl
        ? Math.max(1, lanesAreaEl.getBoundingClientRect().height)
        : 1;

      // -- Section mode: which side the cursor started in, that
      //    side's v-window, and its track-units-per-pixel. --
      let vSide: 'video' | 'audio' | null = null;
      let vStart: { min: number; max: number; vMin: number; vMax: number } | null = null;
      let vUnitsPerPx = 0;
      if (sectionMode) {
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
        if (sectionMode) {
          // Pan ONE section's own scroll window. Hand-tool feel:
          // content follows the cursor. Video stack is bottom-up,
          // audio top-down — so drag UP shifts video's window down
          // (+dy) and audio's up (-dy) to keep "content follows hand".
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
        } else {
          // Reapportion the V/A split. Drag DOWN (dy > 0) moves the
          // divider down = more video on screen = higher vaShare.
          // setVaShare clamps [0,1] so the pan stops at the edges.
          useStore.getState().setVaShare(vaShareStart + dy / regionPx);
        }
      }

      function onUp() {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        document.body.classList.remove('is-hand-panning');
        if (isHandLmb) {
          useStore.getState().setHandPanning(false);
        }
        // Reassert the right C++ cursor for the CURRENT tool. Going
        // to 'default' here would pop the override entirely and leave
        // the cursor blank until the next pointermove (which is what
        // a static post-release pointer never produces). useToolCursor
        // already drives the right cursor on subsequent moves; we just
        // need to bridge the gap from MMB-release to the next move.
        const tool = useStore.getState().activeTool;
        const next = tool === 'hand' ? 'hand' : tool === 'zoom' ? 'zoom' : 'default';
        void send({ kind: 'set-cursor-mode', mode: next }).catch(() => {});
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
