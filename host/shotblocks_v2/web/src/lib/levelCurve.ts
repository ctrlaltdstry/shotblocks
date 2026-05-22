/** Pen-tool volume-curve evaluation.
 *
 *  A clip's level automation is a sorted list of LevelKeyframe nodes.
 *  This module turns that list into a gain (0..1) at any media-space
 *  audio frame — for both the rendered waveform (ducking) and the
 *  WebAudio playback gain.
 *
 *  Per-node bezier (After Effects model): a segment A->B is a cubic
 *  with endpoints (A.af,A.gain) and (B.af,B.gain), and control points
 *    P1 = A + A.outTan scaled by the segment span
 *    P2 = B - B.inTan  scaled by the segment span
 *  Tangents are stored segment-normalized (tx = fraction of the
 *  segment's time span, ty = fraction of its gain span).
 *
 *  'hold' is a step. Before the first node / after the last the curve
 *  flatlines at the nearest node's gain. */

import type { LevelKeyframe } from '../store';

/** Solve a 1-D cubic bezier value at parameter t (0..1), endpoints
 *  p0 and p3, controls p1 and p2. */
function cubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0
    + 3 * u * u * t * p1
    + 3 * u * t * t * p2
    + t * t * t * p3;
}

/** Gain (0..1) at media-frame `af` for a sorted keyframe list.
 *  Empty list -> unity. */
export function evaluateLevel(keyframes: LevelKeyframe[] | undefined, af: number): number {
  if (!keyframes || keyframes.length === 0) return 1;
  if (af <= keyframes[0].af) return clampGain(keyframes[0].gain);
  const last = keyframes[keyframes.length - 1];
  if (af >= last.af) return clampGain(last.gain);
  // Find the segment [a, b] containing `af`.
  let a = keyframes[0];
  let b = keyframes[1];
  for (let i = 0; i < keyframes.length - 1; i++) {
    if (af >= keyframes[i].af && af <= keyframes[i + 1].af) {
      a = keyframes[i];
      b = keyframes[i + 1];
      break;
    }
  }
  if (a.interp === 'hold') return clampGain(a.gain);
  const spanAf = b.af - a.af;
  if (spanAf <= 0) return clampGain(b.gain);
  const spanGain = b.gain - a.gain;
  // Cubic control points in (af, gain) space.
  const p1af = a.af + a.outTan.tx * spanAf;
  const p1g  = a.gain + a.outTan.ty * spanGain;
  const p2af = b.af - b.inTan.tx * spanAf;
  const p2g  = b.gain - b.inTan.ty * spanGain;
  // Find t where the bezier's af equals the target, then read gain.
  // Newton-Raphson, seeded with the linear estimate.
  let t = (af - a.af) / spanAf;
  for (let i = 0; i < 8; i++) {
    const cx = cubic(a.af, p1af, p2af, b.af, t) - af;
    if (Math.abs(cx) < 1e-3) break;
    // d/dt of the cubic.
    const u = 1 - t;
    const d = 3 * u * u * (p1af - a.af)
      + 6 * u * t * (p2af - p1af)
      + 3 * t * t * (b.af - p2af);
    if (Math.abs(d) < 1e-6) break;
    t -= cx / d;
  }
  t = Math.max(0, Math.min(1, t));
  return clampGain(cubic(a.gain, p1g, p2g, b.gain, t));
}

function clampGain(g: number): number {
  return g < 0 ? 0 : g > 1 ? 1 : g;
}
