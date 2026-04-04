# Proposal: Add TUI test coverage

## Change ID
`add-tui-test-coverage`

## Summary
Add unit and snapshot tests to the nexus-tui crate, which currently has only 2 test modules
for ~5K LOC of rendering and state management logic.

## Context
- Extends: `crates/nexus-tui/src/` (app.rs, client.rs, screens/)
- Related: Audit finding — near-zero test coverage on rendering, state, and client aggregation

## Motivation
The TUI is the primary user-facing interface. `app.rs` (1998 LOC) handles all key events, screen
transitions, and state management with zero tests. Client aggregation logic (multi-agent session
merging) has no verification. Rendering regressions are invisible.

## Requirements

### Req-1: State transition tests
Test key event handling → screen transitions in `app.rs`: dashboard ↔ detail, palette open/close,
screen cycling, quit handling.

### Req-2: Client aggregation tests
Test multi-agent session merging in `client.rs`: duplicate dedup, status computation, agent
name propagation, connection failure handling.

### Req-3: Screen rendering tests
Use ratatui's `TestBackend` for snapshot tests on each screen: dashboard, detail, health,
projects, notifications. Verify rendering doesn't panic on empty data, missing fields, or
edge-case inputs.

## Scope
- **IN**: Unit tests for state, client, rendering. Using ratatui TestBackend for snapshots.
- **OUT**: Integration tests against live agents, E2E terminal automation

## Impact
| Area | Change |
|------|--------|
| crates/nexus-tui/src/app.rs | Add #[cfg(test)] module with state transition tests |
| crates/nexus-tui/src/client.rs | Add #[cfg(test)] module with aggregation tests |
| crates/nexus-tui/src/screens/*.rs | Add #[cfg(test)] modules with render snapshot tests |

## Risks
| Risk | Mitigation |
|------|-----------|
| Snapshot tests are brittle across ratatui versions | Pin ratatui version, use semantic assertions where possible |
| app.rs is hard to test due to tight coupling | Test through public methods, mock minimal dependencies |
