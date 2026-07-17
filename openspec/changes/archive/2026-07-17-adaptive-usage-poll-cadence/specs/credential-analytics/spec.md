# Credential Analytics — Delta

## ADDED Requirements

### Requirement: Usage polling MUST tighten to a hot interval near the 5-hour session limit
The credential usage poller MUST reschedule its next tick at a hot interval (default 60
seconds, overridable via `NEXUS_USAGE_POLL_HOT_INTERVAL_MS`) whenever the maximum 5-hour
utilization observed across credentials in the just-completed tick is at or above 80%.
Failure backoff MUST take precedence over the hot interval; below the threshold the existing
default interval (and its `NEXUS_USAGE_POLL_INTERVAL_MS` override) applies unchanged.

#### Scenario: Hot interval engaged at threshold
Given a poll tick where one credential's 5-hour utilization parses to 80 or higher
When the poller schedules its next tick
Then the delay is the hot interval (60s default) rather than the 5-minute default

#### Scenario: Backoff still wins during failure bursts
Given more than half of the tick's usage calls failed
And a credential's 5-hour utilization is at or above 80
When the poller schedules its next tick
Then the delay is the 30-minute backoff interval

#### Scenario: Default cadence below threshold
Given a poll tick where every credential's 5-hour utilization parses below 80
When the poller schedules its next tick
Then the delay is the default interval (5 minutes or `NEXUS_USAGE_POLL_INTERVAL_MS`)
