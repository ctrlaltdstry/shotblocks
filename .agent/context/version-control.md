# Version control & GitHub strategy

How we use git on this project. Read this before your first commit; consult it when deciding what to commit and when.

## Current state

**Local only.** No git repo initialized yet, no remote. A private GitHub repo is planned but not on the immediate roadmap — this section will move to "Remote" once it exists.

The `.gitignore` already exists in the repo root and covers C4D backup files, Python bytecode, build artifacts, and editor metadata. No changes needed before `git init`.

## Initialization

When ready, one command:

```powershell
git init -b main
git add .
git commit -m "v0–v3: initial commit covering plugin shell, timeline canvas, drag-create, multi-track + direct manipulation"
```

The initial commit captures everything that's already shipped (v0 through v3). Subsequent commits start the per-milestone cadence below.

## Branching

**Trunk-based on `main`.** Solo dev, milestone-based commits — there's no need for the overhead of feature branches by default. Commits land directly on main.

**Throwaway branches are fine** when you want to experiment with something risky (a refactor, a parallel design, an audio decoder you're not sure will work). Branch, commit freely, merge fast-forward when it works, delete the branch when it lands. Don't let experimental branches linger past a few days; if it's worth keeping, bring it home.

No `develop`, no `release/*`, no GitFlow. The `.agent/tasks/active/` and `.agent/tasks/archived/` directories already serve the role those branches would.

## Commit cadence

**One commit per major milestone**, where "milestone" usually means a task in `.agent/tasks/active/` is done and ready to move to `archived/`. Examples:

- v3 — overlap policy + multi-track + direct manipulation → one commit on completion
- A new preset shipping with thumbnail + tests → one commit
- A bug fix that closes an entry in `pitfalls.md` → one commit

Mid-task work doesn't need to be committed. If you want a safety net during a long task, use a throwaway branch; otherwise, the file system + auto-memory captures enough state to recover from.

## Commit message format

```
<task-id>: <imperative summary>

<body — the "why," what landed, what didn't>

Co-Authored-By: <if collaboratively authored>
```

**Subject line** (≤72 chars):

- Lead with the task ID matching `.agent/tasks/`: `v3:`, `v4-presets:`, `bugfix-orphan-relink:`, etc.
- For commits that don't tie to a task — repo hygiene, doc edits, refactors of cross-cutting code — use a topic prefix instead: `chore:` (gitignore, build, tooling), `docs:` (anything under `.agent/`, `README.md`, comments), `refactor:` (no behavior change). Borrowed from Conventional Commits but used loosely; we're not parsing these.
- Imperative voice: `add`, `fix`, `refactor` — not "added" or "adds"
- Specific: `v3: cross-track magnetic snap + multi-track lanes` beats `v3: timeline updates`

**Body** (optional but encouraged for milestones):

- The *why* — what problem this solves or which constitution principle / quality bar it advances
- What's *not* covered, especially open-questions that came up
- Anything that changed direction during the work, so the diff doesn't have to retell the story

We're not adopting full Conventional Commits (`feat:`/`fix:`/`chore:` etc.) because our task model already provides the categorization, and our commit cadence is too coarse-grained to benefit from machine-generated changelogs. The task ID prefix gives us most of the same value with less friction.

**Co-author trailer:** when Claude (or any other collaborator) substantially authored the code in a commit, include a `Co-Authored-By` trailer. This is the GitHub-recognized format and shows up in commit history attribution.

## What not to commit

The `.gitignore` already covers most of it. Beyond that:

- **No secrets, no API keys.** If we ever add cloud-backed features, secrets go in environment variables or untracked config, never in the repo.
- **No `.c4d` files larger than necessary.** `scenes/dev-test.c4d` is fine — it's the canonical reproduction case. Avoid committing every test scene; check in only what we'd want to keep across years of work.
- **No generated thumbnails** unless we decide otherwise (the `.gitignore` has the toggle commented out — flip it once we have a thumbnail pipeline).
- **No build artifacts.** `build/`, `dist/`, `__pycache__/` are already excluded.

## Pre-commit checklist

Before every commit, run through `.agent/checklists/pre-commit.md`. The current list focuses on runtime sanity (fresh C4D launch, no console warnings, no leftover prints, persistence round-trip) — it'll grow as the codebase grows.

For milestone commits, also:

- Move the completed task file from `.agent/tasks/active/` to `.agent/tasks/archived/`
- Update `.agent/open-questions.md` if any entries were resolved
- Update `MEMORY.md` if any new auto-memory entries belong there

## Tagging and releases

Defer tagging until v1 ships. While we're in v0/v1 development (currently v3 of v1's foundational work), tags would just be noise.

When v1 ships:

- Tag with semver: `v1.0.0`. Match `release.md`'s versioning policy (major = breaking scene/preset format, minor = new features, patch = fixes).
- Annotated tags only: `git tag -a v1.0.0 -m "..."`. Lightweight tags lose information.
- Follow `.agent/workflows/release.md` for the rest of the release process.

## When we move to GitHub

Decisions to make at that point:

- **Repo name.** `shotblocks` is the obvious one if available.
- **Visibility: private.** Already decided. Switch to public is a separate decision tied to `licensing.md` (still open).
- **Branch protection on `main`.** Once a collaborator joins; not needed solo.
- **CI.** Not until there's something automated worth running; the dev loop is currently `scripts/dev-loop.ps1` + manual verification, which doesn't translate to CI.
- **Issues vs. tasks.** The `.agent/tasks/` system is the source of truth for in-flight work; GitHub Issues mirror that for external visibility, not as a replacement.

Update this file when the move happens — replace this section with the actual remote, current branch protection rules, and where issues live.

## Reverting and force-pushing

- **Prefer `git revert` over `git reset` once a commit lands** — preserves history, makes the revert visible.
- **Never force-push** to any branch with collaborators on it. While solo on `main`, force-push is fine in a pinch but should be rare; if you find yourself forcing often, the commit cadence is wrong (probably committing too early).
- **Never amend a commit that's been pushed** to a shared remote.

For the throwaway-branch experiment case, force-push is fine on your own branches.
