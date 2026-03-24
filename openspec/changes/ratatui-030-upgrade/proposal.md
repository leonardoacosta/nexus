## Summary

Upgrade ratatui 0.29 → 0.30 and crossterm 0.28 → 0.29. Replace manual terminal init/teardown with `ratatui::run()`. Replace manual overlay Rect math with `Rect::centered()`.

## Motivation

ratatui 0.30 provides APIs that simplify multiple other polish specs: `ratatui::run()` eliminates ~18 lines of manual crossterm setup/teardown, `Rect::centered()` replaces 5 manual overlay calculations. This upgrade is a prerequisite for all other polish work.

## Approach

1. Bump `ratatui` to 0.30 and `crossterm` to 0.29 in workspace Cargo.toml
2. Replace manual `enable_raw_mode` / `EnterAlternateScreen` / `Terminal::new` in main.rs with `ratatui::run()`
3. Update editor recovery flow (Ctrl+E) to work with `ratatui::run()` lifecycle
4. Replace all manual overlay Rect math (5 sites) with `Rect::centered()`
5. Fix any crossterm 0.29 API changes (KeyEvent, MouseEventKind)
6. Verify all tests pass

## Files Modified

- `Cargo.toml` — workspace dependency versions
- `crates/nexus-tui/src/main.rs` — terminal init/teardown (lines 108-117, 150-157, 475-494), overlay in status area (line 210-214)
- `crates/nexus-tui/src/screens/palette.rs` — overlay Rect math (lines 17-20, 107-110)
- `crates/nexus-tui/src/screens/projects.rs` — scratchpad overlay Rect math (lines 158-159)
- `crates/nexus-tui/src/screens/stream.rs` — toast Rect math (lines 432-435)
