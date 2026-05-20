import { useEffect, useRef } from 'react';
import { useStore, type Clip } from './store';
import { onMessage } from './lib/host';
import { getAudioBuffer } from './lib/audioStore';

/** Per-scrub blip length in seconds. Standard NLE convention: each
 *  scrub event plays a short slice of audio at the cursor position.
 *  Rapid mousemoves overlap the blips into the characteristic
 *  "scrubby" sound. 80ms is the Premiere default. */
const SCRUB_BLIP_SEC = 0.08;
/** Throttle scrub blips so a single ruler-drag doesn't fire dozens
 *  of overlapping sources per second. ~60ms between blips gives a
 *  continuous-feel scrub without GPU/audio saturation. */
const SCRUB_THROTTLE_MS = 60;

/** Drives WebAudio playback in sync with C4D's transport.
 *
 *  Anchor-sync model (mirrors Python's _playback_anchor_t /
 *  _playback_anchor_frame in sb_canvas_playback.py:147):
 *
 *  When playback starts we snapshot:
 *    - ctxStart   = AudioContext.currentTime at start
 *    - frameStart = the C4D playhead frame at start
 *
 *  For each audio clip overlapping the play range, we schedule one
 *  AudioBufferSourceNode with:
 *    when   = ctxStart + max(0, (clip.inFrame - frameStart) / fps)
 *    offset = max(0, (frameStart - clip.inFrame) / fps)
 *    duration = (clip.outFrame - max(frameStart, clip.inFrame)) / fps
 *
 *  WebAudio's sample-accurate clock keeps audio continuous from the
 *  start point. Subsequent C4D ticks (which carry the playhead frame
 *  for video update) are NOT used to drive audio — that would create
 *  jitter. We only re-anchor when:
 *    - playing flips false → true (start fresh)
 *    - playing is true and the C4D frame diverges from the predicted
 *      audio-clock position by > SCRUB_THRESHOLD_FRAMES (user
 *      scrubbed; restart from the new position).
 *
 *  Audio survives doc save/reload because the file bytes ride in the
 *  C4D helper container (see lib/audioStore.ts).
 */

const SCRUB_THRESHOLD_FRAMES = 3;

interface ActiveSource {
  node: AudioBufferSourceNode;
  clipId: number;
}

export function useAudioPlayback(): void {
  const ctxRef = useRef<AudioContext | null>(null);
  const activeRef = useRef<ActiveSource[]>([]);
  const playingRef = useRef(false);
  const anchorCtxTimeRef = useRef(0);
  const anchorFrameRef = useRef(0);
  const fpsRef = useRef(30);
  const lastScrubMsRef = useRef(0);

  useEffect(() => {
    const off = onMessage((msg) => {
      if (msg.kind !== 'tick') return;
      const fps = msg.fps || 30;
      fpsRef.current = fps;
      const frame = msg.frame;
      const playing = msg.playing;

      if (playing && !playingRef.current) {
        // Transport started.
        playingRef.current = true;
        void startPlayback(frame, fps);
        return;
      }
      if (!playing && playingRef.current) {
        // Transport stopped.
        playingRef.current = false;
        stopAllSources();
        return;
      }
      if (playing && playingRef.current) {
        // Mid-playback tick. Compare expected audio-clock position to
        // the C4D frame; if drifted, scrub-restart.
        const ctx = ctxRef.current;
        if (!ctx) return;
        const elapsedSec = ctx.currentTime - anchorCtxTimeRef.current;
        const predictedFrame = anchorFrameRef.current + elapsedSec * fps;
        if (Math.abs(predictedFrame - frame) > SCRUB_THRESHOLD_FRAMES) {
          stopAllSources();
          void startPlayback(frame, fps);
        }
      }
    });
    return () => {
      off();
      stopAllSources();
      const ctx = ctxRef.current;
      if (ctx) void ctx.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scrub blips — subscribe to scrubFrame changes and play a short
  // slice of any audio clip overlapping the scrub position. Only
  // fires when audioScrub is on AND transport isn't already playing
  // (overlapping the playback stream would be a mess).
  useEffect(() => {
    const unsub = useStore.subscribe((s, prev) => {
      if (s.scrubFrame === prev.scrubFrame) return;
      if (s.scrubFrame == null) return;
      if (!s.audioScrub) return;
      if (playingRef.current) return;
      const now = performance.now();
      if (now - lastScrubMsRef.current < SCRUB_THROTTLE_MS) return;
      lastScrubMsRef.current = now;
      void blipAt(s.scrubFrame, s.fps || fpsRef.current);
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function blipAt(frame: number, fps: number) {
    const ctx = ensureCtx();
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch { /* nop */ }
    }
    const fpsInv = 1 / fps;
    const s = useStore.getState();
    for (const t of s.audioTracks) {
      for (const clip of t.clips) {
        if (frame < clip.inFrame || frame >= clip.outFrame) continue;
        const mediaId = clip.mediaId ?? clip.id;
        const buf = await getAudioBuffer(mediaId, ctx);
        if (!buf) continue;
        // Buffer is the whole media; window starts mediaOffsetFrames in.
        const mediaOffsetFrames = clip.mediaOffsetFrames ?? 0;
        const offset = (mediaOffsetFrames + (frame - clip.inFrame)) * fpsInv;
        const duration = Math.min(SCRUB_BLIP_SEC, buf.duration - offset);
        if (duration <= 0) continue;
        const node = ctx.createBufferSource();
        node.buffer = buf;
        node.connect(ctx.destination);
        try {
          node.start(ctx.currentTime, offset, duration);
        } catch { /* timing race during rapid scrub */ }
        // Auto-cleanup once the blip ends.
        node.onended = () => {
          try { node.disconnect(); } catch { /* nop */ }
        };
      }
    }
  }

  function ensureCtx(): AudioContext {
    if (!ctxRef.current) {
      const Ctor: typeof AudioContext =
        (window.AudioContext) || ((window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
      ctxRef.current = new Ctor();
    }
    return ctxRef.current;
  }

  function stopAllSources() {
    for (const a of activeRef.current) {
      try { a.node.stop(); } catch { /* already stopped */ }
      try { a.node.disconnect(); } catch { /* nop */ }
    }
    activeRef.current = [];
  }

  async function startPlayback(frame: number, fps: number) {
    stopAllSources();
    const ctx = ensureCtx();
    if (ctx.state === 'suspended') {
      // WebView2 sometimes starts the AudioContext suspended until a
      // user gesture; resume explicitly. The spacebar press already
      // counts as a gesture in Chromium's autoplay policy.
      try { await ctx.resume(); } catch { /* nop */ }
    }
    const startCtxTime = ctx.currentTime;
    anchorCtxTimeRef.current = startCtxTime;
    anchorFrameRef.current = frame;

    // Snapshot all audio clips at this instant. We schedule everything
    // up front rather than per-tick; the audio clock takes over.
    const s = useStore.getState();
    const audioClips: Clip[] = [];
    for (const t of s.audioTracks) audioClips.push(...t.clips);

    for (const clip of audioClips) {
      // Skip clips that end before the play start (no future audio).
      if (clip.outFrame <= frame) continue;

      // Audio is keyed by mediaId — split halves share one media.
      const mediaId = clip.mediaId ?? clip.id;
      const buf = await getAudioBuffer(mediaId, ctx);
      if (!buf) continue;

      // Bail if playback already stopped while we were decoding.
      if (!playingRef.current) return;
      // Bail if a re-anchor happened while we were decoding (scrub-
      // restart races a slow decode).
      if (anchorCtxTimeRef.current !== startCtxTime) return;

      // Timing math:
      //   when    = absolute ctx time when this clip should start
      //             playing. If the play head is BEFORE the clip's
      //             inFrame, we schedule into the future. If the play
      //             head is mid-clip, when == startCtxTime (start now,
      //             with an offset).
      //   offset  = seconds into the source buffer to start from.
      //             The buffer is the WHOLE media file; the clip is a
      //             window starting `mediaOffsetFrames` into it. So
      //             the buffer position for doc-frame `frame` is
      //             mediaOffsetFrames + (frame - inFrame). Without the
      //             mediaOffset term, every clip plays from the file's
      //             start — which is why audio dropped after the
      //             first cut (the 2nd clip replayed the intro, or
      //             ran past the buffer end).
      //   duration = how much of the buffer to play (clamped to clip
      //             out-frame and to the buffer's own length).
      const fpsInv = 1 / fps;
      const mediaOffsetFrames = clip.mediaOffsetFrames ?? 0;
      const framesIntoClip = Math.max(0, frame - clip.inFrame);
      const when   = startCtxTime + Math.max(0, (clip.inFrame - frame) * fpsInv);
      const offset = (mediaOffsetFrames + framesIntoClip) * fpsInv;
      const remainingFrames = clip.outFrame - Math.max(frame, clip.inFrame);
      const duration = Math.min(remainingFrames * fpsInv, buf.duration - offset);
      if (duration <= 0) continue;

      const node = ctx.createBufferSource();
      node.buffer = buf;
      node.connect(ctx.destination);
      try {
        node.start(when, offset, duration);
      } catch (e) {
        // Negative-time / past-time scheduling: clamp + retry.
        console.warn('[audio] start failed; retrying with now-anchor', e);
        try { node.start(ctx.currentTime, offset, duration); } catch { /* give up */ }
      }
      activeRef.current.push({ node, clipId: clip.id });
    }
  }
}
