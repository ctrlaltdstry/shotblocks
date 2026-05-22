import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { getAudioBuffer } from '../lib/audioStore';
import { getMeterEnvelope, sampleEnvelope, FLOOR_DBFS, type MeterEnvelope } from '../lib/audioMeter';

/* Meter ballistics.
 *   - Bar: instant attack, METER_RELEASE_DB_S release while live
 *     (playing OR playhead moving), METER_PAUSE_DECAY_DB_S decay when
 *     the playhead is stationary so the bar doesn't freeze loud.
 *   - Peak-hold tick: holds the highest recent bar level, decays at
 *     PEAK_HOLD_DECAY_DB_S.
 * Release is VU-ish (11 dB/s) — combined with the 60ms RMS window in
 * audioMeter.ts it reads as a steady level, not a transient-bouncing
 * peak meter. */
const METER_RELEASE_DB_S     = 11;
const METER_PAUSE_DECAY_DB_S = 40;
const PEAK_HOLD_DECAY_DB_S    = 12;

/** dBFS → fill fraction 0..1 (0 dB = full, FLOOR = empty). */
function dbToFrac(db: number): number {
  if (db >= 0) return 1;
  if (db <= FLOOR_DBFS) return 0;
  return 1 - db / FLOOR_DBFS;
}

/** Live stereo dB meter — two thin bars (L/R) sharing the meter's
 *  width. RMS-envelope driven with peak-hold ticks. Envelope-based
 *  (not a live AnalyserNode tap) so it reads during scrub too,
 *  matching Python. Bars are mutated imperatively on a rAF loop. */
export function Meter() {
  // Two channels' worth of refs (L, R). Mono media drives both bars
  // identically.
  const coverRefs = [useRef<HTMLDivElement | null>(null), useRef<HTMLDivElement | null>(null)];
  const peakRefs  = [useRef<HTMLDivElement | null>(null), useRef<HTMLDivElement | null>(null)];

  // Per-channel animation state.
  const displayedRef = useRef<number[]>([FLOOR_DBFS, FLOOR_DBFS]);
  const peakHoldRef  = useRef<number[]>([FLOOR_DBFS, FLOOR_DBFS]);
  const lastTRef     = useRef(0);
  const lastFrameRef = useRef(-1);
  const envsRef      = useRef(new Map<number, MeterEnvelope>());
  const decodingRef  = useRef(new Set<number>());

  useEffect(() => {
    const ctorCtx = () => {
      const Ctor: typeof AudioContext =
        window.AudioContext
        || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      return new Ctor();
    };
    let decodeCtx: AudioContext | null = null;
    let raf = 0;
    lastTRef.current = performance.now();

    /** Per-channel dBFS at the playhead — [L, R]. FLOOR for both when
     *  no audio clip covers the playhead. Mono media → both equal.
     *  Kicks off an envelope build for media not ready yet. */
    function levelsAtPlayhead(): number[] {
      const s = useStore.getState();
      const frame = s.scrubFrame ?? s.currentFrame;
      const fps = s.fps || 30;
      const anySolo = s.audioTracks.some((t) => t.solo);
      for (const t of s.audioTracks) {
        // A muted / solo'd-out track reads silent on the meter, just
        // as it is silent in playback.
        if (t.muted || (anySolo && !t.solo)) continue;
        for (const clip of t.clips) {
          if (frame < clip.inFrame || frame >= clip.outFrame) continue;
          const mediaId = clip.mediaId ?? clip.id;
          const env = envsRef.current.get(mediaId);
          if (!env) {
            if (!decodingRef.current.has(mediaId)) {
              decodingRef.current.add(mediaId);
              if (!decodeCtx) decodeCtx = ctorCtx();
              void getAudioBuffer(mediaId, decodeCtx).then((buf) => {
                if (buf) {
                  envsRef.current.set(mediaId, getMeterEnvelope(mediaId, buf));
                } else {
                  // No bytes in audioStore yet. On doc LOAD the bytes
                  // are fetched from C++ asynchronously, so the meter
                  // can ask before they've landed. Clear the "tried"
                  // mark so a later rAF retries once fetchAudio lands
                  // — otherwise the meter stays dead for reloaded
                  // audio until the clip is re-imported.
                  decodingRef.current.delete(mediaId);
                }
              });
            }
            continue;
          }
          const mediaOffsetFrames = clip.mediaOffsetFrames ?? 0;
          const docFrameIntoMedia = mediaOffsetFrames + (frame - clip.inFrame);
          const audioFrame = (docFrameIntoMedia / fps) * env.sampleRate;
          const ch = sampleEnvelope(env, audioFrame);
          // Mono media → mirror channel 0 to both bars.
          return ch.length >= 2 ? [ch[0], ch[1]] : [ch[0], ch[0]];
        }
      }
      return [FLOOR_DBFS, FLOOR_DBFS];
    }

    function tick() {
      const now = performance.now();
      const dt = Math.max(0, (now - lastTRef.current) / 1000);
      lastTRef.current = now;

      const s = useStore.getState();
      const frame = s.scrubFrame ?? s.currentFrame;
      const moved = frame !== lastFrameRef.current;
      lastFrameRef.current = frame;
      const live = s.playing || moved;

      const targets = levelsAtPlayhead();
      for (let c = 0; c < 2; c++) {
        const target = targets[c];
        let displayed = displayedRef.current[c];
        if (live) {
          // Instant attack, slow (VU-ish) release.
          if (target >= displayed) {
            displayed = target;
          } else {
            displayed -= METER_RELEASE_DB_S * dt;
            if (displayed < target) displayed = target;
          }
        } else {
          displayed -= METER_PAUSE_DECAY_DB_S * dt;
        }
        if (displayed < FLOOR_DBFS) displayed = FLOOR_DBFS;
        displayedRef.current[c] = displayed;

        let held = peakHoldRef.current[c];
        if (displayed > held) held = displayed;
        else held -= PEAK_HOLD_DECAY_DB_S * dt;
        if (held < displayed) held = displayed;
        if (held < FLOOR_DBFS) held = FLOOR_DBFS;
        peakHoldRef.current[c] = held;

        const cover = coverRefs[c].current;
        const peak = peakRefs[c].current;
        if (cover) cover.style.height = ((1 - dbToFrac(displayed)) * 100) + '%';
        if (peak) {
          peak.style.bottom = (dbToFrac(held) * 100) + '%';
          peak.style.opacity = held > FLOOR_DBFS ? '1' : '0';
        }
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      if (decodeCtx) void decodeCtx.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="rail__meter-stereo">
      {[0, 1].map((c) => (
        <div key={c} className="rail__meter-bar">
          <div className="rail__meter-fill" />
          <div ref={coverRefs[c]} className="rail__meter-cover" />
          <div ref={peakRefs[c]} className="rail__meter-peak" />
        </div>
      ))}
    </div>
  );
}
