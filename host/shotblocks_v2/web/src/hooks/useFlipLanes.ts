import { useLayoutEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { useStore } from '../store';

/** FLIP (First, Last, Invert, Play) layout-transition — but ONLY for
 *  the narrow case of a group drag migrating selected clips between
 *  tracks. Everything else (track delete + renumber, single-clip
 *  release, V-scroll, V/A divider drag, viewport zoom) snaps as before.
 *
 *  Why so narrow:
 *
 *  Solo body drag already has its own GSAP glide built into useClipDrag
 *  (a transform tween on the dragged element). Group drag commits live
 *  every pointermove via moveClips, so every selected clip's React
 *  position updates instantly — bypassing the solo path's transform.
 *  Without this hook, group drag snaps vertically while solo drag
 *  glides. Group drag is the case we want to fix.
 *
 *  A naive FLIP that animates ANY layout change misfires on every
 *  unrelated event: delete-empty-tracks reflows the remaining clips
 *  (they snap to new positions; FLIP animates the reflow, briefly
 *  rendering them below the V/A line and gliding back). Single-clip
 *  release flashes the clip from React's pre-commit position to the
 *  post-commit position even though useClipDrag's own glide already
 *  put the clip where the user wanted it. Spawning a new V<max+1>
 *  shifts ALL existing clips slightly (auto-fit pin), so one of them
 *  jumps and glides back.
 *
 *  Gating: animate a clip ONLY when
 *    1. A group drag is in flight (store.dragClip != null AND the
 *       selection size > 1 — the actual "group" trigger).
 *    2. The clip is part of the live selection (it's being moved by
 *       the drag, not a bystander).
 *    3. The clip's vertical position changed by more than a track-
 *       worth of pixels (rules out small frame-shift artifacts).
 *
 *  Runs in useLayoutEffect (synchronous after DOM mutation, before
 *  paint) so the user never sees the clip flash at its new position
 *  before the animation starts. */
export function useFlipLanes() {
  // Map<clipId, top> captured at the END of every render.
  // Reused as the BEFORE state for the next render's animation.
  const prevTops = useRef<Map<string, number>>(new Map());

  // Subscribe to the slices that move clips so this layout effect
  // re-runs on every clip mutation.
  const videoTracks = useStore((s) => s.videoTracks);
  const audioTracks = useStore((s) => s.audioTracks);
  void videoTracks;
  void audioTracks;

  useLayoutEffect(() => {
    const state = useStore.getState();
    const dragClip = state.dragClip;
    const selected = state.selectedClipIds;
    // A group drag is in flight when dragClip is set AND more than
    // one clip is selected. Solo drag has its own animation; only
    // group drag needs us.
    const groupDragActive = dragClip != null && selected.size > 1;

    const clips = document.querySelectorAll<HTMLElement>('.shot-block[data-clip]');
    const nextTops = new Map<string, number>();
    const animateTargets: Array<{ el: HTMLElement; dy: number }> = [];

    for (const el of clips) {
      const id = el.getAttribute('data-clip');
      if (!id) continue;
      const r = el.getBoundingClientRect();
      nextTops.set(id, r.top);
      if (!groupDragActive) continue;
      // Only animate clips in the active group selection.
      const numId = parseInt(id, 10);
      if (!selected.has(numId)) continue;
      // Skip the clip that has its own inline transform (it's the
      // anchor being dragged — useClipDrag may own its transform).
      if (el.style.transform) continue;
      const prevTop = prevTops.current.get(id);
      if (prevTop === undefined) continue;
      const dy = prevTop - r.top;
      // ~half a natural track height is the threshold for "this
      // counts as a track migration." NATURAL_TRACK_PX is 65, so 32
      // covers the actual ~65px drop on track delete + spawn, and
      // ignores the smaller adjustments from V-scroll / V/A pan.
      if (Math.abs(dy) < 32) continue;
      animateTargets.push({ el, dy });
    }

    // FLIP step 3 + 4: invert and play. Apply the reverse transform
    // synchronously (before paint), then GSAP animates it to 0.
    for (const t of animateTargets) {
      gsap.set(t.el, { y: t.dy });
      gsap.to(t.el, {
        y: 0,
        duration: 0.38,
        ease: 'power3.out',
        onComplete: () => {
          gsap.set(t.el, { clearProps: 'transform' });
        },
      });
    }

    prevTops.current = nextTops;
  });
}
