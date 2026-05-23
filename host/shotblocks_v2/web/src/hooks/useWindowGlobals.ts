import { useEffect } from 'react';
import { useStore } from '../store';

/** Suppress WebView2's native right-click menu globally. We have our
 *  own context menu wired on clips + the lanes-area; anywhere else
 *  (track headers, ruler, palette, scrollbars) a native menu would
 *  expose "Reload / Inspect / Save image as…" — useless and breaks
 *  immersion in a docked DAW panel. Our own menu handlers already
 *  preventDefault, so this is purely a fallback for unhandled spots. */
export function useSuppressNativeContextMenu() {
  useEffect(() => {
    function onCtx(ev: MouseEvent) {
      ev.preventDefault();
    }
    document.addEventListener('contextmenu', onCtx);
    return () => document.removeEventListener('contextmenu', onCtx);
  }, []);
}

/** Suppress browser-level page zoom. Inside a docked DAW panel, Ctrl+
 *  wheel and Ctrl++/Ctrl+-/Ctrl+0 should never scale the whole UI.
 *  WebView2 also persists per-origin zoom between sessions, so we snap
 *  any non-1 body zoom back to 1 on mount as a self-heal. */
export function usePageZoomSuppress() {
  useEffect(() => {
    function onWheel(ev: WheelEvent) {
      if (ev.ctrlKey) ev.preventDefault();
    }
    function onKey(ev: KeyboardEvent) {
      if (!ev.ctrlKey) return;
      if (ev.key === '+' || ev.key === '-' || ev.key === '=' || ev.key === '0') {
        ev.preventDefault();
      }
    }
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey);
    if (document.body) document.body.style.zoom = '1';
    return () => {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
    };
  }, []);
}

/** Mirror the Alt key into the store so LevelCurve / useToolCursor
 *  can treat Alt as a pen-tool modifier without each owning its own
 *  listener (which would also miss keys delivered to elements that
 *  prevent bubbling). `blur` clears the flag so Alt-tabbing out
 *  doesn't leave the app stuck in alt-down. */
export function useAltKey() {
  useEffect(() => {
    const setAlt = useStore.getState().setAltHeld;
    const down = (e: KeyboardEvent) => { if (e.key === 'Alt') setAlt(true); };
    const up = (e: KeyboardEvent) => { if (e.key === 'Alt') setAlt(false); };
    const blur = () => setAlt(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      setAlt(false);
    };
  }, []);
}

/** Mouse-wheel vertical pan over the lanes. Wheel over the video stack
 *  pans the vVideo window; over the audio stack pans vAudio. Pan only —
 *  no zoom (that's Alt+RMB). Each notch moves ~one third of a track
 *  unit. The window is clamped to [min, max]; a wheel where there's
 *  nothing to pan is a silent no-op (the page itself never scrolls). */
export function useWheelScroll() {
  useEffect(() => {
    function onWheel(ev: WheelEvent) {
      if (ev.ctrlKey) return; // page-zoom suppression owns Ctrl+wheel
      const target = ev.target as HTMLElement | null;
      if (!target) return;
      const inVideo = !!target.closest('#lanes-videos')
        || !!target.closest('#headers-videos');
      const inAudio = !!target.closest('#lanes-audios')
        || !!target.closest('#headers-audios');
      if (!inVideo && !inAudio) return;

      const s = useStore.getState();
      const win = inVideo ? s.vVideo : s.vAudio;
      const span = win.vMax - win.vMin;
      const range = win.max - win.min;
      if (range - span < 0.001) return; // nothing to pan

      // ~1/3 of a track unit per notch; deltaY is ~100 per notch.
      const step = (ev.deltaY / 100) * 0.34;
      let vMin = win.vMin + step;
      vMin = Math.max(win.min, Math.min(win.max - span, vMin));
      if (Math.abs(vMin - win.vMin) < 0.0001) return;
      ev.preventDefault();
      const vMax = vMin + span;
      if (inVideo) s.setVVideoVisible(vMin, vMax);
      else s.setVAudioVisible(vMin, vMax);
    }
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, []);
}
