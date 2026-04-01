# Proposal: Wire TUI Analytical gRPC RPCs

## Change ID
`add-tui-analytics`

## Summary
Wire the 4 existing analytical gRPC RPCs (GetSessionHistory, GetFailureTrends,
GetHealthTimeSeries, GetSpecVelocity) into the TUI with hybrid fetch strategy — background
timer for health, on-demand for the rest.

## Context
- Extends: `crates/nexus-tui/src/client.rs` (gRPC client), `crates/nexus-tui/src/main.rs`
  (background task + RpcCommand/RpcResult enums), `crates/nexus-tui/src/app.rs` (App state),
  `crates/nexus-tui/src/screens/health.rs`, `screens/dashboard.rs`, `screens/projects.rs`,
  `screens/specs.rs`
- Related: `grpc-analytics` spec (server-side RPCs), `health-timeseries` spec (SQLite queries)
- Depends on: All 4 RPCs fully implemented server-side (`crates/nexus-agent/src/grpc/analytics.rs`)

## Motivation
The Health screen sparklines currently only show data accumulated since TUI process start (~1hr
ring buffer at 2s intervals). The agent already has 24h+ of historical data in SQLite, served via
4 analytical gRPC RPCs — but the TUI never calls them. This wastes the SQLite persistence work
from Phase 2/3 and leaves the user with a narrow window into system history.

## Requirements
### Req-1: gRPC client methods for all 4 analytical RPCs
Add 4 methods to `NexusClient` in `client.rs` following the existing fan-out-across-agents pattern.

### Req-2: Hybrid fetch strategy
Health timeseries data fetched on a 30s background timer (always warm for sparklines). Session
history, failure trends, and spec velocity fetched on-demand when user navigates to the consuming
screen.

### Req-3: App state caching
Add cache fields to `App` struct for each RPC's response data. On-demand RPCs populate cache on
screen entry; timer-based RPCs update cache continuously.

### Req-4: Screen rendering integration
- **Health screen**: Replace/supplement in-memory ring buffer sparklines with 24h SQLite timeseries
- **Dashboard**: Add session count + cost trend sparkline in status area, failure count indicator
- **Projects screen**: Add per-project spec velocity column (completed/total tasks trend)
- **Specs screen**: Add task completion velocity inline with existing tasks_done/tasks_total

## Scope
- **IN**: 4 client methods, RpcCommand/RpcResult variants, App cache fields, background timer for
  health, on-demand triggers for other 3, screen rendering updates
- **OUT**: New proto definitions (already exist), server-side changes, new TUI screens, interactive
  charts (sparklines only)

## Impact
| Area | Change |
|------|--------|
| client.rs | +4 gRPC client methods |
| main.rs | +RpcCommand/RpcResult variants, +30s health timer, on-demand dispatch |
| app.rs | +4 cache fields for analytics data |
| health.rs | Replace ring buffer sparklines with SQLite-backed 24h data |
| dashboard.rs | Add session/cost sparkline + failure indicator |
| projects.rs | Add spec velocity column |
| specs.rs | Add task velocity inline |

## Risks
| Risk | Mitigation |
|------|-----------|
| gRPC calls add latency to screen transitions | On-demand with cached fallback — show stale data while refreshing |
| Health timer doubles gRPC traffic | 30s interval is modest; existing health poll is 2s (this is separate analytical data) |
| Multi-agent aggregation for analytics | Same fan-out pattern as get_sessions — merge results across agents |
