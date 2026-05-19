import { useEffect } from 'react';
import { useStore, type DragPreview } from './store';
import { computePeaks } from './lib/peaks';
import { addAudio } from './lib/audioStore';

/** Fallback ghost width (frames) while the file's true duration is
 *  still loading. As soon as HTML5 Audio resolves loadedmetadata, the
 *  cached value is used for the drop itself. */
const FALLBACK_DURATION_FRAMES = 48;

/** Walk hit-test the cursor against lanes. Audio side only; drops on
 *  video lanes are silently rejected (audio is file-only by design,
 *  matching the v1 source-of-truth memory). Returns the resolved
 *  trackId + the inFrame derived from cursor X, or null if the cursor
 *  isn't over an audio lane. */
function resolveAudioLane(
  viewportX: number,
  viewportY: number,
): { trackId: string; inFrame: number } | null {
  const targets = document.elementsFromPoint(viewportX, viewportY);
  const laneEl = targets.find((el) => el.classList && el.classList.contains('lane')) as HTMLElement | undefined;
  if (!laneEl) return null;
  if (laneEl.getAttribute('data-side') !== 'audio') return null;

  const trackId = laneEl.getAttribute('data-track');
  if (!trackId) return null;

  const laneRect = laneEl.getBoundingClientRect();
  const xInLane = Math.max(0, viewportX - laneRect.left);
  const state = useStore.getState();
  const visibleSpan = Math.max(1, state.h.vMax - state.h.vMin);
  const pxPerFrame = laneRect.width / visibleSpan;
  if (pxPerFrame <= 0) return null;
  const startFrame = Math.round(state.h.vMin + xInLane / pxPerFrame);
  return { trackId, inFrame: startFrame };
}

/** Load the file's duration via HTML5 Audio + a blob URL. Resolves
 *  with seconds, or NaN on failure. The blob URL is revoked once
 *  metadata has loaded. */
function loadDurationFromBlob(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    audio.preload = 'metadata';
    const cleanup = () => {
      URL.revokeObjectURL(url);
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('error', onErr);
    };
    function onMeta() {
      const d = audio.duration;
      cleanup();
      resolve(Number.isFinite(d) && d > 0 ? d : NaN);
    }
    function onErr() {
      console.warn('[file-drop] HTMLAudio failed to load', file.name);
      cleanup();
      resolve(NaN);
    }
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('error', onErr);
    audio.src = url;
  });
}

function isAudioFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.wav') || lower.endsWith('.mp3');
}

/** Build a DragPreview for the current hover (no file metadata yet —
 *  duration is unknown until drop, since dragover events don't carry
 *  the File payload in WebView2). Width is a fallback; the actual clip
 *  will be the file's true duration. */
function buildHoverPreview(
  viewportX: number,
  viewportY: number,
  filename: string,
): DragPreview | null {
  const lane = resolveAudioLane(viewportX, viewportY);
  if (!lane) return null;
  return {
    trackId: lane.trackId,
    inFrame: lane.inFrame,
    outFrame: lane.inFrame + FALLBACK_DURATION_FRAMES,
    sourceName: filename,
  };
}

/** Listens for Explorer drag/drop directly through the WebView2 DOM.
 *
 *  WebView2 inherits Chromium's security model — File.path is hidden
 *  from JS — so we can't get the absolute filesystem path. We CAN read
 *  the File object (blob), use it to load duration via <audio>, and
 *  store the file's name on the clip. Persistence of the audio binary
 *  itself across save/load is a later milestone (requires the C++
 *  decoder + storing samples or peaks on the helper).
 *
 *  We must also preventDefault on dragover/drop globally so WebView2
 *  doesn't navigate to the file or open it in a new window — which is
 *  the default behavior for ANY OS file drop on a Chromium page. */
export function useFileDrop(): void {
  useEffect(() => {
    function onDragOver(ev: DragEvent) {
      // Only intercept if the drag has files. Internal HTML5 drags
      // (e.g. our own clip drags) should still flow through normally.
      const types = ev.dataTransfer?.types;
      if (!types || !Array.from(types).includes('Files')) return;
      ev.preventDefault();
      // Show the drop ghost on audio lanes during hover. We don't have
      // the filename here (Chrome hides it on dragover for privacy),
      // so use a placeholder.
      const preview = buildHoverPreview(ev.clientX, ev.clientY, 'audio');
      useStore.getState().setDragPreview(preview);
    }

    function onDragLeave(ev: DragEvent) {
      // Only clear if leaving the window entirely. Chromium fires
      // dragleave on every child boundary crossing, so just nulling
      // unconditionally would flicker the ghost off mid-drag.
      if (ev.relatedTarget == null) {
        useStore.getState().setDragPreview(null);
      }
    }

    function onDrop(ev: DragEvent) {
      const types = ev.dataTransfer?.types;
      if (!types || !Array.from(types).includes('Files')) return;
      ev.preventDefault();
      useStore.getState().setDragPreview(null);

      const files = ev.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const file = files[0];
      if (!isAudioFile(file.name)) {
        // Non-audio file — silently reject. The preventDefault above
        // is still important so WebView2 doesn't open it.
        return;
      }

      const lane = resolveAudioLane(ev.clientX, ev.clientY);
      if (!lane) return;

      const fps = useStore.getState().fps || 30;
      loadDurationFromBlob(file).then((seconds) => {
        const durationFrames = Number.isFinite(seconds) && seconds > 0
          ? Math.max(1, Math.round(seconds * fps))
          : FALLBACK_DURATION_FRAMES;
        const newId = useStore.getState().addClip(lane.trackId, {
          inFrame: lane.inFrame,
          outFrame: lane.inFrame + durationFrames,
          sourceName: file.name,
          sourceType: 0,
          objectId: 0,
          state: 'unselected',
          locked: false,
          // No filePath — WebView2 doesn't expose it. Peaks (below)
          // carry the visual representation across save/load even
          // though the source binary doesn't.
          filePath: '',
        });
        // Decode + summarize in parallel so the clip appears
        // immediately and the waveform fills in once decode finishes
        // (~200-400ms for a 5-min file).
        if (newId != null) {
          // Push the binary to the audio store + C++ helper so it
          // rides along with the doc save. Awaited so the bytes are
          // safely persisted before any subsequent save-state.
          void addAudio(newId, file);
          computePeaks(file).then((result) => {
            if (!result) return;
            useStore.getState().setClipPeaks(
              newId,
              result.levels,
              result.absMax,
            );
          });
        }
      });
    }

    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);
}
