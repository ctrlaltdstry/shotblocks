// Beat tracking for audio clips — the FCP-style pipeline.
//
// IMPORTANT: this finds the BEAT — the regular metric pulse — not
// every onset. Those are two different MIR tasks, and conflating them
// was the bug in the first version of this file:
//
//   - ONSET DETECTION finds every note attack. On an orchestral
//     trailer track that's hundreds of events per minute. An onset
//     list is a raw signal, NOT the answer the user wants.
//   - BEAT TRACKING finds the steady pulse you'd tap your foot to —
//     one beat per beat-period. That is what Final Cut Pro's "Beat
//     Detection" shows (its green beat grid: major + interim beats).
//     It is sparse and regular by construction.
//
// The pipeline (Ellis 2007, "Beat Tracking by Dynamic Programming" —
// the algorithm librosa.beat.beat_track implements):
//
//   1. Per-band spectral flux → a dense ONSET ENVELOPE Δ(n). This is
//      the input. It stays dense; the next steps pick beats out of it.
//   2. TEMPO ESTIMATION — autocorrelate Δ, weighted by a log-Gaussian
//      perceptual prior centered on ~120 BPM, to get one global beat
//      period δ̂.
//   3. DYNAMIC PROGRAMMING BEAT TRACKER — find the beat sequence B
//      maximizing  S(B) = Σ Δ(b_l) + λ·Σ P(b_l − b_{l-1})  where the
//      transition penalty  P(δ) = −(log2(δ/δ̂))²  is 0 at the ideal
//      period and steeply negative away from it. A sequence with a
//      beat on every onset would accumulate enormous penalties, so
//      the DP refuses to — it lays down ONE beat per period and
//      snaps each onto a real onset. THIS is what makes the output
//      sparse instead of the dense mess an onset detector produces.
//
// Output: `peaks` = one media-space sample position per tracked beat;
// `grid` = the inferred period + phase for the overlay. The renderer
// and snap convert sample positions → doc frames.

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const ANALYSIS_RATE = 11025;     // onset detection downsample target
const FFT_SIZE = 1024;           // analysis window (~93ms @ 11025)
const HOP_SIZE = 256;            // 75% overlap → ~23ms per flux frame

// Per-band Hz ranges. Kick: low percussion. Snare/hi-hat: crack +
// cymbal energy. The mid (vocals/pads, ~250Hz-2kHz) is deliberately
// excluded from both bands so melodic content doesn't generate flux.
const KICK_LO_HZ = 30;
const KICK_HI_HZ = 160;
const SNARE_LO_HZ = 2000;
const SNARE_HI_HZ = 9000;

// Tempo search bounds + the perceptual prior. START_BPM is the centre
// of the log-Gaussian autocorrelation weight; TEMPO_PRIOR_WIDTH is its
// width in octaves. Ellis/librosa default the prior to ~120 BPM. A
// trailer's "foot-tap" pulse is usually 80–140 BPM, comfortably
// inside the search range.
const GRID_BPM_MIN = 50;
const GRID_BPM_MAX = 210;
const START_BPM = 120;
const TEMPO_PRIOR_WIDTH = 1.0;   // octaves (std-dev of the log-Gaussian)

// Dynamic-programming tightness λ — how strongly beat spacing is held
// to the ideal period. librosa's default is 100. Higher = more rigid
// (more grid-like, fewer beats snapped off-tempo); lower = follows
// onset accents more loosely.
const TIGHTNESS = 100;

export const GRID_CONFIDENCE_FLOOR = 0.5;

export interface BeatGrid {
  /** Beat period in media-space audio sample frames. */
  periodSamples: number;
  /** Phase offset of the first beat, in media-space audio samples. */
  phaseSamples: number;
  /** 0..1 autocorrelation confidence. */
  confidence: number;
  /** Index within the `peaks` array of the first BAR downbeat. A
   *  peak at array index i is a bar when (i - barOffset) % 4 === 0.
   *  Keeps bar lines locked to the tracked beat 0 even though the
   *  extrapolated grid may start a few beats earlier. */
  barOffset: number;
}

export interface DetectResult {
  /** Prominent onset positions, media-space audio sample frames. */
  peaks: number[];
  /** Inferred tempo grid, or null if confidence too low / no data. */
  grid: BeatGrid | null;
}

// ---------------------------------------------------------------------------
// FFT — iterative radix-2, parallel real/imag arrays. Ported from
// sb_audio_onsets.py (_bit_reverse_indices / _twiddles / _fft_magnitudes).
// ---------------------------------------------------------------------------

interface FftTables {
  br: Int32Array;
  cos: Float64Array;
  sin: Float64Array;
}

const fftCache = new Map<number, FftTables>();

function getFftTables(n: number): FftTables {
  const hit = fftCache.get(n);
  if (hit) return hit;
  const bits = Math.log2(n) | 0;
  const br = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i, r = 0;
    for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
    br[i] = r;
  }
  const half = n >> 1;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    const a = (-2 * Math.PI * k) / n;
    cos[k] = Math.cos(a);
    sin[k] = Math.sin(a);
  }
  const t: FftTables = { br, cos, sin };
  fftCache.set(n, t);
  return t;
}

/** In-place radix-2 FFT; fills `mags` with magnitudes for bins
 *  [0, n/2]. `re` holds the windowed frame, `im` is zeroed by caller. */
function fftMagnitudes(
  re: Float64Array, im: Float64Array, n: number, t: FftTables, mags: Float64Array,
): void {
  const { br, cos, sin } = t;
  for (let i = 0; i < n; i++) {
    const j = br[i];
    if (j > i) { const tmp = re[i]; re[i] = re[j]; re[j] = tmp; }
  }
  let size = 2;
  while (size <= n) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      let k = 0;
      for (let i = start; i < start + half; i++) {
        const tc = cos[k], ts = sin[k];
        const ai = i + half;
        const tr = re[ai] * tc - im[ai] * ts;
        const ti = re[ai] * ts + im[ai] * tc;
        re[ai] = re[i] - tr;
        im[ai] = im[i] - ti;
        re[i] = re[i] + tr;
        im[i] = im[i] + ti;
        k += step;
      }
    }
    size <<= 1;
  }
  const half = n >> 1;
  for (let i = 0; i <= half; i++) {
    mags[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
  }
}

function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  if (n <= 1) { w.fill(1); return w; }
  const denom = n - 1;
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / denom);
  return w;
}

// ---------------------------------------------------------------------------
// Signal prep
// ---------------------------------------------------------------------------

function mixToMono(buf: AudioBuffer): Float32Array {
  const ch = buf.numberOfChannels;
  const len = buf.length;
  if (ch === 1) return buf.getChannelData(0);
  const mono = new Float32Array(len);
  for (let c = 0; c < ch; c++) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += data[i];
  }
  const inv = 1 / ch;
  for (let i = 0; i < len; i++) mono[i] *= inv;
  return mono;
}

/** Integer-factor decimation with a box-average pre-filter. Only the
 *  energy envelope shape matters for onsets, so a crude FIR is fine.
 *  Returns the decimated signal + the integer factor used. */
function decimate(
  mono: Float32Array, srcRate: number, targetRate: number,
): { signal: Float32Array; factor: number } {
  const factor = Math.max(1, Math.round(srcRate / targetRate));
  if (factor === 1) return { signal: mono, factor: 1 };
  const n = (mono.length / factor) | 0;
  const out = new Float32Array(n);
  const inv = 1 / factor;
  for (let i = 0; i < n; i++) {
    const base = i * factor;
    let s = 0;
    for (let k = 0; k < factor; k++) s += mono[base + k];
    out[i] = s * inv;
  }
  return { signal: out, factor };
}

// ---------------------------------------------------------------------------
// Per-band spectral flux
// ---------------------------------------------------------------------------

/** Compute half-wave-rectified spectral flux for one frequency band.
 *  Returns the normalized [0,1] flux curve, one entry per hop. */
function bandFlux(
  decimated: Float32Array, effRate: number, binLo: number, binHi: number,
): Float64Array {
  const n = decimated.length;
  if (n < FFT_SIZE * 2) return new Float64Array(0);
  const t = getFftTables(FFT_SIZE);
  const win = hannWindow(FFT_SIZE);
  void effRate;

  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const mags = new Float64Array((FFT_SIZE >> 1) + 1);
  const nFrames = 1 + ((n - FFT_SIZE) / HOP_SIZE | 0);
  const flux = new Float64Array(nFrames);
  let prev: Float64Array | null = null;

  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP_SIZE;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = decimated[off + i] * win[i];
      im[i] = 0;
    }
    fftMagnitudes(re, im, FFT_SIZE, t, mags);
    if (prev) {
      let s = 0;
      for (let b = binLo; b < binHi; b++) {
        const d = mags[b] - prev[b];
        if (d > 0) s += d;
      }
      flux[f] = s;
    }
    prev = mags.slice();
  }

  // Normalize to [0,1] so the absolute threshold offset is meaningful.
  let m = 0;
  for (let i = 0; i < nFrames; i++) if (flux[i] > m) m = flux[i];
  if (m > 0) {
    const inv = 1 / m;
    for (let i = 0; i < nFrames; i++) flux[i] *= inv;
  }
  return flux;
}

// ---------------------------------------------------------------------------
// Onset envelope — combine the per-band flux into one novelty curve
// ---------------------------------------------------------------------------

function onsetEnvelope(kick: Float64Array, snare: Float64Array): Float64Array {
  const n = Math.min(kick.length, snare.length);
  const env = new Float64Array(n);
  for (let i = 0; i < n; i++) env[i] = kick[i] + snare[i];

  // Local-mean subtraction over a ~0.5s window (in hop frames). This
  // is the standard onset-envelope "DC removal" — it stops a loud
  // sustained passage from sitting at a high baseline and dragging
  // the tracker around. Negatives clamp to 0.
  const half = 8;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n, i + half + 1);
    let s = 0;
    for (let j = lo; j < hi; j++) s += env[j];
    const v = env[i] - s / (hi - lo);
    out[i] = v > 0 ? v : 0;
  }

  let m = 0;
  for (let i = 0; i < n; i++) if (out[i] > m) m = out[i];
  if (m > 0) {
    const inv = 1 / m;
    for (let i = 0; i < n; i++) out[i] *= inv;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tempo estimation — perceptually-weighted autocorrelation
// ---------------------------------------------------------------------------

function estimateTempoPeriod(env: Float64Array, hopsPerSec: number): number {
  const n = env.length;
  const lagHi = Math.max(2, Math.round((60 / GRID_BPM_MIN) * hopsPerSec) + 1);
  const lagLo = Math.max(1, Math.round((60 / GRID_BPM_MAX) * hopsPerSec));
  if (lagLo >= lagHi || n < lagHi * 2) {
    return Math.round((60 / START_BPM) * hopsPerSec);
  }
  const idealLag = (60 / START_BPM) * hopsPerSec;

  let bestLag = lagLo;
  let bestScore = -Infinity;
  for (let lag = lagLo; lag < lagHi; lag++) {
    let ac = 0;
    const end = n - lag;
    for (let i = 0; i < end; i++) ac += env[i] * env[i + lag];
    // Log-Gaussian perceptual weight: 1 at idealLag, falling off
    // symmetrically in log-tempo space.
    const logRatio = Math.log2(lag / idealLag);
    const weight = Math.exp(-0.5 * (logRatio / TEMPO_PRIOR_WIDTH) * (logRatio / TEMPO_PRIOR_WIDTH));
    const score = ac * weight;
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  return bestLag;
}

// ---------------------------------------------------------------------------
// Ellis dynamic-programming beat tracker
// ---------------------------------------------------------------------------

function beatTrackDP(
  env: Float64Array, periodHops: number, tightness: number,
): number[] {
  const n = env.length;
  if (n < 3 || periodHops < 2) return [];

  // Only predecessors within ~half..2x the ideal period can win — the
  // penalty is too steep outside that. Keeps the DP O(n*window).
  const searchLo = Math.max(1, Math.round(periodHops * 0.5));
  const searchHi = Math.round(periodHops * 2.0);

  const score = new Float64Array(n);
  const backlink = new Int32Array(n);
  backlink.fill(-1);

  for (let i = 0; i < n; i++) {
    let bestPrevScore = -Infinity;
    let bestPrev = -1;
    const mLo = Math.max(0, i - searchHi);
    const mHi = i - searchLo;
    for (let m = mLo; m <= mHi; m++) {
      const delta = i - m;
      // P(delta) = -(log2(delta/periodHops))^2, scaled by tightness.
      const logRatio = Math.log2(delta / periodHops);
      const penalty = -tightness * logRatio * logRatio;
      const cand = score[m] + penalty;
      if (cand > bestPrevScore) { bestPrevScore = cand; bestPrev = m; }
    }
    if (bestPrev >= 0 && bestPrevScore > 0) {
      score[i] = env[i] + bestPrevScore;
      backlink[i] = bestPrev;
    } else {
      score[i] = env[i];
      backlink[i] = -1;
    }
  }

  let endIdx = 0;
  let endScore = -Infinity;
  for (let i = 0; i < n; i++) {
    if (score[i] > endScore) { endScore = score[i]; endIdx = i; }
  }
  const beats: number[] = [];
  let cur = endIdx;
  while (cur >= 0) {
    beats.push(cur);
    cur = backlink[cur];
  }
  beats.reverse();
  return beats;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** Run beat tracking on a decoded audio buffer. Returns one media-
 *  space sample position per tracked BEAT (sparse + regular, not a
 *  dense onset list) plus the inferred tempo grid. */
export function detectPeaks(buf: AudioBuffer): DetectResult {
  const sampleRate = buf.sampleRate;
  if (sampleRate <= 0 || buf.length <= 0) return { peaks: [], grid: null };

  const mono = mixToMono(buf);
  const dec = decimate(mono, sampleRate, ANALYSIS_RATE);
  const decimated = dec.signal;
  const factor = dec.factor;
  if (decimated.length < FFT_SIZE * 2) return { peaks: [], grid: null };

  const effRate = sampleRate / factor;
  const binHz = effRate / FFT_SIZE;
  const nyBin = FFT_SIZE >> 1;
  const clampBin = (hz: number) =>
    Math.max(1, Math.min(nyBin, Math.round(hz / binHz)));

  const kickFlux = bandFlux(decimated, effRate, clampBin(KICK_LO_HZ), clampBin(KICK_HI_HZ));
  const snareFlux = bandFlux(decimated, effRate, clampBin(SNARE_LO_HZ), clampBin(SNARE_HI_HZ));
  const env = onsetEnvelope(kickFlux, snareFlux);
  if (env.length < 8) return { peaks: [], grid: null };

  const hopSamples = HOP_SIZE * factor;
  const hopsPerSec = sampleRate / hopSamples;

  const periodHops = estimateTempoPeriod(env, hopsPerSec);
  const beatHops = beatTrackDP(env, periodHops, TIGHTNESS);
  if (beatHops.length < 2) return { peaks: [], grid: null };

  // Median inter-beat interval (in hops) — the grid period.
  const intervals: number[] = [];
  for (let i = 1; i < beatHops.length; i++) {
    intervals.push(beatHops[i] - beatHops[i - 1]);
  }
  const sorted = [...intervals].sort((a, b) => a - b);
  const medianInterval = sorted[sorted.length >> 1];

  // Fill the intro gap. The DP can't anchor a beat until the first
  // onset strong enough to start the chain — on a track with a quiet
  // intro that leaves the first ~second with no markers. Extrapolate
  // beats BACKWARD from the first tracked beat at the median interval.
  //
  // Bounded on purpose: a uniform extrapolated period drifts if it's
  // even slightly off, so we only walk back far enough to cover the
  // gap to frame 0 — a handful of beats, where the accumulated drift
  // is sub-frame and invisible. (Extrapolating the WHOLE track this
  // way is what drifted audibly before; this is just the intro.)
  // Count is rounded to a multiple of 4 so bar parity is preserved.
  const filledHops = [...beatHops];
  if (medianInterval > 0) {
    const first = filledHops[0];
    let nBack = Math.floor(first / medianInterval);
    nBack -= nBack % 4;                       // keep bar (4/4) parity
    for (let k = 1; k <= nBack; k++) {
      filledHops.unshift(first - k * medianInterval);
    }
  }
  // Bars: every 4th beat. After prepending a multiple of 4, the
  // original tracked beat 0 is still on a bar boundary, so offset 0.
  const barOffset = 0;

  // Local waveform refinement (the librosa `onset_backtrack` idea,
  // adapted to snap onto the visible peak).
  //
  // The DP gives the metric PULSE — regular, and sitting on the onset
  // ENVELOPE peaks. But the user reads the drawn WAVEFORM, and on a
  // sustained orchestral hit the waveform's loudest point trails the
  // envelope's onset by a few frames. Measured: ~71% of strong
  // waveform transients land within 4 frames of a beat — near, but
  // not locked, and that 2-3 frame gap is the visible mismatch.
  //
  // For each beat, search a TIGHT window of the full-spectrum
  // waveform and move the beat onto the loudest sample inside it. The
  // window is only a fraction of a beat — small enough that a beat
  // can only catch its OWN hit, never a syncopated neighbour. This is
  // the key difference from the earlier failed attempt, which used a
  // ~120ms window and jumped onto whatever was loudest anywhere near.
  const refineRadiusSamples = Math.min(
    Math.round(0.05 * sampleRate),                  // <= ~50ms each way
    Math.floor(medianInterval * hopSamples * 0.25), // <= 1/4 of a beat
  );
  const peaks = filledHops.map((h) => {
    const center = h * hopSamples;
    if (center < 0) return 0;
    const lo = Math.max(0, center - refineRadiusSamples);
    const hi = Math.min(mono.length, center + refineRadiusSamples);
    let bestI = center, bestA = -1;
    for (let i = lo; i < hi; i++) {
      const a = Math.abs(mono[i]);
      if (a > bestA) { bestA = a; bestI = i; }
    }
    return bestI;
  });

  // Confidence = fraction of intervals within 15% of the median.
  let regular = 0;
  for (const iv of intervals) {
    if (Math.abs(iv - medianInterval) <= 0.15 * medianInterval) regular++;
  }
  const confidence = intervals.length ? regular / intervals.length : 0;

  const grid: BeatGrid = {
    periodSamples: medianInterval * hopSamples,
    phaseSamples: peaks.length ? peaks[0] : 0,
    confidence,
    barOffset,
  };

  return { peaks, grid };
}
