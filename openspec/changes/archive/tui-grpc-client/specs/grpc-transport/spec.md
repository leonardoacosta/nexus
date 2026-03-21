## ADDED Requirements

### Requirement: TUI gRPC Client

The TUI SHALL use tonic-generated `NexusAgentClient` to communicate with all configured agents
over gRPC. The client SHALL parse agent endpoints from `~/.config/nexus/agents.toml` using the
existing `NexusConfig::load()` function in nexus-core.

#### Scenario: Successful connection to all agents

- **WHEN** the TUI starts with a valid agents.toml containing 2 agents
- **THEN** the client connects to both agents via gRPC on port 7400
- **AND** both agents report `Connected` status

#### Scenario: Partial agent failure

- **WHEN** one of two configured agents is unreachable
- **THEN** the reachable agent returns its sessions normally
- **AND** the unreachable agent reports `Disconnected` status with an error message
- **AND** the unreachable agent returns an empty session list

### Requirement: Session Aggregation

The client SHALL provide `get_sessions()` that calls `ListSessions` on all connected agents and
returns an aggregated list of sessions paired with their source agent info.

#### Scenario: Aggregate sessions from multiple agents

- **WHEN** agent A has 3 sessions and agent B has 2 sessions
- **THEN** `get_sessions()` returns 5 sessions with correct agent attribution

#### Scenario: Session lookup by ID

- **WHEN** `get_session(id)` is called with a valid session ID
- **THEN** the client iterates all agents to find the session
- **AND** returns the session paired with its source agent info

### Requirement: Session Stop

The client SHALL provide `stop_session(id)` that identifies the owning agent and sends a
`StopSession` RPC to that agent.

#### Scenario: Stop a session on a specific agent

- **WHEN** `stop_session(id)` is called for a session on agent B
- **THEN** the client sends `StopSession` only to agent B
- **AND** returns the RPC result

### Requirement: Connection State Tracking

Each agent connection SHALL track: connection status (Connected/Disconnected), last successful
response timestamp, and last error message. The TUI screens use this state to display agent
health indicators.

#### Scenario: Track connection state transitions

- **WHEN** an agent becomes unreachable after being connected
- **THEN** its status transitions to `Disconnected`
- **AND** `last_seen` retains the timestamp of the last successful response
- **AND** `last_error` contains the failure reason

### Requirement: Connection Timeout

All gRPC calls SHALL use a 2-second timeout. If an agent does not respond within 2 seconds, the
call fails and the agent is marked as `Disconnected`.

#### Scenario: Timeout on slow agent

- **WHEN** an agent takes longer than 2 seconds to respond
- **THEN** the request times out
- **AND** the agent status is set to `Disconnected`
- **AND** subsequent poll cycles retry the connection
