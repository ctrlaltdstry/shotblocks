import { useEffect, useRef, useState } from 'react';
import { useStore, magneticSnap, audioPeakDocFrames, SNAP_PIXEL_RADIUS, clipEdgeZonePx } from '../store';
import type { Track, Clip } from '../store';
import { flushKeyframeRetimes } from '../usePersistence';
import { ShotBlock } from './ShotBlock';
import { useElementSize } from '../useElementSize';

type CursorMode = 'default' | 'trim' | 'roll';

/** A single lane row. Renders its clips using the Figma-spec
 *  <ShotBlock>, picking the thin layout when the lane is short.
 *
 *  Edge-hover follows the standard NLE trim/roll model — see memory
 *  v2-nle-trim-model. Clips render edge-to-edge with no visual gap.
 *  Each clip has 8px inward trim hit zones at its left and right
 *  edges. At a seam where two clips touch, the right-trim zone of
 *  clip A overlaps the left-trim zone of clip B. That overlap is
 *  divided into THIRDS:
 *    - First third (toward A):  trim A's right edge only.
 *    - Middle third (the seam): rolling edit — both edges move
 *      together. Set on BOTH clips so the user sees both brackets.
 *    - Last third (toward B):   trim B's left edge only.
 *
 *  The lane sets a `cursor` value on itself so the cursor shape tells
 *  the user the mode (ew-resize for trim, col-resize for roll). */
const THIN_THRESHOLD_PX = 32;

export function Lane({ track, side }: { track: Track; side: 'video' | 'audio' }) {
  const laneRef = useRef<HTMLDivElement | null>(null);
  const { width: laneWidth, height: laneHeight } = useElementSize(laneRef);
  const h = useStore((s) => s.h);
  const setEdgeHover = useStore((s) => s.setEdgeHover);
  const setSelectedClip = useStore((s) => s.setSelectedClip);
  const resizeClip = useStore((s) => s.resizeClip);
  const setSnapIndicatorFrames = useStore((s) => s.setSnapIndicatorFrames);
  const altHeld = useStore((s) => s.altHeld);
  const ctrlHeld = useStore((s) => s.ctrlHeld);
  const [cursorMode, setCursorMode] = useState<CursorMode>('default');
  // Retime intent for the cursor: hovering a video-clip trim edge with
  // Alt+Ctrl held, OR a retime drag in flight. Alt ALONE is the keyframe
  // marquee now, so retime took the Alt+Ctrl combo to avoid competing.
  // Audio edges never retime (no keyframes), so the video gate keeps the
  // cursor honest there.
  const [retimeDragging, setRetimeDragging] = useState(false);
  const retimeActive = (cursorMode === 'trim' && altHeld && ctrlHeld && side === 'video') || retimeDragging;
  const visibleSpan = Math.max(1, h.vMax - h.vMin);
  const thin = laneHeight > 0 && laneHeight < THIN_THRESHOLD_PX;
  const trackId = (side === 'video' ? 'V' : 'A') + track.id;
  // The dimming washes (mute / solo / lock / hide) only make sense over
  // actual content. An EMPTY lane shows no wash even if its track is
  // muted/locked/hidden — otherwise deleting the last clip on a muted
  // track strands a grey band over empty space (reads as a bug). The
  // header's mute/lock/eye button still reflects the flag; only the
  // lane wash is gated. Re-appears the moment a clip lands here again.
  const hasClips = track.clips.length > 0;
  // An audio lane is "inaudible" — and so gets a dimming wash — when
  // it is muted, or when some OTHER audio track is soloed. Mirrors the
  // playback gate in useAudioPlayback.
  const anySolo = useStore((s) =>
    side === 'audio' && s.audioTracks.some((t) => t.solo));
  const inaudible = hasClips && side === 'audio'
    && (track.muted || (anySolo && !track.solo));
  // A video lane is "invisible" — and gets the same dimming wash —
  // when the eye toggle is off. Mirrors the camera-routing gate in
  // useActiveClipRouter (skips !visible tracks when picking the
  // active scene camera). Clips stay editable; they just won't paint
  // the camera through to the C4D viewport.
  const invisible = hasClips && side === 'video' && !track.visible;

  // Trim drag state. Ref-based (memory: react-drag-state-in-ref) — a
  // re-render would reset let-vars and break drag mid-stream. Captures
  // the clip + edge + original frames at pointer-down; pointermove
  // computes the new edge frame and calls resizeClip with snap applied.
  const trimRef = useRef<{
    active: boolean;
    clipId: number;
    edge: 'left' | 'right';
    origInFrame: number;
    origOutFrame: number;
    startClientX: number;
    pxPerFrame: number;
    // Alt-retime intent, latched at pointer-down. When true, the commit
    // rescales the clip's camera keyframes around the non-moving edge so
    // the motion fills the new duration (vs. the default window-only trim
    // which leaves keys untouched). Latched at gesture start — not read
    // live — so releasing Alt just before mouseup doesn't silently drop
    // the retime the cursor promised while Alt was held.
    retime: boolean;
    objectId: number;   // referenced camera; 0 = no camera (orphan)
  } | null>(null);

  // Rolling-edit drag state. Two adjacent clips at a seam — leftClip's
  // outFrame == rightClip's inFrame. Pointermove computes the new seam
  // frame; rollEdit moves both edges simultaneously, clamped to keep
  // MIN_DURATION on each side.
  const rollRef = useRef<{
    active: boolean;
    leftClipId: number;
    rightClipId: number;
    origSeamFrame: number;
    startClientX: number;
    pxPerFrame: number;
  } | null>(null);

  const rollEdit = useStore((s) => s.rollEdit);

  function onPointerMove(ev: React.PointerEvent<HTMLDivElement>) {
    // While trimming or rolling, route to that handler — hover
    // detection pauses so the cursor doesn't switch modes mid-drag.
    if (trimRef.current && trimRef.current.active) {
      onTrimPointerMove(ev);
      return;
    }
    if (rollRef.current && rollRef.current.active) {
      onRollPointerMove(ev);
      return;
    }
    // Trim / roll edge-hover detection belongs to the SELECT tool only.
    // Skip it when:
    //  - the track is locked — no edits, so no trim/roll affordance.
    //  - the razor or slip tool is active — those tools own the seam
    //    with their own behavior (cut / slip); showing a trim or roll
    //    cursor there would promise an action the click doesn't do.
    //  - a slip drag or body drag is in progress — the dragged clip's
    //    edges sweep under the cursor and would flip the mode (and the
    //    cursor) every frame.
    const tool = useStore.getState().activeTool;
    if (track.locked
        || tool !== 'select'
        || useStore.getState().slipDragging
        || useStore.getState().dragClip) {
      if (cursorMode !== 'default') setCursorMode('default');
      return;
    }
    const rect = ev.currentTarget.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const pxPerFrame = rect.width / visibleSpan;
    if (pxPerFrame <= 0) return;

    // Sort by inFrame so "next" / "prev" really mean adjacent in
    // time (not adjacent in the unsorted clips array — drops happen
    // in any order, so the array is insertion-order, not time-order).
    const sorted = [...track.clips].sort((a, b) => a.inFrame - b.inFrame);
    const edges = new Set<string>();
    let mode: CursorMode = 'default';

    // First pass: is the cursor inside an "isolated" trim hit zone
    // (not overlapped with a neighbor's zone)? An isolated trim zone
    // is the right side of a clip whose right edge isn't shared with
    // a neighbor's left edge (or vice versa).
    for (let i = 0; i < sorted.length; i++) {
      const clip = sorted[i];
      const leftPx  = (clip.inFrame  - h.vMin) * pxPerFrame;
      const rightPx = (clip.outFrame - h.vMin) * pxPerFrame;
      const next = sorted[i + 1];
      const nextAdjacent = next && (next.inFrame - clip.outFrame) <= 1;

      // Per-clip edge hit zone, capped so left/right zones never
      // overlap by more than half the clip width. Floor of 6px keeps
      // handles grabbable even on very narrow clips (a 16px-wide clip
      // gets 6px edges + 4px body — body shrinks but doesn't
      // vanish). Diverges from Python sb_canvas.py:1342 which caps
      // at clip_width/3 with floor 1px — that minimum was unusable
      // in the React UI at v2's higher MIN_CLIP_FRAMES.
      const clipWidth = rightPx - leftPx;
      const edgeZone = clipEdgeZonePx(clipWidth);

      // SEAM CASE: if this clip's right edge meets the next clip's
      // left edge, treat the full overlap zone [rightPx - edgeZone,
      // rightPx + edgeZone] as a unit and split into thirds. This zone
      // straddles both clips so we have to detect it BEFORE the
      // individual right-trim / left-trim checks so neither one
      // claims part of it.
      if (nextAdjacent && x >= rightPx - edgeZone && x <= rightPx + edgeZone) {
        const seamStart = rightPx - edgeZone;
        const seamEnd   = rightPx + edgeZone;
        const t1 = seamStart + (seamEnd - seamStart) / 3;
        const t2 = seamStart + (seamEnd - seamStart) * 2 / 3;
        if (x < t1) {
          edges.add(clip.id + ':right');
          mode = 'trim';
        } else if (x < t2) {
          edges.add(clip.id + ':right');
          edges.add(next!.id + ':left');
          mode = 'roll';
        } else {
          edges.add(next!.id + ':left');
          mode = 'trim';
        }
        break;
      }

      // ISOLATED right-trim (no adjacent next clip).
      if (x >= rightPx - edgeZone && x <= rightPx) {
        edges.add(clip.id + ':right');
        mode = 'trim';
        break;
      }

      // ISOLATED left-trim (no adjacent prev clip; adjacent seams
      // were handled by the previous iteration's seam block).
      if (x >= leftPx && x <= leftPx + edgeZone) {
        const prev = sorted[i - 1];
        const prevAdjacent = prev && (clip.inFrame - prev.outFrame) <= 1;
        if (!prevAdjacent) {
          edges.add(clip.id + ':left');
          mode = 'trim';
          break;
        }
      }
    }

    setEdgeHover(edges);
    setCursorMode(mode);
  }
  function onPointerLeave() {
    setEdgeHover(new Set());
    setCursorMode('default');
  }
  function onPointerDown(ev: React.PointerEvent<HTMLDivElement>) {
    // A locked track accepts no trim / roll gesture (cursorMode is
    // already pinned to 'default' above, but guard the start too).
    if (track.locked) return;
    // Rolling-edit drag start. The seam case has edgeHover containing
    // BOTH clipA:right and clipB:left (set by the seam-third-detection
    // in onPointerMove above). We move both edges together; rollEdit
    // in the store clamps and updates the seam frame.
    if (cursorMode === 'roll' && ev.button === 0) {
      const state = useStore.getState();
      const edges = state.edgeHover;
      let leftClipId = -1;
      let rightClipId = -1;
      for (const key of edges) {
        const [idStr, side] = key.split(':');
        const cid = parseInt(idStr, 10);
        if (!track.clips.some((c) => c.id === cid)) continue;
        if (side === 'right') leftClipId  = cid;  // A's right edge → A is on the LEFT of the seam
        if (side === 'left')  rightClipId = cid;  // B's left edge → B is on the RIGHT of the seam
      }
      if (leftClipId >= 0 && rightClipId >= 0) {
        const leftClip  = track.clips.find((c) => c.id === leftClipId);
        const rightClip = track.clips.find((c) => c.id === rightClipId);
        if (leftClip && rightClip && leftClip.outFrame === rightClip.inFrame) {
          const rect = ev.currentTarget.getBoundingClientRect();
          const pxPerFrame = rect.width / visibleSpan;
          if (pxPerFrame > 0) {
            rollRef.current = {
              active: true,
              leftClipId,
              rightClipId,
              origSeamFrame: leftClip.outFrame,
              startClientX: ev.clientX,
              pxPerFrame,
            };
            try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch { /* noop */ }
            ev.preventDefault();
            ev.stopPropagation();
            return;
          }
        }
      }
    }
    // Trim-drag start. The current `edgeHover` set (already maintained
    // by onPointerMove above) tells us which clip + which edge the
    // cursor is on. The isolated-trim case has exactly one edge in
    // hover; the rolling-edit case (handled above) has two.
    if (cursorMode === 'trim' && ev.button === 0) {
      const state = useStore.getState();
      const edges = state.edgeHover;
      let clipId = -1;
      let edge: 'left' | 'right' | null = null;
      for (const key of edges) {
        const [idStr, side] = key.split(':');
        if (side === 'left' || side === 'right') {
          // Only start a trim if this edge belongs to a clip in OUR track.
          const cid = parseInt(idStr, 10);
          if (track.clips.some((c) => c.id === cid)) {
            clipId = cid;
            edge = side;
            break;
          }
        }
      }
      if (clipId >= 0 && edge) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          const rect = ev.currentTarget.getBoundingClientRect();
          const pxPerFrame = rect.width / visibleSpan;
          if (pxPerFrame > 0) {
            trimRef.current = {
              active: true,
              clipId,
              edge,
              origInFrame: clip.inFrame,
              origOutFrame: clip.outFrame,
              startClientX: ev.clientX,
              pxPerFrame,
              // Latch the retime intent: Alt+Ctrl at press = retime this
              // edit's keyframes (Alt alone is the keyframe marquee now).
              // Only meaningful on video clips with a camera; audio clips
              // carry no keyframes so retime is inert.
              retime: ev.altKey && ev.ctrlKey && side === 'video' && (clip.objectId ?? 0) > 0,
              objectId: clip.objectId ?? 0,
            };
            // Keep the retime cursor pinned for the whole drag (the latch
            // survives a mid-drag Alt release; the hover-derived flag would
            // drop it). Cleared in onTrimPointerEnd.
            setRetimeDragging(trimRef.current.retime);
            // Tell KeyframeTicks to preview the rescale live for this clip
            // (it holds dot fractions while the clip stretches). Cleared in
            // onTrimPointerEnd, after C++ has rescaled the real keys.
            if (trimRef.current.retime)
              useStore.getState().setRetimingClipId(clipId);
            try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch { /* noop */ }
            // Select the clip we're trimming (visual feedback during drag).
            setSelectedClip(clipId);
            ev.preventDefault();
            ev.stopPropagation();
            return;
          }
        }
      }
    }
    // Empty-area click + marquee selection are owned by useMarquee
    // on .lanes-area (the parent container). Lane's pointer-down only
    // needs to handle trim/roll start above this point.
  }

  function onTrimPointerMove(ev: React.PointerEvent<HTMLDivElement>) {
    const t = trimRef.current;
    if (!t || !t.active) return;
    const dxPx = ev.clientX - t.startClientX;
    const dxFrames = Math.round(dxPx / Math.max(0.0001, t.pxPerFrame));
    // Raw cursor-driven edge target frame, before snap. Clamped to
    // [0, docFrames] so the cursor going past the Inspector panel
    // (or off-screen left of frame 0) doesn't keep stretching the
    // trim past the document. Mirrors the body-drag upper-clamp.
    const docFrames = useStore.getState().docFrames;
    const rawWantUnclamped = t.edge === 'left'
      ? t.origInFrame + dxFrames
      : t.origOutFrame + dxFrames;
    const rawWant = Math.min(docFrames, Math.max(0, rawWantUnclamped));

    // Snap to edit points across the WHOLE timeline — every clip's
    // in/out on both sides (video + audio), all tracks — excluding the
    // clip being trimmed itself (self-snap). Global snapping, matching
    // body-drag and roll. Plus the playhead.
    const state = useStore.getState();
    const editPoints: number[] = [];
    for (const trk of [...state.videoTracks, ...state.audioTracks]) {
      for (const c of trk.clips) {
        if (c.id === t.clipId) continue;
        editPoints.push(c.inFrame, c.outFrame);
      }
    }
    editPoints.push(state.scrubFrame ?? state.currentFrame);
    // Beat positions are snap targets only when the beat grid is
    // visible (user-confirmed UX: invisible lines shouldn't snap).
    if (state.beatGridVisible) {
      for (const f of audioPeakDocFrames(state)) editPoints.push(f);
    }
    if (state.markersVisible) {
      for (const f of state.markers) editPoints.push(f);
    }
    // Snap gating (Premiere model): active when the Snap toggle is on
    // OR Shift is held — Shift force-enables snap for this trim even
    // with the toggle off. snapFrames=0 short-circuits magneticSnap.
    const snapActive = state.snapEnabled || ev.shiftKey;
    const snapFrames = snapActive ? Math.max(1, SNAP_PIXEL_RADIUS / t.pxPerFrame) : 0;
    // For a single-edge snap, snap the edge's want-frame directly to
    // the nearest edit point; treat duration as 0 so magneticSnap
    // doesn't try to also snap the OTHER edge.
    const snap = magneticSnap(rawWant, 0, editPoints, snapFrames);
    setSnapIndicatorFrames(snap.targets);
    // Cmd/Ctrl held during trim → ripple mode (push same-track
    // neighbors aside instead of overwriting them). Live: tapping the
    // modifier mid-drag toggles the mode, mirroring Premiere/Resolve.
    // EXCEPT during a retime (Alt+Ctrl latched): Ctrl is part of the
    // retime combo there, not a ripple request — force replace so the
    // two gestures don't conflate.
    const mode = (!t.retime && (ev.ctrlKey || ev.metaKey)) ? 'ripple' : 'replace';
    resizeClip(t.clipId, trackId, t.edge, snap.inFrame, mode);
  }

  function onTrimPointerEnd(ev: React.PointerEvent<HTMLDivElement>) {
    const t = trimRef.current;
    if (!t || !t.active) return;
    t.active = false;
    trimRef.current = null;
    setSnapIndicatorFrames([]);
    setRetimeDragging(false);
    try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch { /* noop */ }

    // Alt-retime commit: rescale the trimmed clip's camera keyframes so the
    // motion fills the clip's NEW duration. Read the FINAL clip from the
    // store (resizeClip clamped + overlap-resolved during the drag) so the
    // duration is the real one. The anchor is the edge that did NOT move —
    // an out-edge drag pins the in-point; an in-edge drag pins the out-
    // point. flushKeyframeRetimes fires an immediate save so C++ rescales
    // the keys in the SAME undo block as the clip in/out write (one Ctrl+Z).
    //
    // The live-preview handoff: when a real rescale WILL be sent, the
    // rescaled-keys `cameras` echo clears retimingClipId (seamless — see
    // setCameraStatuses). In every NON-rescale path (not retiming, no clip,
    // no-op duration, or a shared camera C++ will skip) no echo comes, so
    // we must clear the preview here or the dots stay frozen.
    const clearPreviewNow = () => useStore.getState().setRetimingClipId(null);
    if (!t.retime || t.objectId <= 0) { clearPreviewNow(); return; }
    const st = useStore.getState();
    let finalClip: Clip | undefined;
    for (const trk of st.videoTracks) {
      const c = trk.clips.find((cl) => cl.id === t.clipId);
      if (c) { finalClip = c; break; }
    }
    if (!finalClip) { clearPreviewNow(); return; }
    const oldDur = t.origOutFrame - t.origInFrame;
    const newDur = finalClip.outFrame - finalClip.inFrame;
    if (oldDur <= 0 || newDur <= 0 || oldDur === newDur) { clearPreviewNow(); return; }
    // Anchor = the non-moving edge, in DOCUMENT frames. The dragged edge's
    // frame changed; the other one is unchanged from the original.
    const anchorFrame = t.edge === 'right' ? t.origInFrame : t.origOutFrame;
    // refCount across ALL video clips — a camera shared by two clips is
    // skipped by C++ (rescaling would warp the other clip's animation).
    let refCount = 0;
    for (const trk of st.videoTracks)
      for (const c of trk.clips)
        if (c.objectId === t.objectId) refCount++;
    // Shared camera → C++ skips the rescale → no keys-changed echo will
    // arrive to hand off the preview, so clear it now (the unmoved keys
    // against the new window are the truthful display).
    if (refCount > 1) clearPreviewNow();
    flushKeyframeRetimes([{ objectId: t.objectId, anchorFrame, oldDur, newDur, refCount }]);
  }

  function onRollPointerMove(ev: React.PointerEvent<HTMLDivElement>) {
    const r = rollRef.current;
    if (!r || !r.active) return;
    const dxPx = ev.clientX - r.startClientX;
    const dxFrames = Math.round(dxPx / Math.max(0.0001, r.pxPerFrame));
    // Clamp the seam frame to [0, docFrames] so the cursor going past
    // the Inspector (or off-screen left) doesn't keep stretching the
    // roll past the document. Mirrors the body-drag and trim-drag
    // upper clamps.
    const docFrames = useStore.getState().docFrames;
    const rawSeam = Math.min(docFrames, Math.max(0, r.origSeamFrame + dxFrames));

    // Snap the seam to edit points across the WHOLE timeline — every
    // clip's in/out on BOTH sides (video + audio), plus the playhead.
    // Exclude BOTH seam clips since they move together (self-snap).
    //
    // Why both sides, not just this side: a roll between the only two
    // clips on a track excludes both of them, leaving nothing on that
    // side to catch on. The user expects the seam to still snap to
    // clip edges elsewhere (e.g. the video clips above an audio roll).
    const state = useStore.getState();
    const editPoints: number[] = [];
    for (const trk of [...state.videoTracks, ...state.audioTracks]) {
      for (const c of trk.clips) {
        if (c.id === r.leftClipId || c.id === r.rightClipId) continue;
        editPoints.push(c.inFrame, c.outFrame);
      }
    }
    editPoints.push(state.scrubFrame ?? state.currentFrame);
    if (state.beatGridVisible) {
      for (const f of audioPeakDocFrames(state)) editPoints.push(f);
    }
    if (state.markersVisible) {
      for (const f of state.markers) editPoints.push(f);
    }
    // Same gating as trim (Premiere model) — snap active when the Snap
    // toggle is on OR Shift is held. Roll has no ripple mode.
    const snapActive = state.snapEnabled || ev.shiftKey;
    const snapFrames = snapActive ? Math.max(1, SNAP_PIXEL_RADIUS / r.pxPerFrame) : 0;
    const snap = magneticSnap(rawSeam, 0, editPoints, snapFrames);
    setSnapIndicatorFrames(snap.targets);
    rollEdit(r.leftClipId, r.rightClipId, trackId, snap.inFrame);
  }

  function onRollPointerEnd(ev: React.PointerEvent<HTMLDivElement>) {
    const r = rollRef.current;
    if (!r || !r.active) return;
    r.active = false;
    rollRef.current = null;
    setSnapIndicatorFrames([]);
    try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
  }

  // Mirror roll-edit hover into the store so useToolCursor (global)
  // can force the roll cursor through the C++ host — needed for the
  // post-drag stale-cursor case. Only the seam-owning lane is ever
  // 'roll'; off-seam lanes are 'default' and set false (idempotent).
  useEffect(() => {
    if (cursorMode === 'roll') {
      useStore.getState().setRollEditActive(true);
      return () => useStore.getState().setRollEditActive(false);
    }
  }, [cursorMode]);

  // Same mirror for the Alt-retime cursor — useToolCursor forces it
  // through the C++ host so it survives the drag (a CSS cursor alone
  // loses to C4D's WM_SETCURSOR mid-drag, same as roll).
  useEffect(() => {
    if (retimeActive) {
      useStore.getState().setRetimeHoverActive(true);
      return () => useStore.getState().setRetimeHoverActive(false);
    }
  }, [retimeActive]);

  // Cursor: ew-resize for single-edge trim; the custom roll-edit
  // cursor (data-URI, matching the C++ roll.cur) for a rolling edit.
  const ROLL_CURSOR =
    'url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAACOElEQVR4nO1WPYsTURQ99zIzJOTDLFgEkigGEdRSsp1r7MQ+/gOxEFH8wiosg1VSKrNotcoWrm4KswpW/oWgEtDOHyA2CQlxlXFPfCNhcSZ+TARlDgzz4M7cc9575973gAQJEvyDEAA3AXT5FpFgfKPRaMjC2dPpdJ6Eg8FgxxDPjnMLFwCgQjLf9/1AQDBW1fIiiQ8CyKrqgQgB/CYDIFYhWQBXyuXyCwBrqnooTAAAxu7zWxG5ZP79Iyw7jrPuuu6b0Wj0mSSWZZ0IEyAi09hkMvnSbDZfAXgI4OTvEO8HcKtWq73s9/sffQNDeCpiBb7HiF6v94E5WCEAluayfssznfWjdrvd50z8GQSEEQK6swII5vA87102m90QkeVIAblczt6d/d1Op/PejxnMCeBOoVCwQgXYts0av53JZJ57nvc2rhVotVp9x3G2RcSN7BX5fN4WkdN0O4Bt7h/3cY+ArQgBW7MC6B/jAcbWTG57nhVsVT0K4JqIbFIIHc2ZGKefixAwjY3H4x3XdV87jvMMwBOakDmLxeJc8inq9bpYlrVPRM7QE0xaKpXYBx6r6kpEI2IVbJqe8ZR7LiJnU6nUkjlDfhlcjSMALpuaXg1q/UcCGBOR1d2G9ADARVU9XK1Ww033kxCaU0SOsR3P64SqyrPiuDFb/Kej6ffd4XD4KRAQjE1s4aiYJe7uedbjPoTCwKW9AOAegOsArooIx+f/1n2AFcKGVeGbD/fdNLHF34gSJPjv8BWapcIsthuGngAAAABJRU5ErkJggg==") 16 16, col-resize';
  // Alt-retime cursor — Mike's double-chevron stretch glyph with a clock
  // ("stretch time"), distinct from the plain trim ew-resize. Matches the
  // C++ retime.cur (the drag-survival layer); this CSS form covers hover.
  // Both regenerate from <repo>/Cursors/Retime tool.png via
  // web/public/cursors/_make_retime_cur.py.
  const RETIME_CURSOR =
    'url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAEZUlEQVR4nO1VbUhbVxh+zvXcm3tzb6Imfi1zBONk0lJkZIGOFSm1pYLd3Cb+GaOwD3/4AeqcsKGi/6SMjY39b7t13a+p07EynPuxDmHCzKww8QthEle7rSmkicYmN2e82Y0E6/zofo35wMkN9/14nvO+7zkXOMIRjvAfALPWo8b+K+Sks7B0HukfCHYTKGW92y3uQJAsYg7A2EUYI7vlsy02G/39/ZkchxaRYwWeAnBLluU/ALxm2bgkSaBlCXOmA3L+Lpa1ngTwFYCfANRZvrSRA4FbATWqqt4fGhoSc3NzQlGUMIA8y1YL4Etd1/90Op33ANwE0CqEkCz75319feLGjRuisLAwDuBFSyA/DHmEyIUQD0ZHR03O+XplZaUbwDtlZWXiypUrIhQKiXA4LMbHx8W5c+cEgJGuri4dwFh3d7cphIgHg8GUx+NJAHhlPxE5VtmzyZNDQ0MpVVWFLMvvKYrSSOSrq6tmKBRKNDU1pYQQtIjsQUNDA4m4ZLfb3wCw0dPTk84xMzOTKi0tTQJ41drgQ/MiETnn/BSRj4yMZMgFkQMYzc/PPwHg2+vXrxNhcmxsTFRVVYl4PC42NzfJP7W+vm4ahnGPc/6sLMuXAGz29vaSzVxYWEj5fD7K1WGJ2J5eRuRer1flnP8yPDxMAYlr164Ju91O/RvOy8urAlCi6/rd27dvC9M0UxMTE+Ls2bNiB1KnT58mkpcCgYBbluWPAPze2dmZ3tDy8rLw+XwmgKczp0PKqLhz506hJElPHDt2LEWG6elpbGxs3He73R9HIpFbAPIZY3bOefoE0JqcnERrayva2towPz+fzqPrOgkoCgaDdysqKt4HsDo1NYVYLMbKyspMl8tFnMctAWz7p7i4uAjA1+Xl5WJpaYl6anZ0dFCy72pra50ul+txxtjq+Ph4uudra2uCJr2lpUU0NzeL2dlZEYvFRElJCcW8IMsypf2QhjMajZrxeNysq6sj24rT6XwmU31kD6GiKM8D+JlELC4upkW0t7dT0ITf7y8A8FlNTU26RTtrTyUeGBgg3wWPx/MUgE8uXLhAM2JubW2Z9B/Ab4qitANw7CaAoGqa1kAiaGAsEQmqBGNs1DCMegDr9fX1Ynl5OZVIJNKnIBwOpwYHBwXnfEtRlLcYY4Pkk0wmE5FIxDx//jyR/6ppWicAOsq7gllPW7aIlZWVZDQaTaqqSgN5gnP+NiVzOBypM2fOCNqZx+MhgnuMscsFBQUVAL65evWqGYlEEtXV1WRb0jStFYBrB9dDYDsr4fV6RSAQENa1+pjD4XCrqnoRwKcAfgDwI92KnPN3FUWpbGxspDP+QW5urigqKkq3xGazvZ65sg/yhWQZEYqivGzd6d9LkvQmvSOD3++XVVX1OhyOk4ZhPGcYRqXb7c7u60kAlwF8Icvyxb16vh8UXdePO53OAH0HDpAkY8vRNK3UZrOVA9D2imP7StifLBtiD1/xqALYAQj2ijtMzBGO8D/EXxG08Upgz8snAAAAAElFTkSuQmCC") 16 16, ew-resize';
  const cursor = retimeActive ? RETIME_CURSOR
              : cursorMode === 'trim' ? 'ew-resize'
              : cursorMode === 'roll' ? ROLL_CURSOR
              : undefined;

  return (
    <div
      ref={laneRef}
      className="lane"
      data-track={trackId}
      data-side={side}
      style={cursor ? { cursor } : undefined}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onPointerDown={onPointerDown}
      onPointerUp={(ev) => { onTrimPointerEnd(ev); onRollPointerEnd(ev); }}
      onPointerCancel={(ev) => { onTrimPointerEnd(ev); onRollPointerEnd(ev); }}
    >
      {track.clips.map((clip) => {
        const lanePctLeft  = ((clip.inFrame  - h.vMin) / visibleSpan) * 100;
        const lanePctRight = ((clip.outFrame - h.vMin) / visibleSpan) * 100;
        const widthPx = laneWidth > 0
          ? ((clip.outFrame - clip.inFrame) / visibleSpan) * laneWidth
          : 0;
        return (
          <ShotBlock
            key={clip.id}
            clip={clip}
            side={side}
            trackId={trackId}
            thin={thin}
            widthPx={widthPx}
            style={{
              left:  lanePctLeft + '%',
              right: (100 - lanePctRight) + '%',
            }}
          />
        );
      })}
      {hasClips && track.locked && <div className="lane__locked-overlay" />}
      {inaudible && <div className="lane__silenced-overlay" />}
      {invisible && <div className="lane__invisible-overlay" />}
    </div>
  );
}
