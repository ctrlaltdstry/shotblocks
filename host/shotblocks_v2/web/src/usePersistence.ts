import { useEffect, useRef } from 'react';
import { useStore, getNextClipId, setNextClipId, type Track } from './store';
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
}
interface SavedTrack {
  id: number;
  name: string;
  clips: SavedClip[];
}
interface SavedState {
  videoTracks: SavedTrack[];
  audioTracks: SavedTrack[];
  nextClipId: number;
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

      // Detect audio clip deletions so we can free the persisted
      // bytes. Audio lives in C++'s helper container keyed by
      // BCKEY_V2_AUDIO_BASE + clipId; if we leave it there after the
      // clip is gone, the doc carries dead bytes forever.
      const prevAudioIds = new Set<number>();
      for (const t of prev.audioTracks) for (const c of t.clips) prevAudioIds.add(c.id);
      const nowAudioIds = new Set<number>();
      for (const t of s.audioTracks) for (const c of t.clips) nowAudioIds.add(c.id);
      for (const id of prevAudioIds) {
        if (!nowAudioIds.has(id)) void removeAudio(id);
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
      })),
    }));
    const audioTracks: Track[] = parsed.audioTracks.map((t) => ({
      id: t.id,
      name: t.name,
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
      })),
    }));
    skipNextSave.current = true;
    setNextClipId(Math.max(1, parsed.nextClipId | 0));
    useStore.setState({ videoTracks, audioTracks });

    // Fetch persisted audio binaries for any audio clips we don't
    // already have in memory. Each fetch is async + independent; we
    // don't block the load on them (the clips render fine before
    // playback is requested; useAudioPlayback will await per-clip).
    for (const t of audioTracks) {
      for (const c of t.clips) {
        if (!hasAudio(c.id)) {
          void fetchAudio(c.id);
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
      })),
    })),
    audioTracks: s.audioTracks.map((t) => ({
      id: t.id,
      name: t.name,
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
