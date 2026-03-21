# Change: Surface status bar telemetry via gRPC

## Why

The TUI currently computes status bar data locally (session counts from in-memory agent data,
uptime from local clock). When viewing remote sessions, the TUI needs rate limit utilization,
cost tracking, and model information that only the agent can provide -- these come from parsing
CC stream-json output. The parser already handles `result` events but drops `rate_limit_event`
entirely, and neither cost nor model data is captured or surfaced.

## What Changes

- Parse `rate_limit_event` in `parser.rs` instead of dropping it -- extract utilization percentage,
  rateLimitType, and surpassedThreshold
- Parse `total_cost_usd` and `model` from `result` events in `parser.rs` -- accumulate per-session
  cost totals
- Add proto messages for rate limit and cost/model telemetry (`RateLimitInfo`, `SessionTelemetry`)
- Enrich `HealthResponse` with an optional `RateLimitInfo` field (latest across all sessions)
- Add `SessionTelemetry` fields to the `Session` proto message (cost, model, rate limit per session)
- Update TUI stream view status bar to display rate limit utilization and model info when available

## Impact

- Affected specs: status-telemetry (NEW capability)
- Affected code:
  - `proto/nexus.proto` -- new messages and fields
  - `crates/nexus-agent/src/parser.rs` -- parse rate_limit_event, extract cost/model from result
  - `crates/nexus-agent/src/grpc.rs` -- populate new fields in health/session responses
  - `crates/nexus-agent/src/registry.rs` -- store per-session telemetry
  - `crates/nexus-tui/src/screens/stream.rs` -- render rate limit and model in status bar
  - `crates/nexus-tui/src/app.rs` -- store telemetry data from gRPC responses
- Depends on: proto-and-codegen, agent-grpc-server, agent-health-and-ops (all complete)
- ~250 LOC estimated
