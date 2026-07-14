## MODIFIED Requirements

### Requirement: Usage limits rendered per account

Each account row MUST display 5-hour usage percent and reset timestamp, sourced from
`GET /statusline?accountId=<id>` (`Account5H7D.fiveHour`, per `redesign-status-usage-endpoints`'s
`session-persistence` delta) rather than the retired `Account.usagePercent`/`Account.resetsAt`
fields on `GET /credentials`. When usage data has not yet been polled for that account, a "not
polled yet" fallback MUST be shown instead of blank or zero.

#### Scenario: usage polled for primary credential
- **Given** `GET /statusline?accountId=FP1` returns
  `{ account: { fiveHour: { used: 31, limit: 50, resetsAt: "2026-04-17T15:00:00Z" } } }`
- **When** the account row renders
- **Then** the usage cell shows "62%" and a relative reset time ("in 42 min")

#### Scenario: usage unpolled for new account
- **Given** fingerprint `FP3` was added 10 seconds ago and no usage poll has completed, so
  `GET /statusline?accountId=FP3` returns null `fiveHour`
- **When** the account row renders
- **Then** the usage cell shows "not polled yet" with a spinner affordance
