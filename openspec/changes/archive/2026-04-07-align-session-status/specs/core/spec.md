## MODIFIED Requirements

### Requirement: Canonical Proto-Domain Conversions
The system SHALL provide `From` trait implementations in nexus-core for converting between domain
types and proto types. Conversions SHALL cover `Session`, `MachineHealth`, `SessionStatus`,
`CommandInfo`, and timestamp types. All fields SHALL be mapped correctly without silent data loss.
The `SessionStatus` proto enum SHALL include an `ENDED` variant that maps to and from
`SessionStatus::Ended`.

#### Scenario: Session round-trip preserves all fields
- **WHEN** a `Session` with `session_type: Worktree` and `tmux_target: Some("main:0")` is converted to `proto::Session` and back
- **THEN** the resulting `Session` has `session_type: Worktree` and `tmux_target: Some("main:0")`

#### Scenario: SessionStatus maps to proto enum variants
- **WHEN** a `SessionStatus::Stale` is converted to proto and back
- **THEN** the result is `SessionStatus::Stale` (not a raw i32 match)

#### Scenario: SessionStatus::Ended maps to proto ENDED
- **WHEN** a `SessionStatus::Ended` is converted to `proto::SessionStatus`
- **THEN** the result is `proto::SessionStatus::Ended`

#### Scenario: proto ENDED maps to SessionStatus::Ended
- **WHEN** a `proto::SessionStatus::Ended` is converted to `SessionStatus`
- **THEN** the result is `SessionStatus::Ended`

#### Scenario: MachineHealth round-trip preserves health data
- **WHEN** a `MachineHealth` with docker containers and load averages is converted to proto and back
- **THEN** all fields including `docker_containers` and `load_avg` are preserved

## ADDED Requirements

### Requirement: SessionStatus MUST include an Ended variant
The `SessionStatus` enum in `nexus-core/src/session.rs` SHALL include an `Ended` variant. The
variant MUST serialize to `"ended"` via serde (using the existing `#[serde(rename_all =
"snake_case")]` attribute). All match arms on `SessionStatus` throughout the workspace MUST be
exhaustive, covering `Active`, `Idle`, `Stale`, `Errored`, and `Ended`.

#### Scenario: Ended serializes to "ended"
- **WHEN** a `Session` with `status: SessionStatus::Ended` is serialized to JSON
- **THEN** the `status` field value is `"ended"`

#### Scenario: "ended" deserializes to Ended
- **WHEN** a JSON payload with `"status": "ended"` is deserialized into `SessionStatus`
- **THEN** the result is `SessionStatus::Ended`

#### Scenario: Non-exhaustive match is a compile error
- **WHEN** a `match session.status` block does not include an `Ended` arm
- **THEN** the Rust compiler produces an error before the binary is built

### Requirement: SessionType MUST serialize via Display not Debug
The `SessionType` enum SHALL implement `std::fmt::Display` producing `"ad_hoc"`, `"managed"`, or
`"pooled"`. Database and API serialization of `session_type` SHALL use this `Display`
implementation. The `{:?}` debug format SHALL NOT be used for serialization.

#### Scenario: Display produces ad_hoc not adhoc
- **WHEN** `format!("{}", SessionType::AdHoc)` is evaluated
- **THEN** the result is `"ad_hoc"`

#### Scenario: Managed Display
- **WHEN** `format!("{}", SessionType::Managed)` is evaluated
- **THEN** the result is `"managed"`

#### Scenario: DB write uses Display value
- **WHEN** a session with `session_type = SessionType::AdHoc` is written to the database
- **THEN** the stored value is `"ad_hoc"`, not `"AdHoc"` or `"adhoc"`
