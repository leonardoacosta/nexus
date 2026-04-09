# Spec Delta: Proto Schema Alignment

## MODIFIED Requirements

### Requirement: Session Message Completeness
The proto `Session` message MUST carry all fields present in the DB schema and TS interface so that gRPC round-trips preserve full session data.

#### Scenario: Session with machine provenance round-trips through gRPC
- **Given** a Session with `machine = "homelab"` and `ended_at = "2026-04-08T12:00:00Z"`
- **When** the session is serialized to proto and deserialized back
- **Then** `machine` equals `"homelab"` and `ended_at` equals the original timestamp

#### Scenario: Session without ended_at serializes correctly
- **Given** a Session where `ended_at` is null (still active)
- **When** serialized to proto
- **Then** the `ended_at` field is absent (proto optional semantics)

### Requirement: MachineHealth Structured Representation
The proto `MachineHealth` message MUST use nested sub-messages matching the Rust domain model to eliminate lossy GB-aggregation and support multi-disk, per-core CPU, and hostname fields.

#### Scenario: Multi-disk health data round-trips without aggregation loss
- **Given** a MachineHealth with two disk entries (`/` at 100GB/500GB, `/data` at 200GB/1TB)
- **When** serialized to proto and deserialized back
- **Then** both disk entries are preserved with their individual mount points and byte counts

#### Scenario: Per-core CPU data preserved
- **Given** a MachineHealth with `per_core_percent = [40.0, 51.0, 38.0, 45.0]`
- **When** round-tripped through proto
- **Then** all four per-core values are preserved

#### Scenario: Network and process info included when available
- **Given** a MachineHealth with network interface stats and top-5 CPU processes
- **When** serialized to proto
- **Then** `network` and `processes` sub-messages contain the data

## ADDED Requirements

### Requirement: Proto Sub-Messages for Health
New proto messages `CpuInfo`, `RamInfo`, `DiskInfo`, `NetworkInfo`, `ProcessInfo` MUST be defined to match the Rust health domain types.

#### Scenario: CpuInfo contains all fields
- **Given** the proto schema
- **When** `CpuInfo` message is inspected
- **Then** it has `overall_percent`, `per_core_percent` (repeated), and `load_average` (repeated) fields

#### Scenario: DiskInfo is repeated in MachineHealth
- **Given** the proto schema
- **When** `MachineHealth` is inspected
- **Then** `disks` is a `repeated DiskInfo` field (not aggregated scalars)
