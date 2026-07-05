# rate-limit-interceptor Specification (delta)

## ADDED Requirements

### Requirement: The system MUST proactively rotate the active credential before exhaustion

On each successful usage-poller tick, the agent MUST evaluate the ACTIVE credential's 5-hour
window. When its remaining headroom is at or below 10%, the agent MUST swap to the eligible
candidate with the most remaining 5-hour headroom via the pool's manual-swap primitive.
Candidates with 10% or less remaining headroom are ineligible. The agent MUST NOT auto-swap
if any swap (manual or automatic) occurred within the last 30 minutes.

#### Scenario: Low active credential triggers swap to max-headroom candidate
- **GIVEN** the active credential has 8% of its 5h window remaining
- **AND** candidates A (60% remaining) and B (35% remaining) are available and not in cooldown
- **WHEN** the poller tick completes
- **THEN** the pool swaps the active credential to candidate A
- **AND** audit entries record the swap with an automatic actor

#### Scenario: Healthy active credential is untouched
- **GIVEN** the active credential has 45% of its 5h window remaining
- **WHEN** the poller tick completes
- **THEN** no swap is attempted

#### Scenario: Candidates at or below 10% are ineligible
- **GIVEN** the active credential has 5% remaining and every candidate has 10% or less remaining
- **WHEN** the poller tick completes
- **THEN** no swap is attempted and the exhaustion ladder path is evaluated instead

#### Scenario: Recent swap suppresses auto-swap
- **GIVEN** the active credential has 8% remaining and an eligible candidate exists
- **AND** a swap occurred 10 minutes ago
- **WHEN** the poller tick completes
- **THEN** no swap is attempted this tick

#### Scenario: Cooldown target falls through to next candidate
- **GIVEN** the max-headroom candidate is in pool cooldown and a second eligible candidate exists
- **WHEN** the auto-swap is attempted
- **THEN** the swap falls through to the second candidate instead of failing
