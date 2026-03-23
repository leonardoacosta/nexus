## ADDED Requirements

### Requirement: Agent-Targeted Session Start
The `StartSession` RPC SHALL accept an optional `target_agent` field. When provided,
the agent SHALL only process the request if its name matches the target; otherwise it
SHALL return NOT_FOUND to allow client-side routing.

#### Scenario: Start session on specific agent
- **WHEN** a client calls StartSession with `target_agent: "homelab"`
- **AND** the receiving agent's name is "homelab"
- **THEN** the session is created normally

#### Scenario: Reject mismatched agent target
- **WHEN** a client calls StartSession with `target_agent: "macbook"`
- **AND** the receiving agent's name is "homelab"
- **THEN** the agent returns NOT_FOUND
- **AND** the client can try the next agent

#### Scenario: No target specified (backward compatible)
- **WHEN** a client calls StartSession without `target_agent`
- **THEN** the agent processes the request normally (existing behavior)

### Requirement: Agent Identity Discovery
The agent SHALL expose a `ListAgents` RPC that returns this agent's identity
(name, host, port) so clients can build a topology view.

#### Scenario: Query agent identity
- **WHEN** a client calls ListAgents
- **THEN** the response includes the agent's configured name, host, and port
