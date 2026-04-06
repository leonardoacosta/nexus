## ADDED Requirements

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
