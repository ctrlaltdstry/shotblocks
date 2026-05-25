import { useEffect } from 'react';
import * as host from './lib/host';
import { useStore, type DragPreview } from './store';
import type { OmItem } from './lib/host';

/** Fallback duration (in frames) when an OM-dragged object has no
 *  animated range to mirror. Per user spec: 48 frames. */
const FALLBACK_DURATION_FRAMES = 48;

/** Result of resolving an OM-drag's cursor position. Two cases:
 *    - `relink`: cursor is over an existing orphan clip — drop will
 *      rebind that clip's source camera, no new clip created.
 *    - `create`: cursor is over an empty lane spot — drop creates a
 *      new clip with the dragged camera (the standard path).
 *  Null means the cursor isn't over any valid drop target. */
type Resolved =
  | { kind: 'relink'; clipId: number }
  | { kind: 'create'; preview: DragPreview };

/** Detect whether the cursor sits over an existing orphan shot-block.
 *  Reads `data-clip` off the block, then checks the store's live
 *  orphanObjectIds via the clip's objectId. Only video-side clips
 *  qualify — audio clips have no camera link. */
function resolveOrphanAt(viewportX: number, viewportY: number): number | null {
  const targets = document.elementsFromPoint(viewportX, viewportY);
  const block = targets.find((el) =>
    el instanceof HTMLElement && el.classList.contains('shot-block') && el.hasAttribute('data-clip')
  ) as HTMLElement | undefined;
  if (!block) return null;
  const clipId = parseInt(block.getAttribute('data-clip') || '0', 10);
  if (!clipId) return null;
  const state = useStore.getState();
  for (const t of state.videoTracks) {
    for (const c of t.clips) {
      if (c.id !== clipId) continue;
      if (c.objectId > 0 && state.orphanObjectIds.has(c.objectId)) return clipId;
      return null;
    }
  }
  return null;
}

/** Resolve the drop / hover into either a relink target (orphan
 *  clip under cursor) or a create-clip preview. Relink wins when
 *  both could apply — the orphan clip sits on top of its lane in
 *  the DOM stack. */
function resolveDrop(viewportX: number, viewportY: number, items: OmItem[]): Resolved | null {
  if (!items.length) return null;

  const orphanClipId = resolveOrphanAt(viewportX, viewportY);
  if (orphanClipId != null) return { kind: 'relink', clipId: orphanClipId };

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
    kind: 'create',
    preview: {
      trackId,
      inFrame: startFrame,
      outFrame: startFrame + duration,
      sourceName: item.name || 'clip',
    },
  };
}

/** Listens for OM drag lifecycle messages from C++.
 *    om-hover  → update store.dragPreview (renders the ghost) OR
 *                suppress the ghost when hovering an orphan clip
 *                (the drop will rebind that clip's camera, not
 *                create a new one — no preview needed).
 *    om-drop   → either rebind an orphan clip's camera, or create
 *                a new clip, depending on what's under the cursor.
 *    om-cancel → clear the ghost. */
export function useOmDrop(): void {
  useEffect(() => {
    return host.onMessage((msg) => {
      if (msg.kind === 'om-cancel') {
        useStore.getState().setDragPreview(null);
        return;
      }
      if (msg.kind === 'om-hover') {
        const resolved = resolveDrop(msg.viewportX, msg.viewportY, msg.items);
        // Relink-hover: no ghost. The orphan clip stays as-is and
        // absorbs the drop in place.
        const preview = resolved && resolved.kind === 'create' ? resolved.preview : null;
        useStore.getState().setDragPreview(preview);
        return;
      }
      if (msg.kind === 'om-drop') {
        const resolved = resolveDrop(msg.viewportX, msg.viewportY, msg.items);
        useStore.getState().setDragPreview(null);
        if (!resolved) return;
        const item = msg.items[0];
        if (resolved.kind === 'relink') {
          useStore.getState().relinkClipCamera(
            resolved.clipId,
            (item.objectId ?? 0) | 0,
            item.name || 'clip',
            item.type | 0,
          );
          return;
        }
        useStore.getState().addClip(resolved.preview.trackId, {
          inFrame: resolved.preview.inFrame,
          outFrame: resolved.preview.outFrame,
          sourceName: resolved.preview.sourceName,
          sourceType: item.type | 0,
          objectId: (item.objectId ?? 0) | 0,
          state: 'unselected',
          locked: false,
        });
        return;
      }
    });
  }, []);
}
