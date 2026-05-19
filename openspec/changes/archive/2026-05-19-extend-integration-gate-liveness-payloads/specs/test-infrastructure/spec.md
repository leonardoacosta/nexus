# test-infrastructure Specification Delta

## ADDED Requirements

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
