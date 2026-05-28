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
      // Two triggers for the same gesture:
      //   - Alt + Right-click drag: the C4D-viewport modifier shortcut.
      //   - Left-click drag with the Zoom tool active: surfaces the
      //     same gesture for users who don't know the modifier.
      // Both paths run the identical zoom math below.
      const s0 = useStore.getState();
      const isAltRmb = ev.button === 2 && ev.altKey;
      const isZoomLmb = ev.button === 0 && s0.activeTool === 'zoom';
      if (!isAltRmb && !isZoomLmb) return;
      const target = ev.target as HTMLElement | null;
      if (!target) return;

      const inRuler = !!target.closest('.ruler-row');
      const inLanes = !!target.closest('.lanes-area');
      // The Zoom tool only scopes to the timeline canvas — track-
      // header drags don't exist for it (no tool affordance there).
      // Alt+RMB keeps its existing header scope (audio-only vertical
      // zoom).
      const inHeaders = isAltRmb && (
        !!target.closest('#headers-videos')
        || !!target.closest('#headers-audios')
      );
      if (!inRuler && !inLanes && !inHeaders) return;

      ev.preventDefault();
      ev.stopPropagation();

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

      // ---- Vertical: the audio zoom target (video never zooms) ----
      // Audio zoom is anchored at the top edge (see applyVZoom), so a
      // target only needs the side + the window snapshot.
      interface VTarget {
        side: 'video' | 'audio';
        win: VWin;
      }
      const vTargets: VTarget[] = [];

      const measure = (
        side: 'video' | 'audio',
        rect: DOMRect | null,
        win: VWin,
      ): VTarget | null => {
        if (!rect || rect.height <= 0) return null;
        return { side, win };
      };

      const audiosCanvas = document.getElementById('lanes-audios');
      const audiosHeader = document.getElementById('headers-audios');

      // Vertical zoom only makes sense when there's audio content to
      // resize. With no audio clips present the audio stack is just an
      // empty header row — zooming it does nothing useful and looks
      // broken. Gate all vertical zoom on at least one audio clip.
      const hasAudioContent = s0.audioTracks.some((t) => t.clips.length > 0);

      // Video side is FIXED-HEIGHT — it never zooms vertically. Only
      // the audio stack responds to vertical drag; the video headers
      // are ignored entirely.
      if (headerScoped) {
        // Only the audio side zooms. A press in the video headers is
        // a no-op (no vertical zoom, and headers carry no time axis).
        const inAudioHeaders = !!target.closest('#headers-audios');
        if (hasAudioContent && inAudioHeaders && audiosHeader) {
          const t = measure('audio', audiosHeader.getBoundingClientRect(), s0.vAudio);
          if (t) vTargets.push(t);
        }
      } else if (hasAudioContent) {
        // Canvas scope: horizontal zoom affects everything; vertical
        // zoom is audio-only (and only when audio content exists).
        const ta = measure('audio', audiosCanvas?.getBoundingClientRect() ?? null, s0.vAudio);
        if (ta) vTargets.push(ta);
      }

      // Audio-only vertical zoom, anchored at the TOP edge (the V/A
      // divider). The visible window's top is pinned to win.min — that
      // is the position at which --audio-scroll-y is 0 and A1 sits flush
      // against the divider. So A1 stays glued to the divider and the
      // stack grows downward as you zoom; the top track is never
      // clipped (a centre-anchored zoom did clip it), and the
      // scrollbar thumb stays top-anchored to match.
      function applyVZoom(t: VTarget, factor: number) {
        const spanStart = Math.max(0.01, t.win.vMax - t.win.vMin);
        const spanNew = Math.max(0.05, Math.min(
          t.win.max - t.win.min, spanStart * factor));
        const nMin = t.win.min;
        const nMax = nMin + spanNew;
        useStore.getState().setVAudioVisible(nMin, nMax);
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
        useStore.getState().setAltRmbZooming(false);
      }
      useStore.getState().setAltRmbZooming(true);
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
