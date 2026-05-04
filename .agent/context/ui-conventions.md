# UI Conventions

How this plugin's UI should look and feel inside C4D.

## Principles

- Feel native to C4D — match its dark theme, font sizes, spacing
- Hide complexity — inspector shows only parameters relevant to the selected shot's preset type
- **Drag is primary.** Every operation must be doable by clicking and dragging. The mouse alone, plus the visible UI, must be enough to build a complete sequence. If a feature is only reachable by hotkey, it is broken.
- **Hotkeys are accelerators, not requirements.** They exist for users who want them but never as the only path to any operation.

## Click and drag affordances

The user must be able to do all of the following with the mouse alone:

- Drag a camera from the Object Manager onto the timeline → creates a shot
- Apply a Shotblocks tag through C4D's standard tag menu (right-click camera → Tags → Shotblocks, or the Tags menu in the menu bar) → unlocks rig parameters
- Drag a preset from the panel onto a shot → applies the preset
- Drag a preset onto empty timeline space → creates a new tagged camera and shot
- Drag an audio file onto the timeline → loads audio, generates waveform and beats
- Drag another camera onto an orphaned shot → relinks the shot to that camera
- Drag a shot to move it; drag its edges to resize/retime
- Drag the cut point between two shots → roll edit
- Drag the play-range handles → resize the play range
- Drag the play-range bar → slide both handles together
- Click the play button → play; click again to pause
- Click the loop toggle → switch between play-once and play-looped
- Right-click any shot or selection → contextual menu (slate, bake, set range, duplicate, delete, etc.)
- Right-click empty timeline space → global menu (range to all, clear markers, etc.)

## Optional hotkey accelerators

For users who want them. None of these are the only path to anything.

- **Spacebar — play/pause** (the one near-universal convention worth honoring as a default)
- **S — slate** (the signature verb; aligns selection to beats using motion energy)
- **I — set in-point** at cursor
- **O — set out-point** at cursor
- **B — bake** selected shot to standard camera
- **M — drop manual marker** at cursor
- **Delete — remove** selected shot block
- **Cmd/Ctrl+D — duplicate** selected shot as alt take

The `S` hotkey is reserved exclusively for slate. Do not overload it. Every other listed hotkey has an equivalent click or drag path; this one does too (right-click → "Slate to nearest beat" or the Slate button in the timeline toolbar).

## Timeline zoom

The timeline is zoomable horizontally — same model as After Effects, Final Cut, Resolve. The user stretches the visible frame range wider (zoom in, fewer frames per pixel, more detail) or compresses it (zoom out, more frames per pixel, sequence-level overview). The vertical axis does not zoom — track height is fixed.

Drag-primary affordances for zoom (per principle 5):
- A horizontal zoom bar at the bottom of the timeline with two draggable handles defining the visible range
- Dragging the bar itself (not its handles) pans the visible range without changing zoom
- Optional accelerators: `Cmd/Ctrl+scroll wheel` to zoom around the cursor, `=`/`-` keys to step zoom

Zoom is a property of the timeline view, not of the document. Two open timeline windows on the same document can be at different zooms. Zoom does not persist across sessions for v1; revisit if users ask.

The canvas implementation should treat the visible frame range as instance state (not module constants) from the start, so zoom is a property update rather than a refactor when the bar lands. Done in `ShotblocksTimelineCanvas` — see `visible_first`, `visible_last`.

## Inspector behavior

Inspector shows different fields based on the selected shot's preset type. Common fields always shown: in-point, out-point, operator personality, lens preset. Preset-specific fields below.
