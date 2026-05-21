// Per-channel dBFS RMS envelope for the rail dB meter.
//
// Ports sb_audio_meter.py: builds an RMS-over-time envelope from a
// decoded AudioBuffer, sampled at the playhead's audio position to
// drive the meter. Per-channel (L/R) — the meter shows a stereo pair.
//
// Window: ENVELOPE_WIN_MS per entry. A longer window than a peak
// meter would use — it reads the SUSTAINED level so the bar reads
// steady (VU-style) rather than bouncing on every transient.
// ~9k float entries per channel on a 3-min file. Built lazily,
// cached per mediaId.

/** Window one envelope entry RMS-averages over. 60ms — VU-ish: long
 *  enough to average out transients into a steady reading. */
const ENVELOPE_WIN_MS = 60;

/** dBFS floor — silence (or below) clamps here; also avoids log10(0). */
export const FLOOR_DBFS = -60;

export interface MeterEnvelope {
  /** dBFS per window entry, one Float32Array per channel (1 or 2). */
  channels: Float32Array[];
  /** Audio sample-frames covered by one entry. */
  samplesPerEntry: number;
  /** Source sample rate, for doc-frame → audio-frame mapping. */
  sampleRate: number;
}

const cache = new Map<number, MeterEnvelope>();

/** Build (or fetch cached) the per-channel RMS dBFS envelope for a
 *  decoded buffer, keyed by mediaId. Channels capped at 2 (L/R). */
export function getMeterEnvelope(mediaId: number, buf: AudioBuffer): MeterEnvelope {
  const hit = cache.get(mediaId);
  if (hit) return hit;

  const sampleRate = buf.sampleRate;
  const nFrames = buf.length;
  const nMeterCh = Math.min(2, Math.max(1, buf.numberOfChannels));
  const samplesPerEntry = Math.max(1, Math.round((ENVELOPE_WIN_MS / 1000) * sampleRate));
  const nEntries = Math.ceil(nFrames / samplesPerEntry);

  const channels: Float32Array[] = [];
  for (let c = 0; c < nMeterCh; c++) {
    const src = buf.getChannelData(c);
    const db = new Float32Array(nEntries).fill(FLOOR_DBFS);
    for (let e = 0; e < nEntries; e++) {
      const f0 = e * samplesPerEntry;
      const f1 = Math.min(nFrames, f0 + samplesPerEntry);
      if (f1 <= f0) continue;
      let ssq = 0;
      for (let f = f0; f < f1; f++) {
        const v = src[f];
        ssq += v * v;
      }
      const meanSq = ssq / (f1 - f0);
      if (meanSq <= 0) continue;
      const rms = Math.sqrt(meanSq);        // 0..1 (Float32 PCM)
      let d = 20 * Math.log10(rms);
      if (d < FLOOR_DBFS) d = FLOOR_DBFS;
      else if (d > 0) d = 0;
      db[e] = d;
    }
    channels.push(db);
  }

  const env: MeterEnvelope = { channels, samplesPerEntry, sampleRate };
  cache.set(mediaId, env);
  return env;
}

/** Per-channel dBFS at an audio-frame position. Returns one value per
 *  channel; out-of-range clamps to FLOOR. */
export function sampleEnvelope(env: MeterEnvelope, audioFrame: number): number[] {
  const idx = Math.floor(audioFrame / env.samplesPerEntry);
  return env.channels.map((db) =>
    (idx >= 0 && idx < db.length) ? db[idx] : FLOOR_DBFS);
}

/** Drop a cached envelope when its media is removed. */
export function dropMeterEnvelope(mediaId: number): void {
  cache.delete(mediaId);
}
