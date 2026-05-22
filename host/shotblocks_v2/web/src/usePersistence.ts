import { useEffect, useRef } from 'react';
import { useStore, getNextClipId, setNextClipId, type Track, type LevelKeyframe, type LevelInterp } from './store';
import { onMessage, send } from './lib/host';
import { fetchAudio, removeAudio, hasAudio } from './lib/audioStore';

/** Per-doc clip persistence. C++ owns the storage (hidden helper
 *  BaseObject inside the C4D document), JS owns serialization. Ports
 *  the v1 Python plugin's persistence model (sb_persistence.py) to the
 *  split-process v2.
 *
 *  Flow:
 *   - On first 'hello' from C++ → fire load-state. Parse the JSON,
 *     replace tracks + nextClipId. C++ has already rebuilt its
 *     _cameraLinks map from the BaseLinks stored on the helper, so
 *     playhead-driven camera switching works on the next tick.
 *   - On any change to videoTracks / audioTracks → debounced save.
 *     The 250ms debounce prevents save spam during drag (live commits
 *     fire many times per second).
 *
 *  Save-once flag: avoid an immediate save right after the load, which
 *  would just rewrite what we just read. */
const SAVE_DEBOUNCE_MS = 250;

interface SavedClip {
  id: number;
  inFrame: number;
  outFrame: number;
  sourceName: string;
  sourceType: number;
  objectId: number;
  state: string;
  locked: boolean;
  // Audio-only fields. Persisted so waveforms survive doc reload
  // (the source binary itself can't — WebView2 hides file paths).
  filePath?: string;
  peakLevels?: { sps: number; b64: string }[];
  peakAbsMax?: number;
  // Media-window: must persist so cuts / trims / slips survive
  // reload. Without these a reloaded split clip would rescale its
  // waveform again (mediaOffsetFrames lost → defaults to 0).
  mediaDurationFrames?: number;
  mediaOffsetFrames?: number;
  // Stable audio-media key. Persisted so split halves still resolve
  // to the same C++-stored audio bytes after reload.
  mediaId?: number;
  // Detected prominent peaks (media-space audio sample frames) +
  // the sample rate they were measured at. Persisted so beat
  // detection results survive doc reload.
  audioPeaks?: number[];
  audioPeaksSampleRate?: number;
  audioBeatGrid?: { periodSamples: number; phaseSamples: number; confidence: number; barOffset: number };
  audioSongParts?: number[];
  // Pen-tool volume automation. Each node: media-space af, 0..1 gain,
  // segment interp, and the cubic-bezier handles.
  levelKeyframes?: {
    af: number; gain: number; interp: string;
    ease: [number, number, number, number];
  }[];
}
interface SavedTrack {
  id: number;
  name: string;
  clips: SavedClip[];
  // Per-track flags. Optional in the type so docs saved before these
  // fields existed still parse — load backfills sane defaults.
  muted?: boolean;
  solo?: boolean;
  locked?: boolean;
  visible?: boolean;
  nameIsCustom?: boolean;
}
interface SavedState {
  videoTracks: SavedTrack[];
  audioTracks: SavedTrack[];
  nextClipId: number;
}

/** Resolve a saved track's per-track flags, defaulting any the doc
 *  didn't carry (visible defaults true, everything else false). */
function trackFlagsFromSaved(t: SavedTrack): {
  muted: boolean; solo: boolean; locked: boolean;
  visible: boolean; nameIsCustom: boolean;
} {
  return {
    muted: !!t.muted,
    solo: !!t.solo,
    locked: !!t.locked,
    visible: t.visible !== false,
    nameIsCustom: !!t.nameIsCustom,
  };
}

const LEVEL_INTERPS: LevelInterp[] =
  ['linear', 'hold', 'ease-in', 'ease-out', 'ease-in-out', 'custom'];

/** Coerce saved level-keyframes back to typed LevelKeyframe[]. JSON
 *  loses the union types and could carry stale interp names; this
 *  re-validates each node. Returns undefined for an empty/missing
 *  list so a clip with no automation stays clean. */
function levelKeyframesFromSaved(
  raw: SavedClip['levelKeyframes'],
): LevelKeyframe[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  const out: LevelKeyframe[] = raw.map((k) => {
    const interp: LevelInterp = LEVEL_INTERPS.includes(k.interp as LevelInterp)
      ? (k.interp as LevelInterp) : 'linear';
    const e = Array.isArray(k.ease) && k.ease.length === 4
      ? k.ease : [0, 0, 1, 1];
    return {
      af: k.af | 0,
      gain: Math.max(0, Math.min(1, k.gain)),
      interp,
      ease: [e[0], e[1], e[2], e[3]] as [number, number, number, number],
    };
  });
  out.sort((a, b) => a.af - b.af);
  return out;
}

export function usePersistence(): void {
  // After load: skip the save that the load itself triggers (the
  // store update from setting tracks would otherwise fire the
  // debounced save and round-trip the same data back to C++).
  const skipNextSave = useRef(false);
  // Track whether we've already loaded once for this dialog
  // lifetime. C++ posts 'hello' on every navigate; we only want to
  // load on the first one.
  const loadedOnce = useRef(false);

  // On hello → load. The onMessage stream survives across dialog
  // open/close, so this effect runs once per App mount.
  //
  // On state-changed → reload too. C++ fires this when the helper's
  // version counter changes outside of our own save-state call —
  // i.e. when C4D's native undo / redo rolls the helper to a
  // different snapshot. JS picks up the new (old) state by re-firing
  // load-state, same path as initial load.
  useEffect(() => {
    const off = onMessage((msg) => {
      if (msg.kind === 'hello') {
        if (loadedOnce.current) return;
        loadedOnce.current = true;
        void loadFromHost(skipNextSave);
        return;
      }
      if (msg.kind === 'state-changed') {
        void loadFromHost(skipNextSave);
        return;
      }
    });
    return off;
  }, []);

  // Subscribe to clip-list changes → debounced save + audio cleanup.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = useStore.subscribe((s, prev) => {
      // Only save if tracks actually changed (Zustand fires for ANY
      // state change). Reference equality is fine because every clip
      // mutation creates new track / clip arrays.
      if (s.videoTracks === prev.videoTracks && s.audioTracks === prev.audioTracks) return;

      // Detect audio MEDIA that is no longer referenced by any clip,
      // and free the persisted bytes. Audio lives in C++'s helper
      // keyed by mediaId; leaving it there after the last referencing
      // clip is gone leaks dead bytes into the doc.
      //
      // Keyed by mediaId, NOT clipId: a split produces several clips
      // sharing one media. We must only remove the bytes once EVERY
      // clip with that mediaId is gone — otherwise cutting a clip and
      // deleting one half would silence the other half.
      const prevMediaIds = new Set<number>();
      for (const t of prev.audioTracks) {
        for (const c of t.clips) prevMediaIds.add(c.mediaId ?? c.id);
      }
      const nowMediaIds = new Set<number>();
      for (const t of s.audioTracks) {
        for (const c of t.clips) nowMediaIds.add(c.mediaId ?? c.id);
      }
      for (const mediaId of prevMediaIds) {
        if (!nowMediaIds.has(mediaId)) void removeAudio(mediaId);
      }

      if (skipNextSave.current) {
        skipNextSave.current = false;
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(saveToHost, SAVE_DEBOUNCE_MS);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, []);
}

async function loadFromHost(skipNextSave: React.MutableRefObject<boolean>) {
  try {
    const raw = await send({ kind: 'load-state' });
    const ack = raw as { ok?: boolean; json?: string } | undefined;
    if (!ack || !ack.ok || !ack.json) return;
    const parsed: SavedState = JSON.parse(ack.json);
    if (!parsed || !Array.isArray(parsed.videoTracks) || !Array.isArray(parsed.audioTracks)) return;
    // Coerce types — JSON loses Set / specific string unions etc.
    const videoTracks: Track[] = parsed.videoTracks.map((t) => ({
      id: t.id,
      name: t.name,
      ...trackFlagsFromSaved(t),
      clips: t.clips.map((c) => ({
        id: c.id,
        inFrame: c.inFrame,
        outFrame: c.outFrame,
        sourceName: c.sourceName,
        sourceType: c.sourceType,
        objectId: c.objectId,
        state: c.state as Track['clips'][number]['state'],
        locked: !!c.locked,
        filePath: c.filePath,
        peakLevels: c.peakLevels,
        peakAbsMax: c.peakAbsMax,
        mediaDurationFrames: c.mediaDurationFrames,
        mediaOffsetFrames: c.mediaOffsetFrames,
      })),
    }));
    const audioTracks: Track[] = parsed.audioTracks.map((t) => ({
      id: t.id,
      name: t.name,
      ...trackFlagsFromSaved(t),
      clips: t.clips.map((c) => {
        // Media-window backfill: audio clips saved before the
        // media-window model have no mediaDuration/mediaOffset. A
        // never-edited clip's full timeline span IS its media span,
        // starting at media frame 0. Backfilling here makes every
        // audio clip well-formed before any cut / trim / slip — so
        // splitClip etc. never see undefined fields.
        const clipDur = c.outFrame - c.inFrame;
        return {
          id: c.id,
          inFrame: c.inFrame,
          outFrame: c.outFrame,
          sourceName: c.sourceName,
          sourceType: c.sourceType,
          objectId: c.objectId,
          state: c.state as Track['clips'][number]['state'],
          locked: !!c.locked,
          filePath: c.filePath,
          peakLevels: c.peakLevels,
          peakAbsMax: c.peakAbsMax,
          mediaDurationFrames: c.mediaDurationFrames ?? clipDur,
          mediaOffsetFrames: c.mediaOffsetFrames ?? 0,
          audioPeaks: c.audioPeaks,
          audioPeaksSampleRate: c.audioPeaksSampleRate,
          audioBeatGrid: c.audioBeatGrid,
          audioSongParts: c.audioSongParts,
          levelKeyframes: levelKeyframesFromSaved(c.levelKeyframes),
          // Backfill mediaId: pre-media-window scenes keyed audio
          // bytes in the C++ helper by the (then-unsplit) clipId, so
          // the clip's own id IS the correct media key for old data.
          mediaId: c.mediaId ?? c.id,
        };
      }),
    }));
    skipNextSave.current = true;
    setNextClipId(Math.max(1, parsed.nextClipId | 0));
    useStore.setState({ videoTracks, audioTracks });

    // Fetch persisted audio binaries for any audio MEDIA we don't
    // already have in memory. Keyed by mediaId so split halves
    // (which share one media) only trigger a single fetch. Each
    // fetch is async + independent; we don't block the load on them.
    const seenMedia = new Set<number>();
    for (const t of audioTracks) {
      for (const c of t.clips) {
        const mediaId = c.mediaId ?? c.id;
        if (seenMedia.has(mediaId)) continue;
        seenMedia.add(mediaId);
        if (!hasAudio(mediaId)) {
          void fetchAudio(mediaId);
        }
      }
    }
  } catch (e) {
    console.warn('[persistence] load failed', e);
  }
}

function saveToHost() {
  const s = useStore.getState();
  // Strip transient fields — only persist what defines the timeline.
  const payload: SavedState = {
    videoTracks: s.videoTracks.map((t) => ({
      id: t.id,
      name: t.name,
      muted: t.muted,
      solo: t.solo,
      locked: t.locked,
      visible: t.visible,
      nameIsCustom: t.nameIsCustom,
      clips: t.clips.map((c) => ({
        id: c.id,
        inFrame: c.inFrame,
        outFrame: c.outFrame,
        sourceName: c.sourceName,
        sourceType: c.sourceType,
        objectId: c.objectId,
        state: c.state,
        locked: c.locked,
        filePath: c.filePath,
        peakLevels: c.peakLevels,
        peakAbsMax: c.peakAbsMax,
        mediaDurationFrames: c.mediaDurationFrames,
        mediaOffsetFrames: c.mediaOffsetFrames,
      })),
    })),
    audioTracks: s.audioTracks.map((t) => ({
      id: t.id,
      name: t.name,
      muted: t.muted,
      solo: t.solo,
      locked: t.locked,
      visible: t.visible,
      nameIsCustom: t.nameIsCustom,
      clips: t.clips.map((c) => ({
        id: c.id,
        inFrame: c.inFrame,
        outFrame: c.outFrame,
        sourceName: c.sourceName,
        sourceType: c.sourceType,
        objectId: c.objectId,
        state: c.state,
        locked: c.locked,
        filePath: c.filePath,
        peakLevels: c.peakLevels,
        peakAbsMax: c.peakAbsMax,
        mediaDurationFrames: c.mediaDurationFrames,
        mediaOffsetFrames: c.mediaOffsetFrames,
        mediaId: c.mediaId,
        audioPeaks: c.audioPeaks,
        audioPeaksSampleRate: c.audioPeaksSampleRate,
        audioBeatGrid: c.audioBeatGrid,
        audioSongParts: c.audioSongParts,
        levelKeyframes: c.levelKeyframes,
      })),
    })),
    nextClipId: getNextClipId(),
  };
  // Object ids list — every objectId currently referenced by a clip.
  // C++ uses this to prune stale BaseLinks from the helper.
  const objectIds: number[] = [];
  const collect = (tracks: typeof s.videoTracks) => {
    for (const t of tracks) {
      for (const c of t.clips) {
        if (c.objectId > 0) objectIds.push(c.objectId);
      }
    }
  };
  collect(s.videoTracks);
  collect(s.audioTracks);
  const json = JSON.stringify(payload);
  void send({ kind: 'save-state', json, objectIds });
}
