# .agent

This folder holds the operating context for AI-assisted development of the camera rig plugin. It is structured so that an agent (or a human collaborator) can pick up the project at any point, read a small set of files, and act consistently with prior decisions.

## Start here

`router.md` — the entry point. Tells you which files to read for which task.

## Folder map

- `constitution.md` — immutable principles. Read first, always.
- `router.md` — task-type → file-list lookup.
- `context/` — durable knowledge: glossary, domain, architecture, conventions, pitfalls, audio, c4d-api specifics.
- `workflows/` — procedures for common change types.
- `team/` — review lenses (cinematographer, motion designer, c4d veteran, audio engineer, qa tester).
- `skills/` — reusable knowledge chunks (spring-damper math, onset detection, etc.).
- `checklists/` — quality gates before commit, before release, etc.
- `tasks/` — current and archived work units.
- `evals/` — automated checks (visual regression, perf, smoke tests).
- `modes/` — project mode (exploration / stabilization / release).
- `scripts/` — fastcheck / fullcheck shell scripts.

## Principles for maintaining this folder

1. Write a new file when you have something real to put in it. Empty templates rot.
2. When you hit a decision worth recording, write it into the right context file before moving on.
3. The constitution is immutable in spirit. If you find yourself wanting to change it, that is a serious moment — discuss with the user, do not silently edit.
4. Glossary changes ripple. If you rename a concept, grep the rest of the docs and update.
5. Workflows describe the path that worked. When a workflow stops matching reality, fix the workflow.
