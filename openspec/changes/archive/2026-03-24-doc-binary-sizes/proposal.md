## Summary

Document release binary sizes in the project README and add a CI step that reports binary sizes on each build. Establishes a baseline for tracking binary size over time.

## Motivation

Binary sizes are currently unmeasured. For a CLI tool deployed across machines, knowing and tracking binary size helps catch unexpected bloat from new dependencies.

## Approach

1. Measure current release binary sizes (already done: agent 6.3M, TUI 5.9M, register 4.0M)
2. Add a "Binary Sizes" section to README.md
3. Add a CI step that prints binary sizes after release build

## Files Modified

- `README.md` — add binary sizes section
- `.github/workflows/ci.yml` — add binary size reporting step
