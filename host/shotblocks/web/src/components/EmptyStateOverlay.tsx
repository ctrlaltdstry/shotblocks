import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { onMessage } from '../lib/host';
import { consumeDropCeremonyFlag } from '../useDropCeremony';

/** Empty-state cue for the camera (video) side. Renders a centered
 *  "drop a camera from the object manager" panel over the canvas
 *  when the doc has zero video clips; runs a scale-to-0 exit when
 *  the first clip lands.
 *
 *  Audio side: no panel. Once the V1 + A1 tracks are visible after
 *  the first camera drop, the empty audio lane is self-explanatory;
 *  a second dropzone competing for attention added clutter without
 *  much teaching value. Users figure out "drag an audio file" from
 *  context.
 *
 *  Per Figma node 400:2073 — dashed border, grey-12 fill, grey-24
 *  label text, grey-16 plus glyph. */
/** Exit animation duration. Matches the CSS transition on
 *  .empty-state__panel.is-exiting so the panel is removed from the
 *  DOM just after the scale-to-0 + fade finish. */
const EXIT_MS = 280;

export function EmptyStateOverlay() {
  const videoTracks = useStore((s) => s.videoTracks);
  const videoEmpty = videoTracks.every((t) => t.clips.length === 0);
  // Suppress everything until the persistence layer has loaded the
  // saved doc state. Without this, the dropzone briefly flashes on
  // dialog reopen between mount (initial empty store) and hydration
  // (saved clips arrive). Hydration also flips for genuinely empty
  // docs, so a fresh scene's dropzone still shows.
  const isHydrated = useStore((s) => s.isHydrated);

  // Camera panel lifecycle. Three phases:
  //   videoEmpty=true                         → showCameraPanel=true,  exiting=false
  //   videoEmpty=false, mid-exit              → showCameraPanel=true,  exiting=true
  //   videoEmpty=false, exit done             → showCameraPanel=false
  //
  // The phase transition has to span TWO paints so the browser sees
  // the "before" state (transform: none) and animates to the "after"
  // state (transform: scale(0)). Applying both in one render means
  // the panel starts AT scale(0) and there's no animation.
  //
  // Sequence on first drop:
  //   1) videoEmpty becomes false. Render: panel still mounted,
  //      exiting=false. Browser paints the panel at scale(1).
  //   2) rAF (next frame): set exiting=true. React re-renders with
  //      the .is-exiting class. CSS transition animates scale(1)→0
  //      over 260ms.
  //   3) setTimeout(EXIT_MS): setShowCameraPanel(false). Panel
  //      unmounts.
  // Start `showCameraPanel` false; we'll flip it true once hydration
  // resolves AND the doc is genuinely empty. Initial mount has the
  // store in its empty default state, which would otherwise mount
  // the panel before persistence has had a chance to load saved
  // clips — the dropzone flashes briefly on dialog reopen.
  const [showCameraPanel, setShowCameraPanel] = useState(false);
  const [exiting, setExiting] = useState(false);
  const prevVideoEmpty = useRef(videoEmpty);
  const exitTimer = useRef<number | null>(null);
  const exitFrame = useRef<number | null>(null);
  // First mount: wait for hydration to resolve before showing the
  // panel. If the doc loads with clips already, never show it; if
  // the doc is genuinely empty, show it. Without this gate the
  // panel flashes briefly between mount (empty default store) and
  // hydration (saved clips arrive).
  useEffect(() => {
    if (!isHydrated) return;
    setShowCameraPanel(videoEmpty);
    prevVideoEmpty.current = videoEmpty;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHydrated]);
  useEffect(() => {
    if (!isHydrated) return;
    if (videoEmpty && !prevVideoEmpty.current) {
      // Doc went back to empty (e.g. all clips deleted). Show the
      // camera panel immediately; kill any pending exit timers.
      if (exitTimer.current != null) { window.clearTimeout(exitTimer.current); exitTimer.current = null; }
      if (exitFrame.current != null) { cancelAnimationFrame(exitFrame.current); exitFrame.current = null; }
      setShowCameraPanel(true);
      setExiting(false);
    } else if (!videoEmpty && prevVideoEmpty.current) {
      // Doc just became non-empty. Two ways this happens:
      //   - User dropped a clip → runDropCeremony() set the flag →
      //     play the exit animation here.
      //   - Persistence hydration on dialog reopen → no flag set →
      //     unmount the panel silently (the user didn't do anything,
      //     they just see their saved state).
      const userTriggered = consumeDropCeremonyFlag();
      if (exitTimer.current != null) window.clearTimeout(exitTimer.current);
      if (exitFrame.current != null) cancelAnimationFrame(exitFrame.current);
      if (!userTriggered) {
        setShowCameraPanel(false);
      } else {
        // Defer the exit class to the next frame so the browser
        // captures the "before" state first; the CSS transition
        // then runs on the class change.
        exitFrame.current = requestAnimationFrame(() => {
          setExiting(true);
          exitFrame.current = null;
          exitTimer.current = window.setTimeout(() => {
            setShowCameraPanel(false);
            setExiting(false);
            exitTimer.current = null;
          }, EXIT_MS);
        });
      }
    }
    prevVideoEmpty.current = videoEmpty;
  }, [videoEmpty]);
  // Clean up timers on unmount.
  useEffect(() => () => {
    if (exitTimer.current != null) window.clearTimeout(exitTimer.current);
    if (exitFrame.current != null) cancelAnimationFrame(exitFrame.current);
  }, []);
  // Sticky OM-drag-in-flight flag. Used as a precondition for the
  // panel highlight — but the actual highlight gate is the cursor
  // being inside the panel's bounding rect (see overPanel state
  // below). omDragging clears on om-cancel/om-drop.
  const omDragging = useStore((s) => s.omDragging);

  // Bounding-rect hit test against the camera panel. We subscribe
  // to host inbound messages directly so we can read the latest
  // om-hover's viewportX/Y, then compare against the panel's
  // getBoundingClientRect. Highlight = cursor crosses the panel
  // boundary specifically, not the window boundary.
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [overPanel, setOverPanel] = useState(false);
  useEffect(() => {
    if (!omDragging) {
      // Drag ended — reset so the highlight is fresh next time.
      if (overPanel) setOverPanel(false);
      return;
    }
    const off = onMessage((msg) => {
      if (msg.kind !== 'om-hover') return;
      const el = panelRef.current;
      if (!el) { setOverPanel(false); return; }
      const r = el.getBoundingClientRect();
      const inside = msg.viewportX >= r.left && msg.viewportX <= r.right
                  && msg.viewportY >= r.top  && msg.viewportY <= r.bottom;
      setOverPanel(inside);
    });
    return off;
    // overPanel intentionally excluded — the reset path reads it
    // through state, but adding it to deps would re-subscribe on
    // every hover.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [omDragging]);

  if (showCameraPanel) {
    return (
      <div className="empty-state empty-state--camera">
        <div
          ref={panelRef}
          className={
            'empty-state__panel'
            + (overPanel && !exiting ? ' is-active' : '')
            + (exiting ? ' is-exiting' : '')
          }
        >
          <PlusGlyph />
          <div className="empty-state__label">drop a camera from the object manager</div>
        </div>
      </div>
    );
  }
  return null;
}

/** Plus glyph from Figma 417:2305 — 30x30 with rounded-square +
 *  shape (8px-wide arms, 2px corner rounding). Fill --color-grey-16
 *  matches the dashed border treatment so it sits as a soft visual
 *  cue rather than a hard pop. */
function PlusGlyph() {
  return (
    <svg
      className="empty-state__plus"
      width="30"
      height="30"
      viewBox="0 0 30 30"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M18 0C19.1046 0 20 0.895431 20 2V10H28C29.1046 10 30 10.8954 30 12V18C30 19.1046 29.1046 20 28 20H20V28C20 29.1046 19.1046 30 18 30H12C10.8954 30 10 29.1046 10 28V20H2C0.895431 20 0 19.1046 0 18V12C0 10.8954 0.895431 10 2 10H10V2C10 0.895431 10.8954 0 12 0H18Z"
        fill="#292929"
      />
    </svg>
  );
}
