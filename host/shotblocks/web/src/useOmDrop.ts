import { useEffect } from 'react';
import * as host from './lib/host';
import { useStore, type DragPreview } from './store';
import type { OmItem } from './lib/host';
import { runDropCeremony } from './useDropCeremony';

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

  const state = useStore.getState();
  const item = items[0];
  const duration = item.hasAnim && item.inFrame != null && item.outFrame != null
    ? Math.max(1, item.outFrame - item.inFrame)
    : FALLBACK_DURATION_FRAMES;

  // Empty-doc fast path. When the dropzone is showing, the user is
  // aiming at the centered "drop a camera" panel — which means their
  // cursor can easily land below the V/A divider (the panel is
  // centered in the canvas). The standard hit-test would reject the
  // drop because the lane under the cursor is `data-side="audio"`.
  // Route the drop to V1 at frame 0 unconditionally when the doc has
  // no clips anywhere; matches the dropzone's intent ("any drop on
  // the canvas creates the first shot").
  const docEmpty = state.videoTracks.every((t) => t.clips.length === 0)
                && state.audioTracks.every((t) => t.clips.length === 0);
  if (docEmpty) {
    // Find any V-track to route into — typically V1.
    const v1 = state.videoTracks[0];
    if (!v1) return null;
    return {
      kind: 'create',
      preview: {
        trackId: 'V' + v1.id,
        inFrame: 0,
        outFrame: duration,
        sourceName: item.name || 'clip',
      },
    };
  }

  const targets = document.elementsFromPoint(viewportX, viewportY);
  const laneEl = targets.find((el) => el.classList && el.classList.contains('lane')) as HTMLElement | undefined;

  // Resolve target track id + the lane rect we'll use to compute the
  // horizontal frame. Two cases:
  //   1) cursor is on an existing video lane     → that lane / track
  //   2) cursor is in the empty area above the   → spawn V<max+1>
  //      outermost video lane (the "spawn band")
  // Other cases (cursor over audio lane, or off-canvas entirely) → null.
  let trackId: string;
  let laneRect: DOMRect;
  if (laneEl && laneEl.getAttribute('data-side') === 'video') {
    const rawTrackId = laneEl.getAttribute('data-track');
    if (!rawTrackId) return null;
    trackId = rawTrackId;
    laneRect = laneEl.getBoundingClientRect();
    // If the cursor lands on a LOCKED video track, bump the drop to
    // the next non-locked video track above it. If no non-locked track
    // exists above the cursor, spawn a new one (V<max+1>). Drops are
    // never silently rejected because of a locked target.
    const rawNum = parseInt(rawTrackId.slice(1), 10);
    const rawTrack = state.videoTracks.find((t) => t.id === rawNum);
    if (rawTrack && rawTrack.locked) {
      const above = state.videoTracks
        .filter((t) => t.id > rawNum && !t.locked)
        .sort((a, b) => a.id - b.id);
      if (above.length > 0) {
        trackId = 'V' + above[0].id;
      } else {
        const maxId = state.videoTracks.reduce((m, t) => Math.max(m, t.id), 0);
        trackId = 'V' + (maxId + 1);
      }
    }
  } else {
    // No lane under cursor. Check the spawn band: the area above the
    // topmost video lane up to the ruler. If the cursor sits there,
    // target V<max+1>. Uses the topmost lane's rect to compute the
    // frame from cursor X.
    const topmost = document.querySelector<HTMLElement>(
      '#lanes-videos .lane');
    if (!topmost) return null;
    const tr = topmost.getBoundingClientRect();
    if (viewportY >= tr.top) return null;        // not in spawn band
    if (viewportX < tr.left || viewportX > tr.right) return null;
    const maxId = state.videoTracks.reduce((m, t) => Math.max(m, t.id), 0);
    trackId = 'V' + (maxId + 1);
    laneRect = tr;
  }

  const xInLane = Math.max(0, viewportX - laneRect.left);
  const visibleSpan = Math.max(1, state.h.vMax - state.h.vMin);
  const pxPerFrame = laneRect.width / visibleSpan;
  if (pxPerFrame <= 0) return null;
  const cursorFrame = state.h.vMin + xInLane / pxPerFrame;
  // Center the ghost (and the eventual dropped clip) under the cursor
  // — feels like the mouse is "grabbing" the clip rather than tugging
  // it from one end. Clamp the LEFT edge to >= docMin so the ghost
  // doesn't extend off the timeline's left edge (absolute frames; docMin
  // can be negative — v2 mirrors C4D's ruler).
  const startFrame = Math.max(state.docMin, Math.round(cursorFrame - duration / 2));

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
        useStore.getState().setOmDragging(false);
        return;
      }
      if (msg.kind === 'om-hover') {
        // Mark the drag as in flight from the first hover. This stays
        // true until om-cancel/om-drop so the EmptyStateOverlay's
        // highlight doesn't flicker when the cursor strays off a
        // valid drop target (e.g. over the dropzone panel itself).
        useStore.getState().setOmDragging(true);
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
        useStore.getState().setOmDragging(false);
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
        // First drop into an empty doc anchors at frame 0 — the user
        // is setting the timeline up, not placing precisely. Detected
        // by both video AND audio sides being empty before this drop.
        const st = useStore.getState();
        const wasEmpty = st.videoTracks.every((t) => t.clips.length === 0)
                      && st.audioTracks.every((t) => t.clips.length === 0);
        const duration = resolved.preview.outFrame - resolved.preview.inFrame;
        const inFrame = wasEmpty ? 0 : resolved.preview.inFrame;
        const outFrame = inFrame + duration;
        // First drop into an empty doc resets the track count to the
        // V1/A1 baseline. If the user had multiple tracks before
        // clearing the timeline (delete-all-clips), the empty-state
        // is supposed to read as a fresh start; surviving Vn/An
        // tracks would contradict that. deleteEmptyTracks
        // compacts each side and keeps the base track as the empty
        // placeholder — exactly what we want.
        if (wasEmpty) {
          useStore.getState().deleteEmptyTracks('video');
          useStore.getState().deleteEmptyTracks('audio');
        }
        useStore.getState().addClip(resolved.preview.trackId, {
          inFrame,
          outFrame,
          sourceName: resolved.preview.sourceName,
          sourceType: item.type | 0,
          objectId: (item.objectId ?? 0) | 0,
          state: 'unselected',
          locked: false,
        });
        // Fire the drop ceremony only on a USER drop into an empty
        // doc. State-driven detection (was-empty subscribe) would
        // also fire on dialog reopen + persistence hydration, which
        // would feel wrong — the user didn't drop anything then.
        if (wasEmpty) runDropCeremony();
        return;
      }
    });
  }, []);
}
