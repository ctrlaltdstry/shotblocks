# Shotblocks Website — Handoff to next chat (2026-06-01)

Continuing the mkslate.com Framer build. Master plan: `website-plan-1-production.md`.
This doc = current state + how the tooling actually behaves, so the next chat doesn't relearn it.

## How the Framer MCP actually behaves (LEARNED — don't relearn this)

- **MCP server:** unframer (`mcp.unframer.co`, "MCP: AI Plugin" by Tommy Rossi). The
  Framer plugin must be open + focused in the desktop app for tools to work.
- **createCMSCollection: BROKEN.** Always throws `configureManagedCollection` mode
  assertion. Do NOT retry. Mike creates collections + fields by hand in Framer UI.
- **upsertCMSItem: WORKS** on user collections. Quirk: when updating, you MUST include
  the Status enum with its CASE ID (`HqOG7AktU` = Beta) or it errors
  "Expected a valid enum case." Always send `gIVen4yYV: {type:enum, value:"HqOG7AktU"}`.
- **getCMSCollections** returns names+IDs but is huge (~60KB) and sometimes times out;
  it persists to a file — parse field name→ID from there with python.
- **getCMSItems** returns IDs+values only (no field names) — must cross-ref the schema.
- **updateXmlForNode** (building pages) works well for STATIC structure: Frames/Stacks,
  Text with `inlineTextStyle`, layout, colors. Reliable.
- **Text color MUST come from a text style** (`inlineTextStyle`), never raw `font=` (raw
  font = invisible/black text on dark bg). All site styles are under `/SB/...`.
- **New Stacks default to a SOLID WHITE background** — always set
  `backgroundColor="rgba(0,0,0,0)"` on transparent containers or you get white blocks.
- **SVG nodes: FIGHTY.** Setting `svg=` on an existing Frame does NOT work. Creating a
  fresh SVG node via updateXmlForNode kept getting rejected ("made up attributes") —
  cause not fully pinned (likely `#` needs `%23`, or nested `<path>` children, or
  viewBox). The MK logo was placed by MIKE dragging the SVG onto the canvas instead.
  RECOMMENDATION: for SVG/icons, have Mike drop them on canvas, or find a working
  example in the project first. Don't burn attempts guessing the encoding.
- **`backgroundImage` with data-URI: does NOT apply.** Needs a hosted URL; catbox.moe
  and 0x0.st were both down/blocked. So dot-grid + soft glow couldn't be built via XML.
- **No "create component" tool.** Can't promote a Frame to a reusable component via MCP —
  that's a Framer-UI action (Mike does it). MCP CAN edit a component's internals after.
- **Reordering:** re-list children by nodeId in updateXmlForNode. New nodes often append
  at the END of the parent and must be reordered after creation.
- **DON'T reuse an existing text node's ID as a layout container** — it scrambles the
  tree (this broke the dropdown attempt). Create fresh container nodes.

## THE REAL BOUNDARY (the thing to internalize)

MCP builds **static structure** great. **Interactions** (dropdown open/close, FAQ
accordion expand, carousel scroll-pin, scroll-reveal entrances, hover-reveal, layer
blur for glows) are NOT doable through static XML — they need Framer components with
variants, native Framer interactions/effects on the canvas, marketplace components, or
GSAP code components. This is not a "phase" — it's just what the tool can/can't do.
When an interactive element comes up, go straight to the right mechanism (component/
canvas/GSAP); don't hand-build it as static XML and don't gate it behind a "pass."

## What's BUILT (Framer, page `/products/:slug`, root Desktop `SYVp5AZPA`)

Full static page, top to bottom, dark palette (`/Black Background`), styled via `/SB/*`:
1. **Sticky nav** (`a4a2xqCKj`) — MK Slate logo (Mike added on canvas) → `/`; right side
   Tools · Work · About · Contact-button(`/contact`). Tools link not yet wired; dropdown
   NOT built (see below). Nav is page-local; needs promoting to a reusable COMPONENT
   (Mike, in UI) to be truly global.
2. **Hero** (`TTQ8t3J9N`) — Beta pill, "Find your edit with ease.", subline, 2 CTAs,
   platform note, hero media placeholder.
3. **Features wrap** (`dsjkzlMKV`) — 8 sections, order: Sequence(full-bleed) → Rig
   (horizontal carousel of 4 cards: Smoothing/Chase/Aim&framing/Handheld&zoom, 900px
   each, video slot+title+body) → Sync(full-bleed) → STATEMENT → Markers → Play range →
   Tracks(full-bleed) → Snapping → Saved-in-scene. Splits = `maxWidth 1128`, `0 64px`
   padding; wrapper gap 80px. Full-bleed = edge-to-edge media bg + dark scrim + centered
   text (z-2).
4. **Statement** (`pYunQL0Wb`) — 180px, two stacked centered lines: "Find your whole
   edit" (Geist white) + "without ever leaving Cinema 4D." (Fraunces-600-italic, purple
   `/SB/Statement Accent`). Empty glow frame `rdb_NyygC` sits behind for MIKE to
   layer-blur on canvas + add dot-grid. (overflow:clip on section.)
5. **Render card** (`pwCWc6zek`) — centered card, text only (render screenshot still TODO).
6. **Walkthrough** (`kQDj_a_lF`) — "See the whole workflow" + 16:9 FrameRate embed
   placeholder (`GvJFyaWaF`). Embed code goes in when Mike hosts on FrameRate.
7. **FAQ** (`wV2XMnIrh`) — 5 Q/A rows, divider lines, expanded (accordion interaction TODO).
8. **Download/email-gate** (`UXKyLSt50`) — purple-tinted card, email input + button
   placeholder (Kit form goes here later).
9. **Footer** (`KHzyTErqD`) — wordmark + User manual / Contact / mkslate.com links.

## CMS: Products collection `my4NAlFTO`, Shotblocks item `J_gzvkbzv`
Fully SEEDED with real copy (hero headline `l7MJlZ_91`, tagline `B4zLItY0J`, status,
price 69, descriptions, Feature 1-6, 4 Sub-features `k4MKqLzsN`/`PDg8qjgN9` etc, FAQ
1-10, version, platform, SEO). Media fields all null (Mike provides later). Accent
`M5c_NAUY0` = rgb(130,76,238). Page copy is currently HARD-TYPED, not bound to CMS.
Per-product-page-variant model chosen, so binding is OPTIONAL — don't force it.

## Locked decisions
$69 one-time / free beta · Kit email-gate (LATER) · positioning "Sequence·Sync·Rig"
(NO "slate"/auto-align/Motion-Library claims — see memory) · per-product page variants ·
Vizcom design language: dot-grid ONLY on statement section, subtle glow hero+statement,
big type, scroll reveals · serif-italic accent = Fraunces.

## OPEN / NEXT (no required order — do what makes sense)
- **Tools dropdown** — Mike wants it now (Shotblocks row now; Brick + Lumen added before
  launch). Build via a real Framer dropdown mechanism (component w/ hover variant or
  marketplace), NOT static XML. Hand-built XML attempt failed + was cleaned up.
- Wire the Tools nav link; promote nav to a reusable component (Mike, UI).
- Glow + dot-grid on statement (Mike, canvas — frame `rdb_NyygC` is the glow target).
- Render-section screenshot into Render card.
- Interactions: FAQ accordion, carousel scroll-pin, scroll-reveal entrances, hover states,
  frosted-glass nav — all via components/canvas/GSAP.
- LATER (Mike's side): real media (hero/demo/rig loops + screenshots), Kit account +
  email-gate wiring, FrameRate walkthrough embed, /contact page, responsive (tablet/phone).
- Future: Brick (needs renaming) + Lumen product pages (duplicate this page variant).

## PROCESS NOTE FOR NEXT CHAT
Mike (designer, not engineer) wants you to MOVE, not narrate process or gate work behind
artificial "passes." When something's interactive, just use the right mechanism. Don't
ask permission for obvious next steps. Keep questions to genuine forks. Show, don't
over-explain. He reviews visually on the canvas — give him things to look at.
