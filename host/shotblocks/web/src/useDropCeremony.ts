import { gsap } from 'gsap';

/** Module-level flag set by runDropCeremony so EmptyStateOverlay
 *  can distinguish "user dropped a clip → run the exit animation"
 *  from "persistence hydrated clips on mount → just unmount the
 *  panel silently." Read via consumeDropCeremonyFlag(). */
let pendingDropCeremony = false;
export function consumeDropCeremonyFlag(): boolean {
  const v = pendingDropCeremony;
  pendingDropCeremony = false;
  return v;
}

/** Drop-ceremony entrance animation. Fired EXPLICITLY by the OM-drop
 *  handler on the very first clip into an empty doc — we don't watch
 *  state, because the empty→non-empty transition also happens on
 *  dialog reopen (when the persistence layer hydrates clips from the
 *  doc). Running the ceremony on hydration would feel wrong: the
 *  user didn't just drop anything. By firing only from the actual
 *  user drop path, we avoid that.
 *
 *  Stages:
 *   1) Camera empty-state panel scale-to-0 is owned by the panel's
 *      own CSS transition (see .empty-state__panel.is-exiting). The
 *      panel lingers in the DOM for EXIT_MS so the transition runs;
 *      this ceremony triggers the second half of the timeline.
 *   2) Video side slides UP into place from below the V/A divider;
 *      audio side slides DOWN into place from above. They animate
 *      AWAY from the seam, parting it outward.
 *   3) V/A divider line fades in.
 *   4) The newly-dropped shot block scales in. */
export function runDropCeremony(): void {
  // Signal the panel to run its exit animation (otherwise it'll
  // just unmount silently — see consumeDropCeremonyFlag).
  pendingDropCeremony = true;
  // Wait one frame so React has committed the post-drop render
  // (track headers / V/A divider unhidden, new clip inserted).
  requestAnimationFrame(() => runCeremonyInner());
}

/** GSAP timeline for the drop ceremony. Pulls elements from the DOM
 *  at runtime, so it's resilient to component remounts and doesn't
 *  need refs threaded through unrelated components.
 *
 *  Stages, in order:
 *   1) Empty-state panel scales to 0 and fades out (~280ms).
 *   2) Video side (top half — headers + lanes) slides DOWN into
 *      position from above the V/A divider; audio side slides UP
 *      into position from below. They animate apart, as if the
 *      divider were a seam being parted by the new content
 *      arriving. ~320ms with the panel exit slightly overlapping.
 *   3) The V/A divider line fades in over the same window.
 *   4) The newly-dropped shot block scales in. */
function runCeremonyInner(): void {
  // Stages run SEQUENTIALLY (not overlapping) so the panel finishes
  // its scale-to-0 before the lanes/divider/clip enter. With overlap
  // the V/A divider was fading in while the panel was still scaling,
  // and the resulting layout reflow moved the panel mid-animation
  // (the panel's flex anchor shifted as the divider claimed space).
  // Sequential keeps the panel pinned in place visually.
  const tl = gsap.timeline({ defaults: { ease: 'power2.out' } });

  // 1) Empty-state CAMERA panel: scale to 0 + fade out. Scoped to
  //    --camera specifically: by the time this runs React has
  //    already swapped the empty state from the camera variant
  //    (videoEmpty became false) to the AUDIO variant (audioEmpty
  //    is still true), so a plain `.empty-state__panel` selector
  //    would match the freshly-rendered AUDIO panel — which lives
  //    inside #lanes-audios — and the user would see the "exit"
  //    happening down inside the audio stack instead of in the
  //    center of the canvas where the camera panel was. Since
  //    React already unmounted the camera variant, there's nothing
  //    here to tween; the panel is gone from the DOM. The exit
  //    visual is therefore handled by the existing CSS transition
  //    on .empty-state__panel (opacity 160ms, transform 220ms)
  //    which fires the moment the panel goes from `is-active` to
  //    being removed. That's enough for the panel-to-clip handoff;
  //    leaving this selector empty so we don't accidentally tween
  //    the audio variant.
  // (Intentionally no `tl.to(...panels...)` here.)

  // 2) Tracks grow FROM the V/A divider OUTWARD. Video lives above
  //    so it starts collapsed toward the divider (y: +28) and slides
  //    UP. Audio lives below so it starts collapsed up (y: -28) and
  //    slides DOWN. Reads as the seam parting outward.
  const videoHeaders = document.querySelectorAll('.headers .stack__videos .track-header');
  const audioHeaders = document.querySelectorAll('.headers .stack__audios .track-header');
  const videoLanes = document.querySelectorAll('.stack__videos .lane');
  const audioLanes = document.querySelectorAll('.stack__audios .lane');
  const videoTargets: Element[] = [...videoHeaders, ...videoLanes];
  const audioTargets: Element[] = [...audioHeaders, ...audioLanes];
  if (videoTargets.length) {
    tl.fromTo(
      videoTargets,
      { y: 28, opacity: 0 },
      { y: 0, opacity: 1, duration: 0.34, stagger: 0.02 },
    );
  }
  if (audioTargets.length) {
    tl.fromTo(
      audioTargets,
      { y: -28, opacity: 0 },
      { y: 0, opacity: 1, duration: 0.34, stagger: 0.02 },
      // Start at the same time as the video entrance for symmetry.
      // '<' = start at the previous tween's start time.
      '<',
    );
  }

  // 3) V/A divider line fades in alongside the lanes parting.
  const divider = document.querySelector('.stack__divider');
  if (divider) {
    tl.fromTo(
      divider,
      { opacity: 0 },
      { opacity: 1, duration: 0.36 },
      '<',
    );
  }

  // 4) New shot block scale-in once React has committed it.
  requestAnimationFrame(() => {
    const blocks = document.querySelectorAll('.shot-block');
    if (blocks.length) {
      gsap.fromTo(
        blocks,
        { scale: 0.94, opacity: 0 },
        { scale: 1, opacity: 1, duration: 0.28, ease: 'power2.out' },
      );
    }
  });
}
