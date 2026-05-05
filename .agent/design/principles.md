# Design principles

The "why" behind the visual choices in Shotblocks. Read this before making any UI decision.

The concrete how lives in two files, in this authority order:

1. **`design-system.md`** — the authoritative C4D 2026 dark-theme tokens (surface ramp, accent, semantic colors, text, typography, spacing). Every color, space, and type decision either comes from there or has a written reason for deviating.
2. **`visual-language.md`** — Shotblocks-specific applied tokens (shot block state colors, edge bands, hover highlights, etc.). Derived from the design system; covers what the design system doesn't (timeline-specific composition).

When the two files disagree, `design-system.md` wins and `visual-language.md` is the file to fix. Anything not yet specified in either should be filled in following the principles below.

## What surfaces we control

The plugin lives inside Cinema 4D's UI host. We don't pick everything. Specifically:

- **Host-controlled (we follow C4D, not lead):** dialog window chrome, the Attribute Manager's typography and layout, menu styling, standard widget appearance (numeric fields, dropdowns, checkboxes inside C4D's resource-driven panels), the Object Manager's appearance, the document-level color theme.
- **Shotblocks-controlled (we own every pixel):** the timeline's `GeUserArea` and everything drawn inside it (shot blocks, waveform, cursor, range bar, markers, tracks), preset thumbnails, any custom-drawn HUD elements, the visual styling of the preset library panel.
- **Hybrid (we contribute content within host structure):** the Attribute Manager when a Shotblocks tag is selected — the field layout is C4D's, but the labels, values, and grouping are ours; the preset panel as a whole — it's a panel inside a C4D dialog, but its contents render through our drawing code.

The design system applies to Shotblocks-controlled and hybrid surfaces. For host-controlled surfaces, we follow C4D's conventions per `c4d-conventions.md` and don't try to override.

## Core principles

### 1. Native to C4D, distinctive in the timeline
Shotblocks should feel like more capability bolted onto C4D, not a foreign system grafted in. The dark theme, the tight typography, the dense layout, the muted-by-default palette — these match C4D's host. The timeline's accent colors and clip styling are the place where the Shotblocks identity comes through, because that's the surface we own.

A user opening the Shotblocks timeline for the first time should recognize the *type* of tool from a glance — a sequencer with shot blocks and a play range — without having to read labels. That recognition comes from following timeline conventions established in After Effects, Resolve, and similar tools, not from inventing new ones.

### 2. Color encodes Shotblocks state, not arbitrary categories
Where NLEs use color to differentiate clip types (footage vs precomp vs adjustment), Shotblocks uses color to differentiate *Shotblocks state*: replace-mode tagged camera, additive-mode tagged camera, untagged camera passthrough, orphaned. The state of a shot is the most useful thing to read at a glance.

Color is never decorative. If a user can't articulate what a color means, the color doesn't belong.

### 3. Information density without noise
Pro tools earn the user's trust by showing what's relevant and hiding what isn't. The timeline shows shot blocks, waveform, beats, markers, cursor, range. It does not show: frame thumbnails (expensive, not informative for camera sequences), gradient backgrounds, decorative dividers, drop shadows, animated transitions on routine actions, "celebrate" feedback. Every pixel is justified by what it tells the user.

This is the principle that pushes back against most temptations to add visual flourish.

### 4. Quiet by default, loud when it matters
Most of the timeline is muted: dark backgrounds, mid-saturation clips, subtle markers. The high-energy visual elements are reserved for the things that genuinely need attention: the cursor, the active shot under playback, an orphaned shot, a slate operation's confirmation. When the timeline goes quiet, important things stand out without competing.

### 5. Match the muscle memory
Where After Effects, Resolve, and FCP all converge on a convention, Shotblocks follows it. Examples: dark background, thin colored cursor, audio waveform inside its clip block, sentence-case labels, single-line clip names with ellipsis truncation, drag to move, drag edges to resize. We don't innovate where convention serves users. We innovate where the use case genuinely differs.

### 6. The shot is the identity
A shot block's appearance tells the user: which camera does this reference, what rig state is applied, is it tagged, is it healthy. It does *not* try to tell them what the shot will look like rendered — that's what the viewport is for. The shot block is metadata; the viewport is the picture. Keep them separate.

### 7. Typography is C4D's, sized for density
We use C4D's UI font (whatever it is on the user's install — we don't override). Sizes are constrained by what's legible at C4D's scale: typically 11-12pt for clip labels, 10pt for secondary metadata. No type system more elaborate than primary-and-secondary; we don't have a hierarchy deep enough to need one.

### 8. Voice
The plugin's language is direct, sentence case, and verb-led for actions. We say "Slate" not "Slate to nearest beat" on the button (the verb stands alone); we say "Bake" not "Render to camera"; we say "Apply" not "Use this preset." Tooltips can elaborate; the primary label is the verb. Error messages name the problem and offer a path forward, not just announce the failure.

## What this rules out

Decisions these principles foreclose:

- A bright/light theme. Foreclosed by principle 1; would clash with C4D's host.
- Skeuomorphic clip blocks (film-strip edges, 3D bevels). Foreclosed by principle 3.
- Animated celebrations on slate (a "snap" effect, sound, glow). Foreclosed by principles 4 and 6 of the constitution (slate is instant; no celebration).
- Color used decoratively (e.g., consecutive shots in different colors just for visual variety). Foreclosed by principle 2.
- Sentence-case in some places and Title Case in others. Foreclosed by principle 8.

When a future feature tempts us into one of these, the answer comes from these principles rather than ad-hoc judgment.

## How this relates to brand

Shotblocks does not yet have a separate brand identity (logo, marketing visuals, website). When one is established, the in-app design system should descend *from* it for consistency. Until then, the in-app design system *is* the brand: what users see when they open the Shotblocks timeline is the strongest signal of what Shotblocks is.

Decisions made in `visual-language.md` will ripple outward when a brand identity is established. Bear that in mind: the timeline's accent color is, effectively, the brand's accent color until told otherwise.
