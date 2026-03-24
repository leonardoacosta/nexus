## 1. Fuzzy Matcher
- [ ] 1.1 Add `nucleo` crate to nexus-tui/Cargo.toml
- [ ] 1.2 Build `PaletteIndex` struct that collects searchable items from app state
- [ ] 1.3 Index types: Session (id, project), Project (code, path), Agent (name, host), Action (attach, stop, start, health)

## 2. Overlay Widget
- [ ] 2.1 Render semi-transparent surface over current screen (dark overlay)
- [ ] 2.2 Search input with PRIMARY green cursor at top of overlay
- [ ] 2.3 Results list below: each item shows type icon, name, context (agent/project)
- [ ] 2.4 Matched characters highlighted in PRIMARY green
- [ ] 2.5 Selected item has inverted background (PRIMARY_DIM)

## 3. Navigation
- [ ] 3.1 Ctrl-P opens palette from any screen
- [ ] 3.2 Typing filters results in real-time
- [ ] 3.3 Up/Down arrows navigate result list
- [ ] 3.4 Enter executes: Session → navigate to detail, Project → filter dashboard, Agent → show health, Action → execute
- [ ] 3.5 Esc dismisses palette, returns to previous screen

## 4. Validation
- [ ] 4.1 Open palette, type project code, verify session results filter correctly
- [ ] 4.2 Select a session result, verify navigation to detail screen
- [ ] 4.3 Verify palette works from all screens (dashboard, health, projects, stream, detail)
- [ ] 4.4 `cargo clippy && cargo test` passes
