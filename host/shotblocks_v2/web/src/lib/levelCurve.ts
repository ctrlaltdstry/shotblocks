/** Pen-tool volume-curve evaluation.
 *
 *  A clip's level automation is a sorted list of LevelKeyframe nodes.
 *  This module turns that list into a gain (0..1) at any media-space
 *  audio frame — for both the rendered waveform (ducking) and the
 *  WebAudio playback gain.
 *
 *  Each node carries the cubic-bezier shaping the segment to the NEXT
 *  node (the CSS-easing model). 'hold' is a step. Before the first
 *  node / after the last the curve flatlines at the nearest node's
 *  gain (mirrors Python's evaluate_level). */

import type { LevelKeyframe } from '../store';

/** Solve a cubic-bezier easing y for a given x. The bezier's two
 *  control points are (x1,y1) and (x2,y2); the endpoints are fixed at
 *  (0,0) and (1,1). Standard CSS `cubic-bezier()` semantics. */
export function cubicBezierEase(
  x1: number, y1: number, x2: number, y2: number, x: number,
): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // Bezier component as a function of the curve parameter t.
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  // Newton-Raphson to invert x(t) = x, then read y(t).
  let t = x;
  for (let i = 0; i < 8; i++) {
    const dx = sampleX(t) - x;
    if (Math.abs(dx) < 1e-6) break;
    const d = sampleDX(t);
    if (Math.abs(d) < 1e-6) break;
    t -= dx / d;
  }
  t = Math.max(0, Math.min(1, t));
  return sampleY(t);
}

/** Gain (0..1) at media-frame `af` for a sorted keyframe list.
 *  Empty list → unity. */
export function evaluateLevel(keyframes: LevelKeyframe[] | undefined, af: number): number {
  if (!keyframes || keyframes.length === 0) return 1;
  // Flatline outside the node range.
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
  const span = b.af - a.af;
  if (span <= 0) return clampGain(b.gain);
  const t = (af - a.af) / span;          // 0..1 across the segment
  if (a.interp === 'hold') return clampGain(a.gain);
  // The ease maps normalized time → normalized progress; progress
  // then lerps the two node gains.
  const [x1, y1, x2, y2] = a.ease;
  const progress = cubicBezierEase(x1, y1, x2, y2, t);
  return clampGain(a.gain + (b.gain - a.gain) * progress);
}

function clampGain(g: number): number {
  return g < 0 ? 0 : g > 1 ? 1 : g;
}
