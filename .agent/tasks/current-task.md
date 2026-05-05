# Current Task

**Next: v5** *(not yet scoped — start of a new conversation)*

v4 is complete through v4e. Archived milestones:
- **v4a** — selection polish + right-click context menus
- **v4b** — play-range bar + I/O hotkeys + playhead scrub
- **v4c** — module split (`sb_shot_model.py` + `sb_persistence.py` + `sb_canvas.py` + entry-point `shotblocks.pyp`)
- **v4d** — canvas polish (centered-track NLE layout, visible edge bands with hover highlight, group multi-shot drag, playhead triangle handle, selection-as-fill, BaseLink camera tracking)
- **v4e** — design-system reconciliation (Maxon-blue accent for selection / marquee / range handles / edge-band hover; hard-edges divergence on shot blocks documented because C4D 2026 Python can't render visibly smooth AA at 4 px radius — every path tried failed; revisit when shots ever render at ≥ 48 px height or C4D ships AA primitives, full reasoning in `reference_c4d2026_cursor_and_drawing.md` and `visual-language.md`)

**v5 candidates** from the architecture (unchanged): orphaned-shot handling (camera deletion intercept), audio subsystem (waveform + onset detection), spacebar playback engine, preset library, slate engine, bake-down. Pick one as v5 in the next session.

**Deferred to a holistic post-v5 visual-polish pass**: small visual-design cleanup notes the user wants to revisit *after* v5+ visual elements (audio waveforms, beat markers, orphan visuals, preset thumbnails) are in place — easier to tune everything together than re-tune in pieces.

**Design-system authority**: `.agent/design/design-system.md` is canonical for color/spacing/typography. Any new UI decision must reference it. `visual-language.md` provides Shotblocks-specific applied tokens; if the two ever disagree, `visual-language.md` is the bug.
