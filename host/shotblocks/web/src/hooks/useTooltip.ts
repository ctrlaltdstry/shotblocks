import { useEffect } from 'react';

/** Global custom-tooltip controller. Renders ONE tooltip element into
 *  document.body and drives it off the same `data-tooltip` /
 *  `data-tooltip-pos` attributes the old pure-CSS `::after` tooltip used —
 *  so every existing call site keeps working unchanged. Portaling to
 *  <body> is the whole point: a CSS `::after` can't escape an ancestor
 *  with `overflow: hidden` (the track headers, the stage, the rail all
 *  clip), so those tooltips were silently swallowed. A body-level element
 *  is clipped by nothing.
 *
 *  Behaviour mirrors the previous CSS: dark pill, 350ms appear delay,
 *  instant hide, positioned right/below/below-left/left/above relative to
 *  the hovered element. Default position is "right" (the left rail).
 *
 *  This is the project's DEFAULT tooltip mechanism — any new feature that
 *  needs a tooltip just adds `data-tooltip="..."` (+ optional
 *  `data-tooltip-pos`) and gets this styling for free. Do NOT use the
 *  native `title` attribute. */

type Pos = 'right' | 'below' | 'below-left' | 'left' | 'above';
const APPEAR_DELAY_MS = 350;
const GAP = 12;      // px offset for right/left
const GAP_V = 10;    // px offset for below/above

let el: HTMLDivElement | null = null;
function ensureEl(): HTMLDivElement {
  if (el) return el;
  el = document.createElement('div');
  el.className = 'sb-tooltip';
  el.setAttribute('role', 'tooltip');
  document.body.appendChild(el);
  return el;
}

function place(target: HTMLElement, pos: Pos) {
  const tip = ensureEl();
  const r = target.getBoundingClientRect();
  // Measure the tip after its text is set (caller sets textContent first).
  const tr = tip.getBoundingClientRect();
  let left = 0;
  let top = 0;
  switch (pos) {
    case 'below':
      left = r.left + r.width / 2 - tr.width / 2;
      top = r.bottom + GAP_V;
      break;
    case 'below-left':
      left = r.left;
      top = r.bottom + GAP_V;
      break;
    case 'left':
      left = r.left - GAP - tr.width;
      top = r.top + r.height / 2 - tr.height / 2;
      break;
    case 'above':
      left = r.left + r.width / 2 - tr.width / 2;
      top = r.top - GAP_V - tr.height;
      break;
    case 'right':
    default:
      left = r.right + GAP;
      top = r.top + r.height / 2 - tr.height / 2;
      break;
  }
  // Keep the pill on-screen — nudge horizontally if it would clip.
  const margin = 4;
  const maxLeft = window.innerWidth - tr.width - margin;
  if (left > maxLeft) left = maxLeft;
  if (left < margin) left = margin;
  tip.style.left = Math.round(left) + 'px';
  tip.style.top = Math.round(top) + 'px';
}

export function useTooltip() {
  useEffect(() => {
    let current: HTMLElement | null = null;
    let timer: number | undefined;

    const hide = () => {
      if (timer) { clearTimeout(timer); timer = undefined; }
      current = null;
      if (el) el.classList.remove('is-visible');
    };

    const onOver = (ev: PointerEvent) => {
      const t = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-tooltip]');
      if (!t) { if (current) hide(); return; }
      if (t === current) return;
      hide();
      current = t;
      const text = t.getAttribute('data-tooltip') ?? '';
      if (!text) return;
      const pos = (t.getAttribute('data-tooltip-pos') as Pos) || 'right';
      timer = window.setTimeout(() => {
        // Re-check the element is still hovered (pointer may have left
        // during the delay; onOut clears `current`).
        if (current !== t) return;
        const tip = ensureEl();
        tip.textContent = text;
        // Show first (so it has size to measure) then position.
        tip.classList.add('is-visible');
        place(t, pos);
      }, APPEAR_DELAY_MS);
    };

    const onOut = (ev: PointerEvent) => {
      const related = ev.relatedTarget as HTMLElement | null;
      if (current && (!related || !current.contains(related))) hide();
    };

    // Scroll/wheel/pointerdown all invalidate the anchored position —
    // just hide rather than chase it.
    document.addEventListener('pointerover', onOver, true);
    document.addEventListener('pointerout', onOut, true);
    document.addEventListener('pointerdown', hide, true);
    window.addEventListener('wheel', hide, true);
    window.addEventListener('blur', hide);

    return () => {
      hide();
      document.removeEventListener('pointerover', onOver, true);
      document.removeEventListener('pointerout', onOut, true);
      document.removeEventListener('pointerdown', hide, true);
      window.removeEventListener('wheel', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, []);
}
