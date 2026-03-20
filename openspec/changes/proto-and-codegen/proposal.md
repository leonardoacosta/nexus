# Change: Add protobuf definitions and tonic/prost codegen

## Why

Nexus currently uses hand-written serde types and JSON over HTTP/WebSocket. The PRD
specifies gRPC as the wire protocol between agents and the TUI. This spec lays the
foundation by defining all protobuf messages and the NexusAgent gRPC service, plus
configuring tonic/prost codegen in nexus-core so downstream specs (agent-grpc-server,
tui-grpc-client) can import generated Rust types directly.

## What Changes

- Add `proto/nexus.proto` at workspace root with all message and service definitions
- Add tonic, prost, tonic-build, prost-build to workspace `Cargo.toml` dependencies
- Add `crates/nexus-core/build.rs` to run prost/tonic codegen at build time
- Update `crates/nexus-core/Cargo.toml` with tonic + prost deps and build-dependencies
- Update `crates/nexus-core/src/lib.rs` to re-export the generated protobuf module
- Existing serde types in session.rs, api.rs, health.rs are NOT modified (coexistence until spec 3/4)

## Impact

- Affected specs: grpc-transport (NEW capability)
- Affected code: `proto/`, `crates/nexus-core/` (build.rs, Cargo.toml, lib.rs), workspace `Cargo.toml`
- No breaking changes — additive only, existing serde types untouched
- Phase 1, Wave 1 — no dependencies on other specs
- Depended on by: spec 3 (agent-grpc-server), spec 4 (tui-grpc-client)
