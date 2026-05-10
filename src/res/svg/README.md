# Timeline-block SVG sources — design archive (not used in build)

These SVGs are kept as a **design archive** of earlier iterations. They
are no longer the build input. The active asset pipeline now reads
**PNGs** from `src/res/png-source/`, exported by hand from Figma.

## Why we switched away from SVGs

The svglib + reportlab pipeline ran into multiple issues that required
ever-deeper workarounds: it didn't render `<pattern>` fills (handle dot
grids), ignored `fill-opacity` (translucent handle overlays), produced
binary-alpha rounded corners (no AA), and C4D's `DrawBitmap` then
mis-composited the partial-alpha pixels we tried to generate. Each fix
fought the next, and the final visuals diverged from what Figma showed.

Direct PNG export from Figma sidesteps all of those. Figma honors every
SVG feature it ships, exports at the exact pixel grid we need, and the
output is unambiguous.

## Active pipeline

See `src/res/png-source/` for the source PNGs and
`scripts/build-icons.py` for the build script. The flow:

  Figma → PNG (2x) → src/res/png-source/
                  → build script downsamples + slices
                  → src/res/icons/shots/

The plugin loads the sliced PNGs at runtime; SVGs are not read.

## Keeping the SVGs

If you want to update a design, the recommended path is:

  - Edit in Figma (the actual design source-of-truth).
  - Export PNGs again at 2x.
  - Re-run `python scripts/build-icons.py`.

If you'd rather edit XML directly, you can — but the build no longer
consumes these files, so you'd need to re-export to PNG to see changes.
