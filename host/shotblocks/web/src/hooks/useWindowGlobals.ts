import { useEffect } from 'react';
import { useStore } from '../store';
import { onMessage } from '../lib/host';

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

// Trackpad/wheel zoom sensitivities — e-folds per wheel delta unit. The
// browser synthesizes a ctrlKey wheel for a pinch gesture (both WKWebView
// and WebView2); option/alt + two-finger scroll arrives as a plain wheel
// with altKey set. Both deltas are small per event, so these are gentle.
const PINCH_ZOOM_SENS = 0.01;   // pinch / Ctrl+wheel → horizontal time zoom
const AUDIO_VZOOM_SENS = 0.01;  // option+wheel over audio → audio v-zoom
// Native macOS pinch (NSEvent magnify, forwarded from C++ as tp-magnify):
// magnification delta is small per event; gain maps a full pinch to a few×.
const PINCH_MAGNIFY_GAIN = 2.0;

/** Anchored horizontal zoom: hold the frame under `clientX` fixed while the
 *  visible span scales by `factor` (<1 = zoom in). Shared by Ctrl/pinch
 *  wheel and the native macOS magnify path. */
function horizontalZoomAtClientX(clientX: number, factor: number): void {
  const xRef = (document.querySelector('.lanes-area')
    ?? document.querySelector('.ruler-row')) as HTMLElement | null;
  if (!xRef) return;
  const rect = xRef.getBoundingClientRect();
  if (rect.width <= 0) return;
  const s = useStore.getState();
  const h = s.h;
  const span = Math.max(1, h.vMax - h.vMin);
  const xFrac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const anchorFrame = h.vMin + xFrac * span;
  const spanNew = Math.max(1, Math.min(h.max - h.min, span * factor));
  let vMin = anchorFrame - xFrac * spanNew;
  let vMax = vMin + spanNew;
  if (vMin < h.min) { vMax += h.min - vMin; vMin = h.min; }
  if (vMax > h.max) { vMin -= vMax - h.max; vMax = h.max; }
  vMin = Math.max(h.min, vMin);
  vMax = Math.min(h.max, vMax);
  s.setHVisible(vMin, vMax);
}

/** Mouse-wheel + trackpad gestures over the timeline. Three behaviors,
 *  all cross-platform (the browser maps trackpad gestures onto wheel
 *  events identically on macOS and Windows):
 *
 *    - Pinch / Ctrl+wheel over the canvas → zoom the time axis, anchored
 *      at the frame under the cursor. (usePageZoomSuppress still blocks
 *      the browser's own page zoom; here we repurpose the gesture.)
 *    - Option/Alt + wheel over the audio area → zoom the audio track
 *      stack vertically (same engine as Alt+RMB-drag in the audio
 *      headers), anchored at the top edge. Scroll up = zoom in.
 *    - Plain two-finger scroll → pan. Horizontal swipe (deltaX) pans the
 *      time axis; vertical swipe (deltaY) pans the track stack under the
 *      cursor (video or audio). Both can fire in one event.
 *
 *  Each notch of vertical pan moves ~one third of a track unit. Windows
 *  are clamped to [min, max]; a gesture with nothing to do is a silent
 *  no-op (the page itself never scrolls). */
export function useWheelScroll() {
  useEffect(() => {
    function onWheel(ev: WheelEvent) {
      const target = ev.target as HTMLElement | null;
      if (!target) return;
      const inRuler = !!target.closest('.ruler-row');
      const inLanes = !!target.closest('.lanes-area');
      const inCanvas = inRuler || inLanes;
      const inHeadersVideo = !!target.closest('#headers-videos');
      const inHeadersAudio = !!target.closest('#headers-audios');
      const inVideo = !!target.closest('#lanes-videos') || inHeadersVideo;
      const inAudio = !!target.closest('#lanes-audios') || inHeadersAudio;
      const s = useStore.getState();

      // --- Pinch / Ctrl+wheel → horizontal zoom, anchored at the cursor.
      // (Windows precision trackpads + mice; macOS trackpad pinch comes
      // through the native tp-magnify path below, not as a Ctrl+wheel.)
      if (ev.ctrlKey) {
        if (!inCanvas) return; // outside the canvas, page-zoom suppress owns it
        ev.preventDefault();
        horizontalZoomAtClientX(ev.clientX, Math.exp(ev.deltaY * PINCH_ZOOM_SENS));
        return;
      }

      // --- Option/Alt + wheel over the audio area → audio vertical zoom.
      if (ev.altKey && inAudio) {
        if (!s.audioTracks.some((t) => t.clips.length > 0)) return;
        const win = s.vAudio;
        const spanStart = Math.max(0.01, win.vMax - win.vMin);
        const factor = Math.exp(ev.deltaY * AUDIO_VZOOM_SENS);
        const spanNew = Math.max(0.05, Math.min(win.max - win.min, spanStart * factor));
        if (Math.abs(spanNew - spanStart) < 0.0001) return;
        ev.preventDefault();
        s.setVAudioVisible(win.min, win.min + spanNew); // top-anchored, like Alt+RMB
        return;
      }

      // --- Plain two-finger scroll → pan (both axes).
      if (!inCanvas && !inVideo && !inAudio) return;
      let acted = false;

      // Horizontal time pan from deltaX.
      if (Math.abs(ev.deltaX) > 0.01) {
        const xRef = (target.closest('.lanes-area')
          ?? target.closest('.ruler-row')) as HTMLElement | null;
        const width = xRef?.getBoundingClientRect().width ?? 0;
        const h = s.h;
        const hSpan = h.vMax - h.vMin;
        if (width > 0 && (h.max - h.min) - hSpan > 0.001) {
          const framesPerPx = hSpan / width;
          let vMin = h.vMin + ev.deltaX * framesPerPx;
          vMin = Math.max(h.min, Math.min(h.max - hSpan, vMin));
          if (Math.abs(vMin - h.vMin) > 0.0001) {
            s.setHVisible(vMin, vMin + hSpan);
            acted = true;
          }
        }
      }

      // Vertical pan from deltaY. WHICH stack pans is decided by where the
      // cursor is (user model): over the VIDEO headers -> video tracks
      // only; over the AUDIO headers -> audio tracks only; over the canvas
      // (the clip lanes) -> the ENTIRE canvas, i.e. both stacks together.
      // Pixel-proportional (content follows the fingers ~1:1) so trackpad
      // pixel deltas pan meaningfully; natural-scroll direction (fingers
      // up -> view moves down). A stack with no overflow is a silent no-op.
      if (Math.abs(ev.deltaY) > 0.01) {
        const panVStack = (side: 'video' | 'audio'): boolean => {
          const win = side === 'video' ? s.vVideo : s.vAudio;
          const span = win.vMax - win.vMin;
          const stackEl = document.getElementById(
            side === 'video' ? 'lanes-videos' : 'lanes-audios');
          const stackH = stackEl?.getBoundingClientRect().height ?? 0;
          if (stackH <= 0 || (win.max - win.min) - span <= 0.001) return false;
          // The video stack is bottom-up but the audio stack is top-down
          // (see useMmbPan), so they need OPPOSITE signs to both read as
          // natural scroll — without this, audio pans the wrong way.
          const sign = side === 'video' ? -1 : 1;
          let vMin = win.vMin + sign * ev.deltaY * (span / stackH);
          vMin = Math.max(win.min, Math.min(win.max - span, vMin));
          if (Math.abs(vMin - win.vMin) <= 0.0001) return false;
          if (side === 'video') s.setVVideoVisible(vMin, vMin + span);
          else s.setVAudioVisible(vMin, vMin + span);
          return true;
        };
        if (inHeadersVideo) {
          if (panVStack('video')) acted = true;
        } else if (inHeadersAudio) {
          if (panVStack('audio')) acted = true;
        } else if (inLanes) {
          // Canvas (clip area) -> pan the ENTIRE canvas like the Hand tool:
          // reapportion the V/A split so video + audio move TOGETHER, not
          // as two independent (opposite-direction) stack scrolls. This is
          // exactly useMmbPan's default vertical action (setVaShare).
          const lanesEl = document.getElementById('lanes-area');
          const regionPx = lanesEl
            ? Math.max(1, lanesEl.getBoundingClientRect().height) : 1;
          const before = s.vaShare;
          const next = Math.max(0, Math.min(1, before - ev.deltaY / regionPx));
          if (Math.abs(next - before) > 0.0001) { s.setVaShare(next); acted = true; }
        }
      }

      if (acted) ev.preventDefault();
    }
    window.addEventListener('wheel', onWheel, { passive: false });

    // Native trackpad pinch (macOS): the WebView never receives the
    // gesture, so C++ taps AppKit's magnify NSEvent and forwards it as a
    // tp-magnify message. Pinch doesn't move the cursor, so anchor the
    // zoom at the last pointer position (pointer events DO reach the
    // WebView), and only when that position is over the canvas.
    let lastX = -1, lastY = -1;
    const onPointerMove = (e: PointerEvent) => { lastX = e.clientX; lastY = e.clientY; };
    window.addEventListener('pointermove', onPointerMove, { passive: true, capture: true });
    const unsub = onMessage((m) => {
      if (m.kind !== 'tp-magnify' || lastX < 0) return;
      const el = document.elementFromPoint(lastX, lastY) as HTMLElement | null;
      if (!el || (!el.closest('.lanes-area') && !el.closest('.ruler-row'))) return;
      // delta > 0 = pinch open = zoom in => span shrinks (factor < 1).
      horizontalZoomAtClientX(lastX, Math.exp(-(m.d / 10000) * PINCH_MAGNIFY_GAIN));
    });

    return () => {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('pointermove', onPointerMove, true);
      unsub();
    };
  }, []);
}
