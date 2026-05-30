# Website Plan 1 — mkslate.com Studio Site + Shotblocks Product Page

**Status:** Planning (no Framer changes made yet)
**Owner:** Mike (design/approval) + Claude (Framer MCP build)
**Created:** 2026-05-29
**Goal:** Turn mkslate.com from a single-person portfolio into a **studio hub** that
sells Shotblocks (and later Brick, Neon), with a **high-polish, scroll-driven**
Shotblocks product page and an **email-gated free beta** download.

This is a separate workstream from the plugin's `v1-plan-*` sequence. It depends on
the plugin beta being downloadable (see `v1-plan-6-beta-installer.md`).

---

## 0. Guardrails — don't break the live site

The site is **live at mkslate.com** and there is a **staging URL**
(`particular-lottery-802797.framer.app`). Hard rules for every phase:

1. **Build on staging, publish to production only on Mike's explicit go.** Framer
   publishes the whole site at once — there is no per-page publish. So nothing is
   "live" until Mike clicks publish, but *everything unpublished is already visible
   on the staging URL*. Use staging as the review surface.
2. **Additive first.** New collection, new pages, new components. Do NOT edit or
   delete the existing portfolio (Motion Design / Case Studies collections,
   `/work/:slug`, `/about`, the home page) until their replacement is built and
   approved. The portfolio is the credibility layer — it stays intact.
3. **The home-page rework is the one destructive step.** It is sequenced LAST
   (Phase 5) and only after the product page is done and approved, so if anything
   goes wrong the portfolio pages still stand on their own.
4. **MCP limits, known up front:**
   - Claude **cannot** rename/edit fields on an existing user-managed CMS
     collection. (The "Product" → "Case Studies" rename was done by Mike manually —
     DONE, name "Products" is now free.)
   - Claude builds blind to the rendered canvas — it works via XML. **Mike does the
     visual QA** on staging at each gate. Screenshots of the *published* staging
     site can be pulled, but live unpublished canvas cannot be previewed by Claude.
   - Tablet/Phone breakpoints on the current home are empty shells — **responsive
     is real work**, budgeted into each phase, not assumed free.

---

## 1. Positioning & messaging (the foundation everything hangs on)

### Competitive landscape (researched 2026-05-29)
- **GorillaCam** (closest peer): "Cinematic hand-held camera moves for 3D cameras."
  A *rig/shake* tool — 60 presets, overshoot, focal drift. **Subscription-only**
  ($66/mo or $468/yr via Greyscalegorilla Plus, no standalone buy). Mike finds it
  convoluted.
- **Railcut** (Jake In Motion): NLE track-based editing *inside After Effects*.
  **$48 one-time, 2-seat license, free updates.** "No more round-tripping to
  Premiere." Proves the "NLE-in-your-DCC, one-time price, solo maker" model works.
- **Battle Axe**: brutalist indie tools, flat one-time pricing ($25–$75), founder-led,
  zero-fluff. The indie credibility model.

### Where Shotblocks sits
Between them, and differentiated from both:
- vs **GorillaCam**: Shotblocks is a *timeline shot sequencer* (cut between cameras
  like clips) — AND it includes a rig tag, so it covers GorillaCam's territory
  *plus* sequencing. **One-time vs subscription** is a real wedge.
- vs **Railcut**: same NLE-timeline DNA, but for *Cinema 4D cameras*, and adds
  **beat detection + snap-to-beat** Railcut doesn't have.

> ⚠️ **DO NOT market "slate" / automatic motion-energy shot alignment.** It is
> aspirational (in CLAUDE.md as the eventual signature verb) but **NOT BUILT**.
> There is no auto-align-to-motion-energy feature. What ships is **beat detection**
> + **manual snap-to-beat** + waveforms. Sell the assist, never automatic scoring.
> Banned phrases: "slate", "aligns your cuts automatically", "scores the cut for
> you", "motion-energy peaks". Treat this like the Motion Library — real-only.

### Core positioning line (working)
> **The non-linear editor for your Cinema 4D cameras.**

Supporting: cut shots like footage, sync your cuts to the beat, live in C4D, no
keyframes required. One-time purchase — no subscription.

### Headline rewrite (confident & plain — NO Motion Library language)
The old mockups leaned on "Stack your motion / library of instincts / 60 presets" —
all the **Motion Library**, which is NOT shipping. Cut entirely. Replacements drawn
only from shipping features:

| Section | Old (cut) | New (shipping-true) |
|---|---|---|
| Hero | "Block your shots. Stack your motion. Score the cut." | "A timeline for your cameras." / "Cut shots like footage. Live in Cinema 4D." |
| Sequencing | "Camera sequencing without keyframes" | KEEP — true and strong |
| Library | "A library of cinematic instincts" (Motion Library) | **REPLACE** → "A camera rig that does the acting." (rig tag: damping, look-at, handheld noise, zoom, chase) |
| Audio | "Score it to the music" (preset story) | RETELL as **beat-synced editing** (manual, assisted): "See the beats. Snap your cuts to them." NOT automatic alignment. |
| How it works | "Block. Stack. Score." | "Sequence. Sync. Render." (or "Cut. Sync. Ship.") |
| Stat bar | "60+ presets · 142 BPM · Zero keyframes" | Cut preset stat. Keep "Zero keyframes." Replace others with true facts (e.g. "Lives in C4D", "Beat detection", "One-time license") |

### The three honest pillars (all shipping)
1. **Sequence** — cameras as clips on a multi-track timeline; trim / roll / ripple;
   the NLE muscle memory from Premiere/Final Cut.
2. **Sync** — beat-synced editing: drop a track, Shotblocks **detects the beats** and
   draws them on the timeline + waveforms; you **snap your cuts to them**. This is a
   user-driven *assist*, NOT automatic scoring/alignment. (Auto motion-energy
   alignment is a future "slate" feature — do not claim it.)
3. **Rig** — the camera rig tag: procedural damping, look-at, handheld noise, zoom,
   chase — layered on a camera, no null hierarchy.

(Plus a **Render** section: whole-sequence or per-shot to the C4D render queue.)

### Visual identity (real values, not the mockup's generic violet)
- Accent (Shotblocks purple): **#824cee**
- Audio green: **#02b85d**
- Orphan red: **#ff6259**, Edge amber: **#EDA840**
- Chrome greys from the real UI: grey-7 #121212, grey-10 #1a1a1a, grey-12 #1f1f1f,
  grey-16 #292929, grey-24 #3d3d3d, grey-50 #7f7f7f
- Use **real product screenshots** (the manual set + fresh captures), never the
  mockup's fake blue/green blocks.
- Site already uses Geist (headings) + Inter (body) — keep; pairs well with a
  dark, product-forward Linear/Raycast aesthetic.

---

## 2. Information architecture

### CMS
- **Case Studies** (renamed from "Product", DONE by Mike) — holds Bud Balla, Preo.
  Route `/case-studies/:slug` (Mike renames route if not already). Untouched.
- **Motion Design** — portfolio reels. `/work/:slug`. Untouched.
- **Products** (NEW — Claude builds) — the plugin storefront collection. Purpose-built
  for selling software (schema in Phase 1).

### Routes
- `/` — studio hub (reworked in Phase 5)
- `/products/:slug` — NEW plugin product pages (Shotblocks first)
- `/work/:slug`, `/case-studies/:slug`, `/about` — existing, untouched
- Optional `/tools` or `/products` index — decide in Phase 4

### Nav (final state)
Fewer links, sticky header, single persistent primary CTA ("Get Shotblocks" /
"Download Beta"). Likely: **Tools · Work · About · [Download]**.

---

## 3. Products CMS schema (Phase 1 deliverable)

Built for selling software (distinct from the case-study shape):

**Identity & status:** Name, Slug, Tagline, Status (enum: Beta / Available / Coming soon)
**Commerce:** Price (number), Free-during-beta (bool), Download/installer link,
  Email-gate (bool), License terms link
**Marketing:** Hero video (.mp4), Hero image, Short description, Full description (rich text),
  Accent color (per-plugin tint), Demo/walkthrough Vimeo link
**Features:** Feature list (array of {title, body, icon?}), Screenshot gallery (array of images)
**Spec/trust:** Version, Platform/requirements ("Cinema 4D 2026 · Windows"),
  Changelog (rich text), User-manual link
**Misc:** "What's new" badge, SEO meta (title/description/og-image)

> Mike to confirm/adjust this schema before Claude creates the collection. Changing
> fields after items exist is painful (and Claude can't edit fields post-create), so
> nail it here.

---

## 4. Staged implementation (the production schedule)

Each phase = one reviewable chunk with a clear gate. Nothing proceeds past a gate
without Mike's sign-off on staging.

### Phase 0 — Pre-production (no Framer build)  ← WE ARE HERE
- [x] Audit shipping features (manual)
- [x] Competitive + pattern research
- [x] This plan
- [ ] **GATE 0:** Mike approves positioning, headlines direction, pricing model,
      and the Products schema. Mike confirms "Product→Case Studies" rename + route.

### Phase 1 — Foundation: CMS + content (low risk, no visible site change)
- Create the **Products** collection (approved schema).
- Seed the **Shotblocks** item: copy, features, spec, screenshots, hero video,
  beta download/email-gate fields. (Brick/Neon left as drafts or omitted.)
- Gather/produce assets: real screenshots (have the manual set; may want fresh
  hero-quality captures + a short screen-recording demo for the hero).
- **No pages built yet** — collection + content only. Site looks unchanged.
- **GATE 1:** Mike reviews the Shotblocks content/copy in the CMS.

### Phase 2 — Product page template (built on staging)
- Build `/products/:slug` page template bound to the Products collection.
- Section anatomy (high-polish, scroll-driven; single primary CTA repeated):
  1. **Sticky nav** + persistent Download CTA
  2. **Hero** — story-driven headline + autoplaying product demo video/loop;
     "Download Free Beta" + "Watch demo"; platform line (C4D 2026 · Windows)
  3. **Positioning strip** — "the NLE for your cameras", trust/at-a-glance
  4. **Pillar 1: Sequence** — split-screen, real timeline screenshot, scroll-reveal
  5. **Pillar 2: Sync** — audio waveform + beat-grid screenshot; "see the beats,
     snap your cuts" (manual/assisted — NOT auto-alignment)
  6. **Pillar 3: Rig** — rig-tag screenshot; procedural motion
  7. **Render** — render workflow screenshot
  8. **How it works** — numbered Sequence · Sync · Render
  9. **Stat bar** — true facts (Zero keyframes, Lives in C4D, etc.)
  10. **Social proof** — placeholder now; real testimonials post-beta
  11. **Pricing/Get it** — "Free during beta" → email gate; future paid price shown
  12. **FAQ** — platform, C4D version, updates, license, refund
  13. **Footer**
- Micro-animations: scroll-reveal on feature blocks, hover states, single pulsing CTA.
- **GATE 2:** Mike QA's the Shotblocks page on staging (desktop).

### Phase 3 — Email gate + beta download wiring  (tool: **Kit / ConvertKit**)
- Mike sets up a free Kit account + a Shotblocks-beta form with an **incentive
  email** that hosts and auto-delivers the installer/zip on signup.
- Embed the Kit form on the product page (Framer embed or Kit's HTML/JS snippet).
- Flow: user enters email → Kit auto-emails the download link → list is retained to
  notify at 1.0 launch.
- Installer file comes from `v1-plan-6`. If it slips, run the form as "notify me"
  and add the file to the incentive email later.
- Confirm the full flow end-to-end on staging.
- **GATE 3:** Mike tests the full download flow (signup → email → download).

### Phase 4 — Responsive (tablet + phone)
- Build Tablet + Phone breakpoints for the product page (currently empty shells).
- This is real work — the high-polish desktop layout must reflow cleanly.
- **GATE 4:** Mike QA's the product page on tablet + phone (real devices/staging).

### Phase 5 — Home page → studio hub (the one destructive step)
- Rework `/` from two-column portfolio into a **single-column studio hub**.
- Likely structure: hero (who you are / what mkslate is) → **Tools** (Shotblocks
  featured; light "more tools coming" plumbing only — NO Brick/Lumen names yet) →
  **Work** (portfolio) → about/contact.
- Done LAST so the product page already stands alone if anything breaks here.
- Keep the existing portfolio content reachable; restyle the entry, don't delete it.
- **GATE 5:** Mike QA's the new home on staging, desktop + responsive.

### Phase 6 — Launch
- Final cross-page QA on staging (nav, links, SEO meta, OG images, 404, favicons).
- Mike publishes to production.
- Post-launch: swap social-proof placeholders for real beta testimonials as they
  come in; add Brick/Neon product pages when ready (now trivial — new CMS items +
  the template already exists).

---

## 5. GATE 0 decisions — LOCKED (2026-05-29)

1. **Pricing at 1.0:** **$69 one-time.** Beta is free. Anti-subscription pitch:
   "$69 once vs GorillaCam's $66/month." (License terms — seats/updates — TBD,
   likely free updates + a small seat count à la Railcut; finalize before 1.0.)
2. **Headlines:** Go with the rewritten options for now; Mike will iterate on
   copy through a writing/testing process. Treat current headlines as v1 drafts.
3. **Products schema:** Approved as-is (§3), treated as **adjustable**. MCP reality:
   Claude CAN add new fields + delete/recreate items freely; only AVOID
   renaming/retyping a field that already holds data. So delete-and-recreate is a
   valid escape hatch — schema is not locked forever.
4. **Email tool:** **Kit (formerly ConvertKit).** Free plan = 10k subscribers + a
   built-in **incentive email** that hosts & auto-delivers the download on signup —
   exactly the email-gated-beta mechanism, no installer-hosting or manual sending.
   (MailerLite was the runner-up but its free tier dropped to 500 subs in 2025 and
   doesn't host the file.) Gate = embed Kit form on the product page → Kit emails
   the download link.
5. **Tools index page:** Deferred — for v1, nav link + the home "Tools" section is
   enough. Add a dedicated `/products` (or `/tools`) index when there are 2+ tools.
6. **Brick / Lumen — OMIT for now, plumb for later:**
   - **Brick** (currently public on GitHub, complete, unmarketed) — needs a NAMING
     pass ("Brick" is generic). Bring in AFTER Shotblocks ships.
   - **Lumen** (neon-sign generator, ~50% done) — finish the product first.
   - Architecture is already multi-product (Products CMS + `/products/:slug`
     template), so adding them later = new CMS items, no rebuild. Add only light
     "more tools coming" plumbing — NO fake/placeholder product pages, no names on
     the site until decided/shipped.
7. **Beta download dependency** — the email gate (Phase 3) needs a real installer
   link from `v1-plan-6`. If the installer slips, ship the page with a "notify me"
   capture (still via Kit) and swap in the download link when ready.

---

## 5b. Component sourcing (build accelerators)

Three sources, fastest-to-slowest to integrate:

1. **Framer built-in section components** — Claude's MCP can insert these directly
   via `updateXmlForNode` with `?detached=true` (Hero, Logo Strip, Features, Pricing
   3-plans, Testimonials Grid, CTA, Footer). Best starting skeleton for each section;
   then customize copy/screenshots/styling to the Shotblocks palette.
2. **Framer Marketplace components** (https://www.framer.com/marketplace/components/)
   — large library for inspiration and for richer interactive pieces (bento grids,
   scroll galleries, animated tabs, comparison sliders). **Caveat:** mostly paid,
   third-party packages, and the MCP can't browse/buy them. Workflow: **Mike picks +
   adds the component to the project → Claude integrates & customizes it.** Use these
   for the high-polish interactive bits the built-ins don't cover (e.g. a
   before/after slider, a scroll-pinned feature reveal, an animated timeline demo).
3. **Existing project components** — reuse what's already built where it fits
   (Button, Icon Button, Social Icons, etc.) so the new pages feel native to the site.

Per-section, prefer the cheapest source that achieves the design: built-in skeleton
first, marketplace only where it buys real interaction, custom code component
(Claude writes React) as the fallback for anything bespoke (e.g. an interactive
mini-timeline that mimics the actual Shotblocks UI).

## 6. Risk register

| Risk | Mitigation |
|---|---|
| Home rework breaks portfolio | Sequenced last; portfolio pages independent; staging-first |
| CMS schema wrong after items exist | Nail schema at GATE 0; Claude can't edit fields post-create |
| Claude builds blind to canvas | Mike does visual QA at every gate; staging is the surface |
| Responsive is underestimated | Its own phase (4), not assumed free |
| Email gate complexity | Decide tool at GATE 0; can ship a simple Framer form first |
| Download link not ready | Phase 3 depends on `v1-plan-6`; can launch page with "notify me" if installer slips |
| Motion Library creep | Hard rule: zero Motion Library language/claims until it's real |
