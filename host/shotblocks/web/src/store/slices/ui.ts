import type { StateCreator } from 'zustand';
import type { State } from '../../store';
import type { DragPreview, ToolId } from '../types';

/** UI / interaction state — what the user sees and is doing, separate
 *  from the timeline data and from the playback transport. Includes
 *  the active tool, modal panel visibility, transient drag/hover
 *  state, and the right-click menu. */
/** One row in the camera-type dropdown. Populated by C++'s
 *  get-camera-types handler — only types whose plugin actually
 *  resolves at this C4D session appear (so RS Camera only shows when
 *  Redshift is loaded). See plan-4 R1. */
export interface CameraTypeOption {
  id: number;     // plugin ID, e.g. 5103 (Standard), 1057516 (Redshift)
  label: string;  // localized UI label, e.g. "Camera", "RS Camera"
}

export interface UiSlice {
  activeTool: ToolId;
  audioScrub: boolean;
  settingsOpen: boolean;
  snapEnabled: boolean;
  snapIndicatorFrames: number[];
  detectingBeats: boolean;
  beatGridVisible: boolean;
  altHeld: boolean;
  // Ctrl mirrored the same way as altHeld (useAltKey reads e.ctrlKey on
  // every event as ground truth). Needed for hover-time gesture checks
  // that have no event — currently the Alt+Ctrl retime cursor.
  ctrlHeld: boolean;
  altRmbZooming: boolean;

  /** Available camera types in this C4D session (renderer-aware).
   *  Populated on first Settings open via send('get-camera-types').
   *  Empty until then; SettingsPanel triggers the fetch. */
  availableCameraTypes: CameraTypeOption[];
  /** User's preferred camera type — plugin ID. Used by the camera-
   *  create handler (plan-4 commit 2). Persisted in the helper-BC
   *  JSON blob (alongside renderMode etc.). Default 5103 = Standard
   *  Ocamera. If a saved value is no longer available (e.g. user
   *  uninstalled Redshift), fall back to the first available type. */
  defaultCameraType: number;
  /** True once the doc carried an explicit saved camera-type choice, or
   *  the user picked one this session. While false (fresh doc, no pick),
   *  the available-types resolver may auto-prefer Redshift. */
  cameraTypeExplicit: boolean;

  /** A/V chip "write target" — the track that receives cursorless
   *  inserts (Add Camera button, paste). One active chip per side.
   *  Default 'V1' / 'A1' on fresh docs. Click a chip to activate
   *  (deactivates the previously-active one on that side). Persisted
   *  alongside renderMode etc. in the helper-BC JSON. */
  activeVChip: string;
  activeAChip: string;

  dragPreview: DragPreview | null;
  /** True from the first om-hover until om-cancel / om-drop. Unlike
   *  dragPreview (which goes null whenever the cursor is off a valid
   *  drop target), this stays solid for the entire drag — used by
   *  the EmptyStateOverlay to keep its highlight steady while the
   *  user moves the OM cursor over the dropzone panel. */
  omDragging: boolean;
  /** True once usePersistence's initial load-state has resolved.
   *  EmptyStateOverlay gates rendering on this so the dropzone
   *  doesn't flash up on dialog reopen between mount and hydration. */
  isHydrated: boolean;
  slipDragging: boolean;
  rollEditActive: boolean;
  /** True while the pointer is over a video-clip trim edge with Alt
   *  held (or an Alt-retime drag is running). Drives the retime cursor
   *  through the C++ host so it survives the drag, exactly like
   *  rollEditActive does for the roll cursor. */
  retimeHoverActive: boolean;
  /** Clip id currently being Alt-retimed (its edge dragged with Alt),
   *  or null. Lets KeyframeTicks PREVIEW the rescale live: under retime a
   *  key's fraction-of-clip is invariant, so while this is set the dots
   *  hold their drag-start fractions and the clip stretches around them
   *  — instead of drifting (their true frames haven't moved yet; C++
   *  rescales them only on drag-release). Cleared on trim-end. */
  retimingClipId: number | null;
  /** Selected keyframe COLUMNS (keyframe dots), as a Set of "objectId:
   *  frame" string keys (see keyColKey / parseKeyCol). A dot is a deduped
   *  column — every track keyed at `frame` on this camera — so each entry
   *  addresses (objectId, frame), not a single key. Multi-select via
   *  click / Shift-click / Alt-drag marquee. Drives the dots' selected
   *  render; Delete / drag act on the whole set. Cleared on Esc,
   *  click-away, or a clip-list edit that moves/removes a column. */
  selectedKeyColumns: Set<string>;
  rangeHandleDragging: boolean;
  /** True while a Hand-tool pan drag is in flight. Drives the
   *  cursor swap from open-hand → closed-hand for the duration of
   *  the drag, even if the cursor briefly leaves the canvas. */
  handPanning: boolean;
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
  setAudioScrub: (on: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setAvailableCameraTypes: (types: CameraTypeOption[]) => void;
  setDefaultCameraType: (id: number) => void;
  /** Set the active V or A chip — auto-routes based on the trackId
   *  prefix (V* → activeVChip, A* → activeAChip). No-op if the chip
   *  is already active. */
  setActiveChip: (trackId: string) => void;
  setSnapEnabled: (on: boolean) => void;
  setSnapIndicatorFrames: (frames: number[]) => void;
  setDetectingBeats: (on: boolean) => void;
  setBeatGridVisible: (on: boolean) => void;
  setAltHeld: (on: boolean) => void;
  setCtrlHeld: (on: boolean) => void;
  setAltRmbZooming: (on: boolean) => void;

  setDragPreview: (preview: DragPreview | null) => void;
  setOmDragging: (on: boolean) => void;
  setHydrated: (on: boolean) => void;
  setSlipDragging: (on: boolean) => void;
  setRollEditActive: (on: boolean) => void;
  setRetimeHoverActive: (on: boolean) => void;
  setRetimingClipId: (id: number | null) => void;
  setSelectedKeyColumns: (cols: Set<string>) => void;
  setRangeHandleDragging: (on: boolean) => void;
  setHandPanning: (on: boolean) => void;
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
  settingsOpen: false,
  snapEnabled: false,
  snapIndicatorFrames: [],
  detectingBeats: false,
  beatGridVisible: true,
  altHeld: false,
  ctrlHeld: false,
  altRmbZooming: false,

  availableCameraTypes: [],
  defaultCameraType: 5103,  // Ocamera (Standard) — always available
  cameraTypeExplicit: false,
  activeVChip: 'V1',
  activeAChip: 'A1',

  dragPreview: null,
  omDragging: false,
  isHydrated: false,
  slipDragging: false,
  rollEditActive: false,
  retimeHoverActive: false,
  retimingClipId: null,
  selectedKeyColumns: new Set<string>(),
  rangeHandleDragging: false,
  handPanning: false,
  spawnGhost: null,
  razorHoverX: null,
  razorHoverClipBand: null,

  contextMenu: null,

  setActiveTool: (tool) => set({ activeTool: tool }),
  setAudioScrub: (on) => set({ audioScrub: on }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setAvailableCameraTypes: (types) => set({ availableCameraTypes: types }),
  setDefaultCameraType: (id) => set({ defaultCameraType: id, cameraTypeExplicit: true }),
  setActiveChip: (trackId) => set((s) => {
    if (trackId.startsWith('V')) {
      return s.activeVChip === trackId ? s : { activeVChip: trackId };
    }
    if (trackId.startsWith('A')) {
      return s.activeAChip === trackId ? s : { activeAChip: trackId };
    }
    return s;
  }),
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
  setCtrlHeld: (on) => set((s) => (s.ctrlHeld === on ? s : { ctrlHeld: on })),
  setAltRmbZooming: (on) => set({ altRmbZooming: on }),

  setDragPreview: (preview) => set({ dragPreview: preview }),
  setOmDragging: (on) => set((s) => (s.omDragging === on ? s : { omDragging: on })),
  setHydrated: (on) => set((s) => (s.isHydrated === on ? s : { isHydrated: on })),
  setSlipDragging: (on) => set({ slipDragging: on }),
  setRollEditActive: (on) => set((s) => (s.rollEditActive === on ? s : { rollEditActive: on })),
  setRetimeHoverActive: (on) => set((s) => (s.retimeHoverActive === on ? s : { retimeHoverActive: on })),
  setRetimingClipId: (id) => set((s) => (s.retimingClipId === id ? s : { retimingClipId: id })),
  setSelectedKeyColumns: (cols) => set((s) => {
    // Ref-equality skip on content so identical selections don't re-render.
    const cur = s.selectedKeyColumns;
    if (cur === cols) return s;
    if (cur.size === cols.size) {
      let same = true;
      for (const k of cols) if (!cur.has(k)) { same = false; break; }
      if (same) return s;
    }
    return { selectedKeyColumns: cols };
  }),
  setRangeHandleDragging: (on) => set((s) => (s.rangeHandleDragging === on ? s : { rangeHandleDragging: on })),
  setHandPanning: (on) => set((s) => (s.handPanning === on ? s : { handPanning: on })),
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
