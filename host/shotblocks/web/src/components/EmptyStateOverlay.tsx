import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store';

/** Progressive empty-state cue. Two overlays driven by clip counts:
 *
 *  - When the doc has ZERO video clips: a centered "drop a camera from
 *    the object manager" panel floats over the canvas. V1/A1 already
 *    exist as empty tracks underneath (they're created on store init);
 *    this is a visual cue only, not a track-suppression.
 *  - When the doc has ≥1 video clip but ZERO audio clips: a smaller
 *    "drag an audio file from your file browser" panel sits inside
 *    the audio sub-stack via a portal.
 *  - When both sides have clips: no overlay renders.
 *
 *  Both panels are pointer-events: none — the existing drop targets
 *  (OM-drop on the whole canvas, file-drop on each audio lane) handle
 *  the actual drops. The panels are pure discoverability cues.
 *
 *  Per Figma node 400:2073 — dashed border, grey-12 fill, grey-24
 *  label text, grey-16 plus glyph. */
export function EmptyStateOverlay() {
  const videoTracks = useStore((s) => s.videoTracks);
  const audioTracks = useStore((s) => s.audioTracks);
  const videoEmpty = videoTracks.every((t) => t.clips.length === 0);
  const audioEmpty = audioTracks.every((t) => t.clips.length === 0);

  // Resolve the audio-stack element for portaling the audio variant.
  // It's created by Stage; we look it up by id. Re-resolves on every
  // render so a remount via doc reload picks up the fresh node.
  const [audioStackEl, setAudioStackEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setAudioStackEl(document.getElementById('lanes-audios'));
  });

  if (videoEmpty) {
    return (
      <div className="empty-state empty-state--camera">
        <div className="empty-state__panel">
          <div className="empty-state__label">drop a camera from the object manager</div>
          <PlusGlyph />
        </div>
      </div>
    );
  }
  if (audioEmpty && audioStackEl) {
    return createPortal(
      <div className="empty-state empty-state--audio">
        <div className="empty-state__panel">
          <div className="empty-state__label">drag an audio file from your file browser</div>
          <PlusGlyph />
        </div>
      </div>,
      audioStackEl,
    );
  }
  return null;
}

/** Plus glyph from Figma 400:2095 — 19x19 with a centered +
 *  Subtract-path. Grey-16 fill so it sits subtly over the dashed
 *  border (which is #313131). */
function PlusGlyph() {
  return (
    <svg
      className="empty-state__plus"
      width="19"
      height="19"
      viewBox="0 0 19.1641 19.168"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M9.58203 0C10.1293 0 10.5742 0.444833 10.5742 0.992188V8.5918H18.1729C18.72 8.59198 19.1641 9.03674 19.1641 9.58398L19.1436 9.78223C19.0515 10.2332 18.6531 10.5741 18.1729 10.5742H10.5742V18.1758C10.5742 18.7231 10.1293 19.168 9.58203 19.168C9.03478 19.1679 8.59083 18.723 8.59082 18.1758V10.5742H0.992188C0.443512 10.5742 9.13247e-05 10.1298 0 9.58398C5.02224e-08 9.03662 0.444914 8.5918 0.992188 8.5918H8.59082V0.992188C8.59083 0.444939 9.03478 8.3823e-05 9.58203 0Z"
        fill="#292929"
      />
    </svg>
  );
}
