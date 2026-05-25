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

### Requirement: Health Endpoint Liveness Fields

The `GET /health` endpoint SHALL include three top-level liveness fields in addition to
existing CPU/RAM/disk metrics. The endpoint MUST NOT throw when any subsystem fails to
report — each field falls back to a documented sentinel value.

#### Scenario: DB connectivity surfaces as db_ok=true on healthy pool

- **WHEN** the Drizzle pool can execute `select 1` within the request handler
- **THEN** `GET /health` returns a JSON body whose top-level `db_ok` field is the boolean `true`
- **AND** the HTTP status is 200

#### Scenario: DB connectivity surfaces as db_ok=false on dead pool

- **WHEN** the Drizzle pool is unable to execute `select 1` (timeout, refused, dead host)
- **THEN** `GET /health` returns a JSON body whose top-level `db_ok` field is the boolean `false`
- **AND** the HTTP status remains 200 (the agent itself is up; only PG is degraded)
- **AND** the response handler MUST NOT throw or surface an HTTP 500

#### Scenario: Watcher heartbeat exposed as last_watcher_tick_ms

- **WHEN** the process-watcher's `reconcileOnce()` has completed at least once since agent boot
- **THEN** `GET /health` returns a JSON body whose top-level `last_watcher_tick_ms` field is a
  non-negative number representing monotonic ms since the last reconcile completion
- **AND** the value MUST be less than 5 * 60_000 (5 minutes) on a healthy agent with the
  default 30s watcher interval

#### Scenario: Watcher heartbeat sentinel when never ticked

- **WHEN** the process-watcher has not completed `reconcileOnce()` since agent boot
- **THEN** `GET /health` returns `last_watcher_tick_ms` as the sentinel value `-1`
- **AND** the field MUST NOT be omitted from the JSON payload

#### Scenario: Socket server listening state exposed

- **WHEN** the socket server's UNIX socket is bound and accepting connections
- **THEN** `GET /health` returns `socket_server_listening` as the boolean `true`

#### Scenario: Socket server unbound surfaces as socket_server_listening=false

- **WHEN** the socket server failed to bind (path conflict, permission denied) or has been
  stopped
- **THEN** `GET /health` returns `socket_server_listening` as the boolean `false`
- **AND** the HTTP response remains 200

### Requirement: Live-Session Socket-Spine Roundtrip Test

The homelab-transport gate suite (`apps/agent/src/testing/homelab-transport.test.ts`) SHALL
include a test that emits a `session_start` event via the UNIX socket, polls `GET /sessions`
until the row materialises, and asserts the row shape matches the canonical `SessionRow`
contract. The test MUST run under `NEXUS_HEAVY_TESTS=1` and skip cleanly when PG is unavailable.

#### Scenario: socket-injected session_start appears in /sessions

- **WHEN** `NEXUS_HEAVY_TESTS=1` and `POSTGRES_URL` are both set
- **AND** the test emits `{ event: "session_start", session_id: "<deterministic-id>", ... }` to
  the agent's UNIX socket
- **THEN** within 2 seconds, `GET /sessions` returns a JSON array containing exactly one row
  whose `id` field equals `<deterministic-id>`
- **AND** that row contains the canonical `SessionRow` keys: `id`, `machine`, `status`,
  `startedAt`, `lastActivity`, `pid`

#### Scenario: cleanup emits session_end and removes the fixture

- **WHEN** the live-session test completes (pass or fail)
- **THEN** the test emits `{ event: "session_end", session_id: "<deterministic-id>" }` to the
  socket
- **AND** a subsequent `GET /sessions` does not return the fixture row (it is closed, not
  necessarily deleted; the row may persist with `status: ended`)

#### Scenario: skip cleanly without PG

- **WHEN** `POSTGRES_URL` is not set
- **THEN** the live-session test reports `(skip)` with reason "requires live PG"
- **AND** the rest of the homelab-transport suite continues

#### Scenario: skip cleanly without heavy flag

- **WHEN** `NEXUS_HEAVY_TESTS` is unset or not `"1"`
- **THEN** the live-session test reports `(skip)`
- **AND** the bare per-push `turbo test` invocation MUST NOT execute this test

### Requirement: Swift Payload Decode Tests

The NexusSharedTests target SHALL include `PayloadDecodeTests.swift` exercising five model
decoders against inline JSON fixtures representing the canonical agent response shape for each
endpoint. Each test MUST decode the fixture without throwing and assert at least one
contract-pinning field beyond bare existence.

#### Scenario: ProjectAggregate decodes id and hidden

- **WHEN** the test decodes a JSON fixture mirroring `GET /projects` response
- **THEN** the decoded `ProjectAggregate` has a non-nil `projectID`
- **AND** has `hidden == false` for the canonical row
- **AND** has `sessionCount > 0` for the canonical row

#### Scenario: CredentialState decodes provider state

- **WHEN** the test decodes a JSON fixture mirroring `GET /credentials` response
- **THEN** the decoded credential model contains at least one provider entry
- **AND** the provider's state enum decodes to the expected case (e.g., `.active` or `.expired`)

#### Scenario: SpecMeta decodes proposal/design/tasks tri-state

- **WHEN** the test decodes a JSON fixture mirroring `GET /specs` response with a spec that has
  proposal.md and tasks.md but no design.md
- **THEN** the decoded `SpecMeta` reflects `hasProposal == true`, `hasDesign == false`,
  `hasTasks == true`
- **AND** the capability slug field is non-empty

#### Scenario: Notification decodes severity + delivery state

- **WHEN** the test decodes a JSON fixture mirroring a `/notifications` payload
- **THEN** the decoded `Notification` has a non-nil severity field
- **AND** the delivery-state field decodes to one of the documented enum cases

#### Scenario: FailureRecord decodes trace_id + stack_truncated

- **WHEN** the test decodes a JSON fixture mirroring `GET /failures` response
- **THEN** the decoded `FailureRecord` has a non-nil `trace_id`
- **AND** the `stack_truncated` boolean field decodes without error

#### Scenario: Adding a new required field to the JSON fails the test

- **WHEN** the agent ships a new REQUIRED field on any of the five models and the corresponding
  fixture in PayloadDecodeTests is NOT updated
- **THEN** the Codable decode fails at the fixture-decode line
- **AND** the test reports the missing key in the failure message
- **AND** the pre-push gate aborts the push (Tier A xcodebuild test failure → non-zero exit)

### Requirement: Gate Wiring for New Tests

The pre-push integration gate (`deploy/hooks.d/pre-push/01-deploy`) SHALL invoke the new tests
without requiring a separate gate stage. The new liveness + live-session tests run inside the
existing `homelab-transport.test.ts` under `NEXUS_HEAVY_TESTS=1`; the new payload-decode tests
run inside the existing `xcodebuild test -only-testing:nexus-mac-Tests` invocation.

#### Scenario: gate aborts push on liveness regression

- **WHEN** a regression causes `GET /health` to omit `db_ok`, `last_watcher_tick_ms`, or
  `socket_server_listening`
- **AND** the developer runs `git push`
- **THEN** the pre-push hook's Tier A `bun test` invocation reports a non-zero exit
- **AND** the dispatcher propagates the non-zero exit (via the `# nexus:blocking` sentinel)
- **AND** the push is aborted

#### Scenario: gate aborts push on payload decode regression

- **WHEN** a Swift model gains an incompatible required field and the fixture in
  PayloadDecodeTests is not updated
- **AND** the developer runs `git push`
- **THEN** Tier A `xcodebuild test` exits non-zero
- **AND** the push is aborted

### Requirement: Project Aggregate Includes Hidden Field

The agent's `GET /projects` response SHALL include a top-level `hidden` boolean
field on every row. The Swift `ProjectAggregate` model MUST decode this field
as a non-optional `Bool` with default `false` for backward compatibility with
older agents emitting an absent field.

#### Scenario: registry rows surface hidden state

- **GIVEN** a project in the registry with `hidden = true`
- **WHEN** the dashboard fetches `GET /projects`
- **THEN** the response row for that project contains `"hidden": true`
- **AND** the Swift `ProjectAggregate.hidden` decodes to `true`

#### Scenario: unregistered bucket defaults to false

- **GIVEN** the synthetic `(unregistered)` bucket aggregating session-only projects
- **WHEN** the dashboard fetches `GET /projects`
- **THEN** the bucket row has `"hidden": false`

#### Scenario: older agent absent field tolerated

- **WHEN** an older agent (pre-payload-completeness) omits the field
- **THEN** the Swift decoder substitutes `false` and the dashboard does not
  throw a decode error
- **AND** the per-push gate's PayloadDecodeTests v2 fixture pins the new
  required emission against current-generation agents only

### Requirement: Spec Watcher Emits Marker Tri-State

The agent's `GET /specs` response SHALL include `has_proposal`,
`has_design`, and `has_tasks` boolean fields on every row, derived from
filesystem presence of `proposal.md`, `design.md`, and `tasks.md` in the
spec directory at scan time. The Swift `SpecSummary` model MUST decode all
three as non-optional `Bool`.

#### Scenario: complete spec reports true for all three

- **GIVEN** a spec directory containing `proposal.md`, `design.md`, `tasks.md`
- **WHEN** the spec-watcher emits a row for that spec
- **THEN** `has_proposal = true`, `has_design = true`, `has_tasks = true`

#### Scenario: proposal-only spec reports tri-state

- **GIVEN** a spec directory with only `proposal.md` (no design.md, no tasks.md)
- **WHEN** the spec-watcher emits the row
- **THEN** `has_proposal = true`, `has_design = false`, `has_tasks = false`

#### Scenario: PayloadDecodeTests v2 pins all three fields

- **WHEN** the agent JSON for a spec omits any of the three marker fields
- **AND** the developer runs `git push`
- **THEN** the pre-push gate's `PayloadDecodeTests` decode fails
- **AND** the push is aborted

### Requirement: Notification List Endpoint Exists

The agent SHALL expose `GET /notifications` returning an array of
`NotificationEvent` rows. Each row MUST include `severity` (one of `info`,
`warn`, `error`) and `delivery_state` (one of `pending`, `delivered`,
`failed`) fields. The Swift `NotificationEvent` model MUST decode both as
non-optional enum cases.

#### Scenario: empty list returns 200 with empty array

- **WHEN** the agent has no notifications recorded
- **THEN** `GET /notifications` returns 200 with body `[]`
- **AND** the Swift dashboard's notifications view renders an empty state

#### Scenario: populated list decodes severity + delivery_state

- **GIVEN** the agent has at least one notification with `severity: "warn"`
  and `delivery_state: "delivered"`
- **WHEN** the dashboard fetches `GET /notifications`
- **THEN** the response contains the row with the matching field values
- **AND** the Swift decoder produces `NotificationEvent.severity == .warn`
  and `.deliveryState == .delivered`

#### Scenario: unknown severity fails the gate

- **WHEN** an agent emits a severity outside the documented enum (e.g.
  `"critical"`)
- **THEN** the PayloadDecodeTests v2 fixture decode fails
- **AND** the push is aborted with the unknown enum value in the failure
  message

### Requirement: Failure Top Errors Include Trace ID + Stack Truncation Marker

The agent's `GET /failures.top_errors[]` rows SHALL each include a `trace_id`
string field (nullable on legacy pre-instrumentation rows) and a
`stack_truncated` boolean. The Swift `ScriptError` model MUST decode
`trace_id` as `String?` and `stack_truncated` as non-optional `Bool` with
default `false` for older agents.

#### Scenario: instrumented error carries trace_id

- **GIVEN** a recent failure logged with OpenTelemetry instrumentation
- **WHEN** the failures aggregate is fetched
- **THEN** the corresponding `top_errors` row has a non-null `trace_id`

#### Scenario: legacy row has null trace_id

- **GIVEN** a pre-instrumentation row in `script_errors`
- **WHEN** the aggregate is fetched
- **THEN** the row's `trace_id` is `null`
- **AND** the Swift decoder produces `ScriptError.traceID == nil` without
  throwing

#### Scenario: long stack flagged as truncated

- **GIVEN** an error whose serialized stack exceeds the agent's truncation
  threshold
- **WHEN** the agent emits the row
- **THEN** `stack_truncated = true`
- **AND** the `stack` field contains the truncated content

### Requirement: PayloadDecodeTests v2 Enforces Required Fields

The Swift `NexusSharedTests/PayloadDecodeTests` SHALL replace
`decodeIfPresent` patterns with non-optional Codable for the four
newly-required field groups: `ProjectAggregate.hidden`,
`SpecSummary.{hasProposal, hasDesign, hasTasks}`,
`NotificationEvent.{severity, deliveryState}`, and
`ScriptError.stackTruncated`. A canonical JSON fixture per endpoint MUST be
maintained inline and updated whenever the agent's emission shape changes.

#### Scenario: missing required field aborts the gate

- **WHEN** an agent regression drops any one of the new required fields
- **AND** the developer runs `git push`
- **THEN** the pre-push gate's Tier A xcodebuild invocation returns non-zero
- **AND** the failure tail contains the specific Codable key that was missing
- **AND** the push is aborted

#### Scenario: legacy nullable fields tolerated

- **WHEN** the agent emits `trace_id: null` on a legacy row
- **THEN** the Swift decoder produces `nil` for `traceID` WITHOUT failing
- **AND** the test passes
- **AND** the gate proceeds

### Requirement: Tier B Harness Cleanup Is nounset-Safe

The Tier B XCUITest harness (`deploy/run-tier-b-xcuitests.sh`) SHALL run its `cleanup()` trap
without error under `set -u` on bash 3.2, including when `TEST_LOGS` (or any tracked array) is
empty because the script exited before the array was populated.

#### Scenario: Cleanup runs with an empty TEST_LOGS array

- **WHEN** the harness exits before `TEST_LOGS` is populated (e.g. a `build-for-testing` failure
  or a stub failure aborts under `set -e`)
- **THEN** the `cleanup()` trap completes without emitting an `unbound variable` error, under
  bash 3.2 with `set -euo pipefail`

#### Scenario: No unguarded array expansion remains

- **WHEN** the harness is audited for array expansions under `set -u`
- **THEN** every array expansion uses a nounset-safe form (e.g. `"${arr[@]+"${arr[@]}"}"`) so a
  future empty-array path cannot reintroduce the crash

### Requirement: Tier B Harness Surfaces the Real Failure

The Tier B harness SHALL surface the genuine failure cause and exit code when a step fails; the
`cleanup()` trap MUST NOT overwrite or bury the real failure.

#### Scenario: Build failure is attributed and exit code preserved

- **WHEN** `xcodebuild build-for-testing` fails
- **THEN** the harness reports that the `build-for-testing` stage failed, preserves that stage's
  output, and exits with a non-zero code reflecting the real failure (NOT an `unbound variable`
  message)

#### Scenario: Test failure is distinguishable from a build failure

- **WHEN** `xcodebuild test-without-building` fails with real test failures (not a perms timeout)
- **THEN** the harness reports that the `test-without-building` stage failed and propagates its
  exit code, distinct from the build-stage and the perms-timeout SKIP paths

#### Scenario: Perms-timeout SKIP path is unaffected

- **WHEN** the test run fails with a recognized accessibility/automation perms-timeout signature
- **THEN** the harness still exits 0 with the existing non-failing SKIP message, unchanged by
  this fix

### Requirement: Tier B Real Failures Are Triaged and Filed

Once the harness surfaces the previously-masked Tier B failures, each SHALL be categorized and
filed as a tracked issue rather than silently bypassed.

#### Scenario: Surfaced failures are categorized and filed

- **WHEN** the fixed harness is run and surfaces the real Tier B failures
- **THEN** each failure is categorized (Swift build error / real test regression / env-perms)
  and filed as a beads issue under the `test-infrastructure` capability, linked to the harness
  fix — without being blind-fixed in this change

### Requirement: Tier B Build Compiles SwiftPM C Dependencies

The Tier B XCUITest harness's `build-for-testing` step SHALL compile the project's SwiftPM C
dependencies (including the transitive `cmark-gfm` C target) successfully under the active Xcode
toolchain, without explicitly-built-module `.pcm` resolution failures.

#### Scenario: build-for-testing compiles cmark-gfm

- **WHEN** the Tier B harness runs `xcodebuild build-for-testing` for the `nexus-mac` scheme
- **THEN** the `cmark-gfm` C target compiles without a `module file ... not found` error for
  `_DarwinFoundation*.pcm`, and the build-for-testing stage exits 0

#### Scenario: build and test steps share a consistent artifact strategy

- **WHEN** the harness runs `build-for-testing` and then `test-without-building`
- **THEN** both steps resolve the same built product and SwiftPM artifacts (consistent
  derived-data / cloned-packages strategy), so the test step finds the product the build step
  produced

### Requirement: Tier B Gate Passes Without SKIP_TIER_B_RUN

Once the build fix lands, the Tier B pre-push gate SHALL run to its real outcome without
requiring the `SKIP_TIER_B_RUN` escape hatch to get past the build stage.

#### Scenario: Full harness run reaches the test stage

- **WHEN** the harness runs end-to-end WITHOUT `SKIP_TIER_B_RUN`
- **THEN** it passes `build-for-testing` and proceeds to `test-without-building` (reaching either
  a real test result or the existing graceful perms-timeout SKIP) — it no longer aborts at the
  build stage

#### Scenario: The escape hatch remains available

- **WHEN** `SKIP_TIER_B_RUN=1` is set
- **THEN** the harness still skips with its non-failing message (the sanctioned narrow skip is
  preserved, not removed)

### Requirement: Correctness Tests Avoid Load-Sensitive Real-Time SLAs

Agent correctness tests observing async events MUST assert correctness with a generous event-driven deadline, not a tight wall-clock latency bound that flakes under machine load (fs.watch, debounced re-poll, and bus emissions all jitter under load).

#### Scenario: Spec-watcher progress test waits for the event, not a 2s budget

- **WHEN** the SpecB 5.2 spec-watcher test asserts that a tasks.md checkbox-count change emits a
  `progress` SpecTransition
- **THEN** it waits for the transition with a generous deadline and asserts the transition's
  payload correctness (`transition === "progress"`, the progress spec name, `completed`/`total`
  reflecting the update), WITHOUT a hard `elapsed < 2000ms` assertion

#### Scenario: Any retained latency bound catches only gross regressions

- **WHEN** the test retains any latency assertion at all
- **THEN** the bound is generous enough (>= 5000ms) that normal scheduling jitter under
  concurrent load cannot fail it — only a gross regression would

#### Scenario: The test is stable under repeated runs

- **WHEN** the spec-watcher fs.watch test suite is run repeatedly (e.g. 15+ iterations)
- **THEN** the SpecB 5.2 test passes every time with no timing-related flake

### Requirement: Mac-TTS delivery path has a deterministic integration test

An integration-test harness SHALL drive the existing `stub-agent` to emit a controlled `NotificationFired` SSE event and MUST assert that the Swift TTS observer consumes the event and invokes the audio/synthesis path. The harness MUST mock the actual player so the assertion is deterministic, and it MUST skip cleanly when audio hardware is unavailable.

#### Scenario: NotificationFired drives playback synthesis

- **WHEN** the harness directs the `stub-agent` to emit a `NotificationFired` SSE event
- **THEN** the Swift TTS observer SHALL consume the event and invoke the mocked audio/synthesis path exactly once with the event's text
- **AND** the assertion SHALL be deterministic with no dependence on real audio output

#### Scenario: Harness skips on hardware without audio

- **WHEN** the harness runs on a CI runner that reports no available audio hardware
- **THEN** the test SHALL be marked skipped rather than failing
- **AND** the skip reason SHALL indicate audio hardware is unavailable

#### Scenario: Round-trip assertion is reproducible

- **WHEN** the harness is executed repeatedly against the same stub-agent event
- **THEN** each run SHALL assert the same `NotificationFired` → playback round-trip outcome
- **AND** no run SHALL pass or fail nondeterministically due to timing

