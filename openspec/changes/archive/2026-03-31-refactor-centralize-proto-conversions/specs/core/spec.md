## ADDED Requirements

### Requirement: Canonical Proto-Domain Conversions
The system SHALL provide `From` trait implementations in nexus-core for converting between domain types and proto types. Conversions SHALL cover `Session`, `MachineHealth`, `SessionStatus`, `CommandInfo`, and timestamp types. All fields SHALL be mapped correctly without silent data loss.

#### Scenario: Session round-trip preserves all fields
- **WHEN** a `Session` with `session_type: Worktree` and `tmux_target: Some("main:0")` is converted to `proto::Session` and back
- **THEN** the resulting `Session` has `session_type: Worktree` and `tmux_target: Some("main:0")`

#### Scenario: SessionStatus maps to proto enum variants
- **WHEN** a `SessionStatus::Stale` is converted to proto and back
- **THEN** the result is `SessionStatus::Stale` (not a raw i32 match)

#### Scenario: MachineHealth round-trip preserves health data
- **WHEN** a `MachineHealth` with docker containers and load averages is converted to proto and back
- **THEN** all fields including `docker_containers` and `load_avg` are preserved

### Requirement: No Duplicate Conversions Outside nexus-core
The agent and TUI crates SHALL NOT contain proto-domain conversion functions. All conversion logic SHALL live in nexus-core and be invoked via `From`/`Into` traits.

#### Scenario: Agent uses core conversions
- **WHEN** the agent serializes a session for gRPC response
- **THEN** it calls `proto::Session::from(session)` from nexus-core, not a local helper

#### Scenario: TUI uses core conversions
- **WHEN** the TUI deserializes a session from gRPC response
- **THEN** it calls `Session::from(proto_session)` from nexus-core, not a local helper
