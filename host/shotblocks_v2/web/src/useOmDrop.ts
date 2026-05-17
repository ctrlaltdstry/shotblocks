import { useEffect } from 'react';
import * as host from './lib/host';
import { useStore, type DragPreview } from './store';
import type { OmItem } from './lib/host';

/** Fallback duration (in frames) when an OM-dragged object has no
 *  animated range to mirror. Per user spec: 48 frames. */
const FALLBACK_DURATION_FRAMES = 48;

/** Resolve the drop / hover into a track + frame range. Returns null
 *  if the cursor isn't over a valid lane, or a DragPreview shaped
 *  payload otherwise. */
function resolveDrop(viewportX: number, viewportY: number, items: OmItem[]): DragPreview | null {
  if (!items.length) return null;

  const targets = document.elementsFromPoint(viewportX, viewportY);
  const laneEl = targets.find((el) => el.classList && el.classList.contains('lane')) as HTMLElement | undefined;
  if (!laneEl) return null;
  // OM drops are video-only — audio comes from file imports.
  if (laneEl.getAttribute('data-side') !== 'video') return null;

  const trackId = laneEl.getAttribute('data-track');
  if (!trackId) return null;

  const laneRect = laneEl.getBoundingClientRect();
  const xInLane = Math.max(0, viewportX - laneRect.left);
  const state = useStore.getState();
  const visibleSpan = Math.max(1, state.h.vMax - state.h.vMin);
  const pxPerFrame = laneRect.width / visibleSpan;
  if (pxPerFrame <= 0) return null;
  const startFrame = Math.round(state.h.vMin + xInLane / pxPerFrame);

  const item = items[0];
  const duration = item.hasAnim && item.inFrame != null && item.outFrame != null
    ? Math.max(1, item.outFrame - item.inFrame)
    : FALLBACK_DURATION_FRAMES;

  return {
    trackId,
    inFrame: startFrame,
    outFrame: startFrame + duration,
    sourceName: item.name || 'clip',
  };
}

/** Listens for OM drag lifecycle messages from C++.
 *    om-hover  → update store.dragPreview (renders the ghost).
 *    om-drop   → create a real clip and clear the ghost.
 *    om-cancel → clear the ghost. */
export function useOmDrop(): void {
  useEffect(() => {
    return host.onMessage((msg) => {
      if (msg.kind === 'om-cancel') {
        useStore.getState().setDragPreview(null);
        return;
      }
      if (msg.kind === 'om-hover') {
        const preview = resolveDrop(msg.viewportX, msg.viewportY, msg.items);
        useStore.getState().setDragPreview(preview);
        return;
      }
      if (msg.kind === 'om-drop') {
        const resolved = resolveDrop(msg.viewportX, msg.viewportY, msg.items);
        useStore.getState().setDragPreview(null);
        if (!resolved) {
          console.log('[sb] om-drop landed somewhere we ignore');
          return;
        }
        const item = msg.items[0];
        useStore.getState().addClip(resolved.trackId, {
          inFrame: resolved.inFrame,
          outFrame: resolved.outFrame,
          sourceName: resolved.sourceName,
          sourceType: item.type | 0,
          state: 'unselected',
          locked: false,
        });
        return;
      }
    });
  }, []);
}
