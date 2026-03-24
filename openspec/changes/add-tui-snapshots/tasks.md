## 1. Test Infrastructure
- [ ] 1.1 Add `insta` crate as dev-dependency in nexus-tui/Cargo.toml
- [ ] 1.2 Create `tests/fixtures/mod.rs` with mock session, agent, and health data builders
- [ ] 1.3 Create `tests/snapshots.rs` with helper to render a screen to TestBackend(80x24) and return string

## 2. Screen Snapshots
- [ ] 2.1 Dashboard screen: 2 agents, 5 sessions across 3 projects, mixed status dots
- [ ] 2.2 Stream view: formatted assistant message with code block and tool result
- [ ] 2.3 Health screen: 2 agents with CPU/RAM/disk metrics and Docker containers
- [ ] 2.4 Projects screen: 3 projects with session counts and badges

## 3. Edge Cases
- [ ] 3.1 Dashboard with 0 sessions (empty state)
- [ ] 3.2 Dashboard with disconnected agent (shows connection error)
- [ ] 3.3 Stream view with search active (yellow highlights)

## 4. Validation
- [ ] 4.1 `cargo test --test snapshots` passes
- [ ] 4.2 All .snap files committed to repo
- [ ] 4.3 `cargo clippy` passes
