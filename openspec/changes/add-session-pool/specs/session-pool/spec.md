# Capability: Session Pool

Warm managed CC session pool for fast on-demand command execution. Maintains idle sessions
per project, ready to accept commands without cold-start penalty.

## ADDED Requirements

### Requirement: Pool-Based Session Management

The system SHALL maintain a pool of warm Claude Code sessions, one per active project,
for fast command execution.

#### Scenario: First command for a project
- **WHEN** a command targets a project with no pooled session
- **THEN** the system creates a new managed session in the project directory
- **AND** waits for the session to complete bootstrap before executing the command
- **AND** marks the session as pooled

#### Scenario: Subsequent command for same project
- **WHEN** a command targets a project with an existing ready pooled session
- **THEN** the system reuses the existing session
- **AND** does not incur cold-start latency

#### Scenario: Concurrent commands for same project
- **WHEN** a command targets a project whose pooled session is busy
- **THEN** the system queues the command until the session is available
- **OR** returns `UNAVAILABLE` if the wait exceeds a timeout

### Requirement: Idle Eviction

The system SHALL evict pooled sessions that have been idle beyond a configurable timeout.

#### Scenario: Idle session eviction
- **WHEN** a pooled session has not received a command for longer than `idle_timeout_minutes`
- **THEN** the system stops the session and removes it from the pool

#### Scenario: Active session retention
- **WHEN** a pooled session receives a command within the idle timeout
- **THEN** the idle timer resets and the session remains in the pool

### Requirement: Health Checking

The system SHALL monitor pooled session health and replace failed sessions.

#### Scenario: Pooled session crashes
- **WHEN** a pooled session's process exits unexpectedly
- **THEN** the system removes the session from the pool
- **AND** the next command for that project triggers a new session creation

### Requirement: Pool Capacity Limits

The system SHALL enforce a configurable maximum number of concurrent pooled sessions.

#### Scenario: Pool at capacity
- **WHEN** a command targets a new project and the pool is at max capacity
- **THEN** the system evicts the least-recently-used session to make room
- **OR** returns `UNAVAILABLE` if all sessions are actively busy

### Requirement: Project-Routed SendCommand

The system SHALL accept a project code in `CommandRequest` as an alternative to session ID.

#### Scenario: Command with project code
- **WHEN** `SendCommand` is called with `project` field set and `session_id` empty
- **THEN** the system resolves the project, acquires a pooled session, and executes

#### Scenario: Command with both fields
- **WHEN** `SendCommand` is called with both `session_id` and `project` set
- **THEN** `session_id` takes precedence

### Requirement: Graceful Shutdown

The system SHALL drain all pooled sessions during agent shutdown.

#### Scenario: Agent shutdown
- **WHEN** the agent receives a shutdown signal
- **THEN** all pooled sessions are stopped gracefully before the agent exits
