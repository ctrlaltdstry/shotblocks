# Current Task

**v6 complete; pick v7.**

v6 ships the spacebar playback engine: spacebar toggles play/pause, the dialog's `Timer()` drives `_playback_tick` at `1000/fps` ms, each tick advances `playhead_frame`, pushes `doc.SetTime(BaseTime(frame, fps))`, routes the active shot's camera (via the existing BaseLink) to `doc.GetActiveBaseDraw()[c4d.BASEDRAW_DATA_CAMERA]`, and stops cleanly at `range_out`. Outside-range start snaps to `range_in`. Mid-playback orphan or gap = hold last camera, keep playing — the dashed-red orphan block is the existing visual signal.

Per architecture's "Data flow per frame" — v6 covers steps 1, 2, and 4 (untagged passthrough). Steps 3, 5, 6 (rig state, replace-mode tag, additive-mode tag) await the Shotblocks-tag pipeline.

Archived milestones:
- **v4a** — selection polish + right-click context menus
- **v4b** — play-range bar + I/O hotkeys + playhead scrub
- **v4c** — module split (`sb_shot_model.py` + `sb_persistence.py` + `sb_canvas.py` + entry-point `shotblocks.pyp`)
- **v4d** — canvas polish (centered-track NLE layout, visible edge bands with hover highlight, group multi-shot drag, playhead triangle handle, selection-as-fill, BaseLink camera tracking)
- **v4e** — design-system reconciliation (Maxon-blue accent for selection / marquee / range handles / edge-band hover; hard-edges divergence on shot blocks documented because C4D 2026 Python can't render visibly smooth AA at 4 px radius)
- **v5** — orphan-shot handling
- **v6** — spacebar playback engine (untagged passthrough)

**v7 candidates** from the architecture: audio subsystem (waveform + onset detection), preset library, slate engine, bake-down, Shotblocks-tag pipeline (rig math — required before steps 3/5/6 of the data-flow can run). Pick one as v7 in the next session.

**Loop playback** is deferred until a loop-toggle UI button is added; v6 always stops at out-point.

**Deferred to a holistic post-v5 visual-polish pass**: status-line widget (v5 + v6 use console `print` for orphan transitions and playback start/stop), small visual-design cleanup notes the user wants to revisit *after* v6+ visual elements (audio waveforms, beat markers, preset thumbnails) are in place — easier to tune everything together than re-tune in pieces.

**Design-system authority**: `.agent/design/design-system.md` is canonical for color/spacing/typography. Any new UI decision must reference it. `visual-language.md` provides Shotblocks-specific applied tokens; if the two ever disagree, `visual-language.md` is the bug.
