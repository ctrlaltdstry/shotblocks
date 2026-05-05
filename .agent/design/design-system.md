# Design system — C4D 2026 dark theme

This is the authoritative source for all UI color, typography, and component decisions in this project. Based on an audit of Cinema 4D 2026's interface.

## Core principle

**One accent color does all interactive work.** Maxon blue (`#2C7CD3`) is the only color used for selection, focus, primary actions, and active states. Every other color is either a neutral surface, semantic feedback, or held in reserve for brand moments. Do not introduce new accent colors without updating this doc first.

## Surface scale

A 5-stop neutral ramp. Always pick the stop by role, not by "looks good."

| Token | Hex | Role |
|---|---|---|
| `surface-0` | `#1F1F1F` | Deepest layer. Viewport, content area, code blocks. Pushes content forward. |
| `surface-1` | `#2A2A2A` | Default panel background. The main "page" surface. |
| `surface-2` | `#353535` | Panel headers, raised sections, modal headers. |
| `surface-3` | `#404040` | Input fields, secondary buttons, raised controls. |
| `surface-4` | `#4A4A4A` | Hover and pressed states for surface-3 elements. |

Adjacent surfaces should always differ by one stop, never two. If you find yourself wanting `surface-1` next to `surface-3`, you're missing a header.

## Brand & accent

| Token | Hex | Use for | Don't use for |
|---|---|---|---|
| `accent` | `#2C7CD3` | Selected rows, focus rings, primary buttons, active tabs, links, slider fills | Decorative borders, "this looks blue-ish" moments |
| `accent-hover` | `#3B8CE8` | Hover state on `accent` elements only | |
| `brand` | `#0EAA5A` | Logo lockups, render-success states, Y-axis indicators | General UI accents, success messages (use `success` instead) |

**Rule:** if a UI element is interactive, it gets `accent`. If it's branded, it gets `brand`. Never both, never neither.

## Semantic colors

| Token | Hex | Role |
|---|---|---|
| `keyframe` | `#F1C232` | Animated parameters, timeline keyframes, "this value is driven" indicators |
| `warning` | `#E68A2E` | Non-blocking issues, deprecation notices |
| `error` | `#D74C4C` | Validation failures, destructive action confirms, X-axis |
| `success` | `#5CC36E` | Operation complete, valid state, Y-axis dual-purpose |
| `info` | `#4A9EFF` | Informational callouts, Z-axis dual-purpose |

X/Y/Z axis convention is intentional: red/green/blue maps to error/success/info. Reusing the colors builds spatial intuition.

## Text

Never pure white. Three stops only.

| Token | Hex | Role |
|---|---|---|
| `text-primary` | `#D8D8D8` | Body, labels, values |
| `text-secondary` | `#989898` | Metadata, hints, section labels |
| `text-tertiary` | `#6A6A6A` | Disabled, placeholder, muted |

Text on `accent` (Maxon blue) backgrounds: pure white (`#FFFFFF`).

## Borders & dividers

| Token | Hex | Role |
|---|---|---|
| `divider` | `#1A1A1A` | Inset dividers between surfaces. Darker than the darkest surface for an etched look. |
| `border-subtle` | `#404040` | Default control borders, field outlines |
| `border-strong` | `#5A5A5A` | Hover borders, emphasized dividers |
| `border-focus` | `#2C7CD3` | Focused inputs, active drop zones |

## Typography

- **Family:** system sans stack (`-apple-system, "Segoe UI", system-ui, sans-serif`). No custom webfonts.
- **Mono:** for numeric values, hex codes, code (`ui-monospace, "SF Mono", Consolas, monospace`).
- **Weights:** 400 regular, 500 medium. Never 600 or 700 — they read as heavy on dark surfaces.
- **Sizes:** 11px (mono labels), 12px (small UI), 13px (default UI), 14px (body), 16px (emphasis), 18px (headings).
- **Case:** sentence case everywhere. Never Title Case, never ALL CAPS.

## Component patterns

**Buttons.** Primary button: `accent` background, white text, no border, `border-radius: 4px`, `padding: 7px 14px`. Secondary button: `surface-3` background, `text-primary`, 1px `divider` border, same radius and padding.

**Inputs.** Background `surface-3`, 1px `divider` border, 3px radius. Focused state: border swaps to `border-focus` (no glow, no shadow). Mono font for numeric values. Right-align numbers.

**Lists & rows.** Default row: transparent background, `text-primary`. Selected row: `accent` background, white text. Hover: `surface-4` background. Type indicators (the small colored squares next to row labels) use semantic colors — `success` for active geometry, `keyframe` for animated, `tertiary` for hidden.

**Panel headers.** `surface-2` background, 8px vertical padding, 14px horizontal. Bottom border is `divider`. Title is 13px weight 500.

**Tabs.** Inactive tab: `text-secondary`, no border. Active tab: `text-primary`, 2px bottom border in `accent`, sitting flush with the panel border below.

## Layout & spacing

- Border radius: 3-4px on small controls (buttons, inputs, badges), 6px on cards/panels, 8-12px on top-level containers
- Spacing scale: 4, 6, 8, 10, 14, 16, 20, 24px. Don't invent values between these.
- Use `1px solid #1A1A1A` for dividers, never CSS `box-shadow` for separation
- No drop shadows. No gradients. No glow effects. Flat surfaces only.

## Anti-patterns

- ❌ Pure black (`#000`) backgrounds
- ❌ Pure white (`#FFF`) text on neutral surfaces
- ❌ More than one accent color on screen at once
- ❌ Drop shadows or glows for depth (use surface stops instead)
- ❌ Border-radius above 12px (we're not iOS)
- ❌ Color-coded categories beyond the semantic palette (no purple, pink, etc.)
- ❌ Title Case or ALL CAPS labels
- ❌ Font weights 600 or 700
