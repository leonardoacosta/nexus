# Design: Cross-Language Type Codegen Bridge

## Architecture Decision: Proto as Source of Truth

### Context
Nexus has three type definition sites: Rust domain structs (serde), proto messages (tonic-prost), and TS interfaces (hand-written + Zod). The Rust build already generates Rust types from proto via `tonic-prost-build` in `crates/nexus-core/build.rs`. The TS side has no codegen -- types are manually maintained.

### Decision
Extend the existing proto-first pattern to TypeScript. Proto defines the wire schema; Rust domain types remain separate (richer, with methods) but are kept in sync via `proto_convert.rs` From impls; TS types are generated directly from proto.

### Why Not Just Align Manually?
Manual alignment has already drifted 3 times (Session, Health, Config). A codegen pipeline makes drift a CI failure rather than a runtime surprise.

## Proto Schema Changes

### Session Message (Additive)
```protobuf
message Session {
  // ... existing fields 1-16 ...
  optional string machine = 17;           // NEW: machine provenance
  optional google.protobuf.Timestamp ended_at = 18;  // NEW: when session ended
}
```
Field numbers 17-18 are additive -- existing clients ignore unknown fields. No wire-format break.

### MachineHealth Message (Breaking Restructure)
```protobuf
// NEW sub-messages
message CpuInfo {
  float overall_percent = 1;
  repeated float per_core_percent = 2;
  repeated float load_average = 3;
}

message RamInfo {
  uint64 total_bytes = 1;
  uint64 used_bytes = 2;
  float percent = 3;
}

message DiskInfo {
  string mount = 1;
  uint64 total_bytes = 2;
  uint64 used_bytes = 3;
  float percent = 4;
}

message DockerInfo {
  uint32 containers = 1;
  uint32 running = 2;
}

message NetworkInfo {
  string iface = 1;
  uint64 rx_bytes = 2;
  uint64 tx_bytes = 3;
}

message ProcessInfo {
  uint32 pid = 1;
  string name = 2;
  float cpu_percent = 3;
  float ram_percent = 4;
}

message ProcessSnapshot {
  repeated ProcessInfo top_cpu = 1;
  repeated ProcessInfo top_ram = 2;
}

// RESTRUCTURED (breaking field number changes)
message MachineHealth {
  string hostname = 1;
  uint64 uptime_seconds = 2;
  CpuInfo cpu = 3;
  RamInfo ram = 4;
  repeated DiskInfo disks = 5;
  optional DockerInfo docker = 6;
  repeated NetworkInfo network = 7;
  optional ProcessSnapshot processes = 8;
  optional google.protobuf.Timestamp collected_at = 9;
}
```

This is a **breaking change** to `MachineHealth` field numbers. Safe because:
1. All gRPC consumers are internal (nexus-tui, nexus-register)
2. All crates are in the same workspace -- single coordinated release
3. Health data is ephemeral (no persisted proto bytes to migrate)

### Alternative Considered: Additive-Only Health Changes
Could keep old flat fields and add new nested ones. Rejected because the old flat representation is fundamentally lossy (aggregates multi-disk into single value, loses hostname, loses per-core) and maintaining both paths doubles proto_convert complexity.

## TS Codegen Tool Selection

### ts-proto (Recommended)
- Generates idiomatic TS interfaces (not classes)
- Produces `DeepPartial` types useful for testing
- Handles `optional` proto3 fields correctly
- Active maintenance, 5k+ GitHub stars
- No runtime dependency (pure type generation mode)

### buf (Alternative)
- Schema registry + linting + breaking change detection
- Heavier setup (buf.yaml, buf.gen.yaml)
- Overkill for a single proto file with internal consumers only

### Decision: ts-proto
Simpler setup, idiomatic output, no runtime overhead. Can migrate to buf later if proto surface grows.

## Config Alignment Strategy

Config is TOML-based, not proto-serialized. Proto codegen does not apply. Instead:
1. Align field optionality between Rust serde and TS Zod schemas
2. Add `projects_dir: Option<String>` to Rust `AgentConfig`
3. Make `self_name` consistently optional in both (Rust already is; TS Zod needs `.optional()`)
4. Make `user` optional in Rust to match TS (some agents may not need SSH user)
5. Shared fixture test prevents future drift

## File Impact Map

```
proto/nexus.proto                          MODIFY  Add Session fields, restructure MachineHealth
crates/nexus-core/build.rs                 NO CHANGE (already compiles proto)
crates/nexus-core/src/session.rs           MODIFY  Add machine, ended_at fields
crates/nexus-core/src/health.rs            MODIFY  Add network, processes, collected_at
crates/nexus-core/src/config.rs            MODIFY  Make user optional, add projects_dir
crates/nexus-core/src/proto_convert.rs     MODIFY  Update all From impls
packages/core/src/types/session.ts         REPLACE Re-export from generated
packages/core/src/types/health.ts          REPLACE Re-export from generated
packages/core/src/config.ts                MODIFY  Align Zod schema
packages/core/src/index.ts                 MODIFY  Update exports
packages/core/src/generated/               CREATE  Generated TS types
package.json                               MODIFY  Add proto:codegen script
tests/fixtures/agents.toml                 CREATE  Shared config fixture
```
