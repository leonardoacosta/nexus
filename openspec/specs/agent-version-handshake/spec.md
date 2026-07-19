# agent-version-handshake Specification

## Purpose
TBD - created by archiving change agent-version-handshake. Update Purpose after archive.
## Requirements
### Requirement: Agent serves GET /version with build identity

The agent SHALL expose `GET /version` returning a JSON object with three fields: `buildSha` (short Git SHA, lowercase hex), `builtAt` (ISO-8601 UTC timestamp), and `capabilities` (alphabetically-sorted string array). The endpoint SHALL respond 200 on every successful invocation and SHALL NOT require the `x-nexus-secret` header.

#### Scenario: Successful version request returns full payload

- **WHEN** a client sends `GET /version` to a healthy agent
- **THEN** the response status SHALL be 200
- **AND** the `Content-Type` SHALL be `application/json`
- **AND** the body SHALL be a JSON object with exactly the keys `buildSha`, `builtAt`, `capabilities`
- **AND** `buildSha` SHALL match `/^[0-9a-f]{7,40}$/`
- **AND** `builtAt` SHALL be parseable by `Date.parse()` and have a `Z` UTC suffix
- **AND** `capabilities` SHALL be a non-empty array of strings

#### Scenario: Endpoint is unauthenticated

- **WHEN** a client sends `GET /version` without the `x-nexus-secret` header
- **THEN** the response status SHALL be 200
- **AND** the same payload SHALL be returned as for an authenticated request

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

### Requirement: Build script generates version.gen.ts before bun build

The `apps/agent/build` npm script SHALL run a pre-step that writes `apps/agent/src/version.gen.ts` exporting two constants — `BUILD_SHA` and `BUILT_AT` — populated from `git rev-parse --short HEAD` and the current ISO-8601 UTC timestamp. The pre-step SHALL fail with non-zero exit code if Git is not available or the working tree cannot be read.

#### Scenario: Pre-step writes generated constants

- **WHEN** `bun run build` is invoked from `apps/agent/`
- **THEN** the script SHALL execute the pre-step before `bun build --compile`
- **AND** `apps/agent/src/version.gen.ts` SHALL exist after the pre-step
- **AND** the file SHALL export `BUILD_SHA` matching the current Git short SHA
- **AND** the file SHALL export `BUILT_AT` matching an ISO-8601 UTC timestamp from within the last second

#### Scenario: Build fails fast outside a Git working tree

- **GIVEN** a directory that is not a Git repository
- **WHEN** `bun run build` is invoked
- **THEN** the pre-step SHALL exit non-zero
- **AND** the error message SHALL identify the missing requirement (Git working tree)
- **AND** no `nexus-agent` binary SHALL be produced

#### Scenario: Generated file is gitignored

- **WHEN** `git status` is run after a build
- **THEN** `apps/agent/src/version.gen.ts` SHALL NOT appear in the output
- **AND** `.gitignore` SHALL contain an entry covering this path

### Requirement: Version handler reads from generated constants

The `/version` route handler SHALL import `BUILD_SHA` and `BUILT_AT` from `./version.gen.ts` and SHALL NOT perform any filesystem or shell-out lookup at runtime. Capability resolution SHALL happen once at handler-builder construction time, not per-request.

#### Scenario: No filesystem access per request

- **WHEN** 100 successive `GET /version` requests are served
- **THEN** the agent SHALL NOT open `version.gen.ts` (or any other file) on disk between requests
- **AND** the response payload SHALL be identical across all 100 requests for the lifetime of the process

