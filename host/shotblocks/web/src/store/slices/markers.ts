import type { StateCreator } from 'zustand';
import type { State } from '../../store';

/** Marker data model. Markers are lightweight timing reference
 *  points the user drops on the ruler — typically for syncing to
 *  beats, end credits, or any other frame the user wants flagged.
 *  v1 model: just a frame number. No labels, no colors, no
 *  per-marker properties. Markers persist through save/load with
 *  the rest of the helper's JSON. Visibility is a UI toggle that
 *  doesn't affect the data — markers stay in state when hidden. */
export interface MarkersSlice {
  /** Sorted ascending. Duplicates not allowed (addMarker no-ops if
   *  the frame is already present). */
  markers: number[];
  /** Show / hide on the ruler. Default true. */
  markersVisible: boolean;

  /** Add a marker at `frame`. No-op if a marker already exists at
   *  that frame. Frame is clamped to >= 0. */
  addMarker: (frame: number) => void;
  /** Remove a marker at exact `frame`. No-op if no marker there. */
  removeMarker: (frame: number) => void;
  /** Drop all markers. */
  clearAllMarkers: () => void;
  /** Toggle / set the visibility flag. */
  setMarkersVisible: (visible: boolean) => void;
  /** Replace the entire marker list (used by persistence on load). */
  setMarkers: (markers: number[]) => void;
}

export const createMarkersSlice: StateCreator<State, [], [], MarkersSlice> = (set) => ({
  markers: [],
  markersVisible: true,

  addMarker: (frame) => set((s) => {
    // Floor on the doc start (docMin; absolute frames, can be negative —
    // v2 mirrors C4D's ruler).
    const f = Math.max(s.docMin, frame | 0);
    if (s.markers.includes(f)) return s;
    const next = [...s.markers, f].sort((a, b) => a - b);
    return { markers: next };
  }),

  removeMarker: (frame) => set((s) => {
    if (!s.markers.includes(frame)) return s;
    return { markers: s.markers.filter((m) => m !== frame) };
  }),

  clearAllMarkers: () => set((s) => {
    if (s.markers.length === 0) return s;
    return { markers: [] };
  }),

  setMarkersVisible: (visible) => set((s) => (
    s.markersVisible === visible ? s : { markersVisible: visible }
  )),

  setMarkers: (markers) => set({
    markers: [...markers].sort((a, b) => a - b),
  }),
});
