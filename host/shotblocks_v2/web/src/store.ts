import { create } from 'zustand';

/** Magnetic-snap pull distance in screen pixels. Mirrors Python's
 *  SNAP_PIXEL_RADIUS = 8 (sb_canvas.py:229). Shared by every snap
 *  gesture — clip body drag, trim, roll, playhead scrub, razor — so
 *  they all feel identical. Callers convert to a frame count via the
 *  current pxPerFrame. */
export const SNAP_PIXEL_RADIUS = 8;

export type ToolId = 'select' | 'razor' | 'pen' | 'slip';
export type ClipState = 'unselected' | 'selected' | 'orphaned' | 'orphaned-selected' | 'locked';

export interface Clip {
  id: number;
  inFrame: number;
  outFrame: number;
  /** Original C4D object name for display + future reconciliation. */
  sourceName: string;
  /** C4D type ID, e.g. 5103 (Ocamera) or 1057516 (v1 rig). */
  sourceType: number;
  /** Opaque object id assigned by C++ on OM drop. Used by C++ to
   *  resolve back to the source BaseObject when the playhead enters
   *  this clip's range and the active camera must swap. 0 means "no
   *  link" — clip exists in the timeline but no source to drive
   *  camera output (orphan / file-import audio / etc.). */
  objectId: number;
  state: ClipState;
  /** Per-clip lock (independent of track lock). */
  locked: boolean;
  /** Absolute filesystem path for audio clips imported from disk.
   *  Empty / undefined for video clips (which resolve back to a C4D
   *  BaseObject via `objectId` instead). Used to re-decode the audio
   *  on doc reload — the file path survives save/load via the
   *  persistence helper's JSON blob. */
  filePath?: string;
  /** Multi-resolution peak pyramid — one entry per zoom level, ordered
   *  fine → coarse. The renderer picks the level closest to the
   *  current pixels-per-sample. Computed once at drop time by
   *  `computePeaks` (lib/peaks.ts) and persisted through save/load so
   *  waveforms survive doc reload even though the source binary
   *  doesn't (see [[webview2-hides-file-paths]]). */
  peakLevels?: { sps: number; b64: string }[];
  /** Largest absolute peak value across all buckets at the finest
   *  level (0..127). The waveform renderer divides by this for
   *  auto-gain so quiet material fills the lane height. */
  peakAbsMax?: number;
  /** AUDIO MEDIA-WINDOW MODEL. An audio clip is a *window* onto a
   *  fixed media timeline, not a container that rescales its content.
   *
   *  `mediaDurationFrames` — the source file's full length in doc
   *  frames. The peak pyramid maps across THIS span, not the clip's
   *  visible width.
   *
   *  `mediaOffsetFrames` — how many doc-frames into the media the
   *  clip's `inFrame` sits. 0 = clip head is media head. Left-trim
   *  increases it (head slides into the media); split carries it to
   *  the right half; the slip tool slides it freely.
   *
   *  The renderer shows the media slice [mediaOffsetFrames,
   *  mediaOffsetFrames + (outFrame - inFrame)] — so cutting / trimming
   *  reveals a different part of the same waveform instead of
   *  rescaling it. Mirrors Python's `trim_start_audio_frames`
   *  (sb_audio_track.py:78). Undefined on video clips. */
  mediaDurationFrames?: number;
  mediaOffsetFrames?: number;
  /** Stable identifier for the underlying audio media. The audio
   *  blob (audioStore) and the persisted bytes (C++ helper) are keyed
   *  by THIS, not by `id` — so when a clip is split, both halves
   *  share the same media and the audio is neither re-uploaded nor
   *  re-decoded. Set once on import; carried verbatim to both halves
   *  of every split via the object spread. Undefined on video. */
  mediaId?: number;
}

/** One clip captured to the timeline-local clipboard. Snapshots the
 *  clip data plus the track it lived on so paste can prefer the same
 *  track. */
export interface ClipboardEntry {
  /** All clip fields except `id` — paste mints fresh ids. */
  clip: Omit<Clip, 'id'>;
  /** Source track id like 'V1' / 'A2'. Paste tries to land on the
   *  same id, falling back to V1/A1 if that track no longer exists. */
  trackId: string;
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

  // Currently active tool palette tool. Drives `.is-active` styling
  // and gets sent to C++ so it can drive whatever editing semantics
  // the tool implies (none wired yet).
  activeTool: ToolId;

  // Audio scrubbing — when true, dragging the playhead plays short
  // blips of audio at the scrub position. Premiere / Resolve default.
  // Toggled via the audio-scrub icon below the dB meter in the left
  // rail. Default on.
  audioScrub: boolean;

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

  // Tracks. Index 0 = closest to the V/A divider (V1 / A1). New tracks
  // are added at the outer ends. Auto-create / auto-remove on clip
  // drag rather than via explicit UI buttons (see memory
  // project_v2_auto_track_lifecycle).
  videoTracks: Track[];
  audioTracks: Track[];

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
  // Three variants drive the menu's item list:
  //   - targetClipId != null   → clip menu (Cut/Copy/Paste/Delete/...)
  //   - targetTrackId != null  → track-header menu (Delete Track)
  //   - both null              → empty-area menu (Paste only)
  //
  // Menu items act on the current selection — right-clicking an
  // unselected clip first replaces the selection with that clip
  // (NLE convention), so the selection is always authoritative.
  contextMenu: {
    x: number;
    y: number;
    targetClipId: number | null;
    targetTrackId: string | null;
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
  setActiveTool: (tool: ToolId) => void;
  setAudioScrub: (on: boolean) => void;
  setSnapEnabled: (on: boolean) => void;
  setSnapIndicatorFrames: (frames: number[]) => void;
  setScrubFrame: (frame: number | null) => void;

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

/** Place a new clip on the timeline without overlapping existing clips.
 *  Used by the OM-drop path (new clips coming in from C++), which still
 *  wants the collision-avoid + snap-flush behavior — a drop should not
 *  silently destroy an existing clip.
 *
 *  In-timeline clip drag uses `magneticSnap` + `replaceOverlap` below
 *  (Python's "replace" mode from sb_shot_model.py:_resolve_position),
 *  which IS allowed to overwrite — the user grabbed an existing clip,
 *  and overwrites are NLE convention there.
 *
 *  Snap radius is PIXEL-based at call sites (see SNAP_PIXEL_RADIUS in
 *  the legacy Python at sb_canvas.py:229 — 8px). Callers convert px →
 *  frames using the current pxPerFrame so snap feel stays constant
 *  across zoom levels. Default snapFrames=8 is only a fallback for
 *  callers that don't know the zoom.
 *
 *  outFrame is exclusive (clip occupies [inFrame, outFrame)), so two
 *  clips can share an exact frame boundary (A.outFrame === B.inFrame)
 *  with no overlap and no gap. */
const MIN_GAP_FRAMES = 0;

/** Minimum legal clip duration in frames. Anything below this becomes
 *  unusable in the UI — handles too small to grab at high zoom. Python
 *  shipped MIN_SHOT_FRAMES=1 (sb_shot_model.py:16) which was a pure
 *  data-level minimum; v2 bumps it to 8 frames because the React UI
 *  has fixed-size hit zones that need real pixel area to remain
 *  interactive. Used by resizeClip, rollEdit, and replaceOverlap to
 *  drop trimmed remainders that would be too short to use. */
export const MIN_CLIP_FRAMES = 8;
export function findFreeSlot(
  existing: Clip[],
  desiredInFrame: number,
  duration: number,
  snapFrames: number = 8,
): { inFrame: number; outFrame: number } {
  const dur = Math.max(1, duration);
  const desiredOutFrame = desiredInFrame + dur;
  const sorted = [...existing].sort((a, b) => a.inFrame - b.inFrame);

  // Snap pass: if the proposed range puts our LEFT edge within
  // snapFrames of a clip's right edge, slam it flush. If our RIGHT
  // edge is within snapFrames of a clip's left edge, slam it flush
  // there instead. Closer snap wins.
  let bestSnap: { inFrame: number; dist: number } | null = null;
  for (const c of sorted) {
    // Snap our left edge to c's right edge (c sits to our left).
    const snapLeft = c.outFrame + MIN_GAP_FRAMES;
    const dLeft = Math.abs(desiredInFrame - snapLeft);
    if (dLeft <= snapFrames && (!bestSnap || dLeft < bestSnap.dist)) {
      bestSnap = { inFrame: snapLeft, dist: dLeft };
    }
    // Snap our right edge to c's left edge (c sits to our right).
    const snapRightInFrame = c.inFrame - MIN_GAP_FRAMES - dur;
    const dRight = Math.abs(desiredOutFrame - (c.inFrame - MIN_GAP_FRAMES));
    if (dRight <= snapFrames && (!bestSnap || dRight < bestSnap.dist)) {
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

/** Snap-only: try to align either the moving clip's left or right edge
 *  to the nearest edit point within `snapFrames`. Does NOT collision-
 *  avoid — the clip is free to overlap others; replace-overlap below
 *  resolves overlaps at release time.
 *
 *  `editPoints` is the set of magnet targets (other clips' inFrame and
 *  outFrame on the destination track, plus optional extras like the
 *  playhead and cross-track edges). Mirrors Python's
 *  `_magnetic_snap_position` in sb_shot_model.py.
 *
 *  Returns `{ inFrame, targets }`. `targets` is the edit point(s) the
 *  snapped clip's left/right edge landed on — used by the canvas to
 *  draw yellow snap-indicator lines. Empty when no snap occurred. */
export function magneticSnap(
  desiredInFrame: number,
  duration: number,
  editPoints: number[],
  snapFrames: number,
): { inFrame: number; targets: number[] } {
  if (!editPoints.length || snapFrames <= 0) {
    return { inFrame: desiredInFrame, targets: [] };
  }
  const desiredOutFrame = desiredInFrame + duration;
  let best: { inFrame: number; dist: number } | null = null;
  for (const p of editPoints) {
    // Try aligning left edge to this point.
    const dLeft = Math.abs(desiredInFrame - p);
    if (dLeft <= snapFrames && (!best || dLeft < best.dist)) {
      best = { inFrame: p, dist: dLeft };
    }
    // Try aligning right edge to this point.
    const dRight = Math.abs(desiredOutFrame - p);
    if (dRight <= snapFrames && (!best || dRight < best.dist)) {
      best = { inFrame: p - duration, dist: dRight };
    }
  }
  if (!best) return { inFrame: desiredInFrame, targets: [] };
  // Report every edit point the snapped clip's left OR right edge
  // lands on, so the canvas can draw an indicator at each. Mirrors
  // Python `_magnetic_snap_position` (sb_shot_model.py:184).
  const snappedIn  = best.inFrame;
  const snappedOut = snappedIn + duration;
  const targets: number[] = [];
  if (editPoints.includes(snappedIn)) targets.push(snappedIn);
  if (snappedOut !== snappedIn && editPoints.includes(snappedOut)) {
    targets.push(snappedOut);
  }
  return { inFrame: snappedIn, targets };
}

/** Apply Python's "ripple" overlap resolution to a track's clip list.
 *  Push same-track shots later (or earlier) so target's range is clear,
 *  preserving each pushed shot's duration. Ports `_ripple_around` from
 *  sb_shot_model.py:296.
 *
 *  Direction policy: push-right is tried first; only if no clip got
 *  pushed right does it try pushing earlier clips left. So ripple is
 *  biased toward shoving forward in time, matching Python.
 *
 *  v2 simplification: Python uses `out + 1 + CLIP_GAP_FRAMES` for the
 *  next clip's allowed inFrame and `in - 1 - CLIP_GAP_FRAMES` for the
 *  previous clip's allowed outFrame. With v2's exclusive outFrame and
 *  CLIP_GAP_FRAMES=0, those reduce to `outFrame` and `inFrame`.
 *
 *  Group ripple is intentionally NOT supported here — Python falls
 *  back to replace for groups (sb_shot_model.py:356), so v2 does too.
 */
export function rippleAround(
  existing: Clip[],
  target: { id: number; inFrame: number; outFrame: number },
): Clip[] {
  const same = existing
    .filter((s) => s.id !== target.id)
    .sort((a, b) => a.inFrame - b.inFrame);

  // Push-right pass.
  let cursor = target.outFrame;
  let pushedRight = false;
  const rightResult: Clip[] = [];
  for (const s of same) {
    if (s.inFrame >= target.inFrame) {
      if (s.inFrame < cursor) {
        const dur = s.outFrame - s.inFrame;
        const shifted: Clip = { ...s, inFrame: cursor, outFrame: cursor + dur };
        rightResult.push(shifted);
        cursor = shifted.outFrame;
        pushedRight = true;
      } else {
        rightResult.push(s);
        cursor = s.outFrame;
      }
    } else {
      rightResult.push(s);
    }
  }
  if (pushedRight) return rightResult;

  // Push-left pass (only if push-right was a no-op). Cursor tracks
  // the outFrame the next earlier clip can land on.
  let leftCursor = target.inFrame;
  const leftResult: Clip[] = [];
  // Iterate earlier-to-later for stable result order; do the left-push
  // logic by walking the same list in reverse, then re-sort at end.
  const reversed = [...same].sort((a, b) => b.inFrame - a.inFrame);
  const leftShifted: Clip[] = [];
  for (const s of reversed) {
    if (s.outFrame <= target.outFrame) {
      if (s.outFrame > leftCursor) {
        const dur = s.outFrame - s.inFrame;
        const newOut = leftCursor;
        const newIn = Math.max(0, newOut - dur);
        leftShifted.push({ ...s, inFrame: newIn, outFrame: newOut });
        leftCursor = newIn;
      } else {
        leftShifted.push(s);
        leftCursor = s.inFrame;
      }
    } else {
      leftShifted.push(s);
    }
  }
  // Re-sort to original-style order (inFrame ascending).
  leftShifted.sort((a, b) => a.inFrame - b.inFrame);
  for (const s of leftShifted) leftResult.push(s);
  return leftResult;
}

/** Apply Python's "replace" overlap resolution to a track's clip list.
 *  Given the placed `target` clip (inFrame/outFrame), each same-track
 *  clip whose range intersects target's range is:
 *    - Dropped entirely if fully covered.
 *    - Trimmed at its trailing edge if target covers its right end.
 *    - Trimmed at its leading edge if target covers its left end.
 *    - Trimmed at its trailing edge if target sits fully inside it
 *      (matches Python's "simpler: trim trailing" choice).
 *  Mirrors `_replace_overlap` in sb_shot_model.py:409. */
export function replaceOverlap(existing: Clip[], target: { inFrame: number; outFrame: number; id: number }): Clip[] {
  const out: Clip[] = [];
  for (const s of existing) {
    if (s.id === target.id) { out.push(s); continue; }
    // No overlap (outFrame is exclusive, so equal boundaries are OK).
    if (s.outFrame <= target.inFrame || s.inFrame >= target.outFrame) {
      out.push(s);
      continue;
    }
    // Fully covered → drop.
    if (s.inFrame >= target.inFrame && s.outFrame <= target.outFrame) {
      continue;
    }
    // Partial: trim.
    if (s.inFrame < target.inFrame && s.outFrame <= target.outFrame) {
      // Trim trailing edge.
      const trimmed = { ...s, outFrame: target.inFrame };
      if (trimmed.outFrame - trimmed.inFrame >= MIN_CLIP_FRAMES) out.push(trimmed);
    } else if (s.inFrame >= target.inFrame && s.outFrame > target.outFrame) {
      // Trim leading edge.
      const trimmed = { ...s, inFrame: target.outFrame };
      if (trimmed.outFrame - trimmed.inFrame >= MIN_CLIP_FRAMES) out.push(trimmed);
    } else {
      // Target sits inside s — trim trailing (Python's simpler path).
      const trimmed = { ...s, outFrame: target.inFrame };
      if (trimmed.outFrame - trimmed.inFrame >= MIN_CLIP_FRAMES) out.push(trimmed);
    }
  }
  return out;
}

export const useStore = create<State>((set) => ({
  fps: 30,
  docFrames: 150,
  currentFrame: 0,
  playing: false,
  playRangeIn: 0,
  playRangeOut: 150,
  loopEnabled: false,
  scrubFrame: null,
  h:      { min: 0, max: 150, vMin: 0, vMax: 150 },
  // Vertical windows: range is 2× the track count so the default
  // (centered, span = trackCount) leaves equal headroom on each side
  // for zoom-out. With 1 track: range [0, 2], default [0.5, 1.5].
  vVideo: { min: 0, max: 2,   vMin: 0.5, vMax: 1.5 },
  vAudio: { min: 0, max: 2,   vMin: 0.5, vMax: 1.5 },
  vaShare: 0.5,
  activeTool: 'select',
  audioScrub: true,
  snapEnabled: false,
  snapIndicatorFrames: [],
  videoTracks: [{ id: 1, name: 'Video 1', clips: [] }],
  audioTracks: [{ id: 1, name: 'Audio 1', clips: [] }],
  dragPreview: null,
  dragClip: null,
  slipDragging: false,
  spawnGhost: null,
  selectedClipIds: new Set<number>(),
  marquee: null,
  edgeHover: new Set<string>(),
  razorHoverX: null,
  razorHoverClipBand: null,
  clipboard: [],
  contextMenu: null,

  setTick: (frame, fps, playing) => set((s) => ({
    currentFrame: frame,
    fps: fps > 0 ? fps : s.fps,
    playing,
  })),

  setScrubFrame: (frame) => set({ scrubFrame: frame }),

  setDocInfo: (fps, docFrames, playRangeIn, playRangeOut) => set((s) => {
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
    if (typeof playRangeIn === 'number')  next.playRangeIn  = playRangeIn;
    if (typeof playRangeOut === 'number') next.playRangeOut = playRangeOut;
    return next;
  }),

  setPlayRange: (inFrame, outFrame) => set({
    playRangeIn:  Math.max(0, Math.floor(inFrame)),
    playRangeOut: Math.max(Math.floor(inFrame) + 1, Math.floor(outFrame)),
  }),

  setLoopEnabled: (on) => set({ loopEnabled: on }),

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

  setDragPreview: (preview) => set({ dragPreview: preview }),

  setDragClip: (drag) => set({ dragClip: drag }),
  setSlipDragging: (on) => set({ slipDragging: on }),
  setSpawnGhost: (ghost) => set((s) => {
    const a = s.spawnGhost;
    if (a === ghost) return s;
    if (a && ghost && a.side === ghost.side && a.trackId === ghost.trackId) return s;
    return { spawnGhost: ghost };
  }),

  setSelectedClip: (clipId, additive = false) => set((s) => {
    if (clipId == null) {
      // Null + non-additive = clear. Null + additive = no-op.
      return additive ? s : { selectedClipIds: new Set<number>() };
    }
    if (additive) {
      const next = new Set(s.selectedClipIds);
      if (next.has(clipId)) next.delete(clipId);
      else next.add(clipId);
      return { selectedClipIds: next };
    }
    // Replace with just this clip.
    return { selectedClipIds: new Set([clipId]) };
  }),

  setSelectedClipIds: (ids) => set({ selectedClipIds: ids }),

  setMarquee: (rect) => set({ marquee: rect }),

  moveClip: (clipId, fromTrackId, toTrackId, newInFrame, snapFrames, mode = 'replace') => {
    const fromSide = fromTrackId.startsWith('V') ? 'video' : fromTrackId.startsWith('A') ? 'audio' : null;
    const toSide   = toTrackId.startsWith('V')   ? 'video' : toTrackId.startsWith('A')   ? 'audio' : null;
    if (!fromSide || !toSide || fromSide !== toSide) return null;
    const side = fromSide;
    const fromNum = parseInt(fromTrackId.slice(1), 10);
    const toNum   = parseInt(toTrackId.slice(1), 10);

    let result: { trackId: string; inFrame: number; outFrame: number } | null = null;
    set((s) => {
      const tracks = side === 'video' ? s.videoTracks : s.audioTracks;
      const fromIdx = tracks.findIndex((t) => t.id === fromNum);
      if (fromIdx < 0) return s;
      const moving = tracks[fromIdx].clips.find((c) => c.id === clipId);
      if (!moving) return s;
      const duration = moving.outFrame - moving.inFrame;

      // Spawn-target case: dest track doesn't exist yet. Allow only one
      // step past the current outermost track on this side (so a single
      // drag can spawn V2 from V1 but not V42 in one go).
      let working = tracks;
      if (!working.some((t) => t.id === toNum)) {
        const maxId = working.reduce((m, t) => Math.max(m, t.id), 0);
        if (toNum !== maxId + 1) return s;
        working = [...working, { id: toNum, name: (side === 'video' ? 'Video ' : 'Audio ') + toNum, clips: [] }];
      }

      // Place on dest at the cursor-derived inFrame, clamped to >= 0.
      // No collision-avoid: overlaps get resolved by replaceOverlap
      // below (Python's "replace" mode, sb_shot_model.py:_resolve_position).
      // snapFrames is unused here on commit — live preview already
      // applied snap via magneticSnap and passes the snapped value in.
      void snapFrames;
      const placedIn = Math.max(0, newInFrame);
      const placedOut = placedIn + duration;
      const movedClip: Clip = { ...moving, inFrame: placedIn, outFrame: placedOut };

      // Remove from source, replace overlaps on dest, add moved clip.
      const fromIdxNew = working.findIndex((t) => t.id === fromNum);
      const toIdxNew   = working.findIndex((t) => t.id === toNum);
      // Ripple vs replace: ripple pushes neighbors aside, replace
      // trims/removes them. Cross-track move always uses replace on
      // the destination — there are no "neighbors to push" the moving
      // clip is leaving behind, and pushing dest-track neighbors out
      // would feel surprising when the user just dropped the clip onto
      // an unrelated track. Same-track ripple is the meaningful case.
      const resolve = mode === 'ripple' ? rippleAround : replaceOverlap;
      let next = working.map((t, i) => {
        if (i === fromIdxNew && i === toIdxNew) {
          const others = t.clips.filter((c) => c.id !== clipId);
          const after = resolve(others, { id: clipId, inFrame: placedIn, outFrame: placedOut });
          return { ...t, clips: [...after, movedClip] };
        }
        if (i === fromIdxNew) {
          return { ...t, clips: t.clips.filter((c) => c.id !== clipId) };
        }
        if (i === toIdxNew) {
          const after = replaceOverlap(t.clips, { id: clipId, inFrame: placedIn, outFrame: placedOut });
          return { ...t, clips: [...after, movedClip] };
        }
        return t;
      });

      // Empty non-base tracks are kept (user-confirmed: empty tracks
      // are fine). Without this, dragging V2's sole clip up to spawn
      // V3 culled V2 mid-move, leaving [V1, V3] — confusing.

      result = { trackId: toTrackId, inFrame: placedIn, outFrame: placedOut };
      return side === 'video' ? { videoTracks: next } : { audioTracks: next };
    });
    return result;
  },

  resizeClip: (clipId, trackId, edge, wantFrame, mode = 'replace') => {
    const side = trackId.startsWith('V') ? 'video' : trackId.startsWith('A') ? 'audio' : null;
    if (!side) return null;
    const trackNum = parseInt(trackId.slice(1), 10);
    let result: { inFrame: number; outFrame: number } | null = null;
    set((s) => {
      const tracks = side === 'video' ? s.videoTracks : s.audioTracks;
      const trackIdx = tracks.findIndex((t) => t.id === trackNum);
      if (trackIdx < 0) return s;
      const clip = tracks[trackIdx].clips.find((c) => c.id === clipId);
      if (!clip) return s;
      let newIn = clip.inFrame;
      let newOut = clip.outFrame;
      if (edge === 'left') {
        newIn = Math.max(0, Math.min(wantFrame, clip.outFrame - MIN_CLIP_FRAMES));
      } else {
        newOut = Math.max(clip.inFrame + MIN_CLIP_FRAMES, wantFrame);
      }
      if (newIn === clip.inFrame && newOut === clip.outFrame) {
        result = { inFrame: newIn, outFrame: newOut };
        return s;
      }
      const target = { id: clipId, inFrame: newIn, outFrame: newOut };
      const resized: Clip = { ...clip, inFrame: newIn, outFrame: newOut };
      // Media-window (audio only): a left-edge trim slides the
      // window's head into the media by the same delta inFrame moved,
      // so the waveform under the clip stays put — we just reveal
      // less / more of the head. A right-edge trim only moves
      // outFrame; the window start is unchanged. We establish both
      // fields even if the parent lacked them (un-migrated old clip).
      if (side === 'audio') {
        const parentOffset = clip.mediaOffsetFrames ?? 0;
        resized.mediaDurationFrames = clip.mediaDurationFrames ?? (clip.outFrame - clip.inFrame);
        resized.mediaOffsetFrames = edge === 'left'
          ? parentOffset + (newIn - clip.inFrame)
          : parentOffset;
      }
      const resolve = mode === 'ripple' ? rippleAround : replaceOverlap;
      const next = tracks.map((t, i) => {
        if (i !== trackIdx) return t;
        const others = t.clips.filter((c) => c.id !== clipId);
        const after = resolve(others, target);
        return { ...t, clips: [...after, resized] };
      });
      result = { inFrame: newIn, outFrame: newOut };
      return side === 'video' ? { videoTracks: next } : { audioTracks: next };
    });
    return result;
  },

  slipClip: (clipId, trackId, wantOffset) => {
    // Slip only applies to audio (it slides the media window). Video
    // clips have no media-window — bail.
    if (!trackId.startsWith('A')) return null;
    const trackNum = parseInt(trackId.slice(1), 10);
    let result: { mediaOffsetFrames: number } | null = null;
    set((s) => {
      const trackIdx = s.audioTracks.findIndex((t) => t.id === trackNum);
      if (trackIdx < 0) return s;
      const clip = s.audioTracks[trackIdx].clips.find((c) => c.id === clipId);
      if (!clip) return s;
      if (clip.locked || clip.state === 'locked') return s;
      const clipDur = clip.outFrame - clip.inFrame;
      const mediaDur = clip.mediaDurationFrames ?? clipDur;
      // The window [offset, offset + clipDur] must stay inside the
      // media [0, mediaDur]. Clamp accordingly — a slip past either
      // end just stalls, mirroring Python's hard clamp
      // (sb_canvas_audio.py:1790-1793).
      const maxOffset = Math.max(0, mediaDur - clipDur);
      const clamped = Math.max(0, Math.min(maxOffset, Math.round(wantOffset)));
      if (clamped === (clip.mediaOffsetFrames ?? 0)) {
        result = { mediaOffsetFrames: clamped };
        return s;
      }
      const next = s.audioTracks.map((t, i) => {
        if (i !== trackIdx) return t;
        return {
          ...t,
          clips: t.clips.map((c) =>
            c.id === clipId ? { ...c, mediaOffsetFrames: clamped } : c),
        };
      });
      result = { mediaOffsetFrames: clamped };
      return { audioTracks: next };
    });
    return result;
  },

  moveClips: (clipIds, anchorClipId, anchorFromTrackId, anchorToTrackId, anchorNewInFrame) => {
    const fromSide = anchorFromTrackId.startsWith('V') ? 'video' : anchorFromTrackId.startsWith('A') ? 'audio' : null;
    const toSide   = anchorToTrackId.startsWith('V')   ? 'video' : anchorToTrackId.startsWith('A')   ? 'audio' : null;
    if (!fromSide || !toSide || fromSide !== toSide) return false;
    const side = fromSide;
    const anchorFromNum = parseInt(anchorFromTrackId.slice(1), 10);
    const anchorToNum   = parseInt(anchorToTrackId.slice(1),   10);
    let ok = false;
    set((s) => {
      const tracks = side === 'video' ? s.videoTracks : s.audioTracks;
      // Locate the anchor and gather every selected clip's current
      // (trackId, inFrame, outFrame).
      type Loc = { id: number; trackNum: number; inFrame: number; outFrame: number };
      const selectedLocs: Loc[] = [];
      let anchorLoc: Loc | null = null;
      for (const t of tracks) {
        for (const c of t.clips) {
          if (!clipIds.has(c.id)) continue;
          const loc: Loc = { id: c.id, trackNum: t.id, inFrame: c.inFrame, outFrame: c.outFrame };
          selectedLocs.push(loc);
          if (c.id === anchorClipId) anchorLoc = loc;
        }
      }
      if (!anchorLoc || selectedLocs.length === 0) return s;
      // Frame and track deltas inferred from the anchor's move.
      let dxFrames = anchorNewInFrame - anchorLoc.inFrame;
      const dtTrack = anchorToNum - anchorFromNum;
      // Clamp so no selected clip goes below frame 0.
      const minIn = Math.min(...selectedLocs.map((l) => l.inFrame));
      if (minIn + dxFrames < 0) dxFrames = -minIn;
      if (dxFrames === 0 && dtTrack === 0) {
        ok = true;
        return s;
      }
      // Spawn destination tracks if needed (each target track number
      // must exist or be spawned — but only one step past current max,
      // matching moveClip's rule). For group drag we relax this: any
      // selected clip can land on an existing track OR a freshly
      // spawned one — but we only spawn ONE new track per side per
      // call, the highest needed.
      const targetTrackNums = new Set(selectedLocs.map((l) => l.trackNum + dtTrack));
      let working = tracks;
      const existingIds = new Set(working.map((t) => t.id));
      const maxId = working.reduce((m, t) => Math.max(m, t.id), 0);
      for (const num of targetTrackNums) {
        if (num < 1) return s;                    // can't go below V1/A1
        if (existingIds.has(num)) continue;
        if (num !== maxId + 1) return s;          // only one-step spawn allowed
        working = [...working, { id: num, name: (side === 'video' ? 'Video ' : 'Audio ') + num, clips: [] }];
        existingIds.add(num);
      }
      // Build moved-clip list keyed by id for fast lookup.
      const movedById = new Map<number, { id: number; newTrackNum: number; inFrame: number; outFrame: number }>();
      for (const loc of selectedLocs) {
        movedById.set(loc.id, {
          id: loc.id,
          newTrackNum: loc.trackNum + dtTrack,
          inFrame: loc.inFrame + dxFrames,
          outFrame: loc.outFrame + dxFrames,
        });
      }
      // Rebuild each track:
      //  1. Remove selected clips that originated here.
      //  2. Add selected clips whose destination is here.
      //  3. replaceOverlap with each new arrival against non-selected
      //     clips already on this track (selected clips don't collide
      //     with each other — rigid shift preserves their original
      //     non-overlapping layout).
      const next = working.map((t) => {
        const survivors = t.clips.filter((c) => !clipIds.has(c.id));
        const arrivals: Clip[] = [];
        for (const moved of movedById.values()) {
          if (moved.newTrackNum !== t.id) continue;
          // Find original clip to clone (preserve sourceName etc.).
          let orig: Clip | undefined;
          for (const tt of tracks) {
            const f = tt.clips.find((c) => c.id === moved.id);
            if (f) { orig = f; break; }
          }
          if (!orig) continue;
          arrivals.push({ ...orig, inFrame: moved.inFrame, outFrame: moved.outFrame });
        }
        let combined = survivors;
        for (const a of arrivals) {
          combined = replaceOverlap(combined, { id: a.id, inFrame: a.inFrame, outFrame: a.outFrame });
          combined = [...combined, a];
        }
        return { ...t, clips: combined };
      });
      // Empty tracks retained — explicit delete will come via a track-
      // header button (TBD).

      ok = true;
      return side === 'video' ? { videoTracks: next } : { audioTracks: next };
    });
    return ok;
  },

  rollEdit: (leftClipId, rightClipId, trackId, wantSeamFrame) => {
    const side = trackId.startsWith('V') ? 'video' : trackId.startsWith('A') ? 'audio' : null;
    if (!side) return null;
    const trackNum = parseInt(trackId.slice(1), 10);
    let result: { seamFrame: number } | null = null;
    set((s) => {
      const tracks = side === 'video' ? s.videoTracks : s.audioTracks;
      const trackIdx = tracks.findIndex((t) => t.id === trackNum);
      if (trackIdx < 0) return s;
      const left  = tracks[trackIdx].clips.find((c) => c.id === leftClipId);
      const right = tracks[trackIdx].clips.find((c) => c.id === rightClipId);
      if (!left || !right) return s;
      // Clamp the seam between the two clips' OUTER edges, keeping
      // MIN_CLIP_FRAMES on each side. The seam can move anywhere in
      // [left.inFrame + MIN_CLIP_FRAMES, right.outFrame - MIN_CLIP_FRAMES].
      const minSeam = left.inFrame + MIN_CLIP_FRAMES;
      const maxSeam = right.outFrame - MIN_CLIP_FRAMES;
      const seam = Math.max(minSeam, Math.min(maxSeam, wantSeamFrame));
      if (seam === left.outFrame) {
        result = { seamFrame: seam };
        return s;
      }
      const next = tracks.map((t, i) => {
        if (i !== trackIdx) return t;
        return {
          ...t,
          clips: t.clips.map((c) => {
            if (c.id === leftClipId)  return { ...c, outFrame: seam };
            if (c.id === rightClipId) return { ...c, inFrame:  seam };
            return c;
          }),
        };
      });
      result = { seamFrame: seam };
      return side === 'video' ? { videoTracks: next } : { audioTracks: next };
    });
    return result;
  },

  splitClip: (clipId, trackId, frame) => {
    const side = trackId.startsWith('V') ? 'video' : trackId.startsWith('A') ? 'audio' : null;
    if (!side) return null;
    const trackNum = parseInt(trackId.slice(1), 10);
    const f = Math.round(frame);
    let newRightId: number | null = null;
    set((s) => {
      const tracks = side === 'video' ? s.videoTracks : s.audioTracks;
      const trackIdx = tracks.findIndex((t) => t.id === trackNum);
      if (trackIdx < 0) return s;
      const clip = tracks[trackIdx].clips.find((c) => c.id === clipId);
      if (!clip) return s;
      // Locked clips don't accept structural edits.
      if (clip.locked || clip.state === 'locked') return s;
      // Reject splits that don't land strictly inside the clip OR
      // would produce a half shorter than MIN_CLIP_FRAMES. Mirrors
      // Python _split_shot (sb_shot_model.py:49-54), with v2's
      // exclusive outFrame: left = [inFrame, f), right = [f, outFrame).
      if (f <= clip.inFrame || f >= clip.outFrame) return s;
      if (f - clip.inFrame < MIN_CLIP_FRAMES) return s;
      if (clip.outFrame - f < MIN_CLIP_FRAMES) return s;
      const rightId = nextClipId++;
      const left: Clip = { ...clip, outFrame: f };
      const right: Clip = { ...clip, id: rightId, inFrame: f };
      // Media-window: split is only meaningful for audio clips (they
      // carry a waveform). For audio, the left half keeps the
      // parent's window start; the right half's window starts
      // (f - inFrame) frames deeper into the media — so both halves
      // keep showing their original slice instead of rescaling.
      // We establish BOTH fields even when the parent lacks them
      // (un-migrated old clip): a never-edited clip's full span IS
      // its media span at offset 0. Video clips: left untouched.
      if (side === 'audio') {
        const parentOffset = clip.mediaOffsetFrames ?? 0;
        const parentMediaDur = clip.mediaDurationFrames ?? (clip.outFrame - clip.inFrame);
        left.mediaOffsetFrames = parentOffset;
        left.mediaDurationFrames = parentMediaDur;
        right.mediaOffsetFrames = parentOffset + (f - clip.inFrame);
        right.mediaDurationFrames = parentMediaDur;
      }
      const next = tracks.map((t, i) => {
        if (i !== trackIdx) return t;
        return {
          ...t,
          clips: t.clips.flatMap((c) => (c.id === clipId ? [left, right] : [c])),
        };
      });
      newRightId = rightId;
      // Deselect after split — standard NLE behavior; the user just
      // broke focus on the original clip.
      return {
        ...(side === 'video' ? { videoTracks: next } : { audioTracks: next }),
        selectedClipIds: new Set<number>(),
      };
    });
    return newRightId;
  },

  setRazorHoverX: (x, clipBand = null) => set((s) => {
    const bandSame =
      (s.razorHoverClipBand == null && clipBand == null) ||
      (s.razorHoverClipBand != null && clipBand != null &&
        s.razorHoverClipBand.top === clipBand.top &&
        s.razorHoverClipBand.bottom === clipBand.bottom);
    if (s.razorHoverX === x && bandSame) return s;
    return { razorHoverX: x, razorHoverClipBand: clipBand };
  }),

  copyClips: (clipIds) => {
    if (clipIds.size === 0) return;
    const s = useStore.getState();
    const entries: ClipboardEntry[] = [];
    const captureFromTracks = (tracks: Track[], side: 'V' | 'A') => {
      for (const t of tracks) {
        for (const c of t.clips) {
          if (!clipIds.has(c.id)) continue;
          // Strip id; paste mints fresh ones.
          const { id: _id, ...rest } = c;
          void _id;
          entries.push({ clip: rest, trackId: side + t.id });
        }
      }
    };
    captureFromTracks(s.videoTracks, 'V');
    captureFromTracks(s.audioTracks, 'A');
    set({ clipboard: entries });
  },

  cutClips: (clipIds) => {
    if (clipIds.size === 0) return;
    useStore.getState().copyClips(clipIds);
    // Inline delete (same shape as useKeyboard.deleteSelection so we
    // don't depend on it). Empty non-base tracks get culled.
    set((s) => {
      const filterTrack = (t: Track) => ({
        ...t,
        clips: t.clips.filter((c) => !clipIds.has(c.id)),
      });
      return {
        videoTracks: s.videoTracks.map(filterTrack),
        audioTracks: s.audioTracks.map(filterTrack),
        selectedClipIds: new Set<number>(),
      };
    });
  },

  pasteClips: () => {
    const s = useStore.getState();
    if (s.clipboard.length === 0) return [];
    // Anchor on the earliest inFrame across copied clips, so multi-
    // clip pastes preserve relative spacing with the earliest clip
    // landing AT the playhead.
    const anchor = s.clipboard.reduce(
      (m, e) => Math.min(m, e.clip.inFrame),
      Infinity,
    );
    if (!Number.isFinite(anchor)) return [];
    const playhead = s.scrubFrame ?? s.currentFrame;
    const delta = playhead - anchor;
    const newIds: number[] = [];

    // Group clipboard entries by destination track, falling back to
    // V1/A1 when the source track no longer exists.
    type Pending = { trackId: string; clip: Clip };
    const pending: Pending[] = [];
    for (const e of s.clipboard) {
      const side = e.trackId.startsWith('V') ? 'video' : 'audio';
      const tracks = side === 'video' ? s.videoTracks : s.audioTracks;
      const sourceNum = parseInt(e.trackId.slice(1), 10);
      const exists = tracks.some((t) => t.id === sourceNum);
      const destTrackId = exists ? e.trackId : (side === 'video' ? 'V1' : 'A1');
      const id = nextClipId++;
      newIds.push(id);
      pending.push({
        trackId: destTrackId,
        clip: {
          ...e.clip,
          id,
          inFrame: Math.max(0, e.clip.inFrame + delta),
          outFrame: Math.max(1, e.clip.outFrame + delta),
        },
      });
    }

    // Apply replaceOverlap per destination track so existing clips
    // get trimmed/removed by the incoming pastes (same convention as
    // in-timeline drag / OM drop with the active "replace" mode).
    set((s2) => {
      const apply = (tracks: Track[], side: 'V' | 'A'): Track[] => {
        return tracks.map((t) => {
          const arrivals = pending
            .filter((p) => p.trackId === side + t.id)
            .map((p) => p.clip);
          if (arrivals.length === 0) return t;
          let combined = t.clips;
          for (const a of arrivals) {
            combined = replaceOverlap(combined, { id: a.id, inFrame: a.inFrame, outFrame: a.outFrame });
            combined = [...combined, a];
          }
          return { ...t, clips: combined };
        });
      };
      return {
        videoTracks: apply(s2.videoTracks, 'V'),
        audioTracks: apply(s2.audioTracks, 'A'),
        selectedClipIds: new Set<number>(newIds),
      };
    });
    return newIds;
  },

  toggleLockSelection: (clipIds) => {
    if (clipIds.size === 0) return;
    set((s) => {
      // If any selected clip is unlocked, lock all; otherwise unlock all.
      let anyUnlocked = false;
      for (const t of [...s.videoTracks, ...s.audioTracks]) {
        for (const c of t.clips) {
          if (clipIds.has(c.id) && !c.locked) { anyUnlocked = true; break; }
        }
        if (anyUnlocked) break;
      }
      const nextLocked = anyUnlocked;
      const apply = (t: Track): Track => ({
        ...t,
        clips: t.clips.map((c) => clipIds.has(c.id) ? { ...c, locked: nextLocked } : c),
      });
      return {
        videoTracks: s.videoTracks.map(apply),
        audioTracks: s.audioTracks.map(apply),
      };
    });
  },

  splitSelectionAtPlayhead: (clipIds) => {
    if (clipIds.size === 0) return;
    const s = useStore.getState();
    const playhead = s.scrubFrame ?? s.currentFrame;
    // Capture a snapshot so we don't iterate while the store mutates;
    // splitClip rejects out-of-range frames silently per Python.
    const targets: Array<{ id: number; trackId: string }> = [];
    for (const t of s.videoTracks) {
      for (const c of t.clips) {
        if (clipIds.has(c.id) && c.inFrame < playhead && playhead < c.outFrame) {
          targets.push({ id: c.id, trackId: 'V' + t.id });
        }
      }
    }
    for (const t of s.audioTracks) {
      for (const c of t.clips) {
        if (clipIds.has(c.id) && c.inFrame < playhead && playhead < c.outFrame) {
          targets.push({ id: c.id, trackId: 'A' + t.id });
        }
      }
    }
    for (const tgt of targets) {
      useStore.getState().splitClip(tgt.id, tgt.trackId, playhead);
    }
  },

  setContextMenu: (menu) => set({ contextMenu: menu }),

  deleteTrack: (trackId) => {
    const side = trackId.startsWith('V') ? 'video' : trackId.startsWith('A') ? 'audio' : null;
    if (!side) return false;
    const trackNum = parseInt(trackId.slice(1), 10);
    const namePrefix = side === 'video' ? 'Video ' : 'Audio ';
    let ok = false;
    set((s) => {
      const tracks = side === 'video' ? s.videoTracks : s.audioTracks;
      const target = tracks.find((t) => t.id === trackNum);
      if (!target) return s;
      // Drop selection of any clips that lived on the deleted track.
      const deletedClipIds = new Set<number>(target.clips.map((c) => c.id));
      let newSel = s.selectedClipIds;
      if (deletedClipIds.size && [...s.selectedClipIds].some((id) => deletedClipIds.has(id))) {
        newSel = new Set([...s.selectedClipIds].filter((id) => !deletedClipIds.has(id)));
      }
      // Drop the target, then renumber dense from id=1. Sort by old
      // id first so the relative order of surviving tracks is
      // preserved across the renumber.
      const remaining = tracks
        .filter((t) => t.id !== trackNum)
        .sort((a, b) => a.id - b.id);
      let next: Track[];
      if (remaining.length === 0) {
        // Auto-spawn an empty base track — the side must always have
        // somewhere to drop a clip.
        next = [{ id: 1, name: namePrefix + '1', clips: [] }];
      } else {
        next = remaining.map((t, i) => ({
          ...t,
          id: i + 1,
          name: namePrefix + (i + 1),
        }));
      }
      ok = true;
      return {
        ...(side === 'video' ? { videoTracks: next } : { audioTracks: next }),
        selectedClipIds: newSel,
      };
    });
    return ok;
  },

  deleteEmptyTracks: (side) => {
    let removed = 0;
    set((s) => {
      const tracks = side === 'video' ? s.videoTracks : s.audioTracks;
      // Drop every empty track, then RENUMBER the remaining ones
      // starting at 1 so clips end up on the lowest possible track
      // id (compact-all-gaps semantics). With nothing left, leave
      // the base track behind as an empty placeholder so the user
      // always has somewhere to drop a clip.
      //
      // Sort by current id so renumbering keeps relative order
      // (the lowest-id non-empty track stays nearest the V/A
      // splitter after compaction). Each renamed track's `name`
      // ("Video 3", "Audio 2", etc.) is regenerated to match the
      // new id; the display chip + label both read from this.
      const namePrefix = side === 'video' ? 'Video ' : 'Audio ';
      const occupied = tracks
        .filter((t) => t.clips.length > 0)
        .sort((a, b) => a.id - b.id);
      let next: Track[];
      if (occupied.length === 0) {
        // No clips anywhere on this side. Keep a single base track
        // even if its original id wasn't 1 — the base slot must
        // always exist.
        next = [{ id: 1, name: namePrefix + '1', clips: [] }];
      } else {
        next = occupied.map((t, i) => ({
          ...t,
          id: i + 1,
          name: namePrefix + (i + 1),
        }));
      }
      removed = tracks.length - next.length;
      if (removed === 0) return s;
      return side === 'video' ? { videoTracks: next } : { audioTracks: next };
    });
    return removed;
  },

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

  setClipPeaks: (clipId, peakLevels, peakAbsMax) => {
    set((s) => {
      const patch = (tracks: Track[]) => tracks.map((t) => {
        if (!t.clips.some((c) => c.id === clipId)) return t;
        return {
          ...t,
          clips: t.clips.map((c) => c.id === clipId ? { ...c, peakLevels, peakAbsMax } : c),
        };
      });
      return {
        videoTracks: patch(s.videoTracks),
        audioTracks: patch(s.audioTracks),
      };
    });
  },

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

// Debug hook: expose the store on window so CDP / DevTools sessions
// can inspect live state via useStore.getState() without React's
// reactive layer. No-op in production builds since the bundle always
// runs inside WebView2 anyway.
if (typeof window !== 'undefined') {
  (window as unknown as { __SHOTBLOCKS_STORE__: typeof useStore }).__SHOTBLOCKS_STORE__ = useStore;
}
