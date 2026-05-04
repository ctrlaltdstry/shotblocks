#!/usr/bin/env bash
# Quick checks before commit. Should run in under 30 seconds.
set -e

echo "→ Lint Python sources"
# python -m ruff check src/  # uncomment when ruff is set up

echo "→ Validate preset JSON schemas"
# python tools/validate_presets.py  # uncomment when validator exists

echo "→ Smoke import"
# python -c "import src.plugin_main"  # uncomment when entry exists

echo "fastcheck OK"
