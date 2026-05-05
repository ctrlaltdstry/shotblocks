# Visual language

Concrete tokens for the surfaces Shotblocks controls. Read together with `principles.md` (the why) and `design-system.md` (the canonical color/spacing/typography for the C4D 2026 dark theme).

**Authority order when making any UI decision:**

1. `principles.md` dictates first.
2. `design-system.md` is canonical for color, surface ramp, semantic palette, text stops, typography, spacing scale, and component patterns. Any color/space/type used in Shotblocks should map to a token from there or have a written reason for deviating.
3. This file fills in what the design system doesn't cover — the *applied* tokens for Shotblocks-specific compositions (shot block state colors, edge bands, hover highlights, play range, etc.) — by deriving from the design system's palette.

If a token here disagrees with `design-system.md`, this file is the bug. The values below are the in-code state of v4d; some predate the design system being added and need a reconciliation pass before v5 visual polish lands. Tracked as deferred work.

This is a *starting point*. Values are placeholders informed by the references we've discussed (Railcut for After Effects, Final Cut Pro, DaVinci Resolve) but should be verified by drawing the actual timeline in C4D 2026.2.0 and looking at it. Adjust during the v0 task as the timeline takes shape.

## Surfaces this governs

Per `principles.md`:
- The timeline's `GeUserArea` and everything in it
- Preset thumbnails
- Custom-drawn elements in the preset panel
- Shotblocks-specific iconography

This file does *not* govern the C4D Attribute Manager appearance, dialog window chrome, menu styling, or anything else owned by C4D's host.

## Background and structure

| Token | Value | Use |
|---|---|---|
| `bg.timeline` | `#1a1a1a` | The timeline area's main background. Near-black, slightly warmer than pure black. |
| `bg.track` | `#222222` | Subtle tone shift to delineate track lanes. |
| `bg.track.alt` | `#1e1e1e` | Alternate track background for visual rhythm in multi-track layouts. |
| `bg.ruler` | `#2a2a2a` | The frame/time ruler at the top of the timeline. |
| `border.subtle` | `#333333` | Thin separators between tracks, between header and timeline. |
| `border.emphasis` | `#444444` | Borders around interactive elements like the play range. |

## Shot block colors (encoding Shotblocks state)

These are the most consequential color decisions because they encode meaning. Per principle 2, every color here means something specific.

| State | Fill | Border | Label | Notes |
|---|---|---|---|---|
| **Replace mode** (tagged camera, Shotblocks drives entirely) | `#3a5f8f` (saturated blue) | `#5a8fcf` | `#e0e8f5` | The most "Shotblocks" looking. Replace mode is when the procedural pipeline owns the camera; the strong color signals "this is Shotblocks territory." |
| **Additive mode** (tagged camera, layered on user animation) | `#4a6f5f` (muted teal-green) | `#6a9f8f` | `#dceee5` | Distinct from replace mode but related. Teal-green vs blue suggests "blended with something underneath" rather than replaced. |
| **Untagged passthrough** (no Shotblocks tag, just sequenced) | `#5a5a5a` (neutral gray) | `#7a7a7a` | `#dddddd` | Shotblocks is sequencing only, not directing. Neutral gray says "we're not doing anything to this camera." |
| **Orphaned** (source camera deleted) | `#3a2a2a` (desaturated dark red) | `#7a4a4a` (dashed) | `#a08080` | Visibly broken. Dashed border per principle 4 — loud when it matters. |
| **Selected (any state)** | `accent` `#2C7CD3` (Maxon blue, from `design-system.md`) | unchanged border | white `#FFFFFF` (per design-system "text on accent" rule) | Selection swaps the body fill to the design-system accent rather than adding an outline. Per the design system's "one accent does all interactive work" principle, the same Maxon blue is also used for marquee, range-bar handles, and edge-band hover. |

### Edge grip bands

Every shot block renders a 16 px-wide *edge grip band* at its leading and trailing edges, drawn in a tint slightly darker than the body fill. The band makes the resize zone visible — the user can aim at the band rather than at an invisible 1 px boundary. The 16 px width was chosen empirically: at narrower widths the band is smaller than typical mouse-motion samples (~9 px between consecutive events), so the cursor would flicker as the user crosses the boundary on every wiggle. The band width is clamped to one-third of the clip width for narrow clips so the bands never overlap or dominate the body.

| State | Band tint | Hover tint |
|---|---|---|
| **Untagged passthrough** body `#5a5a5a` | `#4a4a4a` (≈ `surface-4`) | `accent-hover` `#3B8CE8` |
| Future states (replace, additive, orphaned) | one tone darker than that state's body fill | `accent-hover` (consistent across all states — the affordance is "you can grab here," same color regardless of state) |

The 8 px band width matches the click hit-zone (`EDGE_HIT_PX`) and the cursor affordance zone (`CURSOR_EDGE_PX`) exactly — visual feedback equals interaction zone. Hover renders in `accent-hover` so the band lights up Maxon blue on cursor-over, distinct from the static accent-blue body of a selected clip.

These are the *placeholder* values. Verify by drawing the timeline and checking:
- Can you tell additive from replace at a glance, or do they look too similar?
- Does the orphaned state read as "broken" without being alarming?
- Does selection read clearly against every state?

If any of those fail, adjust the affected pair.

## Audio and waveform

Per the Railcut reference, audio sits in its own track underneath the shot tracks. The waveform draws *inside* the audio clip in a darker shade of the clip's own color.

| Token | Value | Use |
|---|---|---|
| `audio.fill` | `#4a4a3a` (warm gray-tan) | Audio clip block fill. Distinct from any shot color so it's clearly "audio" at a glance. |
| `audio.border` | `#6a6a5a` | Audio clip border. |
| `audio.waveform` | `#2a2a1a` | Waveform fill, drawn *inside* the audio clip. Darker shade of the same family. |
| `audio.label` | `#d8d8c8` | Audio clip label color. |

## Beats and markers

Beats are detected from the audio and rendered as vertical lines on the ruler and across the timeline. Manual markers are user-placed annotations.

| Token | Value | Use |
|---|---|---|
| `beat.downbeat` | `#666666` | Stronger beat (typically every 4th in 4/4). Slightly heavier line. |
| `beat.offbeat` | `#3a3a3a` | Regular beats. Subtle. |
| `marker.user` | `#ffd966` (same warm yellow as selection) | User-placed manual markers. Stand out clearly. |

Beats are *non-interactive ambient context*; they help the user see rhythm but they're not selectable. Markers are interactive. The visual hierarchy reflects that — beats are subtle, markers are loud.

## Cursor and play range

The cursor is the playhead — the current frame. The play range is the I/O-bracketed region that defines what plays.

| Token | Value | Use |
|---|---|---|
| `cursor.line` | `#ff6b6b` (warm coral-red) | The thin vertical playhead line. Saturated enough to never get lost; warm enough to read on the dark bg. 1px wide. |
| `cursor.head` | `#4a90d9` (saturated blue) | Downward-pointing triangle at the top of the playhead; ~12px wide × 10px tall, apex on the line. The blue/red contrast makes the grab handle visually distinct from the line itself, and reads as a deliberate UI affordance rather than an extension of the line. |
| `range.bar` | `#3a3a3a` | The play-range track at the top, in its inactive state. |
| `range.active` | `#4A4A4A` (`surface-4`) | Neutral lift between in/out handles. Mark-up is carried by the accent-blue handles at the boundaries. |
| `range.handle` | `accent` `#2C7CD3` | The draggable in-point and out-point handles — Maxon blue per the design-system "interactive = accent" rule. |
| `range.handle.hover` | `accent-hover` `#3B8CE8` | Brighter highlight on the hovered handle. Same hover-affordance pattern as shot-edge bands. |

Cursor red is reserved exclusively for the cursor. Nothing else uses that exact hue, so the cursor is always identifiable.

## Typography

We use C4D's UI font as inherited from the host. We don't override it.

| Token | Size | Weight | Use |
|---|---|---|---|
| `type.label.primary` | 11pt | regular | Shot block labels, audio clip labels, range readouts. |
| `type.label.secondary` | 10pt | regular | Beat/frame numbers in the ruler, secondary metadata. |
| `type.label.emphasis` | 11pt | bold | Selected shot label only. Used sparingly. |

Sentence case throughout. Single-line, truncate with ellipsis when the label exceeds the available space. No font-size variation beyond what's listed; we don't have hierarchy deep enough to need more.

## Spacing

| Token | Value | Use |
|---|---|---|
| `space.track.height` | 32px | Standard track row height (verify against C4D scaling — may need to be `28-36px` on different DPI settings). |
| `space.track.padding` | 4px | Vertical padding inside a track row. |
| `space.clip.padding.h` | 6px | Horizontal padding inside a shot block (between block edge and label). |
| `space.clip.padding.v` | 4px | Vertical padding inside a shot block. |
| `space.clip.gap.min` | 0px | Hard-cuts mean adjacent shot blocks touch with no gap. Visual separation comes from borders, not gaps. |
| `space.ruler.height` | 24px | The ruler bar at the top showing time and beats. |
| `space.range.height` | 16px | The play-range bar above the ruler. |

**Vertical layout.** Track 0 (base video) sits vertically centered in the timeline area. Video tracks (1, 2, 3) stack *upward* from track 0; audio tracks will stack *downward*. The bottom edge of track 0 carries an emphasized 1px divider line (`border.emphasis`, `#444444`) to mark the video/audio boundary. This mirrors Premiere/FCP/Resolve's V1/A1 divider convention and the user's existing NLE muscle memory.

## Corner radii and stroke

| Token | Value | Use |
|---|---|---|
| `radius.clip` | 0px (hard edges) | **Documented divergence** from design-system's "3-4 px small-control radius". Foreclosed at this scale by C4D 2026 Python's draw API: stairstep DrawRectangle approximations were visibly stepped, BaseBitmap with alpha-aware modes (`BMP_ALLOWALPHA \| BMP_TRANSPARENTALPHA`) quantized alpha to a binary threshold (gradient alphas like `255, 215, 76, 8` collapsed to a hard mask in compositing), and per-pixel software AA was bumpy because 4 px is too few transitional pixels for the eye to perceive smoothness. Revisit when (a) shot blocks ever render at ≥ 48 px height with proportionally larger radius, (b) C4D adds anti-aliased shape primitives to the Python API, or (c) we move the timeline rendering off `GeUserArea.DrawRectangle` (e.g., to a Pillow-rendered final blit). Empirical findings recorded in memory under `reference_c4d2026_cursor_and_drawing.md`. |
| `stroke.clip` | none | Shot blocks have no border — the rounded body against the lane background and the darker edge bands provide the delineation. Border-and-rounded-corners would clash visually. |
| `stroke.clip.selected` | none | Selection is conveyed by the accent-blue body fill, not by a stroke. |
| `stroke.cursor` | 1px | The cursor line. |
| `stroke.beat.downbeat` | 1.5px | Slightly heavier than offbeats. |
| `stroke.beat.offbeat` | 0.5px | Subtle. |
| `dash.orphaned` | `4 2` | Dashed border for orphaned shots: 4px on, 2px off. |

## Iconography

Shotblocks icons (the tag's icon, preset library icons, any toolbar icons) follow a consistent style:

- Monochrome strokes only, no fills
- 1.5px stroke at 16x16 (scale stroke proportionally for other sizes)
- Stroke color: `#cccccc` for default state, `#ffffff` for hover/active
- Square frame with 2px internal padding
- Geometric forms preferred over organic; the visual language is "schematic" not "illustrative"
- No drop shadows, no gradients, no decorative elements

Where C4D ships standard icons we'd otherwise duplicate (play, pause, loop), we use C4D's standard icons rather than our own. Custom icons are reserved for Shotblocks-specific verbs (slate, bake) and Shotblocks-specific objects (the tag).

## Worked example: drawing a shot block

For a shot referencing a tagged camera in additive mode, selected, named "Wide opening":

1. Background: `#4a6f5f` (additive mode fill)
2. Border: `#ffd966` at 2px (selection overrides additive border)
3. Label: "Wide opening" in primary label type, color `#dceee5`, sentence case
4. Padding: 6px horizontal, 4px vertical
5. Corner radius: 2px

The same block, deselected, would have:
- Border: `#6a9f8f` at 1px (additive border)
- Label color and content unchanged

The same shot but referencing a camera whose source has been deleted:
- Background: `#3a2a2a` (orphaned fill)
- Border: `#7a4a4a` at 1px, dashed `4 2`
- Label: "Wide opening" still shown, but in `#a08080` (orphaned label)

## What's deliberately not specified yet

These need decisions but not yet:

- **Preset thumbnail style.** Are they animated GIFs? Sprite strips? Static frames? What's the framing of the demo subject? This belongs in `design/components.md` when the preset panel is being built.
- **Hover and pressed states.** The principle is "subtle dimming on hover, slight inset on press." Concrete deltas come once we've drawn enough states to feel what works.
- **HUD overlay style** (if we add a viewport HUD showing current shot info). Possibly off-limits per principle 3 — only worth designing if we decide it earns its place.
- **Animated transitions.** Per principle 4, mostly none. Specific exceptions (if any) get specified in `components.md`.

## Verification during v0

When the timeline is first drawn in real C4D, look at:
- Do the colors render the way they're specified? (C4D's color management may shift things — verify.)
- Is text legibility OK at the specified sizes given C4D's font and DPI handling?
- Does the cursor color stand out against every clip background, or does it disappear over similar hues?
- Does the orphaned state read as "broken" without being alarming?

Adjust here when reality contradicts the spec. The principles stay; the tokens move.
