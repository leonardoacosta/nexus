# Change: Implement TUI screens, app state, and multi-agent session aggregation

## Why

The TUI has stub files for all screens and an empty app state module. The PRD specifies three
must-have screens for M2 (Dashboard, Health, Projects) plus multi-agent session aggregation,
auto-refresh polling, and keyboard navigation. Without these, the TUI binary does nothing. This
spec delivers the visual core: app state machine, screen rendering, session aggregation from
all configured agents, and the 2s polling loop that keeps data fresh.

## What Changes

- **Rewrite** `crates/nexus-tui/src/app.rs`: full App state struct with screen enum, selected
  row tracking, agent data cache, tick-based polling, and keyboard input dispatch
- **Rewrite** `crates/nexus-tui/src/screens/dashboard.rs`: sessions grouped by project, status
  dots (Active/Idle/Stale/Error), [M]/[A] type indicators, braille sparklines, j/k navigation,
  selected row highlighting, status bar
- **Rewrite** `crates/nexus-tui/src/screens/health.rs`: per-machine CPU/RAM/disk metrics,
  Docker container status, agent connection indicators, disconnected agent ✖ with last-seen
- **Rewrite** `crates/nexus-tui/src/screens/projects.rs`: project table with session counts,
  status summary per project
- **Modify** `crates/nexus-tui/src/screens.rs`: ensure module structure exports render functions
- **Modify** `crates/nexus-tui/src/main.rs`: wire up terminal setup (crossterm), App
  initialization, event loop (keyboard + tick), and teardown

## Impact

- Affected specs: tui-dashboard (NEW capability)
- Affected code: `crates/nexus-tui/src/{app.rs, main.rs, screens.rs, screens/dashboard.rs, screens/health.rs, screens/projects.rs}`
- No breaking changes — all files are stubs being implemented for the first time
- Phase 3, Wave 3 — estimated ~400 LOC
- Depends on: tui-grpc-client (spec 4) — screens consume NexusClient for agent queries
- Depended on by: detail-palette-start (spec 8), tui-attach-and-alerts (spec 9)
