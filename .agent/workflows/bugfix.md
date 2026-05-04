# Workflow: Bug Fix

## 1. Reproduce

Build a minimal test scene under `scenes/repro/` that demonstrates the bug. Save it. The scene becomes part of the repo so the bug cannot silently regress.

## 2. Diagnose

- Check `pitfalls.md` — has this been seen before?
- Add print statements or use C4D's console — do not assume the cause
- Confirm the bug is in the plugin, not in user error or a C4D version difference

## 3. Fix

- Smallest change that resolves the bug
- If the fix touches a hot path (per-frame tag code, draw code), profile before and after
- If the fix touches sequencer logic, manually verify a transition through the affected state

## 4. Add a regression test

If we have an eval that could have caught this, extend it. If we don't, write one and add it to `evals/`.

## 5. Update pitfalls.md

If the bug came from a non-obvious cause, document it. The next person should not re-discover this.

## 6. Pre-commit checklist

`.agent/checklists/pre-commit.md`
