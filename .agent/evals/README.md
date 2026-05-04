# Evals

Automated checks that verify quality holds as the codebase changes. Populated as we build.

## Categories

- **smoke/** — does the plugin load? Does a default rig instantiate? Does a default shot bake?
- **visual/** — render comparison: known-good frames vs current output, per preset
- **perf/** — viewport framerate with rig active, audio decode time, onset detection time
- **sync/** — audio playback drift over a 5-minute timeline, beat marker accuracy

## Running

`scripts/fullcheck.sh` runs all evals. Individual categories can be run separately when iterating.

## Adding an eval

1. Pick a category (or define a new one)
2. Write the eval as a script that exits 0 on pass, non-zero on fail
3. Add to the category's runner
4. Document what the eval is measuring and what counts as a regression
