# radar-panel Specification

## Purpose
TBD - created by archiving change add-radar-source-panel. Update Purpose after archive.
## Requirements
### Requirement: nexus-agent SHALL proxy the durable request feed

The agent SHALL serve `GET /requests`, passing query params (`status`, `source`,
`changed_since`) through to the mx gateway (`MX_GATEWAY_URL`, default `http://127.0.0.1:8799`)
following the existing `/sources` passthrough conventions, including auth middleware and
fail-soft behavior when the gateway is down.

#### Scenario: Passthrough with filters
- **WHEN** `GET /requests?source=teams&changed_since=T` is called with valid auth
- **THEN** the agent returns the gateway response for the same path + query

#### Scenario: Gateway down degrades, not crashes
- **GIVEN** the mx gateway is unreachable
- **WHEN** `GET /requests` is called
- **THEN** the agent returns a 502-class JSON error and logs it (no unhandled throw)

### Requirement: apps/web SHALL render one status row per radar source

A `/radar` page SHALL render one row per source from the `/sources` SourceIndex: source name,
health/status, last-scan time, item count, ball==MINE count, and last error when present.
Sources reported unhealthy SHALL be visually distinct. The page SHALL render a
configure-agent-URL message when `NEXT_PUBLIC_NEXUS_AGENT_URL` is unset (matching the
web-dashboard convention).

#### Scenario: Healthy and degraded rows
- **GIVEN** /sources reports teams healthy and snow errored
- **WHEN** the /radar page loads
- **THEN** both rows render, snow visibly degraded with its error text

### Requirement: Each source row SHALL expand into scan-log and request-history drawers

Each row SHALL open two drawers: a scan-log drawer rendering that source's recent scan
outcomes/errors from available health data, and a request-history drawer rendering recent
request transitions (`GET /requests?source=<s>&changed_since=<window>`; each entry: title,
field transition, timestamp). While the mx request store is not yet deployed, the history
drawer SHALL show an explicit empty state naming the missing feed rather than an error.

#### Scenario: History drawer shows transitions
- **GIVEN** the requests feed returns two teams requests with recent disposition flips
- **WHEN** the teams row's history drawer opens
- **THEN** both transitions render with old -> new and timestamps

#### Scenario: Missing feed degrades to empty state
- **GIVEN** `GET /requests` returns the gateway-down error
- **WHEN** the history drawer opens
- **THEN** an empty state names the unavailable request store (no crash, no spinner-forever)

### Requirement: Per-source visibility toggles SHALL persist client-side

The panel SHALL let Leo hide/show sources; the choice SHALL persist across reloads
(localStorage). Hidden sources SHALL still be fetched for the health summary but not rendered
as rows.

#### Scenario: Hide survives reload
- **WHEN** Leo hides "gmail" and reloads /radar
- **THEN** gmail's row is absent and a summary chip notes 1 hidden source

