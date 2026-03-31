## MODIFIED Requirements

### Requirement: Context Structs for Too-Many-Arguments Functions
Functions exceeding clippy's 7-argument threshold SHALL have their parameters bundled into dedicated context structs.

#### Scenario: run_socket_service accepts SocketContext
- **GIVEN** the refactored `run_socket_service` function
- **WHEN** called from `main.rs`
- **THEN** it accepts a single `SocketContext` struct
- **AND** clippy no longer reports `too_many_arguments`

#### Scenario: handle_connection accepts SocketContext
- **GIVEN** the refactored `handle_connection` function
- **WHEN** spawned for each connection
- **THEN** it accepts a `SocketContext` (or a subset via `Clone`)
- **AND** clippy no longer reports `too_many_arguments`

#### Scenario: NexusAgentService::new accepts config struct
- **GIVEN** the refactored `NexusAgentService::new` constructor
- **WHEN** called from `main.rs`
- **THEN** it accepts an `AgentServiceConfig` struct
- **AND** the struct fields match the current parameter list
