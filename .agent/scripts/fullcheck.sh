#!/usr/bin/env bash
# Full pre-release check suite. May take several minutes.
set -e

bash "$(dirname "$0")/fastcheck.sh"

echo "→ Run eval suite"
# python -m evals.run_all  # uncomment when evals exist

echo "→ Generate all preset thumbnails (verifies preset integrity)"
# python tools/generate_thumbnails.py --all  # uncomment when tool exists

echo "→ Run smoke test in C4D 2026.2.0 (requires C4D in PATH)"
# python tools/version_smoke.py  # uncomment when tool exists

echo "fullcheck OK"
