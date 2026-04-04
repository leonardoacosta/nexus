# Spec: Hook-Based Session Registration

## ADDED Requirements

### Requirement: RegisterSession RPC
The agent MUST accept a `RegisterSession` RPC that creates an ad-hoc session entry in the
registry without spawning tmux. The session MUST be assigned `session_type = AD_HOC` and
`tmux_session = None`. The agent MUST emit a `SessionStarted` event via the broadcast channel.

#### Scenario: Register a new ad-hoc session
**Given** nexus-agent is running on port 7400
**When** a `RegisterSession` RPC is received with `session_id`, `pid`, `cwd`, and optional
`project`, `branch`
**Then** the session is added to the registry with status `Active` and `session_type = AD_HOC`
**And** a `SessionStarted` event is emitted on the broadcast channel
**And** the RPC returns the session ID

#### Scenario: Re-register an existing session
**Given** a session with ID "abc123" already exists in the registry
**When** a `RegisterSession` RPC is received with the same session_id "abc123"
**Then** the existing session is updated (not duplicated)
**And** no `SessionStarted` event is emitted (idempotent)

### Requirement: UnregisterSession RPC
The agent MUST accept an `UnregisterSession` RPC that removes a session from the registry
without sending SIGTERM/SIGKILL (unlike `StopSession` which kills the process).

#### Scenario: Unregister an existing session
**Given** a session with ID "abc123" exists in the registry
**When** an `UnregisterSession` RPC is received with session_id "abc123"
**Then** the session is removed from the registry
**And** a `SessionStopped` event is emitted with reason "session ended"

#### Scenario: Unregister a non-existent session
**Given** no session with ID "xyz789" exists in the registry
**When** an `UnregisterSession` RPC is received with session_id "xyz789"
**Then** the RPC returns success (idempotent, no error)

### Requirement: Heartbeat RPC
The agent MUST accept a `Heartbeat` RPC that updates the `last_heartbeat` timestamp of an
existing session.

#### Scenario: Heartbeat for an active session
**Given** a session with ID "abc123" exists with status `Active`
**When** a `Heartbeat` RPC is received with session_id "abc123"
**Then** the session's `last_heartbeat` is updated to the current time
**And** a `HeartbeatReceived` event is emitted on the broadcast channel

#### Scenario: Heartbeat for an unknown session
**Given** no session with ID "xyz789" exists in the registry
**When** a `Heartbeat` RPC is received with session_id "xyz789"
**Then** the RPC returns success (no-op, no error)

### Requirement: Stale Session Detection
The agent MUST run a background task every 30 seconds that checks session heartbeat timestamps.

#### Scenario: Session becomes stale after 5 minutes
**Given** a session with `last_heartbeat` older than 5 minutes
**When** the stale detection task runs
**Then** the session status is changed to `Stale`
**And** a `StatusChanged` event is emitted (Active → Stale)

#### Scenario: Stale session removed after 15 minutes
**Given** a session with `last_heartbeat` older than 15 minutes
**When** the stale detection task runs
**Then** the session is removed from the registry
**And** a `SessionStopped` event is emitted with reason "stale session removed"

#### Scenario: Heartbeat revives a stale session
**Given** a session with status `Stale`
**When** a `Heartbeat` RPC is received for that session
**Then** the session status is changed back to `Active`
**And** a `StatusChanged` event is emitted (Stale → Active)

### Requirement: nexus-register CLI
A new binary (`nexus-register`) MUST provide three subcommands for CC hook integration.

#### Scenario: Register session from SessionStart hook
**Given** nexus-agent is running on localhost:7400
**When** `nexus-register start --session-id SID --pid 1234 --cwd /home/user/dev/oo --project oo`
is executed
**Then** a `RegisterSession` gRPC call is made to localhost:7400
**And** the process exits with code 0

#### Scenario: Unregister session from Stop hook
**Given** nexus-agent is running on localhost:7400
**When** `nexus-register stop --session-id SID` is executed
**Then** an `UnregisterSession` gRPC call is made to localhost:7400
**And** the process exits with code 0

#### Scenario: Send heartbeat from PostToolUse hook
**Given** nexus-agent is running on localhost:7400
**When** `nexus-register heartbeat --session-id SID` is executed
**Then** a `Heartbeat` gRPC call is made to localhost:7400
**And** the process exits with code 0

#### Scenario: Agent unreachable
**Given** nexus-agent is NOT running
**When** any `nexus-register` subcommand is executed
**Then** the process exits with code 0 (silent failure)
**And** no error output is written to stderr

### Requirement: CC Hook Wiring
Global CC hooks MUST be added to `~/.claude/settings.json` for session lifecycle events.

#### Scenario: Session starts
**Given** a Claude Code session starts
**When** the SessionStart hook fires
**Then** `nexus-register start` is called with the session's ID, PID, cwd, and project
**And** the hook completes within 2 seconds

#### Scenario: Session stops
**Given** a Claude Code session ends
**When** the Stop hook fires
**Then** `nexus-register stop` is called with the session's ID
**And** the hook completes within 2 seconds

#### Scenario: Tool use activity
**Given** a Claude Code session is active
**When** a PostToolUse hook fires
**Then** `nexus-register heartbeat` is called with the session's ID
**And** the hook completes within 2 seconds

## REMOVED Requirements

### Requirement: sessions.json File Watcher
The agent MUST NOT watch `sessions.json` for session discovery. The `watcher.rs` module and
its `start_session_watcher` invocation MUST be removed. The `notify` crate dependency SHOULD
be removed from `nexus-agent`'s `Cargo.toml`.

#### Scenario: Agent starts without file watcher
**Given** nexus-agent starts
**When** no `sessions.json` file exists
**Then** the agent starts successfully with an empty session registry
**And** no file watcher thread is spawned
