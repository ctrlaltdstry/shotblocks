import { useEffect, useRef } from 'react';
import './icons.css';
import './icons-block.css';
import './App.css';
import logoUrl from './icons/logo.svg';
import { useHost } from './useHost';
import { useOmDrop } from './useOmDrop';
import { useStore } from './store';
import { Ruler } from './components/Ruler';
import { Playhead } from './components/Playhead';
import { Scrollbar } from './components/Scrollbar';
import { VaSplitter } from './components/VaSplitter';
import { TrackHeader } from './components/TrackHeader';
import { Lane } from './components/Lane';
import { ToolPalette } from './components/ToolPalette';
import { DropGhost } from './components/DropGhost';
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
function VScroll({ which, elementRef }: { which: 'video' | 'audio'; elementRef?: React.RefObject<HTMLDivElement | null> }) {
  const win = useStore((s) => which === 'video' ? s.vVideo : s.vAudio);
  const setter = useStore((s) => which === 'video' ? s.setVVideoVisible : s.setVAudioVisible);
  return (
    <div ref={elementRef} className="v-scroll" title={`${which === 'video' ? 'Video' : 'Audio'} tracks scroll/zoom`}>
      <Scrollbar
        axis="y"
        window={win}
        minSpan={0.1}
        onChange={setter}
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

function useVerticalZoomVars(
  videosRegionRef: React.RefObject<HTMLDivElement | null>,
  audiosRegionRef: React.RefObject<HTMLDivElement | null>,
) {
  const vVideo = useStore((s) => s.vVideo);
  const vAudio = useStore((s) => s.vAudio);
  const vSize = useElementSize(videosRegionRef);
  const aSize = useElementSize(audiosRegionRef);

  useEffect(() => {
    const span = Math.max(0.01, vVideo.vMax - vVideo.vMin);
    const trackCount = Math.max(1, vVideo.max / 2);
    const trackPx = NATURAL_TRACK_PX * trackCount / span;
    const overflow = Math.max(0, trackPx - vSize.height);
    const scrollRange = Math.max(0.0001, (vVideo.max - vVideo.min) - span);
    const scrollFrac = scrollRange > 0 ? Math.max(0, vVideo.vMin - vVideo.min) / scrollRange : 0;
    const scrollY = scrollFrac * overflow;
    document.documentElement.style.setProperty('--video-track-h', trackPx + 'px');
    document.documentElement.style.setProperty('--video-scroll-y', scrollY + 'px');
  }, [vVideo.vMin, vVideo.vMax, vVideo.min, vVideo.max, vSize.height]);

  useEffect(() => {
    const span = Math.max(0.01, vAudio.vMax - vAudio.vMin);
    const trackCount = Math.max(1, vAudio.max / 2);
    const trackPx = NATURAL_TRACK_PX * trackCount / span;
    const overflow = Math.max(0, trackPx - aSize.height);
    const scrollRange = Math.max(0.0001, (vAudio.max - vAudio.min) - span);
    const scrollFrac = scrollRange > 0 ? Math.max(0, vAudio.vMin - vAudio.min) / scrollRange : 0;
    const scrollY = -scrollFrac * overflow;
    document.documentElement.style.setProperty('--audio-track-h', trackPx + 'px');
    document.documentElement.style.setProperty('--audio-scroll-y', scrollY + 'px');
  }, [vAudio.vMin, vAudio.vMax, vAudio.min, vAudio.max, aSize.height]);
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
          {videosOrdered.map((t) => (
            <TrackHeader key={t.id} track={t} side="video" />
          ))}
        </div>
        <VaSplitter stackRef={stackRef} videosRef={videosRef} />
        <div className="stack__audios" id="headers-audios">
          {audioTracks.map((t) => (
            <TrackHeader key={t.id} track={t} side="audio" />
          ))}
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
        {videosOrdered.map((t) => (
          <Lane key={t.id} track={t} side="video" />
        ))}
      </div>
      <VaSplitter stackRef={stackRef} videosRef={videosRef} />
      <div className="stack__audios" id="lanes-audios" ref={audiosRef}>
        {audioTracks.map((t) => (
          <Lane key={t.id} track={t} side="audio" />
        ))}
      </div>
    </div>
  );
}

/** Keeps the vertical scrollbar ranges in sync with track counts.
 *  Range = 2× track count so the centered default window leaves equal
 *  headroom to zoom OUT on both sides. Preserves user zoom unless the
 *  view is at the default centered span. */
function useTrackCountSync() {
  const videoTracks = useStore((s) => s.videoTracks);
  const audioTracks = useStore((s) => s.audioTracks);

  useEffect(() => {
    const n = Math.max(1, videoTracks.length);
    const max = n * 2;
    const s = useStore.getState();
    if (s.vVideo.max === max) return;
    const wasDefault = Math.abs((s.vVideo.vMax - s.vVideo.vMin) - n) < 0.01
                    && Math.abs(((s.vVideo.vMin + s.vVideo.vMax) / 2) - n) < 0.01;
    if (wasDefault) {
      useStore.setState({ vVideo: { min: 0, max, vMin: n / 2, vMax: n + n / 2 } });
    } else {
      useStore.setState({ vVideo: { ...s.vVideo, max } });
    }
  }, [videoTracks.length]);

  useEffect(() => {
    const n = Math.max(1, audioTracks.length);
    const max = n * 2;
    const s = useStore.getState();
    if (s.vAudio.max === max) return;
    const wasDefault = Math.abs((s.vAudio.vMax - s.vAudio.vMin) - n) < 0.01
                    && Math.abs(((s.vAudio.vMin + s.vAudio.vMax) / 2) - n) < 0.01;
    if (wasDefault) {
      useStore.setState({ vAudio: { min: 0, max, vMin: n / 2, vMax: n + n / 2 } });
    } else {
      useStore.setState({ vAudio: { ...s.vAudio, max } });
    }
  }, [audioTracks.length]);
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
  useTrackCountSync();
  usePageZoomSuppress();
  const lanesAreaRef = useRef<HTMLDivElement | null>(null);
  const headersStackRef = useRef<HTMLDivElement | null>(null);
  const headersVideosRef = useRef<HTMLDivElement | null>(null);
  const lanesStackRef = useRef<HTMLDivElement | null>(null);
  const lanesVideosRef = useRef<HTMLDivElement | null>(null);
  const lanesAudiosRef = useRef<HTMLDivElement | null>(null);
  const vgutterRef = useRef<HTMLDivElement | null>(null);
  const vgutterVideoRef = useRef<HTMLDivElement | null>(null);

  // Push vaShare into CSS vars on every change. Both stacks (headers
  // + lanes) read --va-video-share / --va-audio-share via flex-grow.
  const vaShare = useStore((s) => s.vaShare);
  useEffect(() => {
    document.documentElement.style.setProperty('--va-video-share', String(vaShare));
    document.documentElement.style.setProperty('--va-audio-share', String(1 - vaShare));
  }, [vaShare]);

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
          <div className="utilstrip__icon" title="Snap">
            <span className="icon icon--snap" style={{ '--icon-w': '14px', '--icon-h': '14px' } as React.CSSProperties} />
          </div>
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

        {/* row 2, col 1 — tool palette + dB meter */}
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
                <div className="rail__meter-bars__pair">
                  <div className="rail__meter-bar" />
                  <div className="rail__meter-bar" />
                </div>
                <div className="rail__meter-bars__lr">
                  <span>L</span><span>R</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* row 2, col 2 — track headers (rendered from store) */}
        <HeadersColumn
          stackRef={headersStackRef}
          videosRef={headersVideosRef}
        />

        {/* row 2, col 3 — stage (lanes, rendered from store) */}
        <div className="stage">
          <div className="stage__edge-shadow" />
          <div className="lanes-area" id="lanes-area" ref={lanesAreaRef}>
            <LanesStack
              stackRef={lanesStackRef}
              videosRef={lanesVideosRef}
              audiosRef={lanesAudiosRef}
            />
            <DropGhost lanesAreaRef={lanesAreaRef} />
            <Playhead lanesAreaRef={lanesAreaRef} />
          </div>
        </div>

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
