## ADDED Requirements

### Requirement: gRPC Session Listing

The nexus-agent SHALL expose a `GetSessions` gRPC RPC that returns all sessions currently tracked
in the session registry. Each session in the response SHALL include the session ID, PID, project
name, working directory, branch, status, start time, and last heartbeat time.

#### Scenario: Agent returns all tracked sessions

- **WHEN** a TUI client calls `GetSessions` with an empty request
- **THEN** the agent returns a `GetSessionsResponse` containing all sessions in the registry
- **AND** each session includes all required fields populated from the registry

#### Scenario: Agent returns empty list when no sessions exist

- **WHEN** a TUI client calls `GetSessions` and the registry is empty
- **THEN** the agent returns a `GetSessionsResponse` with an empty sessions list

### Requirement: gRPC Single Session Lookup

The nexus-agent SHALL expose a `GetSession` gRPC RPC that returns a single session by ID.
The RPC SHALL return a `NOT_FOUND` gRPC status code if the requested session ID does not exist
in the registry.

#### Scenario: Agent returns a single session by ID

- **WHEN** a TUI client calls `GetSession` with a valid session ID
- **THEN** the agent returns a `GetSessionResponse` containing the matching session

#### Scenario: Agent returns NOT_FOUND for unknown session ID

- **WHEN** a TUI client calls `GetSession` with an ID not in the registry
- **THEN** the agent returns a gRPC `NOT_FOUND` status with a descriptive error message

### Requirement: Session File Watching

The nexus-agent SHALL watch `sessions.json` files written by claude-daemon using the `notify`
crate for cross-platform filesystem event detection (inotify on Linux, FSEvents on macOS).
When a sessions.json file is created, modified, or removed, the agent SHALL update the session
registry accordingly. File change events SHALL be debounced with a 100ms window to prevent
redundant processing.

#### Scenario: Sessions loaded on file change

- **WHEN** sessions.json is written or modified on disk
- **THEN** the agent parses the file and upserts all sessions into the registry
- **AND** all file-discovered sessions are marked as `SessionType::AdHoc`

#### Scenario: File watcher handles missing file gracefully

- **WHEN** sessions.json does not exist at startup or is deleted
- **THEN** the agent logs a warning and continues with an empty registry
- **AND** the watcher remains active to detect future file creation

#### Scenario: File watcher handles parse errors gracefully

- **WHEN** sessions.json contains invalid JSON
- **THEN** the agent logs a warning with the parse error details
- **AND** the existing registry contents are preserved (not cleared)

### Requirement: Session Registry

The nexus-agent SHALL maintain an in-memory session registry using
`tokio::sync::RwLock<HashMap<String, Session>>`. The registry SHALL support concurrent read
access from the gRPC service and write access from the file watcher. The registry SHALL be
shared between components via `Arc<SessionRegistry>`.

#### Scenario: Concurrent read and write access

- **WHEN** the gRPC service reads sessions while the file watcher is updating
- **THEN** readers receive a consistent snapshot (no partial updates visible)
- **AND** no deadlocks occur under concurrent access

#### Scenario: Stale session cleanup

- **WHEN** a session's last heartbeat exceeds the configured threshold
- **THEN** the registry removes the stale session on the next cleanup pass

### Requirement: gRPC Server Startup

The nexus-agent SHALL start a tonic gRPC server bound to `0.0.0.0:7400` during initialization.
The server SHALL register the `NexusAgent` gRPC service and support graceful shutdown via
SIGINT/SIGTERM signals.

#### Scenario: Agent starts gRPC server on configured port

- **WHEN** the nexus-agent binary is launched
- **THEN** a gRPC server starts listening on `0.0.0.0:7400`
- **AND** the `NexusAgent` service is registered and accepting connections

#### Scenario: Agent shuts down gracefully on signal

- **WHEN** the agent receives SIGINT or SIGTERM
- **THEN** the gRPC server stops accepting new connections
- **AND** in-flight RPCs are allowed to complete before the process exits
