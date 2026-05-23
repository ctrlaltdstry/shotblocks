import { useEffect, useRef } from 'react';
import './icons.css';
import './icons-block.css';
import './App.css';
import logoUrl from './icons/logo.svg';
import { useHost } from './useHost';
import { useOmDrop } from './useOmDrop';
import { useFileDrop } from './useFileDrop';
import { useAudioPlayback } from './useAudioPlayback';
import { useActiveClipRouter } from './useActiveClipRouter';
import { usePersistence } from './usePersistence';
import { useKeyboard } from './useKeyboard';
import { useAltRightZoom } from './useAltRightZoom';
import { useMmbPan } from './useMmbPan';
import { useToolCursor } from './useToolCursor';
import { useStore } from './store';
import { Ruler } from './components/Ruler';
import { Playhead } from './components/Playhead';
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
import { UtilityStrip } from './components/UtilityStrip';
import { Timecode } from './components/Timecode';
import { HScroll, VScroll } from './components/StageScrollbars';
import { HeadersColumn } from './components/HeadersColumn';
import { LanesStack } from './components/LanesStack';
import { useMarquee } from './useMarquee';
import { DebugOverlay } from './DebugOverlay';
import { useElementSize } from './useElementSize';
import { useDragRecovery } from './hooks/useDragRecovery';
import {
  useSuppressNativeContextMenu,
  usePageZoomSuppress,
  useAltKey,
  useWheelScroll,
} from './hooks/useWindowGlobals';
import {
  useTrackCountSync,
  useVerticalZoomVars,
  sideOverflows,
} from './hooks/useVerticalLayout';

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
        <UtilityStrip />

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
