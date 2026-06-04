import motionLibraryUrl from '../icons/motion-library.svg';

/** Motion library trigger — floating card at the top of the left rail
 *  per Figma 400:1932. Click target for the future motion-layers
 *  library panel (Plan 3+); right now it's visual scaffolding only,
 *  no click handler.
 *
 *  Chrome unchanged: 50x50, --color-grey-12 fill, 0.5px --color-grey-16
 *  border, 6px radius. The inner glyph is the Shotblocks brand mark
 *  (Figma 442:2728 "Union") — two offset rounded bars, 20x14. Rendered
 *  as a plain <img> (the SVG carries its own grey-50 fill); state tints
 *  exist in Figma but aren't wired until the library panel has real
 *  behaviour.
 *
 *  Inactive placeholder — no click handler, no tooltip, no pointer
 *  cursor (see .motion-library-btn CSS). */
export function MotionLibraryButton() {
  return (
    <div className="motion-library-btn">
      <img className="motion-library-btn__glyph" src={motionLibraryUrl} alt="" draggable={false} />
    </div>
  );
}
