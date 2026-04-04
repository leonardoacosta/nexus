# Change: Add Command Palette

## Why

With 10-20+ sessions across multiple agents, navigating by j/k on the dashboard is slow. A fuzzy search palette lets users jump to any session, project, or action instantly.

## What Changes

- Add `nucleo` crate for fuzzy matching (fast, Rust-native, used by helix editor)
- Build searchable index from: session names/IDs, project codes, agent names, actions (attach, stop, start, health)
- Render overlay widget: semi-transparent surface over current screen, search input at top, results below
- Ctrl-P opens palette from any screen, Esc dismisses, Enter executes selected item
- Arrow keys navigate results, matched characters highlighted in PRIMARY green

## Impact

- Affected specs: none (new capability)
- Affected code:
  - `crates/nexus-tui/src/screens/palette.rs` — full implementation (currently exists as stub or empty)
  - `crates/nexus-tui/src/app.rs` — add PaletteOpen state, Ctrl-P handler, action dispatch
  - `crates/nexus-tui/src/main.rs` — wire palette overlay rendering
  - `crates/nexus-tui/Cargo.toml` — add nucleo dependency
