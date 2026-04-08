## MODIFIED Requirements

### Requirement: Concurrent agent session polling
The TUI client SHALL fan out session queries to all configured agents concurrently. The wall-clock
duration of a full poll cycle SHALL be bounded by the slowest individual agent response, not the
sum of all agent response times. All gRPC client method calls that follow an `.is_some()` guard
SHALL use `if let Some(client) = agent.client.as_mut()` to eliminate the intermediate `.unwrap()`
call. No `.unwrap()` or `.expect()` calls SHALL exist on `Option<GrpcClient>` fields after an
independent guard check.

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

#### Scenario: No panic on concurrent connection drop
- **WHEN** an agent's gRPC connection is present at the start of a call
- **AND** the call path uses `if let Some(client) = agent.client.as_mut()`
- **THEN** no `.unwrap()` is called and a connection drop never causes a process panic

## ADDED Requirements

### Requirement: Agent offline UI row
When an agent's connection status is `Disconnected` or `Failed`, the TUI session list SHALL
display a synthetic non-selectable row for that agent reading "Agent offline — last seen
<relative_timestamp>" (e.g. "Agent offline — last seen 4 min ago") styled with dim foreground.
When `last_seen` is `None`, the row SHALL read "Agent offline — never connected".

#### Scenario: Agent disconnects mid-session
- **WHEN** an agent's status becomes `Disconnected`
- **AND** the session list is rendered
- **THEN** a dim row "Agent offline — last seen X min ago" appears for that agent
- **AND** the row is not selectable (arrow keys skip it)

#### Scenario: Agent never connected
- **WHEN** an agent's `last_seen` is `None` and status is `Failed`
- **THEN** the row reads "Agent offline — never connected"

### Requirement: Alert stream infinite reconnect
The alert stream (`subscribe_alert_stream`) SHALL reconnect to each agent independently using
exponential backoff when the stream ends or the connection fails. There SHALL be no maximum
reconnect attempt limit. The backoff SHALL start at 1 second and double on each attempt up to
a maximum interval of 120 seconds. The reconnect status per agent SHALL be exposed as
`AlertStreamStatus` (`Connected`, `Reconnecting { attempt, next_try_secs }`) in `AppState`.

#### Scenario: Alert stream reconnects after agent restart
- **WHEN** an agent restarts and its gRPC endpoint becomes available again
- **THEN** the alert stream reconnects automatically without user intervention

#### Scenario: Reconnect backoff caps at 120 seconds
- **WHEN** an agent has been unreachable for many reconnect cycles
- **THEN** the reconnect interval does not exceed 120 seconds between attempts

#### Scenario: Reconnect status visible in status bar
- **WHEN** any alert stream is in `Reconnecting` state
- **THEN** the status bar shows the reconnecting agent name and attempt count
