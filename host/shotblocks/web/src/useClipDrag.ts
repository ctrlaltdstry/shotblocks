import { useEffect, useRef, type RefObject } from 'react';
import { gsap } from 'gsap';
import { useStore, magneticSnap, audioPeakDocFrames, isTrackLocked, SNAP_PIXEL_RADIUS, clipEdgeZonePx, type Clip } from './store';
import { DRAG_THRESHOLD_PX, type DragRef } from './hooks/clipDrag/types';
import { resolveLane } from './hooks/clipDrag/resolveLane';
import { startSlipDrag } from './hooks/clipDrag/startSlipDrag';

/** Pointer-driven body drag on a ShotBlock.
 *
 *  Visual model: the clip element itself moves under the cursor via a
 *  CSS transform during the drag — no ghost, no dim. The clip keeps
 *  whatever state class it had (selected, unselected, etc). On release
 *  the transform is cleared and moveClip() commits the snapped
 *  destination, so React re-renders the clip at its new left/right %.
 *
 *  Snap + collision are run on every pointermove against the
 *  destination lane (excluding the moving clip from collision). The
 *  preview translates the clip to the snapped position, not the raw
 *  cursor — so what you see during the drag is what you get on
 *  release. Cross-side moves (V↔A) are rejected — the clip just stops
 *  tracking the cursor until it returns to its own side.
 *
 *  See memory project_v2_auto_track_lifecycle (implicit tracks) and
 *  react-drag-state-in-ref (drag state in useRef, not let). */
export function useClipDrag(
  clip: Clip,
  trackId: string,
  side: 'video' | 'audio',
  elRef: RefObject<HTMLElement | null>,
) {
  const dragRef = useRef<DragRef>({
    active: false,
    pointerId: -1,
    startClientX: 0,
    startClientY: 0,
    startInFrame: 0,
    startOutFrame: 0,
    pxPerFrame: 0,
    previewTrackId: trackId,
    previewInFrame: clip.inFrame,
    currentTrackId: trackId,
    lastDx: 0,
    lastDy: 0,
    animatedDy: 0,
    groupIds: null,
    rippleMode: false,
  });

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;

    function clearTransform() {
      // Kill any in-flight vertical-glide tween before clearing the
      // transform; otherwise the tween's next onUpdate fires after we
      // cleared and would set transform back to a stale value.
      gsap.killTweensOf(dragRef.current, 'animatedDy');
      if (el) el.style.transform = '';
    }

    function endDrag(commit: boolean) {
      const d = dragRef.current;
      const wasActive = d.active;
      const wasGroup = d.groupIds !== null;
      const wasRipple = d.rippleMode;
      const dest = { trackId: d.previewTrackId, inFrame: d.previewInFrame };
      d.active = false;
      d.pointerId = -1;
      d.lastDx = 0;
      d.lastDy = 0;
      d.groupIds = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey);

      useStore.getState().setDragClip(null);
      useStore.getState().setSpawnGhost(null);
      useStore.getState().setSnapIndicatorFrames([]);
      // Body `.is-clip-dragging` class is mirrored from dragClip
      // state by useDragRecovery — no manual remove needed here.

      // Solo REPLACE drag commits on release. Group drag and solo
      // RIPPLE both committed live each pointermove — nothing to do.
      if (wasActive && commit && !wasGroup && !wasRipple) {
        const snapFrames = Math.max(1, SNAP_PIXEL_RADIUS / Math.max(0.0001, d.pxPerFrame));
        useStore.getState().moveClip(clip.id, trackId, dest.trackId, dest.inFrame, snapFrames, 'replace');
      }
      clearTransform();
    }

    function onMove(ev: PointerEvent) {
      const d = dragRef.current;
      if (d.pointerId !== ev.pointerId) return;

      // Re-anchor on ripple-toggle: clear transform AND reset the drag
      // origin to (current pointer, current store position) so the
      // next mode's delta math starts from a clean baseline. Without
      // this, switching from replace (transform-only) to ripple
      // (live-commit) would compute frameDelta from the *original*
      // pointer-down position, double-applying the move.
      // Ripple = Cmd/Ctrl held (Premiere model — Shift is now the
      // force-snap modifier, see snapActive below).
      const nowRipple = ev.ctrlKey || ev.metaKey;
      const toggled = !d.groupIds && nowRipple !== d.rippleMode && d.active;
      if (toggled) {
        // Find the moving clip's live position in the store. After a
        // live-ripple commit, this is its new place; after replace
        // dragging, this is still its start position (no commits yet).
        const liveStore = useStore.getState();
        const liveTracks = side === 'video' ? liveStore.videoTracks : liveStore.audioTracks;
        let liveTrackId: string | null = null;
        let liveInFrame = d.startInFrame;
        let liveOutFrame = d.startOutFrame;
        for (const t of liveTracks) {
          const c = t.clips.find((cc) => cc.id === clip.id);
          if (c) {
            liveTrackId = (side === 'video' ? 'V' : 'A') + t.id;
            liveInFrame = c.inFrame;
            liveOutFrame = c.outFrame;
            break;
          }
        }
        d.startClientX = ev.clientX;
        d.startClientY = ev.clientY;
        d.startInFrame = liveInFrame;
        d.startOutFrame = liveOutFrame;
        if (liveTrackId) {
          d.previewTrackId = liveTrackId;
          d.currentTrackId = liveTrackId;
        }
        d.previewInFrame = liveInFrame;
        // Replace mode uses transform; clear any leftover ripple-side
        // transform reset, or any leftover replace-side transform.
        gsap.killTweensOf(d, 'animatedDy');
        if (el) el.style.transform = '';
        d.lastDx = 0;
        d.lastDy = 0;
        d.animatedDy = 0;
      }
      d.rippleMode = nowRipple;

      const dx = ev.clientX - d.startClientX;
      const dy = ev.clientY - d.startClientY;
      if (!d.active) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        d.active = true;
        // Body `.is-clip-dragging` class is mirrored from dragClip
        // state by useDragRecovery.
        useStore.getState().setDragClip({ clipId: clip.id, fromTrackId: trackId });
      }

      const duration = d.startOutFrame - d.startInFrame;
      const frameDelta = Math.round(dx / Math.max(0.0001, d.pxPerFrame));
      // Clamp the dragged position to [0, docFrames - duration] so the
      // clip can't slide past either end of the document. The lower
      // clamp prevents inFrame < 0; the upper clamp prevents the clip
      // from translating visually under the Inspector panel when the
      // cursor keeps moving right past the canvas edge. Without the
      // upper clamp, frameDelta grows without bound and the clip's
      // transform pushes it under the Inspector. (No auto-scroll on
      // canvas-edge in v1 — out of scope.)
      const docFrames = useStore.getState().docFrames;
      // Upper clamp: the clip's LEFT edge must stay on the timeline.
      // If the clip itself is longer than the doc, its right edge will
      // hang off the right side — that's fine, the user can still drag
      // the clip left/right. The previous clamp (docFrames - duration)
      // produced maxIn = 0 for over-long clips, pinning every drag to
      // frame 0 (audio files imported into a short timeline hit this).
      const maxIn = Math.max(0, docFrames - 1);
      const rawInFrame = Math.min(maxIn, Math.max(0, d.startInFrame + frameDelta));

      const target = resolveLane(ev.clientX, ev.clientY, side);
      if (!target) {
        // Pointer wandered off any valid lane on our side. Hold the
        // previously resolved destination — don't translate the clip
        // out of bounds.
        return;
      }
      // Spawn-ghost preview state. Cleared on every existing-lane move.
      useStore.getState().setSpawnGhost(
        target.kind === 'spawn' ? { side, trackId: target.trackId } : null,
      );

      // Magnetic snap only — no collision-avoid. The clip is free to
      // overlap others while dragging; release-time replaceOverlap
      // resolves any final overlaps (Python's "replace" mode, see
      // sb_shot_model.py:_resolve_position).
      //
      // Edit-point sources: every clip's inFrame + outFrame across the
      // WHOLE timeline — both sides (video + audio), all tracks — so a
      // clip snaps to edges globally (e.g. a video clip catches on an
      // audio clip's edge below it). Excludes the moving clip(s) (single
      // clip OR whole group) to prevent self-snap. Plus the playhead.
      const state = useStore.getState();
      const movingIds = d.groupIds ?? new Set<number>([clip.id]);
      const editPoints: number[] = [];
      for (const t of [...state.videoTracks, ...state.audioTracks]) {
        for (const c of t.clips) {
          if (movingIds.has(c.id)) continue;
          editPoints.push(c.inFrame, c.outFrame);
        }
      }
      editPoints.push(state.scrubFrame ?? state.currentFrame);
      // Snap-to-peak: detected audio peaks are valid snap targets,
      // but ONLY when the beat-grid overlay is visible. If the user
      // toggled the grid off, the beat positions are off-screen — and
      // user-confirmed: invisible lines shouldn't magnet the drag.
      if (state.beatGridVisible) {
        for (const f of audioPeakDocFrames(state)) editPoints.push(f);
      }
      // Snap gating (Premiere model): snap is active when the Snap
      // toggle is on, OR while Shift is held — Shift temporarily
      // force-enables snap for this drag even with the toggle off.
      // snapFrames=0 short-circuits magneticSnap to a no-op.
      const snapActive = state.snapEnabled || ev.shiftKey;
      const snapFrames = snapActive ? Math.max(1, SNAP_PIXEL_RADIUS / d.pxPerFrame) : 0;
      const snap = magneticSnap(rawInFrame, duration, editPoints, snapFrames);
      const snappedIn = Math.max(0, snap.inFrame);
      state.setSnapIndicatorFrames(snap.targets);
      d.previewTrackId = target.trackId;
      d.previewInFrame = snappedIn;

      if (!d.groupIds && d.rippleMode) {
        // Solo ripple: commit live each pointermove so the user sees
        // neighbors shove in real time. Same pattern as group drag —
        // no CSS transform, the React re-render moves the clip's DOM.
        //
        // SAME-TRACK ONLY. Cross-track ripple was structurally racy:
        // the live commit re-mounts useClipDrag (trackId is in the
        // effect deps), tearing down the active pointer listeners
        // before pointerup arrives. Patched over with useDragRecovery
        // for a while; ultimately not worth fixing because the
        // gesture has no clear NLE precedent — Premiere/Resolve don't
        // ripple across tracks either. If the cursor crosses to a
        // different track while ripple is held, hold position and
        // wait for the user to either move back or release the
        // modifier.
        if (target.trackId !== d.currentTrackId) return;
        gsap.killTweensOf(d, 'animatedDy');
        if (el) el.style.transform = '';
        d.lastDx = 0;
        d.lastDy = 0;
        d.animatedDy = 0;
        const snapFramesForCommit = Math.max(1, SNAP_PIXEL_RADIUS / Math.max(0.0001, d.pxPerFrame));
        useStore.getState().moveClip(
          clip.id,
          d.currentTrackId,
          target.trackId,
          snappedIn,
          snapFramesForCommit,
          'ripple',
        );
        d.currentTrackId = target.trackId;
        return;
      }

      if (d.groupIds) {
        // Group drag: commit live via moveClips so every selected
        // clip moves on each pointermove. The anchor's delta (this
        // clip from startInFrame → snappedIn, trackId → target.trackId)
        // drives every group member's shift. No CSS transform — the
        // re-render moves the DOM for all clips simultaneously.
        useStore.getState().moveClips(
          d.groupIds,
          clip.id,
          trackId,
          target.trackId,
          snappedIn,
        );
        // Anchor's frame just changed in the store — update our
        // snapshot so subsequent moves compute deltas from the new
        // position. NOTE: this re-mounts the hook via the deps
        // (clip.inFrame changed), but the new mount won't see an
        // active drag because dragRef.current.active belongs to the
        // OLD effect. So instead we keep dragRef stable and rely on
        // the closure not being torn down mid-drag. Verified: deps
        // include clip.inFrame, so the effect WILL re-run on each
        // commit. To stay alive across that, the listeners must
        // re-attach. Cleanup runs before re-run; new effect adds new
        // listeners; old listeners are gone before the next move.
        // That's actually fine for native pointermove (window-level)
        // because pointer events deliver to whatever's listening at
        // dispatch time. The pointercapture stays bound to el.
        return;
      }

      const placed = { inFrame: snappedIn, outFrame: snappedIn + duration };

      // Solo drag: visual translation via CSS transform. Snapped
      // position is committed to the store on release (endDrag).
      const snappedDx = (placed.inFrame - d.startInFrame) * d.pxPerFrame;
      let snappedDy = 0;
      const srcLane = el!.closest('.lane') as HTMLElement | null;
      const destLane = document.querySelector(`.lane[data-track="${target.trackId}"]`) as HTMLElement | null;
      if (srcLane && destLane) {
        const sr = srcLane.getBoundingClientRect();
        const dr = destLane.getBoundingClientRect();
        snappedDy = dr.top - sr.top;
      } else if (srcLane && target.kind === 'spawn') {
        // No destination lane element yet. Project the clip to land
        // adjacent to the OUTERMOST existing lane on this side — that
        // is where V<max+1>/A<max+1> will materialise on commit.
        //
        // Important: the stack itself fills the full V/A share height
        // (flex-grow) so its top/bottom edges don't track the lanes —
        // with 1 video track, the lane sits at the bottom of the
        // stack and stack.top is far above near the ruler. Anchor on
        // the outermost LANE's bounding rect, not the stack's.
        //
        //   - video: V1 at bottom of stack, V<max> at top → new lane
        //     appears IMMEDIATELY ABOVE V<max>. Target = outermostRect.top - laneH.
        //   - audio: A1 at top, A<max> at bottom → new lane appears
        //     IMMEDIATELY BELOW A<max>. Target = outermostRect.bottom.
        const sr = srcLane.getBoundingClientRect();
        const stackId = side === 'video' ? 'lanes-videos' : 'lanes-audios';
        const lanesInStack = Array.from(
          document.querySelectorAll<HTMLElement>(`#${stackId} .lane`),
        );
        if (lanesInStack.length) {
          // The outermost lane is the topmost in DOM order for video
          // (we render reversed), and the bottommost for audio.
          const outermost = side === 'video'
            ? lanesInStack[0]
            : lanesInStack[lanesInStack.length - 1];
          const or = outermost.getBoundingClientRect();
          const laneH = or.height;
          const targetTop = side === 'video' ? or.top - laneH : or.bottom;
          snappedDy = targetTop - sr.top;
        }
      }
      // Vertical glide: when snappedDy changes (cursor crossed into a
      // new lane), tween animatedDy → snappedDy with a short ease.out.
      // Horizontal stays direct (cursor-driven).
      //
      // We write the clip's position via left/top (the element is
      // position:fixed during drag, anchored to startRect) so it
      // floats above ALL lane stacking contexts. CSS transform is
      // not used here.
      const prevTargetDy = d.lastDy;
      d.lastDx = snappedDx;
      d.lastDy = snappedDy;
      function writePos() {
        if (!el) return;
        el.style.transform = `translate(${d.lastDx}px, ${d.animatedDy}px)`;
      }
      if (el) {
        if (snappedDy !== prevTargetDy) {
          gsap.killTweensOf(d, 'animatedDy');
          // Floaty glide between lane rows — the clip eases smoothly
          // into the target lane rather than snapping. 0.38s with a
          // soft ease.out reads as intentional smoothness (the cursor
          // hotspot is correct, so the lag isn't mistaken for a bug).
          gsap.to(d, {
            animatedDy: snappedDy,
            duration: 0.38,
            ease: 'power3.out',
            onUpdate: writePos,
          });
        } else {
          // No lane change; animatedDy is already at target (or being
          // tweened to it from a previous lane change). Write the
          // latest dx with whatever animatedDy currently is.
          writePos();
        }
      }
    }

    function onUp(ev: PointerEvent) {
      if (dragRef.current.pointerId !== ev.pointerId) return;
      endDrag(true);
    }
    function onCancel(ev: PointerEvent) {
      if (dragRef.current.pointerId !== ev.pointerId) return;
      endDrag(false);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === 'Escape') endDrag(false);
    }

    function onDown(ev: PointerEvent) {
      if (ev.button !== 0) return;

      // Hand and Zoom tools own left-click on the canvas — Hand for
      // panning, Zoom for drag-rect zoom. Clip drag is suspended while
      // either is active; user must switch tools to move clips.
      {
        const t = useStore.getState().activeTool;
        if (t === 'hand' || t === 'zoom') return;
      }

      // A locked track ignores every clip gesture — no select, no
      // body/edge drag, no razor split. The store actions also reject
      // these (defence in depth), but bailing here means the clip
      // never even enters a drag preview that would snap back.
      if (isTrackLocked(trackId)) return;

      // LevelCurve overlay owns the pointerdown ONLY when it actually
      // captures the gesture — Pen tool, Alt-Select (== penActive), or
      // when the press lands on an existing keyframe node / handle.
      // Under plain Select tool with no node/handle hit, LevelCurve
      // returns early without stopPropagation so the event bubbles to
      // here for body-drag. Previously this gate fired for ANY press
      // inside .level-curve, which broke body-drag entirely after
      // Select-tool gained edit-kf parity (flipping the SVG to
      // pointer-events:auto by default — so the SVG is the target for
      // every press on the clip body). The fix: bail only when the
      // SVG actually owns the gesture, which we detect by checking if
      // setPointerCapture was called on it.
      if (side === 'audio') {
        const target = ev.target as Element | null;
        const svg = target && target.closest('.level-curve') as SVGSVGElement | null;
        if (svg && svg.hasPointerCapture && svg.hasPointerCapture(ev.pointerId)) return;
      }

      // Razor tool: click splits the clip at the cursor frame instead
      // of starting a drag. Map cursor X → frame via the lane's
      // pxPerFrame, then call splitClip. Validation (frame inside
      // clip, both halves >= MIN_CLIP_FRAMES) happens in the store —
      // edge-zone clicks just no-op silently. Ports Python
      // _split_shot's caller path (sb_canvas razor mode).
      if (useStore.getState().activeTool === 'razor') {
        const laneEl = el!.closest('.lane') as HTMLElement | null;
        if (!laneEl) return;
        const laneRect = laneEl.getBoundingClientRect();
        const liveStore = useStore.getState();
        const span = Math.max(1, liveStore.h.vMax - liveStore.h.vMin);
        const pxPerFrame = laneRect.width / span;
        if (pxPerFrame <= 0) return;
        let cursorFrame = Math.round(liveStore.h.vMin + (ev.clientX - laneRect.left) / pxPerFrame);
        // Razor snap: pull the cut to the playhead frame only — clip
        // edges are already cuts so they're not useful targets. Lets
        // the user park the playhead inside a clip and cut exactly
        // there. Active when the Snap toggle is on OR Shift is held
        // (Shift force-enables snap — Premiere model).
        if (liveStore.snapEnabled || ev.shiftKey) {
          const playhead = liveStore.scrubFrame ?? liveStore.currentFrame;
          const snapFrames = Math.max(1, SNAP_PIXEL_RADIUS / pxPerFrame);
          if (Math.abs(cursorFrame - playhead) <= snapFrames) {
            cursorFrame = playhead;
          }
        }
        useStore.getState().splitClip(clip.id, trackId, cursorFrame);
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }

      const rect = el!.getBoundingClientRect();
      const xInClip = ev.clientX - rect.left;
      const edgeReserve = clipEdgeZonePx(rect.width);
      if (xInClip < edgeReserve || xInClip > rect.width - edgeReserve) return;

      // Slip gesture: when the Slip tool is active, a body drag on an
      // AUDIO clip slides the media window under the (fixed-position)
      // clip instead of moving the clip. Ports Python's slip branch
      // (sb_canvas.py:2917, _drag_audio_slip). Edge-zone drags already
      // returned above, so trim still works while the Slip tool is on.
      //
      // The old Ctrl-held shortcut for slip is GONE — Ctrl/Cmd now
      // means ripple (Premiere model). Slip is reached via the Slip
      // tool (palette or the `S` hotkey).
      {
        const st = useStore.getState();
        const slipActive = side === 'audio' && st.activeTool === 'slip';
        if (slipActive) {
          startSlipDrag(ev, el!, clip.id, trackId);
          return;
        }
      }

      // Select on pointer-down so the clip enters the selected visual
      // immediately — the drag (if any) continues with the clip already
      // showing the selected state. Matches Premiere / Resolve.
      //
      // Shift+click and Cmd/Ctrl+click toggle the clip in/out of the
      // multi-selection (additive=true). Plain click replaces. Special
      // case: if the clicked clip is already part of a multi-selection
      // (size > 1) and no modifier is held, KEEP the selection — that
      // way a drag can operate on the whole group. The selection only
      // collapses to this clip on a release-as-click (not yet wired).
      const additive = ev.shiftKey || ev.metaKey || ev.ctrlKey;
      const sel = useStore.getState().selectedClipIds;
      const alreadyInGroup = !additive && sel.size > 1 && sel.has(clip.id);
      if (!alreadyInGroup) {
        useStore.getState().setSelectedClip(clip.id, additive);
      }

      const laneEl = el!.closest('.lane') as HTMLElement | null;
      if (!laneEl) return;
      const laneRect = laneEl.getBoundingClientRect();
      const state = useStore.getState();
      const span = Math.max(1, state.h.vMax - state.h.vMin);
      const pxPerFrame = laneRect.width / span;
      if (pxPerFrame <= 0) return;

      // Read the CURRENT clip from the store, not the closure — the
      // effect's deps deliberately omit clip.inFrame to avoid
      // re-mounting listeners on every group-drag live commit. So
      // the closure's `clip` could be stale; look up fresh.
      const liveStore = useStore.getState();
      let liveClip: Clip | undefined;
      const sideTracks = side === 'video' ? liveStore.videoTracks : liveStore.audioTracks;
      for (const tt of sideTracks) {
        const c = tt.clips.find((cc) => cc.id === clip.id);
        if (c) { liveClip = c; break; }
      }
      if (!liveClip) return;

      // Group drag if the dragged clip is part of a multi-selection.
      // Snapshot the selection at pointer-down so subsequent
      // selection changes mid-drag don't reshape the group.
      const selSnapshot = liveStore.selectedClipIds;
      const isGroupDrag = selSnapshot.size > 1 && selSnapshot.has(clip.id);
      dragRef.current = {
        active: false,
        pointerId: ev.pointerId,
        startClientX: ev.clientX,
        startClientY: ev.clientY,
        startInFrame: liveClip.inFrame,
        startOutFrame: liveClip.outFrame,
        pxPerFrame,
        previewTrackId: trackId,
        previewInFrame: liveClip.inFrame,
        currentTrackId: trackId,
        lastDx: 0,
        lastDy: 0,
        animatedDy: 0,
        groupIds: isGroupDrag ? new Set(selSnapshot) : null,
        rippleMode: ev.ctrlKey || ev.metaKey,
      };

      ev.preventDefault();
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onKey);
    }

    el.addEventListener('pointerdown', onDown);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey);
    };
    // Deps deliberately omit clip.inFrame/outFrame: during group
    // drags we commit live, and clip.inFrame changes every
    // pointermove. Re-mounting listeners every frame is wasteful and
    // can drop events between cleanup and re-bind. The closure reads
    // the always-current clip from props via React's render cycle
    // already; onMove uses dragRef-stored startInFrame for delta
    // math, not closure clip.inFrame.
  }, [clip.id, trackId, side, elRef]);
}
