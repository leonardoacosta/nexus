## Context

Nexus needs gRPC as its transport layer between agents and TUI. This spec introduces
protobuf definitions and code generation only — no runtime server or client changes.
The generated Rust types will coexist alongside the existing hand-written serde types
until specs 3 and 4 migrate the agent and TUI respectively.

## Goals / Non-Goals

- Goals:
  - Define the canonical `.proto` file for all Nexus gRPC operations
  - Configure tonic/prost codegen so `cargo build` produces Rust types automatically
  - Make generated types available via `nexus_core::proto`
- Non-Goals:
  - Implementing gRPC server or client (spec 3 and 4)
  - Replacing existing serde types (spec 3 and 4)
  - Health HTTP endpoint changes (stays JSON)

## Decisions

- **Proto file location**: `proto/nexus.proto` at workspace root (not inside a crate).
  Shared by all crates; build.rs uses `../..` relative path or `CARGO_MANIFEST_DIR` parent.
  - Alternative: inside `crates/nexus-core/proto/` — rejected because agent and TUI crates
    may also need direct proto access for custom codegen in the future.

- **Package name**: `nexus.v1` — versioned from the start to allow future `v2` without
  breaking existing clients.

- **Codegen in nexus-core only**: The `build.rs` lives in nexus-core. Other crates consume
  generated types via `nexus-core` dependency (already in place). No duplicate codegen.

- **SessionType enum**: `MANAGED` (tmux-wrapped, full attach) vs `AD_HOC` (stream-only).
  Maps to whether the session was started via nexus or discovered externally.

- **SessionEvent oneof**: Uses protobuf `oneof payload` with typed inner messages rather
  than a generic string. This gives compile-time exhaustiveness in match arms.

- **Coexistence with serde types**: Both type systems exist in nexus-core simultaneously.
  No conversion traits yet — those come in spec 3/4 when the agent/TUI migrate.

## Risks / Trade-offs

- **Build time increase**: prost-build + tonic-build add ~5-10s to clean builds.
  Acceptable for a workspace this size. Incremental builds are unaffected unless .proto changes.
- **Proto drift from serde types**: Until spec 3/4 merge the types, the proto definitions
  and serde structs can diverge. Mitigated by spec ordering (3 and 4 immediately follow).

## Open Questions

- None — all decisions resolved in PRD and this design.
