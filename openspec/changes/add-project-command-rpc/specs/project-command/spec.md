# Capability: Project Command

Project-routed command execution and command discovery. Enables external consumers to discover
available Claude Code slash commands and execute them against any project by name.

## ADDED Requirements

### Requirement: Command Discovery

The system SHALL provide an API to discover available slash commands with metadata.

#### Scenario: List all commands
- **WHEN** a `ListCommands` request is received with no filters
- **THEN** the system returns all invocable commands with name, namespace, description, tier, and cost

#### Scenario: Filter by namespace
- **WHEN** a `ListCommands` request is received with `namespace = "audit"`
- **THEN** the system returns only commands in the `audit` namespace

#### Scenario: Filter by tier
- **WHEN** a `ListCommands` request is received with `tier = STATUS`
- **THEN** the system returns only commands categorized as status/read-only

#### Scenario: Exclude non-invocable files
- **WHEN** the command directory contains `references/` subdirectories or `README.md` files
- **THEN** those files are excluded from the command list

### Requirement: Command Metadata

The system SHALL categorize each command by execution tier and estimated cost.

#### Scenario: Status tier command
- **WHEN** a command like `next` or `workflow:check` is queried
- **THEN** it is categorized as `STATUS` tier with `LOW` cost

#### Scenario: Analysis tier command
- **WHEN** a command like `audit:code` or `monitor:sentry` is queried
- **THEN** it is categorized as `ANALYSIS` tier with `MEDIUM` or `HIGH` cost

#### Scenario: Action tier command
- **WHEN** a command like `apply` or `commit` is queried
- **THEN** it is categorized as `ACTION` tier with `MEDIUM` or `HIGH` cost

### Requirement: Project-Routed Command Execution

The system SHALL execute slash commands against a project by project code, abstracting
session lifecycle from the caller.

#### Scenario: Execute command against project
- **WHEN** `RunProjectCommand` is called with project `oo` and command `audit:code`
- **THEN** the system resolves the project, acquires a session, runs `/ audit:code`, and streams output

#### Scenario: Unknown project
- **WHEN** `RunProjectCommand` is called with an unregistered project code
- **THEN** the system returns `NOT_FOUND`

#### Scenario: Unknown command
- **WHEN** `RunProjectCommand` is called with a command not in the registry
- **THEN** the system returns `INVALID_ARGUMENT`

#### Scenario: Session pool unavailable
- **WHEN** the session pool is at capacity with all sessions busy
- **THEN** the system returns `UNAVAILABLE` with a retry hint

### Requirement: Streaming Output

The system SHALL stream command execution output using the existing `CommandOutput` message format.

#### Scenario: Streamed execution
- **WHEN** a command is executing
- **THEN** the caller receives `TextChunk`, `ToolUseInfo`, `ToolResult`, `ProgressUpdate`,
  and `CommandDone` messages as they occur

### Requirement: HTTP Access

The system SHALL expose command discovery and execution via HTTP endpoints.

#### Scenario: HTTP command listing
- **WHEN** `GET /commands` is requested
- **THEN** the system returns a JSON array of command metadata

#### Scenario: HTTP command execution
- **WHEN** `POST /project/:code/run` is requested with a command body
- **THEN** the system streams newline-delimited JSON `CommandOutput` messages
