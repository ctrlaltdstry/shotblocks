import { useEffect } from 'react';
import { useStore } from './store';

/** C4D viewport-style Alt + right-click drag zoom for the timeline.
 *
 *  Two scopes, by where the press lands:
 *
 *    - In the CANVAS (ruler or lanes-area): zooms EVERYTHING — the
 *      time axis (horizontal) AND both the video and audio track
 *      stacks (vertical), together. The frame + track-row under the
 *      cursor at press time are the anchors.
 *
 *    - In a TRACK-HEADER stack: zooms only THAT side's tracks,
 *      vertically. Press in the video headers → video tracks resize;
 *      press in the audio headers → audio tracks resize. No
 *      horizontal zoom. This is how the two sides are zoomed
 *      independently now that the V/A divider is no longer draggable.
 *
 *  Drag right/up = zoom in, left/down = zoom out. Sensitivity
 *  factor = exp(-delta / 200), matching Python's `_drag_zoom`.
 *
 *  The handler suppresses the context menu while Alt is held so the
 *  right-click never opens a menu under this gesture; plain (Alt-less)
 *  right-click still opens the track-header / clip menus. */

const SENS = 200; // pixels per e-fold; matches Python's _drag_zoom.

type VWin = { min: number; max: number; vMin: number; vMax: number };

export function useAltRightZoom() {
  useEffect(() => {
    function onContextMenu(ev: MouseEvent) {
      if (ev.altKey) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    }

    function onPointerDown(ev: PointerEvent) {
      if (ev.button !== 2 || !ev.altKey) return;
      const target = ev.target as HTMLElement | null;
      if (!target) return;

      const inRuler = !!target.closest('.ruler-row');
      const inLanes = !!target.closest('.lanes-area');
      const inHeaders = !!target.closest('#headers-videos')
        || !!target.closest('#headers-audios');
      if (!inRuler && !inLanes && !inHeaders) return;

      ev.preventDefault();
      ev.stopPropagation();

      const s0 = useStore.getState();
      const startClientX = ev.clientX;
      const startClientY = ev.clientY;

      // Scope: a press in the headers zooms ONE side vertically and
      // does NOT touch the time axis; a press in the canvas zooms
      // time + both sides.
      const headerScoped = inHeaders;

      // ---- Horizontal anchor (canvas scope only) ----
      let hStart = s0.h;
      let hSpanStart = 1;
      let anchorFrame = 0;
      if (!headerScoped) {
        const xRef = (target.closest('.lanes-area')
          ?? target.closest('.ruler-row')) as HTMLElement;
        const xRect = xRef.getBoundingClientRect();
        hStart = s0.h;
        hSpanStart = Math.max(1, hStart.vMax - hStart.vMin);
        const xFrac = Math.max(0, Math.min(1, (startClientX - xRect.left) / xRect.width));
        anchorFrame = hStart.vMin + xFrac * hSpanStart;
      }

      // ---- Vertical: which side(s) to zoom + their anchors ----
      // A "target" describes one side's zoom: its window, the rect it
      // occupies on screen, and the track-unit anchored under the
      // cursor (kept under the cursor through the zoom).
      interface VTarget {
        side: 'video' | 'audio';
        win: VWin;
        anchorUnit: number;
      }
      const vTargets: VTarget[] = [];

      const measure = (
        side: 'video' | 'audio',
        rect: DOMRect | null,
        win: VWin,
      ): VTarget | null => {
        if (!rect || rect.height <= 0) return null;
        const span = Math.max(0.01, win.vMax - win.vMin);
        // yFrac 0 = rect top. Video stack is bottom-up (vMax at top),
        // audio top-down (vMin at top).
        const yFrac = Math.max(0, Math.min(1,
          (startClientY - rect.top) / rect.height));
        const anchorUnit = side === 'video'
          ? win.vMax - yFrac * span
          : win.vMin + yFrac * span;
        return { side, win, anchorUnit };
      };

      const videosCanvas = document.getElementById('lanes-videos');
      const audiosCanvas = document.getElementById('lanes-audios');
      const videosHeader = document.getElementById('headers-videos');
      const audiosHeader = document.getElementById('headers-audios');

      if (headerScoped) {
        // Only the side whose header was pressed.
        const inVideoHeaders = !!target.closest('#headers-videos');
        if (inVideoHeaders && videosHeader) {
          const t = measure('video', videosHeader.getBoundingClientRect(), s0.vVideo);
          if (t) vTargets.push(t);
        } else if (audiosHeader) {
          const t = measure('audio', audiosHeader.getBoundingClientRect(), s0.vAudio);
          if (t) vTargets.push(t);
        }
      } else {
        // Canvas scope: zoom BOTH sides. Each anchors on its own rect
        // (the cursor only sits in one, but both zoom around their
        // visible centre — the pressed side stays glued to the
        // cursor, the other zooms about the equivalent fraction).
        const tv = measure('video', videosCanvas?.getBoundingClientRect() ?? null, s0.vVideo);
        const ta = measure('audio', audiosCanvas?.getBoundingClientRect() ?? null, s0.vAudio);
        if (tv) vTargets.push(tv);
        if (ta) vTargets.push(ta);
      }

      function applyVZoom(t: VTarget, factor: number) {
        const spanStart = Math.max(0.01, t.win.vMax - t.win.vMin);
        const spanNew = Math.max(0.05, spanStart * factor);
        const anchorFrac = t.side === 'video'
          ? (t.win.vMax - t.anchorUnit) / spanStart
          : (t.anchorUnit - t.win.vMin) / spanStart;
        let nMin: number;
        let nMax: number;
        if (t.side === 'video') {
          nMax = t.anchorUnit + anchorFrac * spanNew;
          nMin = nMax - spanNew;
        } else {
          nMin = t.anchorUnit - anchorFrac * spanNew;
          nMax = nMin + spanNew;
        }
        if (nMin < t.win.min) { nMax += t.win.min - nMin; nMin = t.win.min; }
        if (nMax > t.win.max) { nMin -= nMax - t.win.max; nMax = t.win.max; }
        nMin = Math.max(t.win.min, nMin);
        nMax = Math.min(t.win.max, nMax);
        if (t.side === 'video') useStore.getState().setVVideoVisible(nMin, nMax);
        else useStore.getState().setVAudioVisible(nMin, nMax);
      }

      function onMove(mv: PointerEvent) {
        const dx = mv.clientX - startClientX;
        const dy = mv.clientY - startClientY;

        // Horizontal zoom — canvas scope only.
        if (!headerScoped) {
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
        }

        // Vertical zoom — drag UP (dy < 0) = zoom IN.
        const vFactor = Math.exp(dy / SENS);
        for (const t of vTargets) applyVZoom(t, vFactor);
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
