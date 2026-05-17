import { create } from 'zustand';

export type ToolId = 'select' | 'razor' | 'pen' | 'range';
export type ClipState = 'unselected' | 'selected' | 'orphaned' | 'orphaned-selected' | 'locked';

export interface Clip {
  id: number;
  inFrame: number;
  outFrame: number;
  /** Original C4D object name for display + future reconciliation. */
  sourceName: string;
  /** C4D type ID, e.g. 5103 (Ocamera) or 1057516 (v1 rig). */
  sourceType: number;
  state: ClipState;
  /** Per-clip lock (independent of track lock). */
  locked: boolean;
}

export interface Track {
  id: number;
  name: string;
  clips: Clip[];
}

/** Ghost preview of an OM drop that's being hovered. Cleared on
 *  om-cancel or after om-drop creates a real clip. */
export interface DragPreview {
  trackId: string;        // e.g. 'V1' — which track the cursor is over
  inFrame: number;        // computed from cursor X
  outFrame: number;       // inFrame + duration
  sourceName: string;     // for the label inside the ghost
}

// Authoritative app state. C++ is the source of truth for fps/frame/
// docFrames; everything else (visible window, tool, V/A share, tracks)
// lives here. Components subscribe via selectors so each one only
// re-renders when its slice changes.

export interface ScrollWindow {
  min: number;
  max: number;
  vMin: number;
  vMax: number;
}

export interface State {
  // From C++
  fps: number;
  docFrames: number;
  currentFrame: number;
  playing: boolean;

  // Optimistic scrub override. When non-null, the UI renders the
  // playhead at this frame instead of currentFrame — gives instant
  // visual feedback during scrub even though C++ tick echoes lag.
  // The store still tracks currentFrame from C++; we just don't
  // *render* it while a scrub is active.
  scrubFrame: number | null;

  // Scrollbar windows (vMin..vMax visible over min..max).
  // h = horizontal time in frames.
  // vVideo / vAudio = vertical "track slot" units. Fractional values
  // allowed — vMax - vMin < 1 means a track is zoomed beyond its
  // natural height and overflows the side region.
  h: ScrollWindow;
  vVideo: ScrollWindow;
  vAudio: ScrollWindow;

  // V/A divider position (0..1, how much of the vertical body goes
  // to the video side). 0.5 = centered. Drives both the lanes stack
  // and the headers stack via flex-grow CSS vars.
  vaShare: number;

  // Currently active tool palette tool. Drives `.is-active` styling
  // and gets sent to C++ so it can drive whatever editing semantics
  // the tool implies (none wired yet).
  activeTool: ToolId;

  // Tracks. Index 0 = closest to the V/A divider (V1 / A1). New tracks
  // are added at the outer ends. Auto-create / auto-remove on clip
  // drag rather than via explicit UI buttons (see memory
  // project_v2_auto_track_lifecycle).
  videoTracks: Track[];
  audioTracks: Track[];

  // Drop ghost shown while the user is dragging from the OM. Null when
  // no drag is in progress or the drag is outside our drop targets.
  dragPreview: DragPreview | null;

  // Per-clip edge hover. Keyed as `${clipId}:left` / `${clipId}:right`.
  // The Lane computes this on pointermove — when the cursor is at a
  // seam where two clips meet, BOTH edges land in the set so both
  // clips render their bracket (the "double" look the user expects).
  edgeHover: Set<string>;

  // Actions
  setTick: (frame: number, fps: number, playing: boolean) => void;
  setDocInfo: (fps: number, docFrames: number) => void;
  setHVisible: (vMin: number, vMax: number) => void;
  setVVideoVisible: (vMin: number, vMax: number) => void;
  setVAudioVisible: (vMin: number, vMax: number) => void;
  setVaShare: (share: number) => void;
  setActiveTool: (tool: ToolId) => void;
  setScrubFrame: (frame: number | null) => void;

  /** Append a clip to the named track (e.g. 'V1' or 'A2'). Returns
   *  the assigned clip id, or null if the track doesn't exist. */
  addClip: (trackId: string, clip: Omit<Clip, 'id'>) => number | null;

  setDragPreview: (preview: DragPreview | null) => void;
  setEdgeHover: (edges: Set<string>) => void;
}

/** Monotonic clip id. Unique across all tracks for the session. */
let nextClipId = 1;

/** Place a new clip on the timeline without overlapping existing clips.
 *  Snaps flush against an adjacent clip when the drop lands within
 *  SNAP_FRAMES of an existing edge — matches NLE convention where
 *  near-edge drops chain into a continuous strip.
 *  outFrame is exclusive (clip occupies [inFrame, outFrame)), so two
 *  clips can share an exact frame boundary (A.outFrame === B.inFrame)
 *  with no overlap and no gap.
 *  Returns the inFrame / outFrame that should be used. */
const MIN_GAP_FRAMES = 0;
const SNAP_FRAMES = 20;
function findFreeSlot(
  existing: Clip[],
  desiredInFrame: number,
  duration: number,
): { inFrame: number; outFrame: number } {
  const dur = Math.max(1, duration);
  const desiredOutFrame = desiredInFrame + dur;
  const sorted = [...existing].sort((a, b) => a.inFrame - b.inFrame);

  // Snap pass: if the proposed range puts our LEFT edge within
  // SNAP_FRAMES of a clip's right edge, slam it flush. If our RIGHT
  // edge is within SNAP_FRAMES of a clip's left edge, slam it flush
  // there instead. Closer snap wins.
  let bestSnap: { inFrame: number; dist: number } | null = null;
  for (const c of sorted) {
    // Snap our left edge to c's right edge (c sits to our left).
    const snapLeft = c.outFrame + MIN_GAP_FRAMES;
    const dLeft = Math.abs(desiredInFrame - snapLeft);
    if (dLeft <= SNAP_FRAMES && (!bestSnap || dLeft < bestSnap.dist)) {
      bestSnap = { inFrame: snapLeft, dist: dLeft };
    }
    // Snap our right edge to c's left edge (c sits to our right).
    const snapRightInFrame = c.inFrame - MIN_GAP_FRAMES - dur;
    const dRight = Math.abs(desiredOutFrame - (c.inFrame - MIN_GAP_FRAMES));
    if (dRight <= SNAP_FRAMES && (!bestSnap || dRight < bestSnap.dist)) {
      bestSnap = { inFrame: snapRightInFrame, dist: dRight };
    }
  }

  // Build candidate gaps for collision check + snap validation.
  const gaps: Array<{ start: number; end: number }> = [];
  let cursor = -Infinity;
  for (const c of sorted) {
    gaps.push({ start: cursor, end: c.inFrame - MIN_GAP_FRAMES });
    cursor = c.outFrame + MIN_GAP_FRAMES;
  }
  gaps.push({ start: cursor, end: Infinity });

  function fitsInAnyGap(inF: number): boolean {
    return gaps.some((g) => inF >= g.start && inF + dur <= g.end);
  }

  // If snap target fits, use it.
  if (bestSnap && fitsInAnyGap(bestSnap.inFrame)) {
    return { inFrame: Math.max(0, bestSnap.inFrame), outFrame: Math.max(0, bestSnap.inFrame) + dur };
  }

  // Otherwise, original "nearest free gap" placement. Closest start
  // wins; clamp inside the chosen gap.
  let bestStart = desiredInFrame;
  let bestDist = Infinity;
  let placed = false;
  for (const g of gaps) {
    if (g.end - g.start < dur) continue;
    const lo = g.start;
    const hi = g.end - dur;
    const clamped = Math.max(lo, Math.min(hi, desiredInFrame));
    const dist = Math.abs(clamped - desiredInFrame);
    if (dist < bestDist) {
      bestDist = dist;
      bestStart = clamped;
      placed = true;
    }
  }
  if (!placed && sorted.length) {
    const last = sorted[sorted.length - 1];
    bestStart = last.outFrame + MIN_GAP_FRAMES;
  }
  if (bestStart < 0) bestStart = 0;
  return { inFrame: bestStart, outFrame: bestStart + dur };
}

export const useStore = create<State>((set) => ({
  fps: 30,
  docFrames: 150,
  currentFrame: 0,
  playing: false,
  scrubFrame: null,
  h:      { min: 0, max: 150, vMin: 0, vMax: 150 },
  vVideo: { min: 0, max: 1,   vMin: 0, vMax: 1   },
  vAudio: { min: 0, max: 1,   vMin: 0, vMax: 1   },
  vaShare: 0.5,
  activeTool: 'select',
  videoTracks: [{ id: 1, name: 'Video 1', clips: [] }],
  audioTracks: [{ id: 1, name: 'Audio 1', clips: [] }],
  dragPreview: null,
  edgeHover: new Set<string>(),

  setTick: (frame, fps, playing) => set((s) => ({
    currentFrame: frame,
    fps: fps > 0 ? fps : s.fps,
    playing,
  })),

  setScrubFrame: (frame) => set({ scrubFrame: frame }),

  setDocInfo: (fps, docFrames) => set((s) => {
    const wasFullView = s.h.vMin === s.h.min && s.h.vMax === s.h.max;
    const next: Partial<State> = {
      fps: fps > 0 ? fps : s.fps,
      docFrames,
    };
    if (wasFullView) {
      next.h = { min: 0, max: docFrames, vMin: 0, vMax: docFrames };
    } else {
      next.h = { ...s.h, max: docFrames };
    }
    return next;
  }),

  setHVisible: (vMin, vMax) => set((s) => ({
    h: { ...s.h, vMin, vMax },
  })),

  setVVideoVisible: (vMin, vMax) => set((s) => ({
    vVideo: { ...s.vVideo, vMin, vMax },
  })),

  setVAudioVisible: (vMin, vMax) => set((s) => ({
    vAudio: { ...s.vAudio, vMin, vMax },
  })),

  setVaShare: (share) => set({ vaShare: Math.max(0, Math.min(1, share)) }),

  setActiveTool: (tool) => set({ activeTool: tool }),

  setDragPreview: (preview) => set({ dragPreview: preview }),

  setEdgeHover: (edges) => set((s) => {
    // Cheap identity check so we don't churn renders when the set
    // didn't actually change.
    if (s.edgeHover.size === edges.size) {
      let same = true;
      for (const k of edges) if (!s.edgeHover.has(k)) { same = false; break; }
      if (same) return s;
    }
    return { edgeHover: edges };
  }),

  addClip: (trackId, clip) => {
    const id = nextClipId++;
    const side = trackId.startsWith('V') ? 'video' : trackId.startsWith('A') ? 'audio' : null;
    if (!side) return null;
    const num = parseInt(trackId.slice(1), 10);
    let added: number | null = null;
    set((s) => {
      const list = side === 'video' ? s.videoTracks : s.audioTracks;
      const idx = list.findIndex((t) => t.id === num);
      if (idx < 0) return s;
      const track = list[idx];
      // Find a non-overlapping placement closest to the requested
      // inFrame. Clips never overlap; a minimum 1-frame data gap is
      // enforced so even back-to-back placements render with the
      // 2px CSS gap intact.
      const placed = findFreeSlot(
        track.clips,
        clip.inFrame,
        clip.outFrame - clip.inFrame,
      );
      const newClip = { id, ...clip, inFrame: placed.inFrame, outFrame: placed.outFrame };
      const newTracks = list.map((t, i) => i === idx
        ? { ...t, clips: [...t.clips, newClip] }
        : t);
      added = id;
      return side === 'video'
        ? { videoTracks: newTracks }
        : { audioTracks: newTracks };
    });
    return added;
  },
}));
