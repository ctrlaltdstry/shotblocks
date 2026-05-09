# Current Task

**Next: v6** *(not yet scoped — pick at start of next session)*

v5 ships orphan-shot handling: detection-on-`EVMSG_CHANGE` (no deletion veto — C4D 2026 Python doesn't expose one), dashed dark-red orphan visual state with `(missing) name` label, drag-on-shot relink (works for orphans *and* one-gesture re-camera of healthy shots), `Delete`-→-`Remove` verb flip on all-orphan selection, console transition log, and the existing BaseLink + persisted-`cam_name` machinery for save/load survival.

Architecture text relaxed from "Shotblocks intercepts the deletion attempt" to "Shotblocks detects and surfaces deletion" — the three resolution paths (remove, relink, undo) all still hold.

Open question on relink rig-state compatibility (was open-questions.md:31) is closed: trivial in v5 — there is no per-shot rig state yet. Re-open when rig state lands.

Archived milestones:
- **v4a** — selection polish + right-click context menus
- **v4b** — play-range bar + I/O hotkeys + playhead scrub
- **v4c** — module split (`sb_shot_model.py` + `sb_persistence.py` + `sb_canvas.py` + entry-point `shotblocks.pyp`)
- **v4d** — canvas polish (centered-track NLE layout, visible edge bands with hover highlight, group multi-shot drag, playhead triangle handle, selection-as-fill, BaseLink camera tracking)
- **v4e** — design-system reconciliation (Maxon-blue accent for selection / marquee / range handles / edge-band hover; hard-edges divergence on shot blocks documented because C4D 2026 Python can't render visibly smooth AA at 4 px radius)
- **v5** — orphan-shot handling

**v6 candidates** from the architecture: audio subsystem (waveform + onset detection), spacebar playback engine, preset library, slate engine, bake-down. Pick one as v6 in the next session.

**Deferred to a holistic post-v5 visual-polish pass**: status-line widget (v5 uses console `print` for orphan transitions), small visual-design cleanup notes the user wants to revisit *after* v6+ visual elements (audio waveforms, beat markers, preset thumbnails) are in place — easier to tune everything together than re-tune in pieces.

**Design-system authority**: `.agent/design/design-system.md` is canonical for color/spacing/typography. Any new UI decision must reference it. `visual-language.md` provides Shotblocks-specific applied tokens; if the two ever disagree, `visual-language.md` is the bug.
