import { create } from 'zustand';
import type {
  Clip,
  ClipboardEntry,
  DragPreview,
  LevelInterp,
  LevelTangent,
  ScrollWindow,
  ToolId,
  Track,
} from './store/types';
import { isTrackLockedIn } from './store/clipMath';
import { createUiSlice } from './store/slices/ui';
import { createPlaybackSlice } from './store/slices/playback';
import { createViewSlice } from './store/slices/view';
import { createLevelKfSlice } from './store/slices/levelKf';
import { createSelectionSlice } from './store/slices/selection';
import { createTimelineSlice } from './store/slices/timeline';

// Re-export every public symbol consumers used to import from this
// module, so existing `import { Clip, magneticSnap, MIN_CLIP_FRAMES,
// useStore } from './store'` lines keep resolving unchanged.
export {
  SNAP_PIXEL_RADIUS,
  HEADERS_MIN_W,
  HEADERS_MAX_W,
  NATURAL_TRACK_PX,
  MIN_TRACK_PX,
  EDGE_HIT_PX,
  EDGE_HIT_PX_FLOOR,
  clipEdgeZonePx,
  MIN_CLIP_FRAMES,
  LEVEL_MERGE_AF,
} from './store/constants';
export {
  LEVEL_DEFAULT_TANGENT,
  LEVEL_PRESET_TANGENTS,
  TRACK_FLAG_DEFAULTS,
} from './store/types';
export type {
  Clip,
  ClipboardEntry,
  ClipState,
  DragPreview,
  LevelInterp,
  LevelKeyframe,
  LevelTangent,
  ScrollWindow,
  ToolId,
  Track,
} from './store/types';
export {
  findFreeSlot,
  magneticSnap,
  rippleAround,
  replaceOverlap,
  audioPeakDocFrames,
  audioBeatLines,
  audioSongPartLines,
} from './store/clipMath';

// Authoritative app state. C++ is the source of truth for fps/frame/
// docFrames; everything else (visible window, tool, V/A share, tracks)
// lives here. Components subscribe via selectors so each one only
// re-renders when its slice changes.

export interface State {
  // From C++
  fps: number;
  docFrames: number;
  currentFrame: number;
  playing: boolean;
  // C4D's loop range — what plays under spacebar when loop is enabled
  // or what bounds the play head when the loop button is on. Both
  // frames are in doc-relative coords starting at 0. C++ ships these
  // in doc-info and on EVMSG_CHANGE; JS sends edits back via the
  // 'set-play-range' command.
  playRangeIn: number;
  playRangeOut: number;
  // Whether C4D's loop mode is on. v2 owns this independently because
  // C4D 2026's Python API doesn't expose the native cycle button
  // (matches Python's `_loop_enabled` in sb_canvas.py:156).
  loopEnabled: boolean;

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

  // Track-headers column width in px. User-resizable by dragging the
  // headers/timeline seam; clamped to [HEADERS_MIN_W, HEADERS_MAX_W].
  // Drives the --headers-w grid column.
  headersWidth: number;

  // Currently active tool palette tool. Drives `.is-active` styling
  // and gets sent to C++ so it can drive whatever editing semantics
  // the tool implies (none wired yet).
  activeTool: ToolId;

  // Audio scrubbing — when true, dragging the playhead plays short
  // blips of audio at the scrub position. Premiere / Resolve default.
  // Toggled via the audio-scrub icon below the dB meter in the left
  // rail. Default on.
  audioScrub: boolean;

  // Inspector panel (right-side slide-in) open/closed. Toggled from
  // the utilities-strip gear icon. Hosts global settings now; grows
  // into selected-shot properties + preset layers later.
  inspectorOpen: boolean;

  // When ON (default), v2 audio plays/scrubs in response to the C4D
  // NATIVE timeline (its play button AND scrubbing its playhead).
  // When OFF, v2 audio responds ONLY to v2-timeline interaction
  // (v2 spacebar playback, v2 ruler scrub) — interacting with C4D's
  // native timeline produces no audio. The visual playhead stays in
  // sync with C4D either way; this gates AUDIO only.
  c4dAudioFollows: boolean;

  // Snap-to-edge toggle (utilities strip "Snap" button). When OFF,
  // body/trim/roll drags are free of magnetic pull. When ON, they
  // snap to nearby edit points within SNAP_PIXEL_RADIUS px. Shift
  // (ripple) overrides snap regardless of this flag, matching
  // Python's `_qualifier_mode` (sb_canvas.py:344). Default OFF to
  // mirror Python's `_snap_enabled = False`.
  snapEnabled: boolean;

  // Frame numbers a currently-in-flight drag has snapped to. Drives
  // the yellow vertical indicator lines (SnapIndicators overlay).
  // Empty when no drag is active or the drag is outside the snap
  // radius. Cleared on pointer-end.
  snapIndicatorFrames: number[];

  // True while beat detection is running over the audio clips. Drives
  // the Beat Detection button's busy state so it can't be re-fired
  // mid-analysis. Detection itself runs off-thread-ish (chunked) so
  // the UI stays responsive.
  detectingBeats: boolean;

  // Whether the inferred beat-grid overlay (regular dashed tempo
  // lines) is shown. Set true automatically when detection finds a
  // confident grid; user can toggle it off. Independent of the hit
  // markers, which always show once detected.
  beatGridVisible: boolean;

  // Tracks. Index 0 = closest to the V/A divider (V1 / A1). New tracks
  // are added at the outer ends. Auto-create / auto-remove on clip
  // drag rather than via explicit UI buttons (see memory
  // project_v2_auto_track_lifecycle).
  videoTracks: Track[];
  audioTracks: Track[];

  // ObjectIds whose C++-side BaseLink resolves to null — the source
  // camera was deleted from the OM. Derived per-render in C++ and
  // pushed on every EVMSG_CHANGE; never persisted. A clip whose
  // objectId lives in this set is an orphan.
  orphanObjectIds: Set<number>;

  // Live OM camera names keyed by objectId. Shipped alongside the
  // orphan set on every EVMSG_CHANGE; ShotBlock prefers this over
  // the clip's persisted sourceName so OM renames propagate to the
  // label immediately. Falls back to sourceName when the id isn't
  // in the map (camera deleted -> we keep the last persisted name).
  cameraNames: Map<number, string>;

  // Audio mediaIds whose embedded bytes couldn't be loaded on doc
  // open — either C++ helper has no bytes, or decoding the bytes
  // failed. Derived from the audio-load pipeline; never persisted.
  // Audio clips referencing these mediaIds render as orphans
  // (no waveform, silent playback).
  orphanMediaIds: Set<number>;

  // Drop ghost shown while the user is dragging from the OM. Null when
  // no drag is in progress or the drag is outside our drop targets.
  dragPreview: DragPreview | null;

  // Clip currently being dragged for reposition. Drives the .is-dragging
  // class on the source ShotBlock (z-index lift + grabbing cursor) and
  // lets the drag-from-clip path coexist with OM-drop's dragPreview.
  dragClip: { clipId: number; fromTrackId: string } | null;

  // True while a slip drag is in progress. The Lane's edge-hover
  // detection checks this and pauses — otherwise it keeps running
  // during the slip and leaves `cursorMode`/`is-edge-*` in a stuck
  // state when the slip ends, which jams the cursor.
  slipDragging: boolean;

  // True while the pointer is in a roll-edit seam zone OR a roll
  // drag is in progress. Lane mirrors its `cursorMode === 'roll'`
  // into this so useToolCursor (global) can force the roll cursor
  // via the C++ host.
  rollEditActive: boolean;

  // True while a play-range handle is being dragged. RangeBar sets
  // it so useToolCursor keeps the play-range cursor for the whole
  // drag even if the pointer strays off the small chevron handle.
  rangeHandleDragging: boolean;

  // Spawn-zone hint shown while dragging. Non-null when resolveLane
  // resolved to a `spawn` target on the current pointermove. The
  // SpawnGhostLane renders a faded outline where V<max+1> / A<max+1>
  // will appear on release. Cleared on every move that resolves to
  // an existing lane, and at drag-end.
  spawnGhost: { side: 'video' | 'audio'; trackId: string } | null;

  // Currently selected clip ids. Empty set = nothing selected.
  // setSelectedClip(id, additive=false) replaces; additive=true toggles
  // the id in the set (Shift/Cmd+click semantics — matches Premiere /
  // Resolve / Python's _selected_ids in sb_canvas.py).
  selectedClipIds: Set<number>;

  // Live marquee selection rectangle. Non-null while the user is
  // drawing a marquee on empty .lanes-area space. Coordinates are in
  // lanes-area-relative pixels (origin at top-left of .lanes-area).
  marquee: { x0: number; y0: number; x1: number; y1: number } | null;

  // Razor tool cut-line preview. While the razor tool is active and
  // the pointer is hovering over a clip, this holds the cursor's
  // viewport-relative X in CSS pixels. Drives a single overlay that
  // spans the ruler row + the lanes-area so the user can see the
  // cut frame on every track at once. Null = no preview (cursor not
  // on a clip, or razor tool not active). Set by ShotBlock
  // pointermove, cleared by pointerleave.
  razorHoverX: number | null;

  // Vertical extent (viewport-relative px) of the clip the razor is
  // currently hovering. The cut-line overlay paints a brighter/
  // thicker segment between these Y values — the part of the line
  // that will actually slice — while the rest stays faint. Null when
  // no clip is hovered. Published alongside razorHoverX by ShotBlock.
  razorHoverClipBand: { top: number; bottom: number } | null;

  // Per-clip edge hover. Keyed as `${clipId}:left` / `${clipId}:right`.
  // The Lane computes this on pointermove — when the cursor is at a
  // seam where two clips meet, BOTH edges land in the set so both
  // clips render their bracket (the "double" look the user expects).
  edgeHover: Set<string>;

  // Timeline-local clipboard. Populated by copyClips/cutClips, read by
  // pasteClips. Survives only within the session — no doc save, no
  // OS-clipboard bridging in v1. Each entry carries the clip's data
  // plus its source trackId so paste can target the same track.
  clipboard: ClipboardEntry[];

  // Right-click menu state. Non-null while a context menu is visible.
  // `x` / `y` are viewport-relative.
  //
  // Variants drive the menu's item list:
  //   - targetLevelKf != null  → pen-tool node menu (Delete + interp)
  //   - targetClipId != null   → clip menu (Cut/Copy/Paste/Delete/...)
  //   - targetTrackId != null  → track-header menu (Delete Track)
  //   - all null               → empty-area menu (Paste only)
  //
  // Menu items act on the current selection — right-clicking an
  // unselected clip first replaces the selection with that clip
  // (NLE convention), so the selection is always authoritative.
  contextMenu: {
    x: number;
    y: number;
    targetClipId: number | null;
    targetTrackId: string | null;
    // Pen-tool: the volume keyframe right-clicked — its clip id and
    // index into that clip's levelKeyframes. Null for non-node menus.
    targetLevelKf?: { clipId: number; index: number } | null;
  } | null;

  // Actions
  setTick: (frame: number, fps: number, playing: boolean) => void;
  setDocInfo: (fps: number, docFrames: number, playRangeIn?: number, playRangeOut?: number) => void;
  /** Set the play range (in/out frames). Caller is responsible for
   *  also pushing this to C++ via send({kind:'set-play-range', ...}). */
  setPlayRange: (inFrame: number, outFrame: number) => void;
  setLoopEnabled: (on: boolean) => void;
  setHVisible: (vMin: number, vMax: number) => void;
  setVVideoVisible: (vMin: number, vMax: number) => void;
  setVAudioVisible: (vMin: number, vMax: number) => void;
  setVaShare: (share: number) => void;
  /** Set the track-headers column width (px). Clamped to
   *  [HEADERS_MIN_W, HEADERS_MAX_W]. */
  setHeadersWidth: (w: number) => void;
  setActiveTool: (tool: ToolId) => void;
  setInspectorOpen: (open: boolean) => void;
  setC4dAudioFollows: (on: boolean) => void;
  setAudioScrub: (on: boolean) => void;
  setSnapEnabled: (on: boolean) => void;
  setSnapIndicatorFrames: (frames: number[]) => void;
  setScrubFrame: (frame: number | null) => void;
  setDetectingBeats: (on: boolean) => void;
  setBeatGridVisible: (on: boolean) => void;

  /** Attach detected prominent peaks + beat grid to all clips sharing
   *  `mediaId`. Positions are media-space audio sample frames. Splits
   *  share a mediaId, so one detection result paints every sibling. */
  setClipAudioPeaks: (
    mediaId: number,
    audioPeaks: number[],
    audioPeaksSampleRate: number,
    audioBeatGrid: { periodSamples: number; phaseSamples: number; confidence: number; barOffset: number } | null,
    audioSongParts: number[],
  ) => void;

  /** Append a clip to the named track (e.g. 'V1' or 'A2'). Returns
   *  the assigned clip id, or null if the track doesn't exist. */
  addClip: (trackId: string, clip: Omit<Clip, 'id'>) => number | null;

  /** Attach the decoded peak pyramid to an existing clip. Called by
   *  useFileDrop after the WebAudio decode completes asynchronously —
   *  the clip appears immediately at duration-known time, peaks are
   *  patched in when ready. No-op if the clip id doesn't exist. */
  setClipPeaks: (
    clipId: number,
    peakLevels: { sps: number; b64: string }[],
    peakAbsMax: number,
  ) => void;

  setDragPreview: (preview: DragPreview | null) => void;
  setEdgeHover: (edges: Set<string>) => void;
  setRazorHoverX: (x: number | null, clipBand?: { top: number; bottom: number } | null) => void;
  setDragClip: (drag: { clipId: number; fromTrackId: string } | null) => void;
  setSlipDragging: (on: boolean) => void;
  setRollEditActive: (on: boolean) => void;
  setRangeHandleDragging: (on: boolean) => void;
  setSpawnGhost: (ghost: { side: 'video' | 'audio'; trackId: string } | null) => void;
  /** Update the selection. additive=false replaces with just `clipId`
   *  (or clears, if null). additive=true toggles `clipId` in the set
   *  (no-op when null). */
  setSelectedClip: (clipId: number | null, additive?: boolean) => void;
  /** Replace the entire selection at once. Used for marquee select or
   *  programmatic batch (Select-All, etc.). */
  setSelectedClipIds: (ids: Set<number>) => void;

  setMarquee: (rect: { x0: number; y0: number; x1: number; y1: number } | null) => void;

  /** Move an existing clip to (possibly the same) track at a desired
   *  inFrame. Uses findFreeSlot (with the moving clip excluded from
   *  collision checks) so the resulting placement never overlaps and
   *  snaps flush to nearby clip edges within SNAP_FRAMES.
   *
   *  - If `toTrackId` doesn't exist yet (e.g. 'V2' when only V1 does),
   *    a new track is spawned. Spawning is allowed only one step past
   *    the current outermost on the same side.
   *  - After moving, any non-V1/A1 track that ends up empty is culled.
   *
   *  Returns the resolved placement, or null if the move was rejected
   *  (cross-side moves are disallowed). */
  moveClip: (
    clipId: number,
    fromTrackId: string,
    toTrackId: string,
    newInFrame: number,
    snapFrames?: number,
    mode?: 'replace' | 'ripple',
  ) => { trackId: string; inFrame: number; outFrame: number } | null;

  /** Group move: shift every clip in `clipIds` by the same delta,
   *  with the anchor clip moving to (`anchorToTrackId`, `anchorNewInFrame`).
   *  Mirrors Python `_resolve_group_move` (sb_shot_model.py:343):
   *   - All clips move rigidly (same dx_frames, same dy_track).
   *   - Delta clamps so no clip goes below frame 0.
   *   - Non-selected clips on destination tracks get replaceOverlap'd.
   *   - Cross-side moves rejected (V↔A).
   *   - Same-track-only constraint for v2 initial cut (vertical group
   *     drag across tracks is more complex — leave for later if needed). */
  moveClips: (
    clipIds: Set<number>,
    anchorClipId: number,
    anchorFromTrackId: string,
    anchorToTrackId: string,
    anchorNewInFrame: number,
  ) => boolean;

  /** Single-edge trim. Pulls `inFrame` (edge='left') or `outFrame`
   *  (edge='right') of the clip to `wantFrame`, clamped to keep a
   *  minimum 1-frame duration. After clamping, runs replaceOverlap
   *  against same-track neighbors — extending an edge into another
   *  clip's range trims/removes the overlapped clip (Python's
   *  "replace" mode, sb_shot_model.py:_resolve_resize). Snap is
   *  applied by the caller via magneticSnap before passing `wantFrame`
   *  in; the store action itself only clamps + overlap-resolves. */
  resizeClip: (
    clipId: number,
    trackId: string,
    edge: 'left' | 'right',
    wantFrame: number,
    mode?: 'replace' | 'ripple',
  ) => { inFrame: number; outFrame: number } | null;

  /** Slip an audio clip: slide the media window underneath it without
   *  moving the clip on the timeline. `inFrame`/`outFrame` are
   *  untouched; `mediaOffsetFrames` is set to `wantOffset`, clamped to
   *  [0, mediaDurationFrames - clipDuration] so the window stays
   *  fully inside the source. Mirrors Python `_drag_audio_slip`
   *  (sb_canvas_audio.py:1742). No-op on video clips or clips with no
   *  media-window data. Returns the clamped offset, or null. */
  slipClip: (
    clipId: number,
    trackId: string,
    wantOffset: number,
  ) => { mediaOffsetFrames: number } | null;

  /** Rolling edit at a seam. `leftClipId` and `rightClipId` are two
   *  adjacent clips on the same track where leftClip.outFrame ==
   *  rightClip.inFrame. The seam moves to `wantSeamFrame`, clamped so
   *  both clips keep at least 1-frame duration on each side. Mirrors
   *  the standard NLE rolling-edit behavior (no Python source —
   *  Python's drag layer never shipped it). */
  rollEdit: (
    leftClipId: number,
    rightClipId: number,
    trackId: string,
    wantSeamFrame: number,
  ) => { seamFrame: number } | null;

  /** Split the clip into two halves at `frame`. Left half keeps the
   *  original id and runs [inFrame, frame); right half gets a fresh
   *  id and runs [frame, outFrame). Mirrors Python `_split_shot`
   *  (sb_shot_model.py:26), translated to v2's exclusive-outFrame
   *  semantics.
   *
   *  Returns the new right-half id, or null if the split was
   *  rejected (frame outside the clip, or either half would be
   *  shorter than MIN_CLIP_FRAMES). All other clip fields
   *  (sourceName, sourceType, objectId, state, locked) are carried
   *  to both halves. */
  splitClip: (clipId: number, trackId: string, frame: number) => number | null;

  /** Pen-tool: add a level keyframe to an audio clip at media-frame
   *  `af` with `gain` (0..1). A click within MERGE_AF of an existing
   *  node updates that node instead of adding a duplicate. The list
   *  is kept sorted by `af`. New nodes default to a linear segment.
   *  Returns the index of the added/updated node, or null on failure
   *  (clip not found, not an audio clip). */
  addLevelKeyframe: (clipId: number, af: number, gain: number) => number | null;

  /** Pen-tool: move keyframe `index` of an audio clip to a new
   *  media-frame `af` and `gain`. `af` is clamped strictly between
   *  the neighbouring nodes so nodes can't cross; `gain` clamps to
   *  0..1. Re-sorts if needed (it won't, given the clamp). */
  moveLevelKeyframe: (clipId: number, index: number, af: number, gain: number) => void;

  /** Pen-tool: delete keyframe `index` of an audio clip. */
  removeLevelKeyframe: (clipId: number, index: number) => void;

  /** Pen-tool: delete a set of keyframes (by index) at once. */
  removeLevelKeyframes: (clipId: number, indices: number[]) => void;

  /** Pen-tool: shift a set of keyframes by (dAf, dGain) rigidly. The
   *  delta clamps so no selected node crosses an UN-selected
   *  neighbour or leaves the media; gains clamp to 0..1. Mirrors Pro
   *  Tools' Trimmer model. */
  moveLevelKeyframesBy: (clipId: number, indices: number[], dAf: number, dGain: number) => void;

  /** Pen-tool: set the interpolation of a set of keyframes at once. */
  setLevelKeyframesInterp: (clipId: number, indices: number[], interp: LevelInterp) => void;

  /** Pen-tool: set keyframe `index`'s interpolation. A named preset
   *  seeds this node's outgoing tangent + the next node's incoming
   *  tangent; 'hold' / 'custom' leave the tangents as-is. */
  setLevelKeyframeInterp: (clipId: number, index: number, interp: LevelInterp) => void;

  /** Pen-tool: set keyframe `index`'s incoming or outgoing bezier
   *  tangent handle (interp becomes 'custom'). */
  setLevelKeyframeTangent: (
    clipId: number, index: number, side: 'in' | 'out', tan: LevelTangent,
  ) => void;

  /** Pen-tool: the current level-keyframe selection — a clip id and a
   *  set of keyframe indices into that clip's levelKeyframes. Lives in
   *  the store so the Delete key and the context menu can act on it.
   *  Null = nothing selected. */
  levelKfSelection: { clipId: number; indices: number[] } | null;
  setLevelKfSelection: (sel: { clipId: number; indices: number[] } | null) => void;

  /** True while a node / handle drag is in flight inside LevelCurve.
   *  useToolCursor holds the pen cursor for the whole drag so it
   *  doesn't blink off as the pointer crosses overlay boundaries. */
  levelCurveDragging: boolean;
  setLevelCurveDragging: (on: boolean) => void;

  /** Alt key held globally. Lets the pen tool be used with any
   *  active tool (modifier-as-tool). Set by an App-level listener. */
  altHeld: boolean;
  setAltHeld: (on: boolean) => void;

  /** True while an Alt+RMB zoom gesture is in flight. useToolCursor
   *  must NOT show the pen cursor during this — Alt is the zoom
   *  modifier here, not a pen modifier. */
  altRmbZooming: boolean;
  setAltRmbZooming: (on: boolean) => void;

  /** Copy the given clips' data into the timeline-local clipboard.
   *  Existing clipboard contents are replaced. */
  copyClips: (clipIds: Set<number>) => void;

  /** Copy + delete in one action. Mirrors Premiere's Ctrl+X. */
  cutClips: (clipIds: Set<number>) => void;

  /** Paste clipboard contents at the playhead frame. Multi-clip
   *  pastes preserve relative spacing — the earliest copied clip
   *  lands at the playhead and the rest follow. Each clip targets
   *  its source track (V1/A1 fallback if it no longer exists).
   *  Pasted clips replaceOverlap their landing range and become the
   *  new selection. Returns the new clip ids. */
  pasteClips: () => number[];

  /** Toggle the locked state of every selected clip. If any selected
   *  clip is unlocked, lock all; otherwise unlock all. */
  toggleLockSelection: (clipIds: Set<number>) => void;

  /** Split every selected clip the playhead frame is inside. Each
   *  call routes through splitClip's validation (frame strictly
   *  inside, both halves >= MIN_CLIP_FRAMES, not locked); clips that
   *  fail validation are silently skipped. */
  splitSelectionAtPlayhead: (clipIds: Set<number>) => void;

  /** Show / hide the right-click context menu. */
  setContextMenu: (menu: {
    x: number;
    y: number;
    targetClipId: number | null;
    targetTrackId: string | null;
    targetLevelKf?: { clipId: number; index: number } | null;
  } | null) => void;

  /** Remove a track and all of its clips, then RENUMBER the remaining
   *  tracks dense from id=1. Any track is deletable — there are no
   *  protected "base" tracks. If removing this track would leave the
   *  side with zero tracks, an empty V1/A1 is auto-spawned so the
   *  user always has a drop target on each side. */
   deleteTrack: (trackId: string) => boolean;

  /** Cull every empty (clips.length === 0) non-base track on the
   *  given side. Base track (V1 / A1) is preserved even if empty.
   *  Returns the number of tracks removed. */
  deleteEmptyTracks: (side: 'video' | 'audio') => number;

  /** Toggle one of a track's per-track flags. `trackId` is 'V2'/'A1'
   *  style. No-op if the track doesn't exist. muted/solo are meaningful
   *  on audio tracks only, visible on video only; the action does not
   *  enforce that — callers render the relevant control per side. */
  setTrackFlag: (
    trackId: string,
    flag: 'muted' | 'solo' | 'locked' | 'visible',
    value: boolean,
  ) => void;

  /** Rename a track. A non-empty name marks the track `nameIsCustom`
   *  so a later renumber won't overwrite it. An empty/whitespace name
   *  reverts to the default `Video N` / `Audio N` and clears the
   *  custom flag. No-op if the track doesn't exist. */
  setTrackName: (trackId: string, name: string) => void;

  /** Apply a C++ `cameras` snapshot to `orphanObjectIds` and
   *  `cameraNames`. C++ sends the full snapshot of every objectId
   *  in its _cameraLinks; missing ids drop out of both maps. */
  setCameraStatuses: (statuses: { id: number; alive: boolean; name: string }[]) => void;

  /** Rebind an orphan clip's source camera. Called when the user
   *  drags a fresh camera from the OM onto an orphan clip — the
   *  clip stays put, only its source ref + display name swap. */
  relinkClipCamera: (
    clipId: number,
    objectId: number,
    sourceName: string,
    sourceType: number,
  ) => void;

  /** Toggle a mediaId's audio-orphan status. */
  setAudioMediaOrphan: (mediaId: number, orphan: boolean) => void;
}

/** Monotonic clip id. Unique across all tracks for the session.
 *  Exported via accessors so persistence can read/restore it. */
let nextClipId = 1;
export function getNextClipId(): number { return nextClipId; }
export function setNextClipId(n: number): void { nextClipId = n; }

/** Mint a fresh id from the shared monotonic counter. Used for both
 *  clip ids and media ids — drawing from one counter guarantees a
 *  media id never collides with a clip id, which matters because the
 *  C++ helper keys audio bytes by `BCKEY_V2_AUDIO_BASE + <number>`
 *  and that number is the media id. */
export function mintId(): number { return nextClipId++; }

export const useStore = create<State>((set, get, store) => ({
  ...createUiSlice(set, get, store),
  ...createPlaybackSlice(set, get, store),
  ...createViewSlice(set, get, store),
  ...createLevelKfSlice(set, get, store),
  ...createSelectionSlice(set, get, store),
  ...createTimelineSlice(set, get, store),

}));

/** Whether the track named by `trackId` ('V2' / 'A1' style) is locked.
 *  A locked track rejects every clip edit; UI gesture handlers call
 *  this to refuse the gesture up front (rather than let it preview
 *  and snap back on commit). Unknown trackId → false. */
export function isTrackLocked(trackId: string, state?: State): boolean {
  return isTrackLockedIn(trackId, state ?? useStore.getState());
}

// Debug hook: expose the store on window so CDP / DevTools sessions
// can inspect live state via useStore.getState() without React's
// reactive layer. No-op in production builds since the bundle always
// runs inside WebView2 anyway.
if (typeof window !== 'undefined') {
  (window as unknown as { __SHOTBLOCKS_STORE__: typeof useStore }).__SHOTBLOCKS_STORE__ = useStore;
}
