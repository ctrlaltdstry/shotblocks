import { useEffect } from 'react';
import { useStore } from './store';

/** C4D viewport-style Alt + right-click drag zoom for the timeline.
 *
 *  Mirrors Python's `_drag_zoom` in sb_canvas_drag.py:661 (which only
 *  did horizontal — we extend to vertical too). The gesture:
 *    - Alt + RMB press anywhere in the ruler or lanes-area starts
 *      the zoom drag. The frame under the cursor at press time becomes
 *      the horizontal anchor (stays at the same X through the zoom).
 *    - Drag right → zoom in horizontally (smaller h-span).
 *      Drag left  → zoom out horizontally.
 *    - Drag up   → zoom in vertically on whichever side (V/A) the
 *      cursor started in. The track-row under the cursor at press
 *      time is the anchor.
 *      Drag down → zoom out vertically.
 *    - Both axes respond simultaneously based on their own deltas.
 *
 *  Sensitivity: factor = exp(-delta / 200). Matches Python exactly.
 *  200px of drag ≈ 0.37x zoom in (or 2.72x out).
 *
 *  The handler suppresses the default contextmenu when Alt is held so
 *  the right-click never opens the menu under this gesture. Normal
 *  Alt-less right-click still works as before. */

const SENS = 200; // pixels per e-fold; matches Python's _drag_zoom.

export function useAltRightZoom() {
  useEffect(() => {
    // While Alt is held during a right-click gesture, suppress the
    // native (and our own) context menu. Capture phase so we beat
    // the ShotBlock / lanes-area onContextMenu handlers.
    function onContextMenu(ev: MouseEvent) {
      if (ev.altKey) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    }

    function onPointerDown(ev: PointerEvent) {
      if (ev.button !== 2 || !ev.altKey) return;
      // Only react when the press lands somewhere in the timeline
      // content (ruler or lanes-area). Headers, palette, top bar,
      // scrollbars stay untouched.
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

      // ----- Horizontal anchor: snapshot at press time. -----
      // Use the lanes-area (or ruler) rect to convert clientX → frame.
      // Lanes-area and ruler-row span the same horizontal extent.
      const xRef = (lanesArea ?? ruler) as HTMLElement;
      const xRect = xRef.getBoundingClientRect();
      const hStart = s0.h;
      const hSpanStart = Math.max(1, hStart.vMax - hStart.vMin);
      const xFracInRect = Math.max(0, Math.min(1, (startClientX - xRect.left) / xRect.width));
      const anchorFrame = hStart.vMin + xFracInRect * hSpanStart;

      // ----- Vertical anchor: which side (V or A) the cursor is in. -----
      // Determined once at press time; the gesture commits to one side
      // even if the cursor drifts across the V/A splitter mid-drag.
      let vSide: 'video' | 'audio' | null = null;
      let vAnchorTrackUnit = 0;
      let vWinStart: { min: number; max: number; vMin: number; vMax: number } | null = null;
      let vRect: DOMRect | null = null;
      const stackVideos = document.getElementById('lanes-videos');
      const stackAudios = document.getElementById('lanes-audios');
      if (stackVideos) {
        const r = stackVideos.getBoundingClientRect();
        if (startClientY >= r.top && startClientY <= r.bottom) {
          vSide = 'video';
          vWinStart = s0.vVideo;
          vRect = r;
        }
      }
      if (vSide === null && stackAudios) {
        const r = stackAudios.getBoundingClientRect();
        if (startClientY >= r.top && startClientY <= r.bottom) {
          vSide = 'audio';
          vWinStart = s0.vAudio;
          vRect = r;
        }
      }
      if (vSide && vRect && vWinStart) {
        const vSpan = Math.max(0.01, vWinStart.vMax - vWinStart.vMin);
        // Video stack is bottom-up (V1 at the bottom, V<max> at the
        // top), so the topmost edge of the rect maps to vMax. Audio
        // stack is top-down, topmost edge maps to vMin.
        const yFracInRect = Math.max(0, Math.min(1, (startClientY - vRect.top) / vRect.height));
        if (vSide === 'video') {
          vAnchorTrackUnit = vWinStart.vMax - yFracInRect * vSpan;
        } else {
          vAnchorTrackUnit = vWinStart.vMin + yFracInRect * vSpan;
        }
      }

      function onMove(mv: PointerEvent) {
        const dx = mv.clientX - startClientX;
        const dy = mv.clientY - startClientY;

        // ---- Horizontal zoom around anchorFrame ----
        const hFactor = Math.exp(-dx / SENS);
        const hSpanNew = Math.max(1, hSpanStart * hFactor);
        const xRatio = hSpanStart > 0 ? (anchorFrame - hStart.vMin) / hSpanStart : 0;
        let hMin = anchorFrame - xRatio * hSpanNew;
        let hMax = hMin + hSpanNew;
        if (hMin < hStart.min) { hMax += hStart.min - hMin; hMin = hStart.min; }
        if (hMax > hStart.max) { hMin -= hMax - hStart.max; hMax = hStart.max; }
        hMin = Math.max(hStart.min, hMin);
        hMax = Math.min(hStart.max, hMax);
        useStore.getState().setHVisible(hMin, hMax);

        // ---- Vertical zoom around vAnchorTrackUnit (if a side was hit) ----
        if (vSide && vWinStart) {
          // Drag UP (dy < 0) = zoom IN = smaller span. factor = exp(dy / SENS).
          const vFactor = Math.exp(dy / SENS);
          const vSpanStart = Math.max(0.01, vWinStart.vMax - vWinStart.vMin);
          const vSpanNew = Math.max(0.05, vSpanStart * vFactor);
          // Recompute anchor's fractional position so it stays under
          // the cursor's Y after the zoom.
          let anchorFrac: number;
          if (vSide === 'video') {
            // Video stack: vMax maps to rect top. Anchor's frac from top =
            // (vMax - anchor) / span.
            anchorFrac = (vWinStart.vMax - vAnchorTrackUnit) / vSpanStart;
          } else {
            anchorFrac = (vAnchorTrackUnit - vWinStart.vMin) / vSpanStart;
          }
          let nMin: number;
          let nMax: number;
          if (vSide === 'video') {
            nMax = vAnchorTrackUnit + anchorFrac * vSpanNew;
            nMin = nMax - vSpanNew;
          } else {
            nMin = vAnchorTrackUnit - anchorFrac * vSpanNew;
            nMax = nMin + vSpanNew;
          }
          // Clamp to the window's outer range.
          if (nMin < vWinStart.min) { nMax += vWinStart.min - nMin; nMin = vWinStart.min; }
          if (nMax > vWinStart.max) { nMin -= nMax - vWinStart.max; nMax = vWinStart.max; }
          nMin = Math.max(vWinStart.min, nMin);
          nMax = Math.min(vWinStart.max, nMax);
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

    window.addEventListener('contextmenu', onContextMenu, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('contextmenu', onContextMenu, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, []);
}
