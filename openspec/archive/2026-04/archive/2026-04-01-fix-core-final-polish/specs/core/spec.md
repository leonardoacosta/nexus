# Spec Delta: core

## MODIFIED Requirements

### Requirement: Collapsible if in lifecycle.rs
The nested `if *comp == "dev" { if let Some(project) = ... }` pattern at lifecycle.rs:227 SHALL be combined into a single let-chain expression.

#### Scenario: extract_project_from_path with dev component
- **GIVEN** a path containing a `dev` component followed by a project name
- **WHEN** `extract_project_from_path` processes the path
- **THEN** it returns the project name (behavior unchanged, only syntax cleanup)

### Requirement: Delete vestigial api.rs
The `api` module SHALL be removed from nexus-core entirely. The single `HealthResponse` struct MUST move to the HTTP handler that uses it.

#### Scenario: HTTP health endpoint returns HealthResponse
- **GIVEN** the agent HTTP server is running
- **WHEN** a client sends GET /health
- **THEN** it receives a JSON response with agent_name, agent_host, uptime_seconds, session_count, and machine fields (behavior unchanged, struct is now handler-local)

### Requirement: SocketCommand gains Serialize
`SocketCommand` SHALL derive `Serialize` for symmetry with `SocketEvent` and to enable payload logging.

#### Scenario: SocketCommand round-trips through serde
- **GIVEN** a `SocketCommand::ModeSet { mode: "silent" }` instance
- **WHEN** serialized to JSON and deserialized back
- **THEN** the resulting value equals the original

## ADDED Requirements

### Requirement: Typed SocketResponse enum
A `SocketResponse` enum SHALL be defined in `socket_event.rs` with variants covering all 7 command response shapes. The agent MUST serialize `SocketResponse` at the socket write boundary instead of returning raw `String`.

#### Scenario: ModeQuery returns typed response
- **GIVEN** a connected socket client sends a `mode_query` command
- **WHEN** the agent processes it
- **THEN** the response deserializes as `SocketResponse::ModeQuery { mode: String }`

#### Scenario: History returns typed response with entries
- **GIVEN** a connected socket client sends a `history` command with limit 5
- **WHEN** the agent processes it
- **THEN** the response deserializes as `SocketResponse::History { entries: Vec<HistoryEntry> }`

### Requirement: Proto cost field uses double precision
The `total_cost_usd` field in proto `SessionTelemetry` SHALL be changed from `float` (32-bit) to `double` (64-bit) to match the domain model's f64 and eliminate precision loss during conversion.

#### Scenario: Cost value round-trips without precision loss
- **GIVEN** a session with `total_cost_usd = 0.123456789012345_f64`
- **WHEN** converted to proto and back
- **THEN** the resulting f64 equals the original (no f32 truncation)

### Requirement: AgentInfo split into identity and snapshot
`AgentInfo` SHALL be split into `AgentIdentity` (static fields: name, host, port, os) and `AgentSnapshot` (identity + dynamic state: sessions, health, connected).

#### Scenario: TUI constructs AgentSnapshot from gRPC response
- **GIVEN** a gRPC response with agent name, host, sessions, and health
- **WHEN** the TUI client builds the local model
- **THEN** it creates an `AgentSnapshot` containing an `AgentIdentity` and the session/health data

#### Scenario: Detail screen accesses agent identity fields
- **GIVEN** an `AgentSnapshot` passed to the detail screen
- **WHEN** rendering agent name and host
- **THEN** it accesses `snapshot.identity.name` and `snapshot.identity.host`
