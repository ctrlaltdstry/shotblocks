# Licensing and distribution

Decisions about how Shotblocks is licensed and distributed. Empty when work began; populate as decisions are made.

## Status

**MIT, decided 2026-05-10.** Made to unblock the v8 audio decoder choice.
The `LICENSE` file at the repo root carries the canonical text and the
copyright line `Copyright (c) 2026 Michael Slater`. Distribution and
contributor-agreement decisions are still open (see below).

## Why this matters now

Several technical decisions wait on this:

- **Audio decoder choice.** Bundling an MP3/AAC decoder has licensing implications. LGPL libraries like libmpg123 or libavcodec require dynamic linking and explicit notice if Shotblocks ships proprietary. Permissively licensed alternatives (some pure-C MP3 decoders, dr_mp3, minimp3) avoid this but may have functional limits.
- **Bundled font handling, if any.** Most font formats have license terms that affect bundling.
- **Code reuse from open source plugin examples.** Maxon's SDK examples are typically Apache 2.0 — usable but require attribution. Some community examples are GPL — incompatible with proprietary distribution.
- **Whether contributors need to sign a CLA.** Affects how we accept outside contributions.
- **Distribution channel.** Maxon's marketplace, our own site, or both? Each has distribution requirements.

## Decisions to make

### License
Options:
- **Open source (MIT, BSD, Apache 2.0)** — broadest, attracts contributors, no CLA needed
- **Open source copyleft (GPL, AGPL)** — requires derivative works to also be GPL
- **Source-available (e.g., Elastic License)** — public source but commercial restrictions
- **Proprietary** — closed source, paid product

Personal projects most often go MIT; commercial plugins typically go proprietary or source-available. The choice affects what we can pull from.

### Distribution
- **Maxon's marketplace.** Reaches the most users; Maxon takes a cut; subject to Maxon's review process.
- **Self-hosted (own website).** Full control; harder discovery; we handle billing and updates.
- **Both.** Common for serious commercial plugins.
- **Free / paid / freemium.** Affects expectations and support burden.

### Contributor agreement
- **No CLA.** Contributors retain copyright; project must accept their license terms.
- **CLA required.** Contributors assign or license their work to the project; project owner has flexibility for relicensing later.

## Implications by license choice

If **MIT or similar permissive open source:**
- Anyone can fork and use commercially
- Maxon SDK examples (Apache 2.0) usable directly
- Most audio decoders usable without complications
- No CLA needed; contributions just come in
- Distribution typically self-hosted with optional donation; commercial sale possible but unusual

If **proprietary:**
- Source not public
- Maxon SDK examples (Apache 2.0) usable but need attribution
- LGPL audio libraries can be dynamically linked but require notice; GPL libraries excluded
- Contributors would need a CLA (rare for proprietary anyway)
- Distribution through Maxon marketplace and/or own site, paid product likely

If **source-available:**
- Hybrid: source visible, commercial use restricted
- Treats SDK examples like proprietary
- Audio library treatment closer to proprietary
- CLA recommended

## Recommendation when the time comes

This is a decision for the project owner, not for the agent. The agent's job is to flag the decision when it would unblock other work and to honor whatever choice is made. When the decision is made:

1. Add a `LICENSE` file at the project root with the chosen license text
2. Update this document to record the decision and date
3. Resolve the audio decoder choice (which depends on this)
4. Update any third-party code references in the codebase to match

## Implications now that MIT is chosen

Bundled dependencies must be MIT/BSD/Apache/CC0/PD compatible with MIT
redistribution. LGPL is excluded (its dynamic-link + notice obligations
clash with how Shotblocks ships); GPL/AGPL is excluded outright.

Audio decoder fallout: WAV via stdlib `wave`, MP3 via bundled minimp3
(CC0). AAC is effectively shelved — no permissively-licensed AAC
decoder of decent quality exists. FLAC (dr_flac) and Vorbis
(stb_vorbis) are cheap to add later if user demand justifies them.

Each vendored binary gets its own license file under `src/vendor/`
and an entry in `src/vendor/README.md` with source URL and pinned
revision.
