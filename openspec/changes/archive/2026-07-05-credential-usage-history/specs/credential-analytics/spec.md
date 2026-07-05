# credential-analytics Specification (delta)

## ADDED Requirements

### Requirement: The system MUST persist an append-only time-series of credential usage polls

On each successful usage poll, the homelab agent MUST insert one row into a `credential_polls`
table capturing the account's utilization at that instant, in addition to overwriting the
current-state usage columns on `credentials`. Each row MUST include `credential_id` (FK to
`credentials.id`), `fingerprint`, the 5-hour and 7-day `used`/`limit` values, the two window
reset instants, and a `polled_at` timestamp. The table MUST index `(credential_id, polled_at)`
for per-account reads and `(polled_at)` for retention pruning.

#### Scenario: Poll appends a history row
- **GIVEN** a primary, available credential and a parsed `/api/oauth/usage` payload with `five_hour = { used: 120, limit: 900 }` and `seven_day = { used: 3000, limit: 40000 }`
- **WHEN** the usage poller completes a successful tick for that credential
- **THEN** exactly one `credential_polls` row is inserted with `credential_id`, `fingerprint`, `usage_5h_used = 120`, `usage_5h_limit = 900`, `usage_7d_used = 3000`, `usage_7d_limit = 40000`, and `polled_at` set to the poll instant
- **AND** the current-state `usage5h*`/`usage7d*` columns on the `credentials` row are still updated as before

#### Scenario: Failed poll appends nothing
- **GIVEN** a credential whose `/api/oauth/usage` call fails or returns an unparseable body
- **WHEN** the poller tick handles that credential
- **THEN** no `credential_polls` row is inserted for it and the existing `credentials` usage columns are left untouched

### Requirement: The system MUST prune usage-poll history beyond the retention window

The weekly maintenance reaper MUST delete `credential_polls` rows whose `polled_at` is older
than 30 days, so the time-series stays bounded without a separate cron job.

#### Scenario: Reaper drops stale poll rows
- **GIVEN** `credential_polls` contains rows with `polled_at` of 10 days ago and 40 days ago
- **WHEN** the weekly reaper job runs
- **THEN** the 40-day-old row is deleted and the 10-day-old row is retained

### Requirement: The system MUST expose credential usage history over HTTP

The agent MUST serve `GET /credentials/:id/usage-history` returning the ordered poll series
for one credential. The endpoint MUST accept `window` (`5h` or `7d`, default `5h`) selecting
the used/limit column pair, and `sinceHours` (default 24) bounding the lookback. The response
MUST be `{ points: [{ polledAt, used, limit }] }` ordered by `polled_at` ascending.

#### Scenario: History endpoint returns the 5h series
- **GIVEN** a credential with three `credential_polls` rows in the last 24 hours
- **WHEN** a client requests `GET /credentials/:id/usage-history?window=5h&sinceHours=24`
- **THEN** the response is `{ points: [...] }` with three entries ordered oldest-first, each carrying `polledAt`, `used` (from `usage_5h_used`), and `limit` (from `usage_5h_limit`)

#### Scenario: Unknown credential id yields an empty series
- **GIVEN** an id with no `credential_polls` rows
- **WHEN** a client requests its usage history
- **THEN** the response is `{ points: [] }` with a 200 status

### Requirement: The Mac dashboard MUST surface usage history as a trend chart

The macOS `CredentialsView` MUST render a compact utilization-over-time chart per account,
fed by the usage-history endpoint, beneath the existing current-usage bar. The Mac remains a
display-only layer; no collection or persistence runs there.

#### Scenario: Trend chart renders from history points
- **GIVEN** the history endpoint returns three points for an account
- **WHEN** `CredentialsView` renders that account row
- **THEN** a sparkline plots the three points as utilization ratio (`used/limit`) over `polledAt`

#### Scenario: Empty history hides the chart
- **GIVEN** the history endpoint returns `{ points: [] }` for an account
- **WHEN** `CredentialsView` renders that account row
- **THEN** the trend chart is omitted and the current-usage bar still renders
