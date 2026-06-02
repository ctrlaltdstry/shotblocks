import { useEffect } from 'react';
import { useStore } from './store';
import { send } from './lib/host';

/** Tells the C++ host which tool cursor to force.
 *
 *  Why C++ owns this: a CSS cursor wouldn't survive a drag — the
 *  page's CSS cursor stays correct, but C4D's dialog window (the
 *  HtmlViewerCustomGui's host) handles WM_SETCURSOR for its region
 *  and keeps resetting the cursor. JS / DOM tricks can't beat that.
 *  C++ subclasses the C4D dialog window and, while a cursor mode is
 *  on, answers WM_SETCURSOR with the tool cursor itself.
 *
 *  This hook computes the mode and pushes it on every real CHANGE:
 *    - `slip`    Slip tool active AND pointer over an AUDIO clip.
 *    - `razor`   Razor tool active AND pointer over ANY clip.
 *    - `default` otherwise — C++ hands the cursor back to WebView2.
 *
 *  Adding a future tool cursor = one more case here + a `.cur` file
 *  + a mode id in the C++ CursorMode enum.
 */
type CursorMode = 'slip' | 'razor' | 'pen' | 'select' | 'av-split' | 'roll' | 'retime' | 'play-range' | 'hand' | 'hand-grab' | 'zoom' | 'default';

export function useToolCursor(): void {
  useEffect(() => {
    let mode: CursorMode = 'default';

    function apply(next: CursorMode) {
      if (next === mode) return;
      mode = next;
      void send({ kind: 'set-cursor-mode', mode: next }).catch(() => {});
    }

    // Deterministic hit-test: is (x,y) within the bounding rect of
    // any element matching `selector`? Avoids elementFromPoint's
    // topmost-element fragility (overlays, canvas mid-redraw) entirely.
    function pointerOverRect(x: number, y: number, selector: string): boolean {
      const els = document.querySelectorAll(selector);
      for (const e of els) {
        const r = e.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          return true;
        }
      }
      return false;
    }

    // The flake-resistant streak: switch INTO a tool cursor instantly,
    // but only fall back to `default` after several consecutive
    // off-clip readings — a lone bad reading can't flip the cursor.
    let offStreak = 0;
    const OFF_NEEDED = 4;

    function compute(x: number, y: number): CursorMode {
      const s = useStore.getState();
      // (The V/A divider is no longer a draggable handle — no cursor
      // for it. Vertical MMB pan reapportions the split instead.)
      // Roll-edit seam takes priority — the Lane sets
      // `rollEditActive` while the pointer is in a roll seam zone or
      // a roll drag is running.
      if (s.rollEditActive) {
        return 'roll';
      }
      // Alt-retime: pointer over a video-clip trim edge with Alt held,
      // or an Alt-retime drag in flight. The Lane sets retimeHoverActive.
      // Checked before the pen case below (pen also keys off altHeld but
      // only over AUDIO clips, so they never actually collide — this just
      // makes the precedence explicit).
      if (s.retimeHoverActive) {
        return 'retime';
      }
      // Play-range chevron handles — show the play-range cursor over
      // a handle, or for the whole duration of a handle drag.
      if (s.rangeHandleDragging || pointerOverRect(x, y, '.range-bar__handle')) {
        return 'play-range';
      }
      // Hand tool — open-hand cursor over the canvas (ruler / lanes
      // area), closed-hand during a pan drag. Sticky during the
      // drag: the closed-hand stays even if the pointer briefly
      // exits the canvas, matching every map / NLE app's hand-tool
      // feel.
      if (s.activeTool === 'hand') {
        if (s.handPanning) return 'hand-grab';
        return pointerOverRect(x, y, '.ruler-row') || pointerOverRect(x, y, '.lanes-area')
          ? 'hand' : 'default';
      }
      // Zoom tool — magnifier cursor over the canvas.
      if (s.activeTool === 'zoom') {
        return pointerOverRect(x, y, '.ruler-row') || pointerOverRect(x, y, '.lanes-area')
          ? 'zoom' : 'default';
      }
      if (s.activeTool === 'slip') {
        // Slip drag in progress → stay slip unconditionally.
        if (s.slipDragging) return 'slip';
        return pointerOverRect(x, y, '.shot-block.is-audio') ? 'slip' : 'default';
      }
      if (s.activeTool === 'razor') {
        // Razor cuts any clip — video or audio.
        return pointerOverRect(x, y, '.shot-block') ? 'razor' : 'default';
      }
      // Pen-tool cursor. Active when:
      //   - the Pen tool is selected, OR
      //   - Alt is held (modifier-as-tool, modelled on Premiere /
      //     Audition) — BUT not while an Alt+RMB zoom is in flight,
      //     because Alt is the zoom modifier there, not a pen invite.
      // Sticky during a LevelCurve drag — once a node/handle drag
      // starts the cursor stays pen until release even if the pointer
      // strays off the clip (so a fast drag never blinks back to
      // default). Matches Premiere's behaviour for tool drags.
      const penMode = (s.activeTool === 'pen' || s.altHeld) && !s.altRmbZooming;
      if (penMode) {
        if (s.levelCurveDragging) return 'pen';
        return pointerOverRect(x, y, '.shot-block.is-audio') ? 'pen' : 'default';
      }
      // Select tool: no custom cursor. The OS default arrow handles
      // everything the Select tool controls — this removed the
      // WebView2/C++ two-writer race that flickered a custom select
      // cursor during playback. Range handles still get their own
      // play-range cursor (handled above).
      return 'default';
    }

    let lastX = 0, lastY = 0;

    function onMove(ev: PointerEvent) {
      lastX = ev.clientX;
      lastY = ev.clientY;
      const next = compute(ev.clientX, ev.clientY);
      if (next !== 'default') {
        offStreak = 0;
        apply(next);
      } else if (++offStreak >= OFF_NEEDED) {
        apply('default');
      }
    }

    function reevaluate() {
      // Same off-streak debounce as onMove — do NOT snap straight to
      // 'default'. A store change can fire reevaluate on a momentary
      // blip of a flag (notably altHeld, which useAltKey reads raw as
      // ground truth and so flickers true→false→true within a tick on
      // the WebView2 Alt-stick quirk). Applying 'default' instantly on
      // that blip hands the cursor back to WebView2 for one frame — the
      // visible flicker. Switch INTO a cursor immediately; only fall
      // back after OFF_NEEDED consecutive off readings, exactly like a
      // pointermove. Without this, the retime cursor (the one flag tied
      // to altHeld) strobes while you hold Alt over an edge.
      const next = compute(lastX, lastY);
      if (next !== 'default') {
        offStreak = 0;
        apply(next);
      } else if (++offStreak >= OFF_NEEDED) {
        apply('default');
      }
    }

    // Re-evaluate on store changes too — when a slip drag ends with
    // the pointer stationary there's no pointermove; and a tool
    // switch should update the cursor immediately.
    const unsub = useStore.subscribe((s, prev) => {
      if (s.activeTool !== prev.activeTool
        || s.slipDragging !== prev.slipDragging
        || s.rollEditActive !== prev.rollEditActive
        || s.retimeHoverActive !== prev.retimeHoverActive
        || s.rangeHandleDragging !== prev.rangeHandleDragging
        || s.altHeld !== prev.altHeld
        || s.altRmbZooming !== prev.altRmbZooming
        || s.levelCurveDragging !== prev.levelCurveDragging
        || s.handPanning !== prev.handPanning) {
        reevaluate();
      }
    });

    window.addEventListener('pointermove', onMove, true);
    return () => {
      window.removeEventListener('pointermove', onMove, true);
      unsub();
      apply('default');
    };
  }, []);
}
