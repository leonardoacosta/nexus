## MODIFIED Requirements

### Requirement: session idle threshold matches CC's session cache TTL

The `IDLE_THRESHOLD_MS` constant in `apps/agent/src/session-manager.ts` SHALL equal `60 * 60 * 1000` (3,600,000 ms = 60 minutes), matching Claude Code's current session cache TTL. The legacy 5-minute threshold is replaced. The `STALE_THRESHOLD_MS` and `EVICT_THRESHOLD_MS` constants SHALL shift proportionally to preserve the `active → idle → stale → evict` cadence.

#### Scenario: session with 30-minute gap remains active
- **GIVEN** the new 60m threshold is in effect
- **WHEN** a session emits a heartbeat at t=0 and the next heartbeat arrives at t=30min
- **THEN** the session status remains `active` (previously would have been `idle` at t=5min)

#### Scenario: session genuinely abandoned for 90min becomes idle
- **GIVEN** the new 60m threshold
- **WHEN** a session has no heartbeat for 90 minutes
- **THEN** the next sweep tick (60s interval) flips the session status to `idle`
