// Multi-resolution audio peak summary. Computed once at decode time;
// the renderer picks the level that best matches the current zoom and
// walks only the visible buckets of that level.
//
// Why a pyramid: a single-resolution peak cache (e.g. 256 samples/
// bucket) goes blocky at high zoom because each bucket maps to many
// CSS pixels and the same min/max is drawn for every adjacent column.
// Premiere, Resolve, FCP, Pro Tools, Audition all use a pyramid
// (sidecar peak file) for exactly this reason. The pyramid stays in
// the doc, so it survives save/load without re-decoding.
//
// Levels: 64, 256, 1024, 4096, 16384 samples per bucket. At 44.1kHz
// that covers ~1.5ms (very fine, finest zoom) down to ~370ms (coarse,
// whole-timeline zoom-out). Each successive level is 4x coarser than
// the prior so total storage is ~1.33x the finest level (geometric
// sum). For a 3-min file at finest 64 sps that's ~700KB raw int8 /
// ~900KB base64 — under the 4MB HTTP cap and inside C4D's doc helper
// without any meaningful bloat.

export const PEAK_LEVELS = [64, 256, 1024, 4096, 16384] as const;

export interface PeakLevel {
  /** Samples per bucket at this level. */
  sps: number;
  /** Base64-encoded Int8Array of interleaved (min, max) pairs at this
   *  level's resolution. */
  b64: string;
}

export interface PeakResult {
  /** One entry per resolution level, ordered fine → coarse. */
  levels: PeakLevel[];
  /** Largest absolute peak value across all buckets at the finest
   *  level (0..127). Used by the renderer for auto-gain so quiet
   *  material fills the lane height. */
  absMax: number;
}

/** Decode an audio blob via WebAudio and compute the multi-resolution
 *  peak pyramid. Returns null on decode failure. */
export async function computePeaks(file: File): Promise<PeakResult | null> {
  let arrayBuf: ArrayBuffer;
  try {
    arrayBuf = await file.arrayBuffer();
  } catch (e) {
    console.warn('[peaks] file.arrayBuffer failed:', e);
    return null;
  }

  const Ctor: typeof AudioContext =
    (window.AudioContext) || ((window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
  if (!Ctor) {
    console.warn('[peaks] no AudioContext available');
    return null;
  }
  const ctx = new Ctor();
  let audioBuffer: AudioBuffer;
  try {
    audioBuffer = await ctx.decodeAudioData(arrayBuf);
  } catch (e) {
    console.warn('[peaks] decodeAudioData failed:', e);
    ctx.close();
    return null;
  }

  const channels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  // Mono down-mix into a single Float32Array. For stereo this is the
  // sum/2; for mono it's just channel 0.
  let mono: Float32Array;
  if (channels === 1) {
    mono = audioBuffer.getChannelData(0);
  } else {
    mono = new Float32Array(length);
    for (let ch = 0; ch < channels; ch++) {
      const data = audioBuffer.getChannelData(ch);
      for (let i = 0; i < length; i++) mono[i] += data[i];
    }
    const invCh = 1 / channels;
    for (let i = 0; i < length; i++) mono[i] *= invCh;
  }

  // Compute the finest level by walking the PCM, then each coarser
  // level by walking the prior level — 4x cheaper than re-walking PCM
  // for every level (the pyramid math is the whole point of the
  // mipmap-style storage).
  const levels: PeakLevel[] = [];
  let absMax = 0;
  let prevPeaks: Int8Array | null = null;
  let prevSps = 0;
  for (const sps of PEAK_LEVELS) {
    let peaks: Int8Array;
    if (prevPeaks === null) {
      // Finest level — walk the PCM directly.
      const bucketCount = Math.ceil(length / sps);
      peaks = new Int8Array(bucketCount * 2);
      for (let b = 0; b < bucketCount; b++) {
        const start = b * sps;
        const end = Math.min(start + sps, length);
        let mn = 1.0;
        let mx = -1.0;
        for (let i = start; i < end; i++) {
          const v = mono[i];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        if (mn < -1) mn = -1;
        if (mn > 1)  mn = 1;
        if (mx < -1) mx = -1;
        if (mx > 1)  mx = 1;
        const mnI = Math.round(mn * 127);
        const mxI = Math.round(mx * 127);
        peaks[b * 2]     = mnI;
        peaks[b * 2 + 1] = mxI;
        const a = Math.max(Math.abs(mnI), Math.abs(mxI));
        if (a > absMax) absMax = a;
      }
    } else {
      // Coarser level — walk the prior level. ratio = sps / prevSps is
      // how many prior buckets fold into one new bucket.
      const ratio = sps / prevSps;
      const prevBuckets = prevPeaks.length / 2;
      const bucketCount = Math.ceil(prevBuckets / ratio);
      peaks = new Int8Array(bucketCount * 2);
      for (let b = 0; b < bucketCount; b++) {
        const p0 = b * ratio;
        const p1 = Math.min(p0 + ratio, prevBuckets);
        let mn = 127;
        let mx = -128;
        for (let p = p0; p < p1; p++) {
          const lo = prevPeaks[p * 2];
          const hi = prevPeaks[p * 2 + 1];
          if (lo < mn) mn = lo;
          if (hi > mx) mx = hi;
        }
        peaks[b * 2]     = mn;
        peaks[b * 2 + 1] = mx;
      }
    }
    levels.push({ sps, b64: peaksToBase64(peaks) });
    prevPeaks = peaks;
    prevSps = sps;
  }

  ctx.close();
  return { levels, absMax };
}

/** Base64-encode an Int8Array. */
export function peaksToBase64(peaks: Int8Array): string {
  const bytes = new Uint8Array(peaks.buffer, peaks.byteOffset, peaks.byteLength);
  let binary = '';
  const chunk = 0x4000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

/** Decode a base64 peak string back into an Int8Array view. */
export function peaksFromBase64(b64: string): Int8Array | null {
  if (!b64) return null;
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } catch (e) {
    console.warn('[peaks] base64 decode failed:', e);
    return null;
  }
}

/** Pick the pyramid level best matching the current zoom.
 *
 *  Rule: use the COARSEST level whose buckets are still ≤1 CSS pixel
 *  wide. That guarantees we always have at least 1 bucket per drawn
 *  column (no blockiness from a coarse level smearing across many
 *  pixels), while doing the minimum bucket-walk work.
 *
 *  At extreme zoom-in (where even the finest level has bucket >1 CSS
 *  pixel), fall back to the finest level — bars will visibly widen as
 *  the user zooms further, but each bucket has unique data so it
 *  stays smooth (one bucket = one wider bar = no level snap).
 *
 *  At extreme zoom-out, use the coarsest level — many samples per CSS
 *  pixel means we'd otherwise walk millions of fine buckets per
 *  frame.
 */
export function pickLevel(
  levels: PeakLevel[],
  cssPxPerSample: number,
): { sps: number; peaks: Int8Array } | null {
  if (!levels.length) return null;
  // bucketWidthCssPx at level L = L.sps * cssPxPerSample.
  // We want the LARGEST sps where bucketWidthCssPx <= 1.
  const ordered = [...levels].sort((a, b) => a.sps - b.sps);
  let chosen: PeakLevel | null = null;
  for (const lvl of ordered) {
    if (lvl.sps * cssPxPerSample <= 1) {
      chosen = lvl; // keep walking up — find the coarsest level still ≤ 1px
    } else {
      break;
    }
  }
  // Zoom-in past the finest level: nothing satisfies the ≤1px rule.
  // Use the finest level; bars will get wider as zoom continues but
  // that's smooth (no level transition).
  if (!chosen) chosen = ordered[0];
  const peaks = peaksFromBase64(chosen.b64);
  if (!peaks) return null;
  return { sps: chosen.sps, peaks };
}
