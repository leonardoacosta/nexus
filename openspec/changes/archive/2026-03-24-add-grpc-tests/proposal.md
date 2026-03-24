# Change: Add gRPC Integration Tests

## Why

No integration tests means regressions are caught only by manual testing. The gRPC API is the primary contract between agent, TUI, and Nova — it must be tested end-to-end. Currently all 32 tests are unit tests with zero integration coverage.

## What Changes

- New integration test file at `crates/nexus-agent/tests/grpc_integration.rs`
- New shared test harness at `crates/nexus-agent/tests/common/mod.rs`
- Possible dev-dependency additions in `crates/nexus-agent/Cargo.toml` (tokio-test, etc.)
- Tests exercise every RPC: GetSessions, GetSession, RegisterSession, UnregisterSession, Heartbeat, StreamEvents, SendCommand, StopSession, GetHealth, ListAgents, ListProjects
- Each RPC gets at least one success-path and one error-path test
- Tests run with `cargo test --test grpc_integration`

## Impact

- Affected specs: none (additive test coverage only)
- Affected code: `crates/nexus-agent/tests/` (new), `crates/nexus-agent/Cargo.toml` (dev-deps)
