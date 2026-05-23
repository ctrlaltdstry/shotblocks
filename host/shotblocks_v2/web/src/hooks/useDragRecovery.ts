import { useEffect } from 'react';
import { useStore } from '../store';

/** Mirrors the store's `dragClip` state onto a body class, and provides
 *  a global safety net that clears stuck drag state when the page loses
 *  focus, becomes hidden, or sees a pointer release with no live drag
 *  closure handling it.
 *
 *  Background: useClipDrag binds pointer listeners on window when a
 *  drag starts and unbinds them in endDrag. If the React effect
 *  re-mounts mid-drag (e.g. cross-track ripple changes the trackId
 *  prop, which is in the effect deps), the OLD listeners are gone
 *  before the pointerup fires, the NEW mount has fresh listeners but
 *  no live drag, and dragClip / .is-clip-dragging stick. Same thing
 *  happens when the user takes a screenshot (Win+Shift+S overlay
 *  steals focus mid-pointermove) — pointerup never reaches us.
 *
 *  This hook treats `dragClip` as the source of truth: the body class
 *  always matches it, and any global pointerup / visibility / blur
 *  while a drag is "active" force-clears the state. */
export function useDragRecovery() {
  const dragClip = useStore((s) => s.dragClip);
  useEffect(() => {
    document.body.classList.toggle('is-clip-dragging', dragClip != null);
  }, [dragClip]);

  useEffect(() => {
    function clear() {
      const s = useStore.getState();
      if (s.dragClip != null) s.setDragClip(null);
      if (s.spawnGhost != null) s.setSpawnGhost(null);
      if (s.snapIndicatorFrames.length > 0) s.setSnapIndicatorFrames([]);
      // Wipe inline drag styles in case useClipDrag's closure cleanup
      // never ran. useClipDrag only writes `transform` (the visual
      // translation during a solo body drag), so that's the only
      // inline property to clear here. An earlier version of this
      // hook also blanked left/top/width/height/position — but those
      // are React-managed style props on ShotBlock (the clip's
      // pixel-percent placement comes from Lane.tsx as inline
      // style={...}). Blanking them via the DOM bypasses React's
      // style-diffing, so the next render doesn't re-apply them and
      // the clip renders as a zero-width strip until something else
      // triggers a fresh render (e.g. a click). The narrow `transform`
      // wipe is what we actually need.
      const stuck = document.querySelector<HTMLElement>('.shot-block.is-dragging');
      if (stuck) stuck.style.transform = '';
    }
    function onVisibility() {
      if (document.hidden) clear();
    }
    function onPointerUpFallback() {
      // If dragClip is set, the per-clip closure should already have
      // cleared it before this capture-phase fallback runs. If we
      // see dragClip still set on the NEXT tick, the closure didn't
      // run — clear it ourselves.
      setTimeout(() => {
        const s = useStore.getState();
        if (s.dragClip != null) clear();
      }, 0);
    }
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', clear);
    window.addEventListener('pointerup', onPointerUpFallback, true);
    window.addEventListener('pointercancel', clear, true);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', clear);
      window.removeEventListener('pointerup', onPointerUpFallback, true);
      window.removeEventListener('pointercancel', clear, true);
    };
  }, []);
}
