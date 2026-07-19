## MODIFIED Requirements

### Requirement: Capabilities derived from live route table at boot

The `capabilities` array in the `/version` response SHALL be computed from
`LEGACY_DISPATCH_ROUTES`, the manually-maintained array in
`apps/agent/src/server-request-handler.ts` that lists every route the `handleRequestInner`
if/else dispatch chain actually serves. Each capability entry SHALL be the literal string
`"<METHOD> <path>"` where method is uppercase and path matches the route's registered path (no
trailing slash, no query string). The list SHALL be deduplicated and sorted alphabetically
before being cached at boot.

`LEGACY_DISPATCH_ROUTES` SHALL be kept in exact sync with the live dispatch chain — no route
dispatched by `handleRequestInner` may be absent from the array, and no array entry may be
absent from the dispatch chain — enforced by an automated test
(`apps/agent/src/server-request-handler-route-parity.test.ts`), not by manual review alone.

#### Scenario: New route appears in capabilities without manual registration

- **GIVEN** `LEGACY_DISPATCH_ROUTES` contains `GET /health`, `POST /notifications/send`
- **WHEN** a developer adds a new dispatch branch for `{ method: "GET", path: "/version" }` to
  `handleRequestInner`
- **AND** adds the matching `{ method: "GET", path: "/version" }` entry to
  `LEGACY_DISPATCH_ROUTES`
- **AND** rebuilds the binary
- **AND** a client requests `GET /version`
- **THEN** `capabilities` SHALL include `"GET /health"`, `"GET /version"`, and `"POST
  /notifications/send"`
- **AND** the entries SHALL be in alphabetical order

#### Scenario: Capabilities are cached at boot

- **WHEN** the agent boots
- **THEN** the capability list SHALL be computed once from `LEGACY_DISPATCH_ROUTES` and stored
- **AND** subsequent `/version` requests SHALL return the cached list without re-walking the
  route table

#### Scenario: A dispatched route missing from LEGACY_DISPATCH_ROUTES fails the test suite

- **GIVEN** `handleRequestInner` dispatches a route (e.g. `POST /apns/register`) via an if/else
  branch
- **WHEN** that route's `{ method, path }` entry is absent from `LEGACY_DISPATCH_ROUTES`
- **THEN** `server-request-handler-route-parity.test.ts` SHALL fail
- **AND** the failure message SHALL name the missing route
