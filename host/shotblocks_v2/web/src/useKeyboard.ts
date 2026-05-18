import { useEffect } from 'react';
import { useStore } from './store';
import { send } from './lib/host';

/** Keyboard shortcuts for the timeline:
 *    - Delete / Backspace: remove all clips in the current selection.
 *    - Arrow keys: nudge selected clips by 1 frame (Shift = 10 frames).
 *    - Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z / Cmd/Ctrl+Y: NOT handled here —
 *      we let C4D's native undo system swallow these so it can roll back
 *      the helper BaseObject (which fires EVMSG_CHANGE → state-changed
 *      → JS reload). See usePersistence.ts.
 *
 *  Diagnostic logging is intentionally still in place — keyboard
 *  routing through the docked HtmlViewer panel into the WebView2 is
 *  known-flaky in C4D 2026, and this is the first round wiring it up.
 *  Remove the console.log once we've confirmed events arrive
 *  consistently. */
export function useKeyboard(): void {
  useEffect(() => {
    function onKeyDown(ev: KeyboardEvent) {
      // Don't steal text-input keys when an input/textarea has focus.
      const t = ev.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        return;
      }

      // Undo / Redo — forward to C4D's native undo. WebView2 swallows
      // Ctrl+Z before C4D's menu system sees it, so we explicitly
      // tell C++ to call doc->DoUndo() / DoRedo(). C++ writes the
      // helper back, EVMSG_CHANGE fires, state-changed routes back to
      // JS, and the timeline rolls back.
      const mod = ev.ctrlKey || ev.metaKey;
      if (mod && (ev.key === 'z' || ev.key === 'Z')) {
        ev.preventDefault();
        ev.stopPropagation();
        void send({ kind: ev.shiftKey ? 'redo' : 'undo' });
        return;
      }
      if (mod && (ev.key === 'y' || ev.key === 'Y')) {
        ev.preventDefault();
        ev.stopPropagation();
        void send({ kind: 'redo' });
        return;
      }

      // Cut / Copy / Paste — timeline-local clipboard. Pure JS-side,
      // no C4D round-trip. WebView2 normally lets these through when
      // no input/contenteditable has focus.
      if (mod && (ev.key === 'c' || ev.key === 'C')) {
        const sel = useStore.getState().selectedClipIds;
        if (sel.size === 0) return;
        ev.preventDefault();
        useStore.getState().copyClips(sel);
        return;
      }
      if (mod && (ev.key === 'x' || ev.key === 'X')) {
        const sel = useStore.getState().selectedClipIds;
        if (sel.size === 0) return;
        ev.preventDefault();
        useStore.getState().cutClips(sel);
        return;
      }
      if (mod && (ev.key === 'v' || ev.key === 'V')) {
        if (useStore.getState().clipboard.length === 0) return;
        ev.preventDefault();
        useStore.getState().pasteClips();
        return;
      }

      // Delete / Backspace → delete selection.
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        const sel = useStore.getState().selectedClipIds;
        if (sel.size === 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        deleteSelection(sel);
        return;
      }

      // Arrow keys → nudge selection (1 frame, Shift = 10).
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
        const sel = useStore.getState().selectedClipIds;
        if (sel.size === 0) return;
        ev.preventDefault();
        const dir = ev.key === 'ArrowLeft' ? -1 : 1;
        const step = ev.shiftKey ? 10 : 1;
        nudgeSelection(sel, dir * step);
        return;
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

/** Remove every clip in `ids` from its track. Tracks that empty out
 *  beyond V1/A1 are culled by the same rule moveClip uses. */
function deleteSelection(ids: Set<number>) {
  const s = useStore.getState();
  const filterTrack = (t: typeof s.videoTracks[number]) => ({
    ...t,
    clips: t.clips.filter((c) => !ids.has(c.id)),
  });
  const v = s.videoTracks.map(filterTrack).filter((t) => t.id === 1 || t.clips.length > 0);
  const a = s.audioTracks.map(filterTrack).filter((t) => t.id === 1 || t.clips.length > 0);
  useStore.setState({
    videoTracks: v,
    audioTracks: a,
    selectedClipIds: new Set<number>(),
  });
}

/** Shift every selected clip by `delta` frames. Clamps so no clip
 *  goes below frame 0; preserves relative offsets for groups. */
function nudgeSelection(ids: Set<number>, delta: number) {
  const s = useStore.getState();
  if (delta === 0) return;
  // Min in across selected so we can clamp the group.
  let minIn = Infinity;
  for (const t of [...s.videoTracks, ...s.audioTracks]) {
    for (const c of t.clips) {
      if (ids.has(c.id) && c.inFrame < minIn) minIn = c.inFrame;
    }
  }
  if (!Number.isFinite(minIn)) return;
  let dx = delta;
  if (minIn + dx < 0) dx = -minIn;
  if (dx === 0) return;
  const shift = (t: typeof s.videoTracks[number]) => ({
    ...t,
    clips: t.clips.map((c) => ids.has(c.id)
      ? { ...c, inFrame: c.inFrame + dx, outFrame: c.outFrame + dx }
      : c),
  });
  useStore.setState({
    videoTracks: s.videoTracks.map(shift),
    audioTracks: s.audioTracks.map(shift),
  });
}
