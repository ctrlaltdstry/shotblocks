import { useRef } from 'react';
import './icons.css';
import './App.css';
import logoUrl from './icons/logo.svg';
import { useHost } from './useHost';
import { useStore } from './store';
import { Ruler } from './components/Ruler';
import { Playhead } from './components/Playhead';
import { Scrollbar } from './components/Scrollbar';

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

/** Vertical scrollbar for one side of the V/A split. */
function VScroll({ which }: { which: 'video' | 'audio' }) {
  const win = useStore((s) => which === 'video' ? s.vVideo : s.vAudio);
  const setter = useStore((s) => which === 'video' ? s.setVVideoVisible : s.setVAudioVisible);
  return (
    <div className="v-scroll" title={`${which === 'video' ? 'Video' : 'Audio'} tracks scroll/zoom`}>
      <Scrollbar
        axis="y"
        window={win}
        minSpan={0.1}
        onChange={setter}
      />
    </div>
  );
}

function App() {
  useHost();
  const lanesAreaRef = useRef<HTMLDivElement | null>(null);

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
          <div className="stack">
            <div className="stack__videos" id="headers-videos">
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
            <div className="stack__divider" id="headers-divider" />
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
            <div className="stack">
              <div className="stack__videos" id="lanes-videos">
                <div className="lane" data-track="V1" data-side="video" />
              </div>
              <div className="stack__divider" id="lanes-divider" />
              <div className="stack__audios" id="lanes-audios">
                <div className="lane" data-track="A1" data-side="audio" />
              </div>
            </div>
            <Playhead lanesAreaRef={lanesAreaRef} />
          </div>
        </div>

        {/* row 3 — h-scroll */}
        <HScroll />

        {/* row 2, col 4 — v-gutter */}
        <div className="v-gutter">
          <VScroll which="video" />
          <div className="stack__divider v-gutter__divider" id="vgutter-divider" />
          <VScroll which="audio" />
        </div>
      </div>
    </div>
  );
}

export default App;
