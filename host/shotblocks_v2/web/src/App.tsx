import { useEffect, useRef } from 'react';
import './icons.css';
import './App.css';
import logoUrl from './icons/logo.svg';
import { useHost } from './useHost';
import { useStore } from './store';
import { Ruler } from './components/Ruler';
import { Playhead } from './components/Playhead';
import { Scrollbar } from './components/Scrollbar';
import { VaSplitter } from './components/VaSplitter';
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
 *  Zoom: trackHeight = NATURAL_TRACK_PX / span. Lane stays anchored at
 *  the V/A divider via .stack__videos flex-end / .stack__audios
 *  flex-start. Both end-dots are real handles; the dot positions ARE
 *  vMin/vMax.
 *
 *  Scroll: when zoomed in, the lane overflows. vMin within
 *  [0, max - span] determines how far we've scrolled. scrollFrac = 0
 *  means the divider-adjacent edge of the lane is visible (natural);
 *  scrollFrac = 1 means the far edge is visible.
 *
 *  Translate direction:
 *  - Video (flex-end, lane bottom at divider, extends up): translate
 *    DOWN by scrollFrac * overflowPx. The lane top moves into view at
 *    the top of the region while the bottom slides past the divider
 *    (clipped by parent overflow:hidden).
 *  - Audio (flex-start, lane top at divider, extends down): translate
 *    UP, symmetric. */
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
    const trackPx = NATURAL_TRACK_PX / span;
    const overflow = Math.max(0, trackPx - vSize.height);
    const scrollRange = Math.max(0.0001, (vVideo.max - vVideo.min) - span);
    const scrollFrac = scrollRange > 0 ? Math.max(0, vVideo.vMin - vVideo.min) / scrollRange : 0;
    const scrollY = scrollFrac * overflow;
    document.documentElement.style.setProperty('--video-track-h', trackPx + 'px');
    document.documentElement.style.setProperty('--video-scroll-y', scrollY + 'px');
  }, [vVideo.vMin, vVideo.vMax, vVideo.min, vVideo.max, vSize.height]);

  useEffect(() => {
    const span = Math.max(0.01, vAudio.vMax - vAudio.vMin);
    const trackPx = NATURAL_TRACK_PX / span;
    const overflow = Math.max(0, trackPx - aSize.height);
    const scrollRange = Math.max(0.0001, (vAudio.max - vAudio.min) - span);
    const scrollFrac = scrollRange > 0 ? Math.max(0, vAudio.vMin - vAudio.min) / scrollRange : 0;
    const scrollY = -scrollFrac * overflow;
    document.documentElement.style.setProperty('--audio-track-h', trackPx + 'px');
    document.documentElement.style.setProperty('--audio-scroll-y', scrollY + 'px');
  }, [vAudio.vMin, vAudio.vMax, vAudio.min, vAudio.max, aSize.height]);
}

function App() {
  useHost();
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
          <div className="rail__tools" id="rail-tools">
            <div className="rail__tool is-active" title="Select" data-tool="select" style={{ '--icon-w': '14px', '--icon-h': '14px' } as React.CSSProperties}>
              <span className="icon icon--select" />
            </div>
            <div className="rail__tool" title="Razor" data-tool="razor" style={{ '--icon-w': '14px', '--icon-h': '14px', '--icon-rot': '45deg' } as React.CSSProperties}>
              <span className="icon icon--razor" />
            </div>
            <div className="rail__tool" title="Pen" data-tool="pen" style={{ '--icon-w': '14px', '--icon-h': '14px' } as React.CSSProperties}>
              <span className="icon icon--pen" />
            </div>
            <div className="rail__tool" title="Range" data-tool="range" style={{ '--icon-w': '15px', '--icon-h': '12px' } as React.CSSProperties}>
              <span className="icon icon--range" />
            </div>
          </div>
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

        {/* row 2, col 2 — track headers */}
        <div className="headers">
          <div className="stack" ref={headersStackRef}>
            <div className="stack__videos" id="headers-videos" ref={headersVideosRef}>
              <div className="track-header is-video" data-track="V1">
                <div className="track-header__twirl">
                  <span className="icon icon--triangle" style={{ '--icon-w': '8px', '--icon-h': '10px', '--icon-rot': '90deg' } as React.CSSProperties} />
                </div>
                <div className="track-header__lock-wrap">
                  <span className="icon icon--lock" style={{ '--icon-w': '12px', '--icon-h': '12px' } as React.CSSProperties} />
                </div>
                <div className="track-header__chip-wrap">
                  <div className="track-header__chip">V1</div>
                </div>
                <div className="track-header__right">
                  <div className="track-header__right-col">
                    <span className="icon icon--eye" style={{
                      '--icon-w': '18px', '--icon-h': '18px',
                      backgroundColor: 'var(--color-timeline-primary-highlight)',
                    } as React.CSSProperties} />
                    <div className="track-header__label-wrap">
                      <div className="track-header__label">Video 1</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <VaSplitter stackRef={headersStackRef} videosRef={headersVideosRef} />
            <div className="stack__audios" id="headers-audios">
              <div className="track-header is-audio" data-track="A1">
                <div className="track-header__twirl">
                  <span className="icon icon--triangle" style={{ '--icon-w': '8px', '--icon-h': '10px', '--icon-rot': '90deg' } as React.CSSProperties} />
                </div>
                <div className="track-header__lock-wrap">
                  <span className="icon icon--lock-locked" style={{ '--icon-w': '12px', '--icon-h': '12px' } as React.CSSProperties} />
                </div>
                <div className="track-header__chip-wrap">
                  <div className="track-header__chip">A1</div>
                </div>
                <div className="track-header__right">
                  <div className="track-header__right-col">
                    <div className="track-header__icons-row"><span>M</span><span className="s">S</span></div>
                    <div className="track-header__label-wrap">
                      <div className="track-header__label">Audio 1</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* row 2, col 3 — stage (lanes) */}
        <div className="stage">
          <div className="stage__edge-shadow" />
          <div className="lanes-area" id="lanes-area" ref={lanesAreaRef}>
            <div className="stack" ref={lanesStackRef}>
              <div className="stack__videos" id="lanes-videos" ref={lanesVideosRef}>
                <div className="lane" data-track="V1" data-side="video" />
              </div>
              <VaSplitter stackRef={lanesStackRef} videosRef={lanesVideosRef} />
              <div className="stack__audios" id="lanes-audios" ref={lanesAudiosRef}>
                <div className="lane" data-track="A1" data-side="audio" />
              </div>
            </div>
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
    </div>
  );
}

export default App;
