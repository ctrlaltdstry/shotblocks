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
import { useKeyboard } from './useKeyboard';
import { useAltRightZoom } from './useAltRightZoom';
import { useMmbPan } from './useMmbPan';
import { useSlipCursor } from './useSlipCursor';
import { useStore } from './store';
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
import { ContextMenu } from './components/ContextMenu';
import { RangeDim } from './components/RangeDim';
import { SpawnGhostLane } from './components/SpawnGhostLane';
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
 *  Python's `_snap_enabled = False` (sb_canvas.py:420). Shift held
 *  during a drag overrides this toggle (ripple mode beats snap, per
 *  Python `_qualifier_mode`). */
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
function HScroll() {
  const h = useStore((s) => s.h);
  const setHVisible = useStore((s) => s.setHVisible);
  return (
    <div className="h-scroll">
      <Scrollbar
        axis="x"
        window={h}
        minSpan={4}
        onChange={setHVisible}
      />
    </div>
  );
}

/** Vertical scrollbar for one side of the V/A split. Both dots are
 *  the actual edges of the visible window — drag them together to
 *  zoom in, apart to zoom out. The lane content stays anchored at the
 *  V/A divider via the .stack__videos / .stack__audios flex rules. */
function VScroll({
  which,
  elementRef,
}: {
  which: 'video' | 'audio';
  elementRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const win = useStore((s) => which === 'video' ? s.vVideo : s.vAudio);
  const setter = useStore((s) => which === 'video' ? s.setVVideoVisible : s.setVAudioVisible);
  const trackCount = useStore((s) => which === 'video' ? s.videoTracks.length : s.audioTracks.length);
  // maxSpan: largest legal zoom-out. trackPx = NATURAL * count / span,
  // clamped at MIN_TRACK_PX. Past `span = NATURAL * count / MIN`,
  // zooming out further has no visual effect — lanes are already at
  // their floor. We cap there. The cap is always >= trackCount (the
  // natural zoom default) so the user can zoom from "all tracks at
  // natural height" down to "all tracks at min height" without the
  // dots fighting them.
  const maxSpan = NATURAL_TRACK_PX * Math.max(1, trackCount) / MIN_TRACK_PX;
  return (
    <div ref={elementRef} className="v-scroll" title={`${which === 'video' ? 'Video' : 'Audio'} tracks scroll/zoom`}>
      <Scrollbar
        axis="y"
        window={win}
        minSpan={0.1}
        maxSpan={maxSpan}
        onChange={setter}
        // Video stack is bottom-up (V1 at the bottom, V<max> at the
        // top), so the scrollbar reads naturally only when inverted:
        // thumb-at-top corresponds to V<max> being visible.
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
const NATURAL_TRACK_PX = 65;
/** Hard minimum lane height. The vertical-zoom out is clamped at this
 *  value so the stacked track-header layout always has room to read
 *  without needing a separate compact variant. Picked by feel — at
 *  ~48px the icon-above-label layout still fits comfortably. */
const MIN_TRACK_PX = 48;

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

  useEffect(() => {
    if (vSize.height < 1) return;
    const span = Math.max(0.01, vVideo.vMax - vVideo.vMin);
    // Track count comes from the store directly. The old formula
    // (vVideo.max / 2) was tied to the legacy max = 2 * count
    // convention; now that vVideo.max is adaptive (varies with
    // visible-height for pan headroom) we can't infer count from it.
    const trackCount = Math.max(1, videoTrackCount);
    // Lane height is clamped at MIN_TRACK_PX. Past that the scrollbar
    // span keeps growing but lanes stop shrinking; pan still works
    // because scrollY math uses the clamped trackPx for overflow.
    const trackPx = Math.max(MIN_TRACK_PX, NATURAL_TRACK_PX * trackCount / span);
    // contentH includes the spawn-buffer spacer (one extra track).
    const contentH = trackPx * (trackCount + 1);
    const overflow = Math.max(0, contentH - vSize.height);
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
        <VaSplitter stackRef={stackRef} videosRef={videosRef} />
        <div className="stack__audios" id="headers-audios">
          {audioTracks.map((t) => (
            <TrackHeader key={t.id} track={t} side="audio" />
          ))}
          <div className="lane-spacer" data-side="audio" />
        </div>
      </div>
    </div>
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
      <VaSplitter stackRef={stackRef} videosRef={videosRef} />
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
  useEffect(() => {
    const n = Math.max(1, videoTracks.length);
    const newMax = computeVMax(n, videoStackH);
    const s = useStore.getState();
    if (Math.abs(s.vVideo.max - newMax) < 0.001) return;
    const prevN = Math.max(1, prevVideoCount.current);
    prevVideoCount.current = n;
    const isCountChange = n !== prevN;
    const isAdd = n > prevN;
    if (isCountChange) {
      // Track count actually changed — reproportion the user's view.
      const prevSpan = s.vVideo.vMax - s.vVideo.vMin;
      const newSpan = prevSpan * (n / prevN);
      let vMin: number;
      let vMax: number;
      if (isAdd) {
        // Pin to the outer (top) end so V<max> is at the top with
        // the spawn buffer above it.
        vMax = newMax;
        vMin = Math.max(0, newMax - newSpan);
      } else {
        const prevCenter = (s.vVideo.vMin + s.vVideo.vMax) / 2;
        const newCenter = prevCenter * (n / prevN);
        vMin = newCenter - newSpan / 2;
        vMax = newCenter + newSpan / 2;
        if (vMin < 0) { vMax += -vMin; vMin = 0; }
        if (vMax > newMax) { vMin -= vMax - newMax; vMax = newMax; }
        vMin = Math.max(0, vMin);
        vMax = Math.min(newMax, vMax);
      }
      useStore.setState({ vVideo: { min: 0, max: newMax, vMin, vMax } });
    } else {
      // Only the visible height (and therefore max) changed — keep
      // the user's current pan/zoom but clamp into the new range.
      let vMin = s.vVideo.vMin;
      let vMax = Math.min(s.vVideo.vMax, newMax);
      vMin = Math.min(vMin, vMax - 0.01);
      useStore.setState({ vVideo: { min: 0, max: newMax, vMin, vMax } });
    }
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
  useSlipCursor();
  const lanesAreaRef = useRef<HTMLDivElement | null>(null);
  useMarquee(lanesAreaRef);
  const headersStackRef = useRef<HTMLDivElement | null>(null);
  const headersVideosRef = useRef<HTMLDivElement | null>(null);
  const lanesStackRef = useRef<HTMLDivElement | null>(null);
  const lanesVideosRef = useRef<HTMLDivElement | null>(null);
  const lanesAudiosRef = useRef<HTMLDivElement | null>(null);
  const vgutterRef = useRef<HTMLDivElement | null>(null);
  const vgutterVideoRef = useRef<HTMLDivElement | null>(null);
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

  useVerticalZoomVars(lanesVideosRef, lanesAudiosRef);

  return (
    <div className="app">
      <div className="topbar">
        <Timecode />
      </div>

      <div className="body">
        {/* row 1, col 1 — logo */}
        <div className="logo">
          <img className="logo__mark" src={logoUrl} alt="Shotblocks" />
        </div>

        {/* row 1, col 2 — utilities strip */}
        <div className="utilstrip">
          <LoopToggle />
          <SnapToggle />
          <div className="utilstrip__icon" title="Beat Detection">
            <span className="icon icon--beat-detection" style={{ '--icon-w': '13px', '--icon-h': '13px' } as React.CSSProperties} />
          </div>
          <div className="utilstrip__icon" title="Markers">
            <span className="icon icon--markers" style={{ '--icon-w': '10px', '--icon-h': '13px' } as React.CSSProperties} />
          </div>
          <div className="utilstrip__icon" title="Settings">
            <span className="icon icon--settings" style={{ '--icon-w': '15px', '--icon-h': '15px' } as React.CSSProperties} />
          </div>
        </div>

        {/* row 1, col 3 — ruler */}
        <div className="ruler-row" id="ruler-row">
          <Ruler />
        </div>
        <div className="ruler-row__gutter-cap" />

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
                <div className="rail__meter-bar" />
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
          {/* Play-range dim: black-30% overlay outside [in, out]. Sits
              above the lane backgrounds + clips but BELOW the playhead
              (z:5). pointer-events:none lets clicks/scrub/drag still
              reach the underlying elements. */}
          <RangeDim />
          <div
            className={'lanes-area'
              + (activeTool === 'razor' ? ' is-tool-razor' : '')
              + (activeTool === 'slip' ? ' is-tool-slip' : '')}
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

        {/* row 3 — h-scroll */}
        <HScroll />

        {/* row 2, col 4 — v-gutter. Uses the same VaSplitter; the two
            VScrolls' flex-grow reads --va-video-share / --va-audio-share. */}
        <div className="v-gutter" ref={vgutterRef}>
          <VScroll which="video" elementRef={vgutterVideoRef} />
          <VaSplitter stackRef={vgutterRef} videosRef={vgutterVideoRef} />
          <VScroll which="audio" />
        </div>
      </div>
      <DebugOverlay />
    </div>
  );
}

export default App;
