## Summary

Add TUI snapshot tests using ratatui's TestBackend to render key screens and assert terminal output. Snapshots are committed to the repo for regression detection.

## Motivation

TUI rendering bugs are currently caught only by visual inspection. Snapshot tests capture the expected terminal output and fail if rendering changes unexpectedly.

## Approach

1. Create test infrastructure using ratatui's `TestBackend` with a fixed terminal size (80x24)
2. Build mock data fixtures (sessions, agents, health metrics) for consistent test output
3. Render each screen to the TestBackend and compare against committed snapshots
4. Use `insta` crate for snapshot management (review + approve changes)

## Files Modified

- `crates/nexus-tui/tests/snapshots.rs` — snapshot test file
- `crates/nexus-tui/tests/fixtures/mod.rs` — mock data generators
- `crates/nexus-tui/tests/snapshots/` — committed snapshot files (.snap)
- `crates/nexus-tui/Cargo.toml` — add insta as dev-dependency
