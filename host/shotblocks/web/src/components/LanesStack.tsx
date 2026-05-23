import { useStore } from '../store';
import { Lane } from './Lane';
import { VaSplitter } from './VaSplitter';

/** Lanes stack — same structure as the headers, but renders lanes
 *  with their clips. */
export function LanesStack({
  stackRef,
  videosRef,
  audiosRef,
}: {
  stackRef: React.RefObject<HTMLDivElement | null>;
  videosRef: React.RefObject<HTMLDivElement | null>;
  audiosRef: React.RefObject<HTMLDivElement | null>;
}) {
  const videoTracks = useStore((s) => s.videoTracks);
  const audioTracks = useStore((s) => s.audioTracks);
  const videosOrdered = [...videoTracks].reverse();
  return (
    <div className="stack" ref={stackRef}>
      <div className="stack__videos" id="lanes-videos" ref={videosRef}>
        {/* Empty slot above V<max> so the user always has somewhere
            to drop a clip for spawn, even when the lanes already
            fill the visible area. Resolves to no lane on hit-test;
            useClipDrag.resolveLane's "above the stack" branch picks
            up the cursor there and returns a spawn target. */}
        <div className="lane-spacer" data-side="video" />
        {videosOrdered.map((t) => (
          <Lane key={t.id} track={t} side="video" />
        ))}
      </div>
      <VaSplitter />
      <div className="stack__audios" id="lanes-audios" ref={audiosRef}>
        {audioTracks.map((t) => (
          <Lane key={t.id} track={t} side="audio" />
        ))}
        {/* Spawn slot below A<max>. */}
        <div className="lane-spacer" data-side="audio" />
      </div>
    </div>
  );
}
