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
  /** Prominent-peak positions in MEDIA-SPACE audio sample frames (at
   *  the decoded buffer's sample rate). Detected by `detectPeaks`
   *  (lib/onsets.ts) when the user hits Beat Detection. The renderer
   *  converts to doc frames; snap-to-peak feeds these into the drag
   *  edit-point set. Undefined until detection runs; persists through
   *  save/load so detection results survive doc reload. */
  audioPeaks?: number[];
  /** Sample rate of the buffer `audioPeaks` were measured against —
   *  needed to convert sample positions → doc frames after a reload
   *  when the decoded buffer isn't in memory yet. */
  audioPeaksSampleRate?: number;
  /** Inferred tempo grid for this clip's media. `periodSamples` /
   *  `phaseSamples` are media-space audio sample frames (same rate as
   *  `audioPeaksSampleRate`); `confidence` is 0..1. Undefined when the
   *  autocorrelation didn't land a clear pulse. */
  audioBeatGrid?: { periodSamples: number; phaseSamples: number; confidence: number; barOffset: number };
  /** Song-part boundaries in media-space audio sample frames — the
   *  big structural transitions (intro→build→drop). The FCP "heavy
   *  line" tier. Same sample rate as `audioPeaksSampleRate`. */
  audioSongParts?: number[];
  /** Stable identifier for the underlying audio media. The audio
   *  blob (audioStore) and the persisted bytes (C++ helper) are keyed
   *  by THIS, not by `id` — so when a clip is split, both halves
   *  share the same media and the audio is neither re-uploaded nor
   *  re-decoded. Set once on import; carried verbatim to both halves
   *  of every split via the object spread. Undefined on video. */
  mediaId?: number;
  /** Pen-tool volume automation — a sorted list of level keyframes
   *  (audio clips only). Undefined / empty = no automation (unity
   *  everywhere). See LevelKeyframe. */
  levelKeyframes?: LevelKeyframe[];
}

/** A level-keyframe's segment interpolation. The named modes are
 *  presets that seed the node's bezier tangents; 'custom' means a
 *  tangent handle was dragged freely. 'hold' is a step (evaluator
 *  special-case), not a bezier. */
export type LevelInterp =
  | 'linear' | 'hold' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'custom';

/** A bezier tangent handle on a level keyframe, in SEGMENT-NORMALIZED
 *  units: `tx` is a fraction of the segment's time span, `ty` a
 *  fraction of its gain span. `outTan` belongs to the segment leaving
 *  the node; `inTan` to the segment arriving — measured BACK from the
 *  node (so a positive `tx` reaches toward the previous node). */
export interface LevelTangent {
  tx: number;
  ty: number;
}

/** One pen-tool volume keyframe (Clip.levelKeyframes).
 *
 *  `af` — MEDIA-space doc-frame (frames into the source media, same
 *  units as mediaOffsetFrames / mediaDurationFrames). Media-space so
 *  trim / slip / split don't invalidate the curve.
 *  `gain` — 0..1 linear multiplier, 1 = unity.
 *  `interp` — the segment shape FROM this node to the next (the named
 *  presets seed `outTan` + the next node's `inTan`; 'custom' once a
 *  handle is dragged; 'hold' is a step).
 *  `inTan` / `outTan` — per-node bezier handles (After Effects model).
 *  A segment A->B is a cubic with control points A+(A.outTan) and
 *  B-(B.inTan), each tangent scaled by that segment's span. */
export interface LevelKeyframe {
  af: number;
  gain: number;
  interp: LevelInterp;
  inTan: LevelTangent;
  outTan: LevelTangent;
}

/** Default tangents for a freshly-added keyframe — control points a
 *  third of the segment along, HORIZONTAL (ty 0). Horizontal tangents
 *  at both ends give a smooth ease-in-out S-curve between nodes (not
 *  a straight ramp), and the handles draw flat so they're easy to
 *  grab and adjust. */
export const LEVEL_DEFAULT_TANGENT: LevelTangent = { tx: 1 / 3, ty: 0 };

/** Per-preset tangents: [outTan, inTan-of-next]. The named ease
 *  presets seed BOTH the node's outgoing handle and the next node's
 *  incoming handle. 'hold' steps (no curve) and 'custom' is per-node,
 *  so neither appears here. */
export const LEVEL_PRESET_TANGENTS: Record<
  string, { out: LevelTangent; nextIn: LevelTangent }
> = {
  linear:        { out: { tx: 1 / 3, ty: 1 / 3 }, nextIn: { tx: 1 / 3, ty: 1 / 3 } },
  'ease-in':     { out: { tx: 0.42, ty: 0 },      nextIn: { tx: 1 / 3, ty: 1 / 3 } },
  'ease-out':    { out: { tx: 1 / 3, ty: 1 / 3 }, nextIn: { tx: 0.42, ty: 0 } },
  'ease-in-out': { out: { tx: 0.42, ty: 0 },      nextIn: { tx: 0.42, ty: 0 } },
};

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
  /** Audio only — silences the track during playback / scrub. */
  muted: boolean;
  /** Audio only — if ANY audio track is soloed, only soloed tracks
   *  are audible. */
  solo: boolean;
  /** Both sides — prevents clip edits (move/trim/roll/slip/split/
   *  delete/nudge) on every clip this track owns. */
  locked: boolean;
  /** Video only — the eye toggle. When false the track's clips never
   *  win active-camera routing (their camera won't take the C4D
   *  viewport). The clips still render on the timeline. */
  visible: boolean;
  /** True once the user has renamed the track. Governs whether a
   *  renumber (after a track delete) regenerates the auto name. */
  nameIsCustom: boolean;
}

/** Default flag values for a freshly-minted track. Spread into every
 *  Track literal so a new V2/A3/etc. starts unlocked, visible, etc. */
export const TRACK_FLAG_DEFAULTS = {
  muted: false,
  solo: false,
  locked: false,
  visible: true,
  nameIsCustom: false,
} as const;

/** Ghost preview of an OM drop that's being hovered. Cleared on
 *  om-cancel or after om-drop creates a real clip. */
export interface DragPreview {
  trackId: string;        // e.g. 'V1' — which track the cursor is over
  inFrame: number;        // computed from cursor X
  outFrame: number;       // inFrame + duration
  sourceName: string;     // for the label inside the ghost
}

export interface ScrollWindow {
  min: number;
  max: number;
  vMin: number;
  vMax: number;
}
