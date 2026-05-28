import { useState } from 'react';
import { useStore } from '../store';

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

/** Live readout in the topbar. Reads currentFrame + fps directly from
 *  the store; re-renders only when one of those two values changes.
 *  Ctrl/Cmd-click toggles between HH:MM:SS:FF timecode and a raw frame
 *  number — After Effects' timecode/frames switch. */
export function Timecode() {
  // Prefer the optimistic scrub frame so the readout updates every
  // frame during a drag — matching the playhead/ruler (which also use
  // scrubFrame ?? currentFrame). Reading currentFrame alone makes the
  // numbers jump in groups because C++'s tick echo is slower than the
  // pointermove rate.
  const currentFrame = useStore((s) => s.currentFrame);
  const scrubFrame = useStore((s) => s.scrubFrame);
  const frame = scrubFrame ?? currentFrame;
  const fps = useStore((s) => s.fps);
  const [showFrames, setShowFrames] = useState(false);
  const text = showFrames
    ? String(Math.max(0, frame | 0))
    : formatTimecode(frame, fps);
  return (
    <div
      className="topbar__timecode"
      title="Ctrl-click to toggle timecode / frames"
      onClick={(e) => { if (e.ctrlKey || e.metaKey) setShowFrames((v) => !v); }}
    >
      {text}
    </div>
  );
}
