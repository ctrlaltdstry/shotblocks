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

      // Spacebar → toggle C4D playback. Standard NLE shortcut. We
      // forward to C++ which calls CallCommand(12412); C4D drives the
      // playhead via EVMSG_TIMECHANGED and our existing tick stream
      // routes the frame updates back to JS.
      if (ev.key === ' ' || ev.code === 'Space') {
        ev.preventDefault();
        ev.stopPropagation();
        void send({ kind: 'toggle-play' });
        return;
      }

      // I → set play-range in at playhead. O → set play-range out at
      // playhead. NLE standard. Bare keys (no modifier). Mirrors
      // Python's _on_keyboard handler (sb_canvas.py:2470).
      if (!mod && !ev.altKey && (ev.key === 'i' || ev.key === 'I')) {
        ev.preventDefault();
        const s = useStore.getState();
        const frame = s.scrubFrame ?? s.currentFrame;
        const newIn  = Math.max(0, Math.min(frame, s.playRangeOut - 1));
        s.setPlayRange(newIn, s.playRangeOut);
        void send({ kind: 'set-play-range', inFrame: newIn, outFrame: s.playRangeOut });
        return;
      }
      if (!mod && !ev.altKey && (ev.key === 'o' || ev.key === 'O')) {
        ev.preventDefault();
        const s = useStore.getState();
        const frame = s.scrubFrame ?? s.currentFrame;
        const newOut = Math.max(s.playRangeIn + 1, Math.min(frame, s.docFrames));
        s.setPlayRange(s.playRangeIn, newOut);
        void send({ kind: 'set-play-range', inFrame: s.playRangeIn, outFrame: newOut });
        return;
      }
      // `/` → reset the play range to the full timeline (0 → docFrames).
      if (!mod && !ev.altKey && ev.key === '/') {
        ev.preventDefault();
        const s = useStore.getState();
        s.setPlayRange(0, s.docFrames);
        void send({ kind: 'set-play-range', inFrame: 0, outFrame: s.docFrames });
        return;
      }
      // `Shift+/` (which the keyboard reports as `?`) → set play-range
      // to the selection (or all clips if nothing is selected).
      // Mirrors Python's _range_to_selection_or_all (sb_canvas.py:2576).
      if (!mod && !ev.altKey && ev.key === '?') {
        ev.preventDefault();
        rangeToSelectionOrAll(useStore.getState());
        return;
      }

      // Tool shortcuts — bare keys, NLE-standard letters. Mirror the
      // tool-palette buttons: set the store tool + tell C++.
      //   V → select   B → blade (razor)   S → slip
      if (!mod && !ev.altKey && !ev.shiftKey) {
        let toolId: 'select' | 'razor' | 'slip' | null = null;
        if (ev.key === 'v' || ev.key === 'V') toolId = 'select';
        else if (ev.key === 'b' || ev.key === 'B') toolId = 'razor';
        else if (ev.key === 's' || ev.key === 'S') toolId = 'slip';
        if (toolId) {
          ev.preventDefault();
          useStore.getState().setActiveTool(toolId);
          void send({ kind: 'tool', id: toolId });
          return;
        }
      }

      // N → toggle Snap (mirrors the utilities-strip Snap button).
      if (!mod && !ev.altKey && !ev.shiftKey && (ev.key === 'n' || ev.key === 'N')) {
        ev.preventDefault();
        useStore.getState().setSnapEnabled(!useStore.getState().snapEnabled);
        return;
      }

      // Shift+L → toggle Loop (mirrors the utilities-strip Loop button).
      if (!mod && !ev.altKey && ev.shiftKey && (ev.key === 'l' || ev.key === 'L')) {
        ev.preventDefault();
        const next = !useStore.getState().loopEnabled;
        useStore.getState().setLoopEnabled(next);
        void send({ kind: 'set-loop', enabled: next });
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

/** Compute the bounding [in, out] frame range over the current
 *  selection (or all clips on every track if nothing is selected),
 *  then write it as the new play range. Out frame is exclusive in
 *  the v2 model — we use the rightmost clip's outFrame directly. */
function rangeToSelectionOrAll(s: ReturnType<typeof useStore.getState>) {
  const sel = s.selectedClipIds;
  const tracks = [...s.videoTracks, ...s.audioTracks];
  let minIn = Infinity;
  let maxOut = -Infinity;
  const useSelection = sel.size > 0;
  for (const t of tracks) {
    for (const c of t.clips) {
      if (useSelection && !sel.has(c.id)) continue;
      if (c.inFrame < minIn)  minIn = c.inFrame;
      if (c.outFrame > maxOut) maxOut = c.outFrame;
    }
  }
  if (!Number.isFinite(minIn) || !Number.isFinite(maxOut)) return;
  const newIn  = Math.max(0, minIn | 0);
  const newOut = Math.max(newIn + 1, Math.min(maxOut | 0, s.docFrames));
  s.setPlayRange(newIn, newOut);
  void send({ kind: 'set-play-range', inFrame: newIn, outFrame: newOut });
}

/** Remove every clip in `ids` from its track. Tracks that empty out
 *  beyond V1/A1 are culled by the same rule moveClip uses. */
function deleteSelection(ids: Set<number>) {
  const s = useStore.getState();
  const filterTrack = (t: typeof s.videoTracks[number]) => ({
    ...t,
    clips: t.clips.filter((c) => !ids.has(c.id)),
  });
  const v = s.videoTracks.map(filterTrack);
  const a = s.audioTracks.map(filterTrack);
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
