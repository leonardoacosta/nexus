# Capability: Agent Module Structure

Well-decomposed module structure for the nexus-agent daemon crate.

## ADDED Requirements

### Requirement: gRPC module decomposition

The gRPC service SHALL be organized into domain-specific submodules within a `grpc/` directory.

#### Scenario: Developer navigates to session RPCs
- **WHEN** a developer needs to modify session lifecycle RPCs
- **THEN** they find them in `grpc/sessions.rs`, not a 1500+ line monolith

#### Scenario: Developer modifies command execution
- **WHEN** a developer changes CC subprocess spawning logic
- **THEN** the change is made in one place (CommandExecutor) and applies to all command paths

### Requirement: HTTP handler separation

HTTP handler functions SHALL live in a dedicated module, separate from startup wiring.

#### Scenario: Developer adds a new HTTP endpoint
- **WHEN** a developer adds a new axum route handler
- **THEN** they add it to `http_handlers.rs`, not `main.rs`

### Requirement: Shared command executor

CC subprocess spawn and stream-json parsing logic SHALL exist in a single shared implementation.

#### Scenario: Bug fix in stream parsing
- **WHEN** a bug is found in the CC subprocess output parsing
- **THEN** fixing `CommandExecutor` fixes it for SendCommand, RunProjectCommand, and pool-routed commands simultaneously
