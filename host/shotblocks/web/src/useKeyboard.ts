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

      // Bracket edits relative to the playhead (After Effects model):
      //   Alt+[  trim the IN  point to the playhead (edge moves, length changes)
      //   Alt+]  trim the OUT point to the playhead
      //   [      move the WHOLE clip so its START lands on the playhead
      //   ]      move the WHOLE clip so its END   lands on the playhead
      // All four act on every selected clip (locked tracks/clips are
      // skipped by the store actions). No-op with an empty selection.
      // Checked before the bare-key tool shortcuts so the brackets
      // aren't swallowed.
      if (!mod && (ev.key === '[' || ev.key === ']')) {
        const sel = useStore.getState().selectedClipIds;
        if (sel.size === 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        const st = useStore.getState();
        const frame = Math.max(0, st.scrubFrame ?? st.currentFrame);
        const edge: 'in' | 'out' = ev.key === '[' ? 'in' : 'out';
        if (ev.altKey) {
          trimSelectionToPlayhead(sel, edge, frame);
        } else {
          moveSelectionToPlayhead(sel, edge, frame);
        }
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
      //   V → select   B → blade (razor)   S → slip   P → pen
      //   H → hand      Z → zoom
      // Premiere-style: the tool stays active after the key press
      // until the user picks another one.
      if (!mod && !ev.altKey && !ev.shiftKey) {
        let toolId: 'select' | 'razor' | 'slip' | 'pen' | 'hand' | 'zoom' | null = null;
        if (ev.key === 'v' || ev.key === 'V') toolId = 'select';
        else if (ev.key === 'b' || ev.key === 'B') toolId = 'razor';
        else if (ev.key === 's' || ev.key === 'S') toolId = 'slip';
        else if (ev.key === 'p' || ev.key === 'P') toolId = 'pen';
        else if (ev.key === 'h' || ev.key === 'H') toolId = 'hand';
        else if (ev.key === 'z' || ev.key === 'Z') toolId = 'zoom';
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

      // M → drop a marker at the current playhead frame. NLE-standard
      // shortcut (Premiere, Resolve, Final Cut). Frame is the scrubbed
      // frame if a scrub is in flight, otherwise the C++ tick frame.
      if (!mod && !ev.altKey && !ev.shiftKey && (ev.key === 'm' || ev.key === 'M')) {
        ev.preventDefault();
        const st = useStore.getState();
        const frame = st.scrubFrame ?? st.currentFrame;
        st.addMarker(frame);
        return;
      }

      // Shift+M → toggle marker visibility (mirrors the utilities-strip
      // Markers button). Distinct from bare M (drop a marker).
      if (!mod && !ev.altKey && ev.shiftKey && (ev.key === 'm' || ev.key === 'M')) {
        ev.preventDefault();
        useStore.getState().setMarkersVisible(!useStore.getState().markersVisible);
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

      // Delete / Backspace → delete selection. A pen-tool level-
      // keyframe selection takes priority over the clip selection.
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        const st = useStore.getState();
        const lk = st.levelKfSelection;
        if (lk && lk.indices.length) {
          ev.preventDefault();
          ev.stopPropagation();
          st.removeLevelKeyframes(lk.clipId, lk.indices);
          st.setLevelKfSelection(null);
          return;
        }
        const sel = st.selectedClipIds;
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

/** Remove every clip in `ids` from its track. Clips on a locked track
 *  are left untouched (NLE convention — a locked track ignores edits,
 *  the rest of the selection still deletes). */
function deleteSelection(ids: Set<number>) {
  const s = useStore.getState();
  const filterTrack = (t: typeof s.videoTracks[number]) =>
    t.locked ? t : { ...t, clips: t.clips.filter((c) => !ids.has(c.id)) };
  const v = s.videoTracks.map(filterTrack);
  const a = s.audioTracks.map(filterTrack);
  useStore.setState({
    videoTracks: v,
    audioTracks: a,
    selectedClipIds: new Set<number>(),
  });
}

/** Locate a clip across both sides. Returns the clip plus its track id
 *  string ('V2' / 'A1') so the store actions can be addressed. */
function findClipWithTrack(id: number):
  { clip: import('./store').Clip; trackId: string } | null {
  const s = useStore.getState();
  for (const t of s.videoTracks) {
    const clip = t.clips.find((c) => c.id === id);
    if (clip) return { clip, trackId: 'V' + t.id };
  }
  for (const t of s.audioTracks) {
    const clip = t.clips.find((c) => c.id === id);
    if (clip) return { clip, trackId: 'A' + t.id };
  }
  return null;
}

/** Alt+[ / Alt+]: trim each selected clip's in/out edge to `frame`.
 *  Reuses the store's resizeClip — same media-window, MIN_CLIP_FRAMES,
 *  locked-track, and collision rules as the edge-drag. A frame outside
 *  the clip's valid range is clamped by resizeClip (no-op if it can't
 *  move). */
function trimSelectionToPlayhead(ids: Set<number>, edge: 'in' | 'out', frame: number) {
  const resizeClip = useStore.getState().resizeClip;
  for (const id of ids) {
    const found = findClipWithTrack(id);
    if (!found) continue;
    resizeClip(id, found.trackId, edge === 'in' ? 'left' : 'right', frame);
  }
}

/** [ / ]: slide each selected clip (length unchanged) so its start
 *  (edge='in') or end (edge='out') lands on `frame`. Reuses the store's
 *  moveClip, which handles clamping + collision. For 'out' we target an
 *  inFrame of frame - duration so the out edge hits the playhead. */
function moveSelectionToPlayhead(ids: Set<number>, edge: 'in' | 'out', frame: number) {
  const moveClip = useStore.getState().moveClip;
  for (const id of ids) {
    const found = findClipWithTrack(id);
    if (!found) continue;
    const dur = found.clip.outFrame - found.clip.inFrame;
    const newIn = edge === 'in' ? frame : frame - dur;
    if (newIn < 0) continue; // can't place the clip before frame 0
    moveClip(id, found.trackId, found.trackId, newIn);
  }
}

/** Shift every selected clip by `delta` frames. Clamps so no clip
 *  goes below frame 0; preserves relative offsets for groups. Clips
 *  on a locked track don't move (and don't constrain the clamp). */
function nudgeSelection(ids: Set<number>, delta: number) {
  const s = useStore.getState();
  if (delta === 0) return;
  // Min in across the clips that will actually move (locked-track
  // clips are excluded so they neither move nor clamp the group).
  let minIn = Infinity;
  for (const t of [...s.videoTracks, ...s.audioTracks]) {
    if (t.locked) continue;
    for (const c of t.clips) {
      if (ids.has(c.id) && c.inFrame < minIn) minIn = c.inFrame;
    }
  }
  if (!Number.isFinite(minIn)) return;
  let dx = delta;
  if (minIn + dx < 0) dx = -minIn;
  if (dx === 0) return;
  const shift = (t: typeof s.videoTracks[number]) =>
    t.locked ? t : {
      ...t,
      clips: t.clips.map((c) => ids.has(c.id)
        ? { ...c, inFrame: c.inFrame + dx, outFrame: c.outFrame + dx }
        : c),
    };
  useStore.setState({
    videoTracks: s.videoTracks.map(shift),
    audioTracks: s.audioTracks.map(shift),
  });
}
