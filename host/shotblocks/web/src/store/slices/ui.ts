import type { StateCreator } from 'zustand';
import type { State } from '../../store';
import type { DragPreview, ToolId } from '../types';

/** UI / interaction state — what the user sees and is doing, separate
 *  from the timeline data and from the playback transport. Includes
 *  the active tool, modal panel visibility, transient drag/hover
 *  state, and the right-click menu. */
export interface UiSlice {
  activeTool: ToolId;
  audioScrub: boolean;
  inspectorOpen: boolean;
  snapEnabled: boolean;
  snapIndicatorFrames: number[];
  detectingBeats: boolean;
  beatGridVisible: boolean;
  altHeld: boolean;
  altRmbZooming: boolean;

  dragPreview: DragPreview | null;
  slipDragging: boolean;
  rollEditActive: boolean;
  rangeHandleDragging: boolean;
  spawnGhost: { side: 'video' | 'audio'; trackId: string } | null;
  razorHoverX: number | null;
  razorHoverClipBand: { top: number; bottom: number } | null;

  contextMenu: {
    x: number;
    y: number;
    targetClipId: number | null;
    targetTrackId: string | null;
    targetLevelKf?: { clipId: number; index: number } | null;
    /** Set when the right-click happened on the ruler. The `frame`
     *  field is the marker frame that was hit (within MARKER_HIT_RADIUS
     *  pixels of a marker), or null if no marker — i.e. the user
     *  right-clicked empty ruler space. Mutually exclusive with the
     *  other target fields. */
    targetRulerMarker?: { frame: number | null } | null;
  } | null;

  setActiveTool: (tool: ToolId) => void;
  setInspectorOpen: (open: boolean) => void;
  setAudioScrub: (on: boolean) => void;
  setSnapEnabled: (on: boolean) => void;
  setSnapIndicatorFrames: (frames: number[]) => void;
  setDetectingBeats: (on: boolean) => void;
  setBeatGridVisible: (on: boolean) => void;
  setAltHeld: (on: boolean) => void;
  setAltRmbZooming: (on: boolean) => void;

  setDragPreview: (preview: DragPreview | null) => void;
  setSlipDragging: (on: boolean) => void;
  setRollEditActive: (on: boolean) => void;
  setRangeHandleDragging: (on: boolean) => void;
  setSpawnGhost: (ghost: { side: 'video' | 'audio'; trackId: string } | null) => void;
  setRazorHoverX: (x: number | null, clipBand?: { top: number; bottom: number } | null) => void;
  setContextMenu: (menu: {
    x: number;
    y: number;
    targetClipId: number | null;
    targetTrackId: string | null;
    targetLevelKf?: { clipId: number; index: number } | null;
    targetRulerMarker?: { frame: number | null } | null;
  } | null) => void;
}

export const createUiSlice: StateCreator<State, [], [], UiSlice> = (set) => ({
  activeTool: 'select',
  audioScrub: true,
  inspectorOpen: false,
  snapEnabled: false,
  snapIndicatorFrames: [],
  detectingBeats: false,
  beatGridVisible: true,
  altHeld: false,
  altRmbZooming: false,

  dragPreview: null,
  slipDragging: false,
  rollEditActive: false,
  rangeHandleDragging: false,
  spawnGhost: null,
  razorHoverX: null,
  razorHoverClipBand: null,

  contextMenu: null,

  setActiveTool: (tool) => set({ activeTool: tool }),
  setInspectorOpen: (open) => set({ inspectorOpen: open }),
  setAudioScrub: (on) => set({ audioScrub: on }),
  setSnapEnabled: (on) => set({ snapEnabled: on }),
  setSnapIndicatorFrames: (frames) => set((s) => {
    // Reference-equality skip — pointermove fires every frame at a
    // rate of hundreds per second; if the indicator set didn't
    // change, avoid waking subscribers (SnapIndicators re-renders).
    if (s.snapIndicatorFrames.length === frames.length &&
        s.snapIndicatorFrames.every((v, i) => v === frames[i])) {
      return {};
    }
    return { snapIndicatorFrames: frames };
  }),
  setDetectingBeats: (on) => set({ detectingBeats: on }),
  setBeatGridVisible: (on) => set({ beatGridVisible: on }),
  // Identity-checked: useAltKey calls this on every pointer/wheel/key
  // event (it derives altHeld from e.altKey as ground truth to dodge
  // the Windows alt-eats-keyup quirk). Without this skip, every
  // pointermove during a no-alt-state-change drag would wake every
  // subscriber to the full state via Zustand's subscribe().
  setAltHeld: (on) => set((s) => (s.altHeld === on ? s : { altHeld: on })),
  setAltRmbZooming: (on) => set({ altRmbZooming: on }),

  setDragPreview: (preview) => set({ dragPreview: preview }),
  setSlipDragging: (on) => set({ slipDragging: on }),
  setRollEditActive: (on) => set((s) => (s.rollEditActive === on ? s : { rollEditActive: on })),
  setRangeHandleDragging: (on) => set((s) => (s.rangeHandleDragging === on ? s : { rangeHandleDragging: on })),
  setSpawnGhost: (ghost) => set((s) => {
    const a = s.spawnGhost;
    if (a === ghost) return s;
    if (a && ghost && a.side === ghost.side && a.trackId === ghost.trackId) return s;
    return { spawnGhost: ghost };
  }),
  setRazorHoverX: (x, clipBand = null) => set((s) => {
    const bandSame =
      (s.razorHoverClipBand == null && clipBand == null) ||
      (s.razorHoverClipBand != null && clipBand != null &&
        s.razorHoverClipBand.top === clipBand.top &&
        s.razorHoverClipBand.bottom === clipBand.bottom);
    if (s.razorHoverX === x && bandSame) return s;
    return { razorHoverX: x, razorHoverClipBand: clipBand };
  }),
  setContextMenu: (menu) => set({ contextMenu: menu }),
});
