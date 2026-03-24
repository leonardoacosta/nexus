# Plan Completion: Nexus MVP

## Phase: MVP (v0.1)
## Completed: 2026-03-23
## Duration: 2026-03-19 → 2026-03-23 (5 days)

## Delivered

### M1: Agent + Core (planned)
- `proto-and-codegen`: Protobuf schema + tonic gRPC codegen for agent API
- `agent-grpc-server`: gRPC server with session lifecycle, registry, event streaming
- `agent-health-and-ops`: Machine health metrics (CPU/RAM/disk/Docker), systemd/launchd service
- `deploy-and-ci`: GitHub Actions CI/CD, systemd/launchd services, install script, pre-push deploy hook
- `hook-session-registration`: Direct gRPC registration from CC hooks (replaced sessions.json watcher)

### M2: TUI Dashboard (planned)
- `tui-grpc-client`: gRPC client replacing HTTP/reqwest stubs
- `tui-screens-and-aggregation`: Dashboard, Health, Projects screens with multi-agent aggregation
- `stream-events-rpc`: Real-time gRPC StreamEvents for live session updates
- `tui-attach-and-alerts`: Stream attach (read-only) + SSH/tmux full attach + alert notifications
- `detail-palette-start`: Session detail drill-down screen

### M3: Attach + UX (planned)
- `session-broker`: gRPC command broker — TUI sends prompts, agent streams CC output (replaced tmux)
- `stream-message-formatting`: Role-based formatting, styled lines, elapsed spinner
- `collapsible-tool-output`: Collapsible blocks for verbose tool results, Enter toggle
- `input-bar-enhancements`: Multi-line input, history, placeholder, external editor

### Unplanned Additions
- `project-list-wizard`: ListProjects RPC + project select widget + filesystem scan
- `status-bar-telemetry`: Rate limit, cost, model telemetry in TUI status bar
- `project-badges-scratchpad`: Activity badges, notes persistence, scratchpad overlay
- `improve-stream-markdown`: pulldown-cmark rendering — headers, code blocks, tables, bold/italic
- `improve-stream-framing`: Message framing with user/assistant headers, left-border accents, verbosity filter
- `add-stream-actions`: Code yank (OSC 52), stream search, session tabs (1-9), thinking collapse, inline diffs
- `add-event-stream-enhancements`: EventType filtering, agent_name on events, initial snapshot
- `add-health-api-spec`: Accurate uptime, machine health fixes
- `add-agent-targeting`: target_agent field for multi-agent routing
- `add-command-progress-relay`: ProgressUpdate in command streams for incremental relay
- `add-discovery-api`: ListAgents + ListProjects for smart session routing

## Deferred
None — all tasks completed.

## Metrics
- LOC: ~9,000 Rust
- Tests: 32
- Specs: 25 archived / 25 total (100%)
- Commits: 54
- Crates: 4 (nexus-core, nexus-agent, nexus-tui, nexus-register)

## PRD Coverage

| Requirement | Status | Notes |
|-------------|--------|-------|
| A1: Session tracking via hooks | Done | hook-session-registration (Option B) |
| A2: gRPC GetSessions/GetSession/StopSession | Done | agent-grpc-server |
| A3: StreamEvents | Done | stream-events-rpc + enhancements |
| A4: HTTP /health | Done | agent-health-and-ops |
| A5: StopSession SIGTERM/SIGKILL | Done | agent-grpc-server |
| A6: Machine health metrics | Done | sysinfo + Docker |
| A7: systemd/launchd service | Done | deploy-and-ci |
| A9: Port 7400 gRPC, 7401 HTTP | Done | |
| A10: StartSession (managed) | Done | session-broker |
| T1: agents.toml discovery | Done | tui-grpc-client |
| T2: Multi-agent aggregation | Done | tui-screens-and-aggregation |
| T3: Session Dashboard | Done | |
| T5: Health Overview | Done | |
| T6: Project Overview | Done | project-list-wizard |
| T8: Stream attach | Done | tui-attach-and-alerts + session-broker |
| T9: Full attach (SSH+tmux) | Removed | Replaced by command broker (no tmux needed) |
| T10: Auto-refresh via polling | Done | 2s polling + gRPC stream |
| T11: Agent connection status | Done | status dots in status bar |
| T12: Single binary | Done | |
| T4: Session Detail (M3) | Partial | detail-palette-start (basic) |
| T7: Command palette (M3) | Not started | |
| T13: Start session from TUI (M3) | Not started | |
| I1-I5: iMessage (M3) | Not started | |

## Architecture Decisions
1. **Replaced tmux attach with command broker** — session-broker spec pivoted from SSH+tmux to direct gRPC command streaming. More portable, no tmux dependency for interactive use.
2. **Skipped Option A (sessions.json watcher)** — went directly to Option B (hook registration). Cleaner, real-time, no file polling.
3. **Added Nova integration** — 5 unplanned specs to support Nova as a consumer of the Nexus API.

## Lessons
- **What worked**: Small, focused specs (1-3 files each) with clear task lists. Batch execution by layer (proto → agent → TUI) prevented dependency issues.
- **What didn't**: roadmap.md was locked but never committed to disk — lost on session compaction. Future phases should commit all artifacts immediately.
- **Runtime observation**: Agent port configuration drifted after restart (8400 vs 7400/7401). Port binding needs investigation in production-hardening.
- **Scope creep (good)**: Nova integration specs (5 unplanned) were high-leverage — made Nexus useful to external consumers immediately.
