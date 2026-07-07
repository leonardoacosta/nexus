# daily-digest Delta

## ADDED Requirements

### Requirement: The agent SHALL send exactly one digest per day composing queue head and exceptions

nexus-agent SHALL send one digest at the configured hour (`DIGEST_HOUR`,
default 07:30 local) through the existing notify dispatch transport,
composing: the queue-head line, up to 5 fleet-exception lines, and a
menubar-deck pointer whose count is the session size (capped at 10), never
the backlog total. Delivery SHALL be idempotent per calendar day (sent-marker;
agent restarts do not resend). When both queue and exceptions are empty the
digest SHALL still send, saying clear.

#### Scenario: One send per day survives restarts
- **GIVEN** the digest was sent at 07:30 and the agent restarts at 09:00
- **WHEN** the scheduler re-evaluates
- **THEN** no second digest is sent that day

#### Scenario: Clear day still sends
- **GIVEN** an empty queue and no exceptions
- **WHEN** the digest fires
- **THEN** a "clear" digest is delivered

### Requirement: The digest SHALL degrade gracefully and SHALL NOT leak aggregates or add per-item paths

When `GET /exceptions` is unavailable the digest SHALL send queue-head-only.
The composed digest SHALL never contain the fleet open-issue total, an
override rate, or any cumulative tally, and this change SHALL introduce no
per-item notification path.

#### Scenario: Exceptions feed down degrades the digest
- **GIVEN** /exceptions returns the fail-soft empty error state
- **WHEN** the digest composes
- **THEN** it sends with the queue-head line and no exceptions section

#### Scenario: No backlog totals in any digest
- **GIVEN** 193 open issues fleet-wide and 24 queued verdicts
- **WHEN** the digest composes
- **THEN** the message contains the queue-head line and a deck pointer of at most 10, and no other numeric aggregate
