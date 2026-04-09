# Proposal: Cross-Language Type Codegen Bridge

## Change ID
`add-type-codegen-bridge`

## Summary
Adopt `proto/nexus.proto` as the single source of truth for all shared types (Session, HealthMetrics, Config), add TS codegen from proto, and align all Rust domain types and TS interfaces to the proto schema -- eliminating triple-source type drift that silently drops fields across language boundaries.

## Context
- Extends: `proto/nexus.proto`, `crates/nexus-core/src/session.rs`, `crates/nexus-core/src/health.rs`, `crates/nexus-core/src/config.rs`, `crates/nexus-core/src/proto_convert.rs`, `packages/core/src/types/session.ts`, `packages/core/src/types/health.ts`, `packages/core/src/config.ts`, `packages/db/src/schema/sessions.ts`
- Related: `unify-health-schema` (completed -- made TS the health storage authority but did not address proto/Rust schema gaps), `fix-health-scheduler` (completed)

## Motivation
The code audit found four independent type divergences where Session, HealthMetrics, and Config definitions have drifted across Rust, Proto, and TypeScript. The Rust `Session` struct and proto `Session` message are both missing `machine` and `ended_at` fields that the TS interface and DB schema carry. The proto `MachineHealth` message uses a flat GB-based representation while Rust `MachineHealth` uses a structured bytes-based model with `hostname`, `per_core_percent`, and multi-disk support -- causing lossy round-trips through the proto conversion layer (see `proto_convert.rs:199-298`). The `AgentConfig` has `user: String` (required) in Rust but `z.string().optional()` in TS, and `projects_dir` exists only in TS. `NexusConfig.self_name` is `Option<String>` in Rust but `z.string()` (required) in TS Zod. These mismatches mean sessions flowing through gRPC silently lose machine provenance, health data cannot round-trip without precision loss, and valid TS-parsed agents.toml can fail Rust deserialization (or vice versa).

## Requirements

### Req-1: Proto as Single Source of Truth
Proto definitions in `proto/nexus.proto` become the canonical schema for all shared types. Both Rust (via tonic-prost codegen) and TS (via new codegen pipeline) derive their wire types from proto. Manual TS interface definitions for proto-covered types are replaced by generated code.

### Req-2: Session Schema Alignment
Add `machine` and `ended_at` fields to the proto `Session` message and the Rust `Session` domain struct. Update `proto_convert.rs` to map these fields. Verify DB schema already carries both columns (it does). Ensure gRPC round-trips preserve machine provenance.

### Req-3: Health Schema Alignment
Restructure the proto `MachineHealth` message to match the Rust domain model's structured representation (nested `cpu`, `ram`, `disk[]`, `docker`, `hostname`). This eliminates the lossy GB-aggregation in `proto_convert.rs` and supports multi-disk, per-core, and hostname fields. Add `network` and `processes` sub-messages to match the TS `HealthMetrics` fields. Add `collected_at` timestamp.

### Req-4: Config Schema Unification
Align `AgentConfig` across Rust and TS: make `user` optional in Rust (or required in TS -- match the stricter contract), add `projects_dir` to Rust. Align `NexusConfig.self_name` optionality. Config is TOML-based (not proto-serialized), so alignment is convention-enforced, not codegen-enforced, but a shared schema test validates both parsers accept the same input.

### Req-5: TS Codegen Pipeline
Add a codegen step that generates TypeScript types from `proto/nexus.proto`. Evaluate `ts-proto` (generates idiomatic TS interfaces) or `buf` (schema registry + multi-language codegen). Generated types replace hand-written interfaces in `packages/core/src/types/session.ts` and `packages/core/src/types/health.ts`. A `proto:codegen` script in package.json runs the pipeline.

## Scope
- **IN**: Proto schema updates (Session, MachineHealth, new sub-messages), Rust domain struct alignment, proto_convert.rs updates, TS codegen pipeline setup, replacement of hand-written TS types with generated types, config field alignment, shared config validation test
- **OUT**: gRPC transport changes (TS agent stays HTTP -- no gRPC client), DB migration (DB schema already has the fields), notification or TUI types (not shared cross-language), proto schema registry / buf.build hosting, breaking wire format changes to existing gRPC RPCs (additive only)

## Impact
| Area | Change |
|------|--------|
| `proto/nexus.proto` | Add `machine`, `ended_at` to Session; restructure MachineHealth with nested messages; add CpuInfo, RamInfo, DiskInfo, NetworkInfo, ProcessInfo messages |
| `crates/nexus-core/src/session.rs` | Add `machine: Option<String>`, `ended_at: Option<DateTime<Utc>>` |
| `crates/nexus-core/src/proto_convert.rs` | Update Session and MachineHealth conversions for new fields/structure |
| `crates/nexus-core/src/config.rs` | Make `user` optional, add `projects_dir` to AgentConfig |
| `crates/nexus-core/src/health.rs` | Add `network`, `processes`, `collected_at` fields |
| `packages/core/src/types/session.ts` | Replace with codegen output |
| `packages/core/src/types/health.ts` | Replace with codegen output |
| `packages/core/src/config.ts` | Align Zod schema: `self_name` optional, `user` required or both optional |
| `packages/core/src/index.ts` | Update re-exports for generated types |
| Build pipeline | Add `proto:codegen` script, codegen dev dependency |

## Risks
| Risk | Mitigation |
|------|-----------|
| Proto MachineHealth restructure is a breaking wire change for gRPC clients | All gRPC clients are internal (nexus-tui, nexus-register). Coordinate version bump across all crates in single release. |
| ts-proto / buf codegen adds build complexity | Keep codegen in a single script; CI runs `proto:codegen --check` to verify generated files are up-to-date |
| Config alignment may break existing agents.toml files | Make changes additive (new fields optional with defaults); test both Rust and TS parsers against the same fixture TOML |
| Health proto restructure requires proto_convert.rs rewrite | Existing round-trip tests in proto_convert.rs provide safety net; add new tests for structured fields |
