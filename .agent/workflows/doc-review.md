# Doc review workflow

The purpose of doc review is to catch documents that have drifted from reality before the drift causes problems. Documents go stale silently — code changes, decisions get revised in conversation, and the docs that captured the original assumption keep sounding authoritative even when they're wrong. This workflow exists so the doc set stays trustworthy.

## When to run it

- **Before every release.** A checkbox in `checklists/pre-release.md` enforces this.
- **When the deploy-and-test loop reveals a stale claim.** Don't wait — fix it in the moment.
- **When picking up the project after a long pause.** A drift in your own memory is also a kind of doc rot.

## The pass

The full review is intended to be brief — minutes, not hours. The point is to flag, not to rewrite in place. Anything that needs substantial rework becomes its own task.

For each file in `.agent/`:

1. **Skim the file's headings and opening claims.** Are the framing statements still true? (e.g., "Cameras-as-clips" is still the architectural model — yes, still true. "We use Plugin Cafe IDs" — that one bit us, would be caught here.)
2. **Spot-check version-specific claims.** Anything mentioning a specific C4D version, plugin path, API constant, or version-shifted naming. These are the most likely to rot.
3. **Spot-check claims about C4D specifics.** Three were wrong already in this project; assume more will be.
4. **Check cross-references.** If file A says "see file B for X" and file B no longer covers X, fix one or both.
5. **Note anything that feels overconfident or vague** without trying to resolve it on the spot — flag it for follow-up.

## What to actually do with findings

Three buckets:

- **Trivially correctable** (a wrong path, a renamed constant, an outdated link) — fix in place during the review.
- **Substantively wrong but not blocking** — fix in place if you can, otherwise add to `open-questions.md` or file a task.
- **Reveals a deeper architecture or design issue** — file a task; do not silently bandage the doc.

The trap to avoid: rewriting an entire context document during what should have been a 10-minute review. If the work expands beyond a quick correction, stop, capture the issue as a task, and move on.

## What to skip

The constitution and the glossary are durable — they shift on intent, not on implementation detail. Skim them but don't pick them apart for staleness. The most volatile docs are anything that names specific C4D versions, paths, API surfaces, product-specific assumptions, or visual tokens that will change as real UI gets drawn:

- `context/c4d-conventions.md`
- `context/c4d-plugin-development.md`
- `context/c4d-api.md`
- `context/dev-environment.md`
- `context/pitfalls.md`
- `design/visual-language.md` (tokens drift as the UI is drawn and refined)

These are where doc rot accumulates fastest. Concentrate review effort there.

The design principles file (`design/principles.md`) is closer to the constitution — durable, shifts on intent. Review it for clarity, not for value churn.

## After the pass

- If anything substantive was changed, note it in the release's changelog.
- If `open-questions.md` got new entries, that's expected — open questions accumulating is not a problem, them never getting resolved is.
- The pre-release checkbox can be checked off only when the review actually happened, not when it was scheduled.

## Why this is brief

A doc review that takes hours doesn't get done. A doc review that takes 15 minutes gets done every release. We optimize for the latter.
