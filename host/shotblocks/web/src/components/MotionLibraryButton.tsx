/** Motion library trigger — floating card at the top of the left rail
 *  per Figma 400:1932. Click target for the future motion-layers
 *  library panel (Plan 3+); right now it's visual scaffolding only,
 *  no click handler.
 *
 *  Chrome: 39x39, --color-grey-12 fill, 0.5px --color-grey-16 border,
 *  6px radius. Inner glyph (Figma 357:875) = two 15.02x5.46 pills
 *  rotated -45deg each, the second offset (+1.93, +7.99) from the
 *  first — reads as a stacked-pages library icon. We mirror Figma's
 *  exact DOM (flex-centered wrapper around each rotated pill) so
 *  each rotation is centered on its own pill, not on a shared
 *  origin.
 *
 *  Inactive placeholder for the next iteration — no click handler, no
 *  tooltip, no pointer cursor (see .motion-library-btn CSS). */
export function MotionLibraryButton() {
  return (
    <div className="motion-library-btn">
      <div className="motion-library-btn__glyph">
        <div className="motion-library-btn__pill-wrap motion-library-btn__pill-wrap--top">
          <div className="motion-library-btn__pill" />
        </div>
        <div className="motion-library-btn__pill-wrap motion-library-btn__pill-wrap--bot">
          <div className="motion-library-btn__pill" />
        </div>
      </div>
    </div>
  );
}
