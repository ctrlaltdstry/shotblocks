import { useEffect, useRef } from 'react';
import './icons.css';
import './icons-block.css';
import './App.css';
import logoUrl from './icons/logo.svg';
import { useHost } from './useHost';
import { useOmDrop } from './useOmDrop';
import { useFileDrop } from './useFileDrop';
import { useAudioPlayback } from './useAudioPlayback';
import { send } from './lib/host';
import { useActiveClipRouter } from './useActiveClipRouter';
import { usePersistence } from './usePersistence';
import { runBeatDetection } from './lib/beatDetection';
import { useKeyboard } from './useKeyboard';
import { useAltRightZoom } from './useAltRightZoom';
import { useMmbPan } from './useMmbPan';
import { useToolCursor } from './useToolCursor';
import { useStore, NATURAL_TRACK_PX, MIN_TRACK_PX } from './store';
import { Ruler } from './components/Ruler';
import { Playhead } from './components/Playhead';
import { Scrollbar } from './components/Scrollbar';
import { VaSplitter } from './components/VaSplitter';
import { TrackHeader } from './components/TrackHeader';
import { Lane } from './components/Lane';
import { ToolPalette } from './components/ToolPalette';
import { DropGhost } from './components/DropGhost';
import { MarqueeOverlay } from './components/MarqueeOverlay';
import { CutLineOverlay } from './components/CutLineOverlay';
import { SnapIndicators } from './components/SnapIndicators';
import { BeatGrid } from './components/BeatGrid';
import { ContextMenu } from './components/ContextMenu';
import { RangeDim } from './components/RangeDim';
import { SpawnGhostLane } from './components/SpawnGhostLane';
import { Inspector } from './components/Inspector';
import { Meter } from './components/Meter';
import { useMarquee } from './useMarquee';
import { DebugOverlay } from './DebugOverlay';
import { useElementSize } from './useElementSize';

// Round 1 of the React port: layout grid + static chrome only.
// No live state, no interactions yet. Visual parity with the legacy
// empty-state UI is the goal of this round.
//
// Subsequent rounds will:
//   2. wire the C++ bridge + ruler + playhead + timecode (live data)
//   3. scrollbars (h-time, v-video, v-audio)
//   4. V/A splitter
//   5. tracks + shot blocks + OM drop pipeline
//   6. GSAP Draggable + Inertia for clip drag

function pad2(n: number): string { return (n < 10 ? '0' : '') + n; }
function formatTimecode(frame: number, fps: number): string {
  if (!fps || fps <= 0) return '00:00:00:00';
  const f = Math.max(0, frame | 0);
  const ff = f % fps;
  const ts = Math.floor(f / fps);
  const ss = ts % 60;
  const mm = Math.floor(ts / 60) % 60;
  const hh = Math.floor(ts / 3600);
  return pad2(hh) + ':' + pad2(mm) + ':' + pad2(ss) + ':' + pad2(ff);
}

function Timecode() {
  const frame = useStore((s) => s.currentFrame);
  const fps = useStore((s) => s.fps);
  return <div className="topbar__timecode">{formatTimecode(frame, fps)}</div>;
}

/** Loop toggle in the utilities strip. Drives C4D's loop preview
 *  mode via JS→C++ 'set-loop'. Grey when off, primary-highlight
 *  blue when on. Matches the standard utilities-strip styling. */
function LoopToggle() {
  const on = useStore((s) => s.loopEnabled);
  return (
    <div
      className={'utilstrip__icon' + (on ? ' is-active' : '')}
      title={on ? 'Loop: on' : 'Loop: off'}
      onClick={() => {
        const next = !useStore.getState().loopEnabled;
        useStore.getState().setLoopEnabled(next);
        // Fire-and-forget; C++ will EVMSG_CHANGE → state-changed →
        // doc-info round-trip if anything else cares.
        void send({ kind: 'set-loop', enabled: next });
      }}
    >
      <span className="icon icon--loop" style={{ '--icon-w': '16px', '--icon-h': '16px' } as React.CSSProperties} />
    </div>
  );
}

/** Snap toggle in the utilities strip. Magnetic snap during clip
 *  body/trim/roll drags is gated on this flag. Default OFF, mirroring
 *  Python's `_snap_enabled = False` (sb_canvas.py:420). Holding Shift
 *  during a drag force-enables snap even when this toggle is off
 *  (Premiere model); Cmd/Ctrl during a drag is ripple mode. */
function SnapToggle() {
  const on = useStore((s) => s.snapEnabled);
  return (
    <div
      className={'utilstrip__icon' + (on ? ' is-active' : '')}
      title={on ? 'Snap: on' : 'Snap: off'}
      onClick={() => useStore.getState().setSnapEnabled(!useStore.getState().snapEnabled)}
    >
      <span className="icon icon--snap" style={{ '--icon-w': '14px', '--icon-h': '14px' } as React.CSSProperties} />
    </div>
  );
}

/** Beat Detection button in the utilities strip. Mirrors Final Cut
 *  Pro's "Enable/Disable Beat Detection" toggle:
 *    - First click → analyses every audio clip + shows the grid.
 *    - Later clicks → toggle the green grid on/off. The analysis
 *      result is kept, so re-enabling is instant (no re-analyse).
 *  `is-active` reflects whether the grid is currently shown. */
function BeatDetectionButton() {
  const busy = useStore((s) => s.detectingBeats);
  const gridVisible = useStore((s) => s.beatGridVisible);
  // Has detection ever produced peaks? (cheap scan)
  const hasPeaks = useStore((s) =>
    s.audioTracks.some((t) => t.clips.some((c) => c.audioPeaks && c.audioPeaks.length)));
  const active = gridVisible && hasPeaks;
  return (
    <div
      className={'utilstrip__icon' + ((active || busy) ? ' is-active' : '')}
      title={
        busy ? 'Detecting beats…'
          : active ? 'Beat Detection: on'
          : hasPeaks ? 'Beat Detection: off'
          : 'Beat Detection'
      }
      onClick={() => {
        if (busy) return;
        if (!hasPeaks) {
          // Never analysed — run detection (it shows the grid on done).
          void runBeatDetection();
        } else {
          // Already have results — just toggle the grid visibility.
          useStore.getState().setBeatGridVisible(!gridVisible);
        }
      }}
    >
      <span className="icon icon--beat-detection" style={{ '--icon-w': '13px', '--icon-h': '13px' } as React.CSSProperties} />
    </div>
  );
}

/** Inspector toggle — the utilities-strip gear icon. Opens / closes
 *  the right-side Inspector panel. (Gear icon kept for now; a custom
 *  icon comes later.) */
function InspectorToggle() {
  const open = useStore((s) => s.inspectorOpen);
  return (
    <div
      className={'utilstrip__icon' + (open ? ' is-active' : '')}
      title="Inspector"
      onClick={() => useStore.getState().setInspectorOpen(!useStore.getState().inspectorOpen)}
    >
      <span className="icon icon--settings" style={{ '--icon-w': '15px', '--icon-h': '15px' } as React.CSSProperties} />
    </div>
  );
}

/** Audio-scrub toggle. Sits below the dB meter in the left rail.
 *  Same visual treatment as the top utilities strip (grey-24 when
 *  off, primary-highlight blue when on, grey-50 on hover). */
function AudioScrubToggle() {
  const on = useStore((s) => s.audioScrub);
  const set = useStore((s) => s.setAudioScrub);
  return (
    <div
      className={'rail__scrub-toggle utilstrip__icon' + (on ? ' is-active' : '')}
      title={on ? 'Audio scrub: on' : 'Audio scrub: off'}
      onClick={() => set(!on)}
    >
      <span className="icon icon--audio-scrub" style={{ '--icon-w': '14px', '--icon-h': '16px' } as React.CSSProperties} />
    </div>
  );
}

/** Bottom horizontal scrollbar — pans/zooms the visible time window. */
/** Horizontal scrollbar — overlay on the stage's bottom edge. Renders
 *  ONLY while the timeline is zoomed in (the visible window is a
 *  strict subset of the full range); at full zoom-out there's nothing
 *  to pan, so no scrollbar shows. */
function HScroll() {
  const h = useStore((s) => s.h);
  const setHVisible = useStore((s) => s.setHVisible);
  const zoomedIn = h.vMin > h.min || h.vMax < h.max;
  if (!zoomedIn) return null;
  return (
    <div className="h-scroll">
      <Scrollbar axis="x" window={h} minSpan={4} onChange={setHVisible} />
    </div>
  );
}

/** Vertical scrollbar for one side of the V/A split. Both dots are
 *  the actual edges of the visible window — drag them together to
 *  zoom in, apart to zoom out. The lane content stays anchored at the
 *  V/A divider via the .stack__videos / .stack__audios flex rules. */
/** Vertical scrollbar for one side of the V/A split — overlay on the
 *  stage's right edge. Renders ONLY when that side's tracks overflow
 *  the visible region (real pan distance exists). A zoomed-but-still-
 *  fitting view has nowhere to pan, so no scrollbar shows. Pan-only —
 *  vertical zoom is Alt+RMB drag. */
function VScroll({ which, overflows }: { which: 'video' | 'audio'; overflows: boolean }) {
  const win = useStore((s) => which === 'video' ? s.vVideo : s.vAudio);
  const setter = useStore((s) => which === 'video' ? s.setVVideoVisible : s.setVAudioVisible);
  if (!overflows) return null;
  return (
    <div className={'v-scroll v-scroll--' + which}>
      <Scrollbar
        axis="y"
        window={win}
        minSpan={0.1}
        onChange={setter}
        // Video stack is bottom-up (V1 bottom, V<max> top), so the
        // scrollbar reads naturally only inverted: thumb-at-top maps
        // to V<max> being visible.
        invert={which === 'video'}
      />
    </div>
  );
}

/** Drives per-side track-height + scroll-offset CSS vars from each
 *  vertical scrollbar window.
 *
 *  Range model: max = 2 × trackCount, with the default visible window
 *  centered at span = trackCount. That gives the user equal headroom
 *  on both sides of the default — they can zoom IN (drag dots toward
 *  each other) or OUT (drag dots apart) from the natural state.
 *
 *  trackHeight = NATURAL_TRACK_PX × trackCount / span.
 *    span = trackCount  → natural 65px tracks (default).
 *    span < trackCount  → zoomed in (taller tracks, overflow scrolls).
 *    span > trackCount  → zoomed out (shorter tracks; sub-32px flips
 *                          to the thin shot-block layout).
 *
 *  Scroll: vMin within the available scroll range maps to a translate
 *  on the lane content. Lane stays anchored at the V/A divider via
 *  the flex layout; the translate moves what's visible inside the
 *  side region. */
function useVerticalZoomVars(
  videosRegionRef: React.RefObject<HTMLDivElement | null>,
  audiosRegionRef: React.RefObject<HTMLDivElement | null>,
) {
  const vVideo = useStore((s) => s.vVideo);
  const vAudio = useStore((s) => s.vAudio);
  const videoTrackCount = useStore((s) => s.videoTracks.length);
  const audioTrackCount = useStore((s) => s.audioTracks.length);
  const vSize = useElementSize(videosRegionRef);
  const aSize = useElementSize(audiosRegionRef);

  // Video side is FIXED-HEIGHT — lanes always render at NATURAL_TRACK_PX
  // and never respond to vertical zoom (camera-sequencing tracks are
  // typically 1-3 deep; a fixed height keeps the future twirl-down
  // sub-tracks predictable). The vVideo window is pan-only: span =
  // how many 65px lanes fit, vMin = pan position. Only --video-scroll-y
  // varies; --video-track-h is the constant NATURAL_TRACK_PX.
  useEffect(() => {
    if (vSize.height < 1) return;
    const trackCount = Math.max(1, videoTrackCount);
    const trackPx = NATURAL_TRACK_PX;
    // contentH includes the spawn-buffer spacer (one extra track).
    const contentH = trackPx * (trackCount + 1);
    const overflow = Math.max(0, contentH - vSize.height);
    const span = Math.max(0.01, vVideo.vMax - vVideo.vMin);
    const scrollRange = Math.max(0.0001, (vVideo.max - vVideo.min) - span);
    const scrollFrac = scrollRange > 0 ? Math.max(0, vVideo.vMin - vVideo.min) / scrollRange : 0;
    const scrollY = scrollFrac * overflow;
    document.documentElement.style.setProperty('--video-track-h', trackPx + 'px');
    document.documentElement.style.setProperty('--video-scroll-y', scrollY + 'px');
  }, [vVideo.vMin, vVideo.vMax, vVideo.min, vVideo.max, vSize.height, videoTrackCount]);

  useEffect(() => {
    if (aSize.height < 1) return;
    const span = Math.max(0.01, vAudio.vMax - vAudio.vMin);
    const trackCount = Math.max(1, audioTrackCount);
    const trackPx = Math.max(MIN_TRACK_PX, NATURAL_TRACK_PX * trackCount / span);
    const contentH = trackPx * (trackCount + 1);
    const overflow = Math.max(0, contentH - aSize.height);
    const scrollRange = Math.max(0.0001, (vAudio.max - vAudio.min) - span);
    const scrollFrac = scrollRange > 0 ? Math.max(0, vAudio.vMin - vAudio.min) / scrollRange : 0;
    const scrollY = -scrollFrac * overflow;
    document.documentElement.style.setProperty('--audio-track-h', trackPx + 'px');
    document.documentElement.style.setProperty('--audio-scroll-y', scrollY + 'px');
  }, [vAudio.vMin, vAudio.vMax, vAudio.min, vAudio.max, aSize.height, audioTrackCount]);
}

/** Headers column — video on top (rendered reversed: Vn..V1), audio
 *  below, V/A splitter between. Driven entirely by store. */
function HeadersColumn({
  stackRef,
  videosRef,
}: {
  stackRef: React.RefObject<HTMLDivElement | null>;
  videosRef: React.RefObject<HTMLDivElement | null>;
}) {
  const videoTracks = useStore((s) => s.videoTracks);
  const audioTracks = useStore((s) => s.audioTracks);
  const videosOrdered = [...videoTracks].reverse();
  return (
    <div className="headers">
      <div className="stack" ref={stackRef}>
        <div className="stack__videos" id="headers-videos" ref={videosRef}>
          {/* Spacer matches the lanes-side spawn buffer so the two
              stacks stay 1:1 aligned at all zoom/scroll positions. */}
          <div className="lane-spacer" data-side="video" />
          {videosOrdered.map((t) => (
            <TrackHeader key={t.id} track={t} side="video" />
          ))}
        </div>
        <VaSplitter />
        <div className="stack__audios" id="headers-audios">
          {audioTracks.map((t) => (
            <TrackHeader key={t.id} track={t} side="audio" />
          ))}
          <div className="lane-spacer" data-side="audio" />
        </div>
      </div>
      <HeadersResizeHandle />
    </div>
  );
}

/** Drag handle on the headers / timeline seam — widens or narrows the
 *  track-headers column. Clamped in the store to [HEADERS_MIN_W,
 *  HEADERS_MAX_W]. A thin invisible strip; the col-resize cursor is
 *  the affordance. */
function HeadersResizeHandle() {
  const drag = useRef<{ startX: number; startW: number } | null>(null);
  function onPointerDown(ev: React.PointerEvent<HTMLDivElement>) {
    if (ev.button !== 0) return;
    drag.current = {
      startX: ev.clientX,
      startW: useStore.getState().headersWidth,
    };
    ev.currentTarget.setPointerCapture(ev.pointerId);
    // Suppress the body's grid-column transition for the duration of
    // the drag — otherwise every setHeadersWidth animates 160ms and
    // the column lags choppily behind the cursor.
    document.body.classList.add('is-resizing-headers');
    ev.preventDefault();
    ev.stopPropagation();
  }
  function onPointerMove(ev: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    useStore.getState().setHeadersWidth(d.startW + (ev.clientX - d.startX));
  }
  function onPointerEnd(ev: React.PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    drag.current = null;
    document.body.classList.remove('is-resizing-headers');
    try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
  }
  return (
    <div
      className="headers__resize"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    />
  );
}

/** Lanes stack — same structure as the headers, but renders lanes
 *  with their clips. */
function LanesStack({
  stackRef,
  videosRef,
  audiosRef,
}: {
  stackRef: React.RefObject<HTMLDivElement | null>;
  videosRef: React.RefObject<HTMLDivElement | null>;
  audiosRef: React.RefObject<HTMLDivElement | null>;
}) {
  const videoTracks = useStore((s) => s.videoTracks);
  const audioTracks = useStore((s) => s.audioTracks);
  const videosOrdered = [...videoTracks].reverse();
  return (
    <div className="stack" ref={stackRef}>
      <div className="stack__videos" id="lanes-videos" ref={videosRef}>
        {/* Empty slot above V<max> so the user always has somewhere
            to drop a clip for spawn, even when the lanes already
            fill the visible area. Resolves to no lane on hit-test;
            useClipDrag.resolveLane's "above the stack" branch picks
            up the cursor there and returns a spawn target. */}
        <div className="lane-spacer" data-side="video" />
        {videosOrdered.map((t) => (
          <Lane key={t.id} track={t} side="video" />
        ))}
      </div>
      <VaSplitter />
      <div className="stack__audios" id="lanes-audios" ref={audiosRef}>
        {audioTracks.map((t) => (
          <Lane key={t.id} track={t} side="audio" />
        ))}
        {/* Spawn slot below A<max>. */}
        <div className="lane-spacer" data-side="audio" />
      </div>
    </div>
  );
}

/** Keeps the vertical scrollbar ranges in sync with track counts.
 *  Range = 2× track count so the centered default window leaves equal
 *  headroom to zoom OUT on both sides. Preserves user zoom unless the
 *  view is at the default centered span. */
/** Returns the adaptive `max` value for a v-window so the scrollbar
 *  ends sit at the natural extremes of the track at max zoom-out.
 *
 *  Two regimes:
 *   - Content fits in visible region at MIN_TRACK_PX → no need for
 *     pan headroom. max = maxSpan = NATURAL/MIN * count. At max
 *     zoom-out, span == max → thumb spans the entire track.
 *   - Content overflows at MIN_TRACK_PX → reserve pan headroom in
 *     track-units. max = maxSpan + (overflow / MIN_TRACK_PX). At
 *     max zoom-out, thumb fills span/max < 1 portion of the track,
 *     and vMin can slide through the remaining headroom.
 */
function computeVMax(trackCount: number, visibleHeight: number): number {
  const n = Math.max(1, trackCount);
  const maxSpan = NATURAL_TRACK_PX * n / MIN_TRACK_PX;
  if (visibleHeight <= 0) return maxSpan;
  // contentH includes the spawn-buffer spacer.
  const contentH = (n + 1) * MIN_TRACK_PX;
  const overflow = Math.max(0, contentH - visibleHeight);
  const panHeadroom = overflow / MIN_TRACK_PX;
  return maxSpan + panHeadroom;
}

/** Video side is fixed-height + pan-only. Its v-window is measured in
 *  fixed 65px track-units: max = trackCount + 1 (the spawn-buffer
 *  spacer), span = how many 65px lanes fit in the visible region. No
 *  zoom — span is derived purely from the visible height. */
function videoVSpan(visibleHeight: number): number {
  if (visibleHeight <= 0) return 1;
  return visibleHeight / NATURAL_TRACK_PX;
}

/** True when one side's tracks overflow its visible region — i.e.
 *  there is real distance to pan. The v-scrollbar is gated on this: a
 *  view with nowhere to pan shows no scrollbar.
 *
 *  Video: fixed 65px lanes — overflow is just (count+1)*65 vs height.
 *  Audio: zoomable — height depends on the current zoom span. */
function sideOverflows(
  win: { vMin: number; vMax: number },
  trackCount: number,
  visibleHeight: number,
  side: 'video' | 'audio',
): boolean {
  if (visibleHeight < 1) return false;
  const n = Math.max(1, trackCount);
  const trackPx = side === 'video'
    ? NATURAL_TRACK_PX
    : Math.max(MIN_TRACK_PX,
        NATURAL_TRACK_PX * n / Math.max(0.01, win.vMax - win.vMin));
  const contentH = trackPx * (n + 1);   // +1 = spawn-buffer spacer
  return contentH - visibleHeight > 0.5;
}

function useTrackCountSync(videoStackH: number, audioStackH: number) {
  const videoTracks = useStore((s) => s.videoTracks);
  const audioTracks = useStore((s) => s.audioTracks);
  // Remember the previous video/audio counts across renders so we
  // can tell whether the effect fired because of a count change
  // (reproportion + pin) or a visible-height change (just clamp).
  const prevVideoCount = useRef(videoTracks.length);
  const prevAudioCount = useRef(audioTracks.length);

  // On track-count change, scale the v-window so the user-perceived
  // ZOOM RATIO stays constant: zoom ratio = span / trackCount =
  // (vMax - vMin) / (max / 2). Without this, adding a track to a
  // user-zoomed-in view would visually shrink (or balloon) every
  // existing track because the same span now represents a different
  // fraction of the new total. Reset-to-default would be heavy-handed
  // every spawn.
  //
  // Direction policy on a track ADD: pin the visible window to the
  // OUTERMOST end of the new range so the freshly-spawned track and
  // its spawn-buffer are both in view. For video (bottom-up pile,
  // V<max> at top), that's pin-to-top: vMax = newMax. For audio
  // (top-down pile, A<max> at bottom), pin-to-bottom: vMax = newMax
  // too — same end of the range, but visually the "outer" end.
  // On a track REMOVE, keep the user's current position centered
  // proportionally rather than snapping anywhere.
  // Video side is fixed-height + pan-only (no zoom). The window's max
  // is just trackCount + 1 (spawn buffer); its span is derived from
  // the visible height (how many fixed 65px lanes fit). On a track
  // ADD, pin to the outer (top) end so the new track + spawn buffer
  // land in view. Otherwise keep the current pan, clamped.
  useEffect(() => {
    const n = Math.max(1, videoTracks.length);
    const newMax = n + 1;
    const span = Math.min(newMax, videoVSpan(videoStackH));
    const s = useStore.getState();
    const prevN = Math.max(1, prevVideoCount.current);
    prevVideoCount.current = n;
    const isAdd = n > prevN;
    let vMin: number;
    if (isAdd || s.vVideo.vMax > newMax + 0.001) {
      // Pin to the top end (V<max> + spawn buffer visible).
      vMin = Math.max(0, newMax - span);
    } else {
      vMin = Math.max(0, Math.min(s.vVideo.vMin, newMax - span));
    }
    const vMax = vMin + span;
    if (Math.abs(s.vVideo.max - newMax) < 0.001
        && Math.abs(s.vVideo.vMin - vMin) < 0.001
        && Math.abs(s.vVideo.vMax - vMax) < 0.001) return;
    useStore.setState({ vVideo: { min: 0, max: newMax, vMin, vMax } });
  }, [videoTracks.length, videoStackH]);

  useEffect(() => {
    const n = Math.max(1, audioTracks.length);
    const newMax = computeVMax(n, audioStackH);
    const s = useStore.getState();
    if (Math.abs(s.vAudio.max - newMax) < 0.001) return;
    const prevN = Math.max(1, prevAudioCount.current);
    prevAudioCount.current = n;
    const isCountChange = n !== prevN;
    const isAdd = n > prevN;
    if (isCountChange) {
      const prevSpan = s.vAudio.vMax - s.vAudio.vMin;
      const newSpan = prevSpan * (n / prevN);
      let vMin: number;
      let vMax: number;
      if (isAdd) {
        vMax = newMax;
        vMin = Math.max(0, newMax - newSpan);
      } else {
        const prevCenter = (s.vAudio.vMin + s.vAudio.vMax) / 2;
        const newCenter = prevCenter * (n / prevN);
        vMin = newCenter - newSpan / 2;
        vMax = newCenter + newSpan / 2;
        if (vMin < 0) { vMax += -vMin; vMin = 0; }
        if (vMax > newMax) { vMin -= vMax - newMax; vMax = newMax; }
        vMin = Math.max(0, vMin);
        vMax = Math.min(newMax, vMax);
      }
      useStore.setState({ vAudio: { min: 0, max: newMax, vMin, vMax } });
    } else {
      let vMin = s.vAudio.vMin;
      let vMax = Math.min(s.vAudio.vMax, newMax);
      vMin = Math.min(vMin, vMax - 0.01);
      useStore.setState({ vAudio: { min: 0, max: newMax, vMin, vMax } });
    }
  }, [audioTracks.length, audioStackH]);
}

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
function useDragRecovery() {
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
      // Wipe inline drag styles defensively in case useClipDrag's
      // closure cleanup never ran.
      const stuck = document.querySelector<HTMLElement>('.shot-block.is-dragging');
      if (stuck) {
        stuck.style.transform = '';
        stuck.style.left = '';
        stuck.style.top = '';
        stuck.style.width = '';
        stuck.style.height = '';
        stuck.style.zIndex = '';
        stuck.style.position = '';
      }
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

/** Suppress WebView2's native right-click menu globally. We have our
 *  own context menu wired on clips + the lanes-area; anywhere else
 *  (track headers, ruler, palette, scrollbars) a native menu would
 *  expose "Reload / Inspect / Save image as…" — useless and breaks
 *  immersion in a docked DAW panel. Our own menu handlers already
 *  preventDefault, so this is purely a fallback for unhandled spots. */
function useSuppressNativeContextMenu() {
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
function usePageZoomSuppress() {
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
function useAltKey() {
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
function useWheelScroll() {
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

function App() {
  useHost();
  useOmDrop();
  useFileDrop();
  useAudioPlayback();
  useActiveClipRouter();
  usePersistence();
  useKeyboard();
  usePageZoomSuppress();
  useSuppressNativeContextMenu();
  useDragRecovery();
  useAltRightZoom();
  useMmbPan();
  useWheelScroll();
  useToolCursor();
  useAltKey();
  const lanesAreaRef = useRef<HTMLDivElement | null>(null);
  useMarquee(lanesAreaRef);
  const headersStackRef = useRef<HTMLDivElement | null>(null);
  const headersVideosRef = useRef<HTMLDivElement | null>(null);
  const lanesStackRef = useRef<HTMLDivElement | null>(null);
  const lanesVideosRef = useRef<HTMLDivElement | null>(null);
  const lanesAudiosRef = useRef<HTMLDivElement | null>(null);
  // Measure the lane stack heights so useTrackCountSync can compute
  // an adaptive `max` for each side (smaller = thumb fills more of
  // the track at zoom-out; larger = pan headroom when content
  // overflows).
  const videoStackSize = useElementSize(lanesVideosRef);
  const audioStackSize = useElementSize(lanesAudiosRef);
  useTrackCountSync(videoStackSize.height, audioStackSize.height);

  // Push vaShare into CSS vars on every change. Both stacks (headers
  // + lanes) read --va-video-share / --va-audio-share via flex-grow.
  const vaShare = useStore((s) => s.vaShare);
  useEffect(() => {
    document.documentElement.style.setProperty('--va-video-share', String(vaShare));
    document.documentElement.style.setProperty('--va-audio-share', String(1 - vaShare));
  }, [vaShare]);

  const activeTool = useStore((s) => s.activeTool);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const headersWidth = useStore((s) => s.headersWidth);

  useVerticalZoomVars(lanesVideosRef, lanesAudiosRef);

  // Does each side's track content overflow its visible region at the
  // current zoom? Same formula as useVerticalZoomVars (track height =
  // NATURAL/span clamped at MIN; contentH includes the spawn spacer).
  // A v-scrollbar shows ONLY when there's real overflow to pan — not
  // merely because the zoom window is a subset of the full range.
  const vVideo = useStore((s) => s.vVideo);
  const vAudio = useStore((s) => s.vAudio);
  const videoTrackCount = useStore((s) => s.videoTracks.length);
  const audioTrackCount = useStore((s) => s.audioTracks.length);
  const videoOverflows = sideOverflows(vVideo, videoTrackCount, videoStackSize.height, 'video');
  const audioOverflows = sideOverflows(vAudio, audioTrackCount, audioStackSize.height, 'audio');

  return (
    <div className="app">
      <div className="topbar">
        <Timecode />
      </div>

      <div
        className={'body'
          + (activeTool === 'select' ? ' is-tool-select' : '')
          + (inspectorOpen ? ' inspector-open' : '')}
        style={{ '--headers-w': headersWidth + 'px' } as React.CSSProperties}
      >
        {/* row 1, col 1 — logo */}
        <div className="logo">
          <img className="logo__mark" src={logoUrl} alt="Shotblocks" />
        </div>

        {/* row 1, col 2 — utilities strip */}
        <div className="utilstrip">
          <LoopToggle />
          <SnapToggle />
          <BeatDetectionButton />
          <div className="utilstrip__icon" title="Markers">
            <span className="icon icon--markers" style={{ '--icon-w': '10px', '--icon-h': '13px' } as React.CSSProperties} />
          </div>
          <InspectorToggle />
        </div>

        {/* row 1, col 3 — ruler */}
        <div className="ruler-row" id="ruler-row">
          <Ruler />
        </div>

        {/* row 2, col 1 — tool palette + dB meter + audio-scrub toggle */}
        <div className="rail">
          <ToolPalette />
          <div className="rail__meter-wrap">
            <div className="rail__meter" title="dB meter">
              <div className="rail__meter-scale">
                <div className="rail__meter-scale__labels">
                  <span>6</span><span>0</span><span>-6</span><span>-12</span>
                  <span>-20</span><span>-30</span><span>-40</span><span>-50</span><span>-∞</span>
                </div>
              </div>
              <div className="rail__meter-bars">
                <Meter />
              </div>
            </div>
          </div>
          <AudioScrubToggle />
        </div>

        {/* row 2, col 2 — track headers (rendered from store) */}
        <HeadersColumn
          stackRef={headersStackRef}
          videosRef={headersVideosRef}
        />

        {/* row 2, col 3 — stage (lanes, rendered from store) */}
        <div className="stage">
          <div className="stage__edge-shadow" />
          {/* Detected beat grid — FCP-style green tempo lines. First
              child + z-index 0 so clip bodies paint over it; the
              lines show through the transparent empty lane area and
              gutters. Toggled by the Beat Detection button. */}
          <BeatGrid />
          {/* Play-range dim: black-30% overlay outside [in, out]. Sits
              above the lane backgrounds + clips but BELOW the playhead
              (z:5). pointer-events:none lets clicks/scrub/drag still
              reach the underlying elements. */}
          <RangeDim />
          <div
            className={'lanes-area'
              + (activeTool === 'razor' ? ' is-tool-razor' : '')
              + (activeTool === 'slip' ? ' is-tool-slip' : '')
              + (activeTool === 'select' ? ' is-tool-select' : '')}
            id="lanes-area"
            ref={lanesAreaRef}
            onContextMenu={(ev) => {
              // Empty-area right-click: only show Paste. ShotBlock's
              // own onContextMenu stops propagation, so this fires only
              // when the click missed any clip.
              ev.preventDefault();
              useStore.getState().setContextMenu({
                x: ev.clientX,
                y: ev.clientY,
                targetClipId: null,
                targetTrackId: null,
              });
            }}
          >
            <LanesStack
              stackRef={lanesStackRef}
              videosRef={lanesVideosRef}
              audiosRef={lanesAudiosRef}
            />
            <DropGhost lanesAreaRef={lanesAreaRef} />
            <MarqueeOverlay />
          </div>
          {/* Playhead lives at the .stage level (sibling of lanes-area)
              rather than INSIDE lanes-area, so it isn't blocked by the
              per-lane stacking contexts that `transform: translateY(...)`
              creates for vertical scroll. With z:5 it now paints over
              both lane backgrounds AND clip bodies. */}
          <Playhead lanesAreaRef={lanesAreaRef} />

          {/* Overlay scrollbars — minimal 4px thumbs floating on the
              stage's bottom / right edges. Each renders only while its
              axis is zoomed in (see HScroll / VScroll). */}
          <HScroll />
          <VScroll which="video" overflows={videoOverflows} />
          <VScroll which="audio" overflows={audioOverflows} />
        </div>

        {/* Razor cut-line preview — spans ruler row (row 1) through
            stage (row 2), column 3, via CSS grid placement. Rendered
            only when activeTool === 'razor' && pointer is on a clip. */}
        <CutLineOverlay />

        {/* Yellow magnetic-snap indicator lines — drawn at every edit
            point the in-flight drag is currently magnetized to. Same
            grid-span pattern as CutLineOverlay. */}
        <SnapIndicators />

        {/* Right-click context menu — viewport-positioned, renders only
            while state.contextMenu is non-null. */}
        <ContextMenu />

        {/* Spawn-zone preview — outlined ghost lane shown while
            dragging a clip into a not-yet-existing track. */}
        <SpawnGhostLane />

        {/* Inspector — grid column 4, all 3 rows. Width collapses to 0
            when closed so the timeline reclaims the space. */}
        <Inspector />
      </div>
      <DebugOverlay />
    </div>
  );
}

export default App;
