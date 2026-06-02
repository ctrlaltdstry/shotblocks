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
 *  prevent bubbling).
 *
 *  Why we read e.altKey on EVERY event instead of keydown/keyup only:
 *  Windows + WebView2 has a quirk where pressing Alt also activates
 *  the window's menu-bar focus mode, and the OS sometimes swallows
 *  the matching keyup. With pure keydown/keyup tracking, the user
 *  saw Alt "stick" — one tap entered alt-mode, a second tap exited.
 *  Reading e.altKey from pointer/wheel/key events as ground truth
 *  keeps `altHeld` at most one event-tick stale instead of
 *  permanently wrong. `blur` still clears the flag so Alt-tabbing
 *  out doesn't leave the app stuck. */
export function useAltKey() {
  useEffect(() => {
    const setAlt = useStore.getState().setAltHeld;
    const setCtrl = useStore.getState().setCtrlHeld;
    function sync(e: { altKey: boolean; ctrlKey?: boolean }) {
      // Ref-equality-skip happens inside the store action; calling
      // setAlt(true) when it's already true is a no-op for renders.
      setAlt(e.altKey);
      setCtrl(!!e.ctrlKey);
    }
    const blur = () => { setAlt(false); setCtrl(false); };
    // Cover every UI event that surfaces `altKey` on the event object.
    // Together these run on virtually every interaction — the alt flag
    // never drifts more than one event-tick away from physical reality.
    window.addEventListener('keydown', sync);
    window.addEventListener('keyup', sync);
    window.addEventListener('pointermove', sync, true);
    window.addEventListener('pointerdown', sync, true);
    window.addEventListener('pointerup', sync, true);
    window.addEventListener('wheel', sync, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', sync);
      window.removeEventListener('keyup', sync);
      window.removeEventListener('pointermove', sync, true);
      window.removeEventListener('pointerdown', sync, true);
      window.removeEventListener('pointerup', sync, true);
      window.removeEventListener('wheel', sync, true);
      window.removeEventListener('blur', blur);
      setAlt(false);
      setCtrl(false);
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
