import { useEffect, useRef } from 'react';
import { useStore, NATURAL_TRACK_PX, MIN_TRACK_PX } from '../store';
import { useElementSize } from '../useElementSize';

/** Returns the adaptive `max` value for an audio v-window so the
 *  scrollbar ends sit at the natural extremes of the track at max
 *  zoom-out.
 *
 *  Two regimes:
 *   - Content fits in visible region at MIN_TRACK_PX → no need for
 *     pan headroom. max = maxSpan = NATURAL/MIN * count. At max
 *     zoom-out, span == max → thumb spans the entire track.
 *   - Content overflows at MIN_TRACK_PX → reserve pan headroom in
 *     track-units. max = maxSpan + (overflow / MIN_TRACK_PX). At
 *     max zoom-out, thumb fills span/max < 1 portion of the track,
 *     and vMin can slide through the remaining headroom. */
export function computeVMax(trackCount: number, visibleHeight: number): number {
  const n = Math.max(1, trackCount);
  const maxSpan = NATURAL_TRACK_PX * n / MIN_TRACK_PX;
  if (visibleHeight <= 0) return maxSpan;
  // contentH includes the spawn-buffer spacer.
  const contentH = (n + 1) * MIN_TRACK_PX;
  const overflow = Math.max(0, contentH - visibleHeight);
  const panHeadroom = overflow / MIN_TRACK_PX;
  return maxSpan + panHeadroom;
}

/** Video side is fixed-height + pan-only. Its v-window is measured in
 *  fixed 65px track-units: max = trackCount + 1 (the spawn-buffer
 *  spacer), span = how many 65px lanes fit in the visible region. No
 *  zoom — span is derived purely from the visible height. */
export function videoVSpan(visibleHeight: number): number {
  if (visibleHeight <= 0) return 1;
  return visibleHeight / NATURAL_TRACK_PX;
}

/** True when one side's tracks overflow its visible region — i.e.
 *  there is real distance to pan. The v-scrollbar is gated on this: a
 *  view with nowhere to pan shows no scrollbar.
 *
 *  Video: fixed 65px lanes — overflow is just (count+1)*65 vs height.
 *  Audio: zoomable — height depends on the current zoom span. */
export function sideOverflows(
  win: { vMin: number; vMax: number },
  trackCount: number,
  visibleHeight: number,
  side: 'video' | 'audio',
): boolean {
  if (visibleHeight < 1) return false;
  const n = Math.max(1, trackCount);
  const trackPx = side === 'video'
    ? NATURAL_TRACK_PX
    : Math.max(MIN_TRACK_PX,
        NATURAL_TRACK_PX * n / Math.max(0.01, win.vMax - win.vMin));
  const contentH = trackPx * (n + 1);   // +1 = spawn-buffer spacer
  return contentH - visibleHeight > 0.5;
}

/** Keeps the vertical scrollbar ranges in sync with track counts.
 *  Range = 2× track count so the centered default window leaves equal
 *  headroom to zoom OUT on both sides. Preserves user zoom unless the
 *  view is at the default centered span.
 *
 *  On track-count change, scale the v-window so the user-perceived
 *  ZOOM RATIO stays constant: zoom ratio = span / trackCount =
 *  (vMax - vMin) / (max / 2). Without this, adding a track to a
 *  user-zoomed-in view would visually shrink (or balloon) every
 *  existing track because the same span now represents a different
 *  fraction of the new total. Reset-to-default would be heavy-handed
 *  every spawn.
 *
 *  Direction policy on a track ADD: pin the visible window to the
 *  OUTERMOST end of the new range so the freshly-spawned track and
 *  its spawn-buffer are both in view. On a track REMOVE, keep the
 *  user's current position centered proportionally rather than
 *  snapping anywhere. */
export function useTrackCountSync(videoStackH: number, audioStackH: number) {
  const videoTracks = useStore((s) => s.videoTracks);
  const audioTracks = useStore((s) => s.audioTracks);
  // Remember the previous video/audio counts across renders so we
  // can tell whether the effect fired because of a count change
  // (reproportion + pin) or a visible-height change (just clamp).
  const prevVideoCount = useRef(videoTracks.length);
  const prevAudioCount = useRef(audioTracks.length);

  // Video side is fixed-height + pan-only (no zoom). The window's max
  // is just trackCount + 1 (spawn buffer); its span is derived from
  // the visible height (how many fixed 65px lanes fit). On a track
  // ADD, pin to the outer (top) end so the new track + spawn buffer
  // land in view. Otherwise keep the current pan, clamped.
  useEffect(() => {
    const n = Math.max(1, videoTracks.length);
    const newMax = n + 1;
    const span = Math.min(newMax, videoVSpan(videoStackH));
    const s = useStore.getState();
    const prevN = Math.max(1, prevVideoCount.current);
    prevVideoCount.current = n;
    const isAdd = n > prevN;
    let vMin: number;
    if (isAdd || s.vVideo.vMax > newMax + 0.001) {
      // Pin to the top end (V<max> + spawn buffer visible).
      vMin = Math.max(0, newMax - span);
    } else {
      vMin = Math.max(0, Math.min(s.vVideo.vMin, newMax - span));
    }
    const vMax = vMin + span;
    if (Math.abs(s.vVideo.max - newMax) < 0.001
        && Math.abs(s.vVideo.vMin - vMin) < 0.001
        && Math.abs(s.vVideo.vMax - vMax) < 0.001) return;
    useStore.setState({ vVideo: { min: 0, max: newMax, vMin, vMax } });
  }, [videoTracks.length, videoStackH]);

  useEffect(() => {
    const n = Math.max(1, audioTracks.length);
    const newMax = computeVMax(n, audioStackH);
    const s = useStore.getState();
    if (Math.abs(s.vAudio.max - newMax) < 0.001) return;
    const prevN = Math.max(1, prevAudioCount.current);
    prevAudioCount.current = n;
    const isCountChange = n !== prevN;
    const isAdd = n > prevN;
    if (isCountChange) {
      const prevSpan = s.vAudio.vMax - s.vAudio.vMin;
      const newSpan = prevSpan * (n / prevN);
      let vMin: number;
      let vMax: number;
      if (isAdd) {
        vMax = newMax;
        vMin = Math.max(0, newMax - newSpan);
      } else {
        const prevCenter = (s.vAudio.vMin + s.vAudio.vMax) / 2;
        const newCenter = prevCenter * (n / prevN);
        vMin = newCenter - newSpan / 2;
        vMax = newCenter + newSpan / 2;
        if (vMin < 0) { vMax += -vMin; vMin = 0; }
        if (vMax > newMax) { vMin -= vMax - newMax; vMax = newMax; }
        vMin = Math.max(0, vMin);
        vMax = Math.min(newMax, vMax);
      }
      useStore.setState({ vAudio: { min: 0, max: newMax, vMin, vMax } });
    } else {
      let vMin = s.vAudio.vMin;
      let vMax = Math.min(s.vAudio.vMax, newMax);
      vMin = Math.min(vMin, vMax - 0.01);
      useStore.setState({ vAudio: { min: 0, max: newMax, vMin, vMax } });
    }
  }, [audioTracks.length, audioStackH]);
}

/** Drives per-side track-height + scroll-offset CSS vars from each
 *  vertical scrollbar window.
 *
 *  Range model: max = 2 × trackCount, with the default visible window
 *  centered at span = trackCount. That gives the user equal headroom
 *  on both sides of the default — they can zoom IN (drag dots toward
 *  each other) or OUT (drag dots apart) from the natural state.
 *
 *  trackHeight = NATURAL_TRACK_PX × trackCount / span.
 *    span = trackCount  → natural 65px tracks (default).
 *    span < trackCount  → zoomed in (taller tracks, overflow scrolls).
 *    span > trackCount  → zoomed out (shorter tracks; sub-32px flips
 *                          to the thin shot-block layout).
 *
 *  Scroll: vMin within the available scroll range maps to a translate
 *  on the lane content. Lane stays anchored at the V/A divider via
 *  the flex layout; the translate moves what's visible inside the
 *  side region. */
export function useVerticalZoomVars(
  videosRegionRef: React.RefObject<HTMLDivElement | null>,
  audiosRegionRef: React.RefObject<HTMLDivElement | null>,
) {
  const vVideo = useStore((s) => s.vVideo);
  const vAudio = useStore((s) => s.vAudio);
  const videoTrackCount = useStore((s) => s.videoTracks.length);
  const audioTrackCount = useStore((s) => s.audioTracks.length);
  const vSize = useElementSize(videosRegionRef);
  const aSize = useElementSize(audiosRegionRef);

  // Video side is FIXED-HEIGHT — lanes always render at NATURAL_TRACK_PX
  // and never respond to vertical zoom (camera-sequencing tracks are
  // typically 1-3 deep; a fixed height keeps the future twirl-down
  // sub-tracks predictable). The vVideo window is pan-only: span =
  // how many 65px lanes fit, vMin = pan position. Only --video-scroll-y
  // varies; --video-track-h is the constant NATURAL_TRACK_PX.
  useEffect(() => {
    if (vSize.height < 1) return;
    const trackCount = Math.max(1, videoTrackCount);
    const trackPx = NATURAL_TRACK_PX;
    // contentH includes the spawn-buffer spacer (one extra track).
    const contentH = trackPx * (trackCount + 1);
    const overflow = Math.max(0, contentH - vSize.height);
    const span = Math.max(0.01, vVideo.vMax - vVideo.vMin);
    const scrollRange = Math.max(0.0001, (vVideo.max - vVideo.min) - span);
    const scrollFrac = scrollRange > 0 ? Math.max(0, vVideo.vMin - vVideo.min) / scrollRange : 0;
    const scrollY = scrollFrac * overflow;
    document.documentElement.style.setProperty('--video-track-h', trackPx + 'px');
    document.documentElement.style.setProperty('--video-scroll-y', scrollY + 'px');
  }, [vVideo.vMin, vVideo.vMax, vVideo.min, vVideo.max, vSize.height, videoTrackCount]);

  useEffect(() => {
    if (aSize.height < 1) return;
    const span = Math.max(0.01, vAudio.vMax - vAudio.vMin);
    const trackCount = Math.max(1, audioTrackCount);
    const trackPx = Math.max(MIN_TRACK_PX, NATURAL_TRACK_PX * trackCount / span);
    const contentH = trackPx * (trackCount + 1);
    const overflow = Math.max(0, contentH - aSize.height);
    const scrollRange = Math.max(0.0001, (vAudio.max - vAudio.min) - span);
    const scrollFrac = scrollRange > 0 ? Math.max(0, vAudio.vMin - vAudio.min) / scrollRange : 0;
    const scrollY = -scrollFrac * overflow;
    document.documentElement.style.setProperty('--audio-track-h', trackPx + 'px');
    document.documentElement.style.setProperty('--audio-scroll-y', scrollY + 'px');
  }, [vAudio.vMin, vAudio.vMax, vAudio.min, vAudio.max, aSize.height, audioTrackCount]);
}
