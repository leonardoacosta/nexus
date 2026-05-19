# test-infrastructure Specification

## Purpose
TBD - created by archiving change fix-bun-test-runner. Update Purpose after archive.
## Requirements
### Requirement: Next.js Frontend Test Alignment
Acceptance and component tests for the Next.js app (`apps/nextjs`) SHALL assert against the
actual rendered output of current components. Tests MUST be updated whenever a component refactor
changes the DOM structure or visible text.

#### Scenario: AC-13 session count asserted from table columns
- **WHEN** `ProjectsPoller` renders projects using the `ProjectsTable` layout
- **AND** project "co" has `activeSessions = 2` and `totalSessions = 4`
- **THEN** the Active column cell for that row contains the value `2`
- **AND** the Total column cell for that row contains the value `4`
- **AND** no test SHALL assert the combined string `"2 active"` which is never rendered as a single node

#### Scenario: AC-15 empty state shows current message
- **WHEN** `ProjectsPoller` receives an empty `initialProjects` array
- **THEN** the text `"No projects in registry"` is present in the document
- **AND** no test SHALL assert the string `NEXUS_PROJECTS_DIR` which was removed in commit 9f9d030

#### Scenario: AC-15 zero active sessions asserted from table columns
- **WHEN** a project has `activeSessions = 0`
- **THEN** the Active column cell for that row contains the value `0`
- **AND** no test SHALL assert the combined string `"0 active"` which is never rendered as a single node

#### Scenario: Test suite runs clean
- **WHEN** `vitest run` is executed in `apps/nextjs`
- **THEN** all test files pass with zero failures
- **AND** the currently failing 4 tests (AC-13 × 2, AC-15 × 2) are no longer reported as failures

### Requirement: Session Route Integration Tests
The session route test suite (`apps/agent/src/routes/sessions.test.ts`) SHALL contain real HTTP
assertions against a live PostgreSQL instance gated on `POSTGRES_URL`. Every test case MUST make
an actual HTTP request to a running agent server and assert response status codes, body shapes,
and filter semantics. No test body SHALL consist solely of `expect(true).toBe(true)`.

#### Scenario: GET /sessions returns populated array
- **WHEN** `POSTGRES_URL` is set and at least one session row exists in the database
- **THEN** `GET /sessions` returns 200 with a JSON array containing at least one session object

#### Scenario: GET /sessions returns empty array
- **WHEN** `POSTGRES_URL` is set and the sessions table is empty
- **THEN** `GET /sessions` returns 200 with an empty JSON array

#### Scenario: GET /sessions project filter
- **WHEN** sessions exist for projects "nx" and "tl"
- **AND** `GET /sessions?project=nx` is called
- **THEN** only sessions with project "nx" are returned

#### Scenario: GET /sessions status filter
- **WHEN** sessions exist with status "active" and "idle"
- **AND** `GET /sessions?status=active` is called
- **THEN** only active sessions are returned

#### Scenario: GET /sessions combined filter
- **WHEN** `GET /sessions?project=nx&status=active` is called
- **THEN** only sessions matching both project "nx" and status "active" are returned

#### Scenario: GET /sessions invalid status returns 400
- **WHEN** `GET /sessions?status=badvalue` is called
- **THEN** the response status is 400

#### Scenario: GET /sessions/:id found
- **WHEN** a session with id "abc-123" exists in the database
- **AND** `GET /sessions/abc-123` is called
- **THEN** the response is 200 with a session object whose id is "abc-123"

#### Scenario: GET /sessions/:id not found
- **WHEN** no session with id "missing-id" exists
- **AND** `GET /sessions/missing-id` is called
- **THEN** the response is 404 with a JSON body containing an `error` key

### Requirement: Credential Integration Tests
The credential test suite (`apps/agent/src/credentials/credentials.test.ts`) SHALL gate all
database-dependent suites on `POSTGRES_URL` using `describe.skipIf(!hasPg)` instead of
hard-coded `.skip`. Every skipped suite MUST contain real assertions (not `expect(true).toBe(true)`)
when PG is available.

#### Scenario: Credential store CRUD runs with live PG
- **WHEN** `POSTGRES_URL` is set
- **THEN** the "credential store" suite executes insert, findById, queryAll, queryByStatus,
  updateStatus, queryExpiredCooldowns, and queryStaleLeases with real SQL assertions

#### Scenario: Pool lifecycle runs with live PG
- **WHEN** `POSTGRES_URL` is set
- **THEN** the "credential pool — lifecycle" suite executes add, lease, release, re-lease,
  exhaustion, and error-path scenarios against the real database

#### Scenario: Rate-limit rotation runs with live PG
- **WHEN** `POSTGRES_URL` is set
- **THEN** the "credential pool — rate limit rotation" suite exercises cooldown assignment,
  next-credential selection, cooldown expiry recovery, and missing-credential paths

#### Scenario: Stale-lease cleanup runs with live PG
- **WHEN** `POSTGRES_URL` is set
- **THEN** the "credential pool — stale lease cleanup" suite verifies TTL-expired leases are
  recovered, recent leases are preserved, and multiple stale leases are handled in one pass

### Requirement: WebSocket Endpoint Auth Expectations
The acceptance test suite (`apps/agent/__tests__/acceptance/api-contracts.test.ts`) SHALL assert
that WebSocket endpoints (`/sessions/{id}/stream`, `/sessions/{id}/interact`) return HTTP 401
when no `NEXUS_ATTACH_SECRET` header is present, reflecting the auth-first guard added after
original test authoring.

#### Scenario: Stream endpoint without auth returns 401
- **WHEN** `GET /sessions/test-id/stream` is called without a `NEXUS_ATTACH_SECRET` header
- **THEN** the response status is 401 (not 404)

#### Scenario: Interact endpoint without auth returns 401
- **WHEN** `GET /sessions/test-id/interact` is called without a `NEXUS_ATTACH_SECRET` header
- **THEN** the response status is 401 (not 404)

#### Scenario: Stream endpoint with valid auth returns 404 (no PTY)
- **WHEN** `GET /sessions/test-id/stream` is called with `NEXUS_ATTACH_SECRET=test`
- **AND** no PTY session exists for "test-id"
- **THEN** the response status is 404 with `error: "session not found"`

### Requirement: TUI Stream Unit Tests
The `stream.rs` module (`crates/nexus-tui/src/stream.rs`) SHALL have a `#[cfg(test)]` unit test
module covering reconnection backoff, channel capacity enforcement, and message variant construction.

#### Scenario: Reconnection gives up after MAX_RECONNECT_ATTEMPTS
- **WHEN** the gRPC endpoint is unreachable for every attempt
- **THEN** after `MAX_RECONNECT_ATTEMPTS` failures the task emits `StreamMessage::Disconnected`
- **AND** no further reconnection attempts are made

#### Scenario: Channel capacity bounds memory
- **WHEN** the producer sends more messages than `STREAM_CHANNEL_CAPACITY`
- **THEN** the channel does not panic or block indefinitely
- **AND** the oldest unread messages are dropped to make room

#### Scenario: Heartbeat message carries timestamp
- **WHEN** a Heartbeat message is constructed
- **THEN** the `timestamp` field is a non-empty HH:MM:SS formatted string

### Requirement: TUI StreamViewState Unit Tests
The `stream_state.rs` module (`crates/nexus-tui/src/stream_state.rs`) SHALL have a `#[cfg(test)]`
unit test module covering buffer eviction, scroll clamping, and metadata preservation.

#### Scenario: Buffer evicted at 10 000 lines
- **WHEN** 10 001 lines are appended to a `StreamViewState`
- **THEN** `lines.len()` is at most 10 000 after eviction

#### Scenario: Scroll offset clamped
- **WHEN** `scroll_offset` is set to a value greater than the number of lines
- **THEN** accessing scroll-bounded rendering clamps the offset to the maximum valid value

#### Scenario: Metadata preserved across appends
- **WHEN** `model`, `rate_limit_utilization`, and `total_cost_usd` are set
- **AND** additional lines are appended
- **THEN** the metadata fields retain their previously set values

### Requirement: Pre-push integration gate with macOS-guarded UI tier

The pre-push deploy hook MUST execute a headless integration tier (agent
contract + payload + bundle-integrity) before build, and MUST abort the push
when any non-skipped test fails. A second tier (XCUITest render checks and the
built-bundle transport round-trip) MUST run only when the host is `Darwin`
with a usable GUI session, and MUST emit an explicit SKIP marker (not a
failure) on headless or non-macOS hosts.

#### Scenario: headless host runs Tier A and skips Tier B

- **GIVEN** the pre-push hook runs on a non-macOS or GUI-less host
- **WHEN** the integration gate executes
- **THEN** the agent contract + payload + bundle-integrity tests run
- **AND** the XCUITest / built-bundle transport tests are reported as SKIP
- **AND** the push is not aborted solely because Tier B was skipped

#### Scenario: failing Tier A test aborts the push

- **GIVEN** a Tier A integration test fails
- **WHEN** the pre-push hook runs
- **THEN** the hook aborts the push with a non-zero status and a clear message

#### Scenario: macOS host runs Tier B

- **GIVEN** the pre-push hook runs on macOS with a GUI session
- **WHEN** the integration gate executes
- **THEN** the XCUITest render checks and built-bundle transport round-trip run
- **AND** a failure in either aborts the push

### Requirement: Client transport tier reproduces macOS ATS faithfully

The client transport test MUST drive the real built `.app` bundle against a
stub agent bound to a non-loopback address. A stub on `127.0.0.1`, `localhost`,
`::1`, or a `*.local` host is non-conforming because macOS exempts loopback and
link-local from App Transport Security, which would mask the cleartext
rejection class this test exists to catch.

#### Scenario: bundle transport round-trip against non-loopback stub

- **GIVEN** a stub agent serving deterministic fixtures on a non-loopback address
- **WHEN** the built `.app` bundle fetches sessions from it
- **THEN** the request completes without an ATS cleartext error
- **AND** the payload decodes and the dashboard renders the fixture sessions

#### Scenario: loopback stub is rejected as non-conforming

- **WHEN** the client transport test is configured against a `localhost`/`127.0.0.1` stub
- **THEN** the test setup fails fast with a non-conforming-address error

### Requirement: Dashboard render coverage for every navigation section

An XCUITest MUST launch the built app, open the dashboard window, and assert
that every `DashboardSection` case renders its detail view, so a
section/observer that never mounts is caught automatically.

#### Scenario: all sections render

- **GIVEN** the built app is launched and the dashboard window opened
- **WHEN** the test iterates every `DashboardSection`
- **THEN** each section's detail view is present
- **AND** the Sessions section triggers a session fetch

### Requirement: Homelab transport check runs locally on the agent host

The homelab transport check MUST run on the agent host against loopback
(no Tailscale dependency) and assert the agent binds the configured
non-loopback interface, serves the `/sessions` and `/health` contract shape,
and round-trips the UNIX socket spine.

#### Scenario: agent serves contract and spine locally

- **GIVEN** the agent is running on the homelab host
- **WHEN** the local transport check queries `/sessions`, `/health`, and emits a socket event
- **THEN** the responses match the `packages/core` contract shape
- **AND** the socket event is observed at the dispatcher

### Requirement: Real cross-host smoke is non-gating

A real macbook→homelab Tailscale round-trip MUST be reported but MUST NOT
abort a push or fail the gating suite.

#### Scenario: cross-host smoke fails without blocking

- **GIVEN** homelab is unreachable over Tailscale
- **WHEN** the non-gating smoke runs in the pre-push hook
- **THEN** its failure is reported
- **AND** the push is not aborted on that basis

