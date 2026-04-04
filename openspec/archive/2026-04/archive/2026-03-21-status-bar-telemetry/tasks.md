## 1. Proto Schema

- [ ] 1.1 Add `RateLimitInfo` message to `proto/nexus.proto` with fields: `float utilization_percent`, `string rate_limit_type`, `bool surpassed_threshold`
- [ ] 1.2 Add `SessionTelemetry` message to `proto/nexus.proto` with fields: `optional RateLimitInfo rate_limit`, `optional float total_cost_usd`, `optional string model`
- [ ] 1.3 Add `optional SessionTelemetry telemetry` field to the `Session` message in `proto/nexus.proto`
- [ ] 1.4 Add `optional RateLimitInfo latest_rate_limit` field to the `HealthResponse` message in `proto/nexus.proto`
- [ ] 1.5 Run proto codegen and verify generated Rust types compile: `cargo build -p nexus-core`

## 2. Agent Parser

- [ ] 2.1 Add `rate_limit_event` arm to `parse_stream_json_line` match in `crates/nexus-agent/src/parser.rs` -- extract `utilizationPercent`, `rateLimitType`, `surpassedThreshold` into a return struct
- [ ] 2.2 Extend `parse_result` in `crates/nexus-agent/src/parser.rs` to extract `total_cost_usd` (float) and `model` (string) from result events, returning them alongside the `CommandDone` message
- [ ] 2.3 Define a `ParsedTelemetry` struct (or similar) to carry side-channel telemetry data alongside `CommandOutput` from the parser
- [ ] 2.4 Add unit tests for rate_limit_event parsing (valid event, missing fields, unknown type)
- [ ] 2.5 Add unit tests for cost/model extraction from result events (present, absent, zero cost)

## 3. Registry Telemetry Storage

- [ ] 3.1 Add telemetry fields to the session model in `crates/nexus-core/src/session.rs` or registry: `latest_rate_limit`, `total_cost_usd`, `model`
- [ ] 3.2 Add `update_telemetry(session_id, telemetry)` method to `SessionRegistry` in `crates/nexus-agent/src/registry.rs`
- [ ] 3.3 Ensure telemetry is cleared when a session is removed (unregister/stop)

## 4. gRPC Integration

- [ ] 4.1 Update `session_to_proto` in `crates/nexus-agent/src/grpc.rs` to populate the `telemetry` field from registry data
- [ ] 4.2 Update `get_health` in `crates/nexus-agent/src/grpc.rs` to populate `latest_rate_limit` from the most recent rate limit event across sessions
- [ ] 4.3 Update the `SendCommand` stream loop in `crates/nexus-agent/src/grpc.rs` to call `registry.update_telemetry()` when the parser returns rate limit or cost data

## 5. TUI Status Bar

- [ ] 5.1 Store session telemetry in the TUI `StreamView` or `App` struct (from session data received via gRPC)
- [ ] 5.2 Update `render_status_bar` in `crates/nexus-tui/src/screens/stream.rs` to display model name, rate limit %, and cost when available
- [ ] 5.3 Add color coding for rate limit utilization: green < 50%, yellow 50-79%, red 80%+
- [ ] 5.4 Verify status bar renders correctly with no telemetry, partial telemetry, and full telemetry
