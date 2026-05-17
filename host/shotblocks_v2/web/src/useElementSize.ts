import { useEffect, useState, type RefObject } from 'react';

/** Subscribes to ResizeObserver for the given ref. Returns the current
 *  contentRect width/height (0/0 until first observation). */
export function useElementSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Seed with current size so the first render after mount isn't 0/0.
    const r = el.getBoundingClientRect();
    setSize({ width: r.width, height: r.height });
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (!e) return;
      const rect = e.contentRect;
      setSize({ width: rect.width, height: rect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}
