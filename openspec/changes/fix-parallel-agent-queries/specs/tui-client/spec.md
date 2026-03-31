## ADDED Requirements

### Requirement: Concurrent agent session polling
The TUI client SHALL fan out session queries to all configured agents concurrently. The wall-clock duration of a full poll cycle SHALL be bounded by the slowest individual agent response, not the sum of all agent response times.

#### Scenario: All agents reachable
- **WHEN** `get_sessions` is called with 3 configured agents
- **AND** each agent responds within 100ms
- **THEN** all 3 queries execute concurrently
- **AND** the total poll time is approximately 100ms (not 300ms)

#### Scenario: One agent unreachable
- **WHEN** `get_sessions` is called with 3 configured agents
- **AND** one agent times out after 2 seconds
- **AND** the other two respond within 100ms
- **THEN** the total poll time is approximately 2 seconds (not 4.2 seconds)
- **AND** the timed-out agent is marked Disconnected with an empty session list
- **AND** sessions from the healthy agents are returned normally

#### Scenario: All agents unreachable
- **WHEN** `get_sessions` is called with 3 configured agents
- **AND** all agents time out after 2 seconds
- **THEN** the total poll time is approximately 2 seconds (not 6 seconds)
- **AND** all agents are marked Disconnected
