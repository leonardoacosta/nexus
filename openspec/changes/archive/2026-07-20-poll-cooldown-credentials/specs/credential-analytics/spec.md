# credential-analytics — poll-cooldown-credentials delta

## ADDED Requirements

### Requirement: The usage poller MUST include cooldown credentials in the poll set
`queryPollableRows` MUST return primary credentials whose status is `available` OR `cooldown`,
so that a credential swapped out at its 5-hour session limit keeps receiving usage polls (and
the hot-interval requirement can engage on it). Rows with status `refresh_failed` MUST remain
excluded — their dead OAuth tokens would fail every call and trip the >50%-failure backoff.

#### Scenario: Cooldown credential keeps polling
- **GIVEN** a primary credential in `status: 'cooldown'` after an auto-swap at its session limit
- **WHEN** the next poller tick queries pollable rows
- **THEN** the cooldown credential is included and its `usage5h*`/`usage7d*` columns and
  `usagePolledAt` are updated on success

#### Scenario: Hot interval engages for a cooldown credential
- **GIVEN** a cooldown credential whose just-polled 5-hour utilization is at or above 80%
- **WHEN** the poller schedules its next tick
- **THEN** the delay is the hot interval (60s default), not the 5-minute default

#### Scenario: refresh_failed rows stay excluded
- **GIVEN** rows with `status: 'refresh_failed'`
- **WHEN** the poller queries pollable rows
- **THEN** those rows are not returned and do not count toward the tick's failure rate
