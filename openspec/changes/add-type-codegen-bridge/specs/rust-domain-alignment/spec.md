# Spec Delta: Rust Domain Type Alignment

## MODIFIED Requirements

### Requirement: Session Struct Matches Proto
The Rust `Session` struct in `nexus-core` MUST include all fields defined in the proto `Session` message so that `proto_convert.rs` mappings are lossless.

#### Scenario: Session struct has machine field
- **Given** the Rust `Session` struct
- **When** inspected
- **Then** it has `pub machine: Option<String>` field

#### Scenario: Session struct has ended_at field
- **Given** the Rust `Session` struct
- **When** inspected
- **Then** it has `pub ended_at: Option<DateTime<Utc>>` field

#### Scenario: proto_convert round-trip preserves new fields
- **Given** a Session with `machine = Some("homelab")` and `ended_at = Some(now)`
- **When** converted to `proto::Session` and back
- **Then** both fields are preserved exactly

### Requirement: MachineHealth Struct Extended
The Rust `MachineHealth` struct MUST include `network` and `processes` fields matching the TS `HealthMetrics` and the updated proto schema.

#### Scenario: MachineHealth has network field
- **Given** the Rust `MachineHealth` struct
- **When** inspected
- **Then** it has `pub network: Option<Vec<NetworkInterface>>` field

#### Scenario: MachineHealth has processes field
- **Given** the Rust `MachineHealth` struct
- **When** inspected
- **Then** it has `pub processes: Option<ProcessSnapshot>` field

#### Scenario: MachineHealth has collected_at field
- **Given** the Rust `MachineHealth` struct
- **When** inspected
- **Then** it has `pub collected_at: Option<DateTime<Utc>>` field
