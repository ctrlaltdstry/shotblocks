# Workflow: Modifying the Timeline UI

The timeline is the spine. Changes here affect every other feature. Move carefully.

## 1. Confirm the change fits the metaphor

The timeline is shot blocks on tracks with markers and a waveform. Before adding UI, ask:
- Is this a property of a shot? → goes in the inspector, not the timeline
- Is this a property of the sequence? → goes in the timeline header / toolbar
- Is this a global plugin setting? → goes in a separate preferences dialog
- Is this transient feedback? → consider tooltips, status bar, or non-modal indicator

## 2. Sketch before coding

Custom-drawn UI is expensive to iterate. Describe the change in words. Mock it as a screenshot or sketch. Only then implement.

## 3. Respect the draw cache

The timeline area uses cached bitmaps for the waveform and shot blocks. New visual elements must either:
- Live in their own cache layer, invalidated on relevant changes only, OR
- Be cheap enough to draw every refresh (text labels, cursor, hover states)

## 4. Direct manipulation

If the new element is interactive, it must support drag where it makes sense — drag-to-resize, drag-to-move, drag-to-create. Click-only interactions are a fallback, not the primary affordance.

## 5. Hotkey parity

Any timeline action that takes more than two clicks should have a hotkey. Add it to `ui-conventions.md`.

## 6. Test at multiple zooms

Timeline UI must work at the densest zoom (full sequence visible) and the loosest (single shot detail). Watch for elements that overlap or disappear at extremes.

## 7. Test with audio loaded and without
