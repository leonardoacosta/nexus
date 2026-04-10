# Capability: cleanup

## REMOVED Requirements

### Requirement: Remove dead Rust crates
The Rust crates `nexus-register` and `nexus-mcp` are removed. They cannot compile (no Cargo workspace root) and are superseded by Bun implementations. The empty `crates/archive/` directory is also removed.

#### Scenario: Deleting broken Rust crates
- Given the crates at `crates/nexus-register/` and `crates/nexus-mcp/` reference `workspace = true` with no workspace root
- When the cleanup batch runs
- Then both directories are deleted along with `crates/archive/`

### Requirement: Remove generated protobuf
The generated protobuf at `packages/core/src/generated/nexus.ts` (7,733 LOC) is removed. It has zero import consumers. The `proto/` directory and `proto:codegen` script are also removed.

#### Scenario: Deleting unused protobuf
- Given `ProtoSession` and `ProtoMachineHealth` have zero import sites outside their re-export
- When the cleanup batch runs
- Then `packages/core/src/generated/` and `proto/` are deleted
- And the `proto:codegen` script is removed from root `package.json`
- And the re-exports from `packages/core/src/types/` are removed

## ADDED Requirements

### Requirement: Bun nexus-status replacement
The system SHALL provide a Bun implementation of the `nexus-status` binary to replace the broken Rust crate. It MUST fetch session and API usage data from the agent HTTP API and render a compact statusline string.

#### Scenario: Statusline renders session summary
- Given the agent is running on localhost:7400
- When nexus-status is invoked
- Then it fetches `/sessions` and `/analytics/api-usage` with `NEXUS_ATTACH_SECRET` header
- And renders a one-line statusline string with session count, active project, and credit usage
