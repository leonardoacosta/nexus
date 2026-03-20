## ADDED Requirements

### Requirement: Protobuf Service Definition

The system SHALL define a `NexusAgent` gRPC service in `proto/nexus.proto` under package
`nexus.v1` with the following RPCs:

- `GetSessions(SessionFilter) returns (SessionList)` — list sessions with optional filtering
- `GetSession(SessionId) returns (Session)` — get a single session by ID
- `StartSession(StartSessionRequest) returns (StartSessionResponse)` — register a new session
- `StreamEvents(EventFilter) returns (stream SessionEvent)` — server-streaming session events
- `StopSession(SessionId) returns (StopResult)` — deregister a session

#### Scenario: Proto file defines all RPCs
- **WHEN** the proto file is compiled with protoc or tonic-build
- **THEN** it SHALL produce Rust server and client stubs for all five RPCs
- **AND** each RPC SHALL have correctly typed request and response messages

### Requirement: Protobuf Message Types

The system SHALL define the following protobuf messages in `proto/nexus.proto`:

- `Session` — full session state including id, pid, project, cwd, branch, timestamps, status, type, spec, command, agent, tmux_session
- `SessionStatus` enum — UNKNOWN, ACTIVE, IDLE, STALE, ERRORED
- `SessionType` enum — SESSION_TYPE_UNSPECIFIED, MANAGED, AD_HOC
- `SessionId` — wrapper for session ID string
- `SessionFilter` — optional filters for status, project, session_type
- `SessionList` — repeated Session with agent metadata
- `StartSessionRequest` — fields for pid, cwd, project, branch, tmux_session, session_type
- `StartSessionResponse` — created session
- `StopResult` — boolean success with optional message
- `EventFilter` — optional session_id and event type filters
- `SessionEvent` — timestamp plus oneof payload: SessionStarted, HeartbeatReceived, StatusChanged, SessionStopped
- `MachineHealth` — cpu, memory, disk, load averages, uptime, docker containers
- `HealthResponse` — agent metadata with machine health

#### Scenario: Messages cover all session lifecycle fields
- **WHEN** a Session message is populated with all fields from the existing Session struct
- **THEN** no information SHALL be lost in the protobuf representation
- **AND** SessionType SHALL distinguish MANAGED (tmux-wrapped) from AD_HOC (discovered) sessions

#### Scenario: SessionEvent payload is exhaustive
- **WHEN** a SessionEvent is received
- **THEN** the oneof payload SHALL be one of: SessionStarted, HeartbeatReceived, StatusChanged, SessionStopped
- **AND** each variant SHALL carry the relevant session data for that event type

### Requirement: Tonic/Prost Code Generation

The system SHALL configure `crates/nexus-core/build.rs` to compile `proto/nexus.proto`
using tonic-build and prost-build, generating Rust types and gRPC stubs at build time.

#### Scenario: Build generates protobuf module
- **WHEN** `cargo build -p nexus-core` is executed
- **THEN** the build SHALL succeed and produce generated Rust types in `OUT_DIR`
- **AND** the types SHALL be accessible via `nexus_core::proto`

#### Scenario: Workspace dependencies are configured
- **WHEN** tonic, prost, tonic-build, and prost-build are added to workspace dependencies
- **THEN** `crates/nexus-core/Cargo.toml` SHALL reference them via `workspace = true`
- **AND** tonic-build SHALL be listed under `[build-dependencies]`

### Requirement: Coexistence with Existing Types

The system SHALL preserve all existing serde types in `session.rs`, `api.rs`, `health.rs`,
and `agent.rs` without modification. The generated protobuf types SHALL exist alongside
them in the `nexus_core::proto` module.

#### Scenario: Existing types are unchanged
- **WHEN** the proto-and-codegen change is applied
- **THEN** `nexus_core::session::Session`, `nexus_core::api::SessionEvent`, and all other existing types SHALL compile and behave identically to before
- **AND** no existing module SHALL be modified except `lib.rs` (to add the proto module)
