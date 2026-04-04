# Implementation Tasks

<!-- beads:epic:TBD -->

## DB Batch

- [x] [1.1] [P-1] Add state transition tests to `app.rs` — screen cycling (Tab/Shift-Tab), quit (q/Ctrl-C), palette toggle (/), detail entry (Enter) and exit (Esc) [owner:db-engineer]

## API Batch

- [x] [2.1] [P-1] Add client aggregation tests to `client.rs` — multi-agent session merge, duplicate dedup by session ID, status computation from heartbeat age, connection failure returns empty session list [owner:api-engineer]
- [x] [2.2] [P-1] Add rendering tests for dashboard screen — empty state (0 sessions), populated state, session grouping by project [owner:api-engineer]
- [x] [2.3] [P-1] Add rendering tests for health screen — empty health data, full gauges, sparkline rendering [owner:api-engineer]
- [x] [2.4] [P-1] Add rendering tests for detail screen — session with all fields, session with missing optional fields [owner:api-engineer]
- [x] [2.5] [P-1] Add rendering tests for projects screen — empty project list, projects with session counts [owner:api-engineer]

## E2E Batch

- [x] [4.1] Run `cargo test -p nexus-tui --lib` and verify all new tests pass [owner:api-engineer]
- [x] [4.2] Verify test count increased from 2 modules to 7+ modules [owner:api-engineer]
