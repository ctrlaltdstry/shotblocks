import { useStore } from '../store';
import { Scrollbar } from './Scrollbar';

/** Horizontal scrollbar — overlay on the stage's bottom edge. Renders
 *  ONLY while the timeline is zoomed in (the visible window is a
 *  strict subset of the full range); at full zoom-out there's nothing
 *  to pan, so no scrollbar shows. */
export function HScroll() {
  const h = useStore((s) => s.h);
  const setHVisible = useStore((s) => s.setHVisible);
  const zoomedIn = h.vMin > h.min || h.vMax < h.max;
  if (!zoomedIn) return null;
  return (
    <div className="h-scroll">
      <Scrollbar axis="x" window={h} minSpan={4} onChange={setHVisible} />
    </div>
  );
}

/** Vertical scrollbar for one side of the V/A split — overlay on the
 *  stage's right edge. Renders ONLY when that side's tracks overflow
 *  the visible region (real pan distance exists). A zoomed-but-still-
 *  fitting view has nowhere to pan, so no scrollbar shows. Pan-only —
 *  vertical zoom is Alt+RMB drag. */
export function VScroll({ which, overflows }: { which: 'video' | 'audio'; overflows: boolean }) {
  const win = useStore((s) => which === 'video' ? s.vVideo : s.vAudio);
  const setter = useStore((s) => which === 'video' ? s.setVVideoVisible : s.setVAudioVisible);
  if (!overflows) return null;
  return (
    <div className={'v-scroll v-scroll--' + which}>
      <Scrollbar
        axis="y"
        window={win}
        minSpan={0.1}
        onChange={setter}
        // Video stack is bottom-up (V1 bottom, V<max> top), so the
        // scrollbar reads naturally only inverted: thumb-at-top maps
        // to V<max> being visible.
        invert={which === 'video'}
      />
    </div>
  );
}
