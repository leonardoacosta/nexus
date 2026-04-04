## 1. Dependency Upgrade
- [ ] 1.1 Bump `ratatui` from "0.29" to "0.30" in workspace Cargo.toml (line 29)
- [ ] 1.2 Bump `crossterm` from "0.28" to "0.29" in workspace Cargo.toml (line 30)
- [ ] 1.3 Run `cargo update -p ratatui -p crossterm` and verify Cargo.lock resolves

## 2. Terminal Lifecycle
- [ ] 2.1 Replace manual terminal setup (main.rs lines 108-117: enable_raw_mode, EnterAlternateScreen, EnableMouseCapture, CrosstermBackend, Terminal::new) with `ratatui::run()` or equivalent 0.30 entry point
- [ ] 2.2 Remove manual teardown (main.rs lines 150-157: disable_raw_mode, LeaveAlternateScreen, DisableMouseCapture, show_cursor)
- [ ] 2.3 Update editor recovery flow (main.rs lines 475-494) to work with new lifecycle — ensure Ctrl+E can exit/re-enter raw mode

## 3. Overlay Rect Migration
- [ ] 3.1 Replace palette overlay math (palette.rs lines 17-20) with `Rect::centered()` — 60% width, 20 rows
- [ ] 3.2 Replace start-session panel math (palette.rs lines 107-110) with `Rect::centered()` — 50% width, 12 rows
- [ ] 3.3 Replace scratchpad overlay math (projects.rs lines 158-159) with `Rect::centered()` — 60% width, 50% height
- [ ] 3.4 Review toast positioning (stream.rs lines 432-435) and status area (main.rs lines 210-214) — these may not be centered overlays, adjust as appropriate

## 4. API Compatibility
- [ ] 4.1 Fix any crossterm 0.29 breaking changes (KeyEvent field renames, MouseEventKind changes)
- [ ] 4.2 Update any deprecated ratatui 0.29 APIs per migration guide

## 5. Validation
- [ ] 5.1 `cargo build` passes with zero warnings
- [ ] 5.2 `cargo test` — all 61 tests pass
- [ ] 5.3 `cargo clippy` — no new warnings
- [ ] 5.4 Manual smoke: launch TUI, verify all screens render, overlays center correctly
