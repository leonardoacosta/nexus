## 1. Session Route Integration Tests

- [x] 1.1 Remove all `expect(true).toBe(true)` stub bodies from `apps/agent/src/routes/sessions.test.ts`
- [x] 1.2 Add test setup: seed one session row into PG before each suite, truncate after
- [x] 1.3 Implement `GET /sessions returns sessions array` — assert 200, body is array, row present
- [x] 1.4 Implement `GET /sessions returns empty array when no sessions exist` — assert 200, empty array
- [x] 1.5 Implement `GET /sessions?project= filters by project name` — seed two projects, assert filter
- [x] 1.6 Implement `GET /sessions?project= returns empty for non-matching project` — assert empty array
- [x] 1.7 Implement `GET /sessions?status= filters by status` — seed active+idle rows, assert filtered
- [x] 1.8 Implement `GET /sessions?status= combines project and status filters` — assert correct intersection
- [x] 1.9 Implement `GET /sessions/{id} returns single session` — assert 200, id matches
- [x] 1.10 Implement `GET /sessions/{id} returns 404 for unknown ID` — assert 404, body has `error` key
- [x] 1.11 Implement `GET /projects returns aggregated list` — assert 200, project shape (name, active_sessions, total_sessions, machines)
- [x] 1.12 Implement `GET /projects returns empty array when no sessions exist` — assert 200, empty array
- [x] 1.13 Implement `GET /sessions?status=invalid returns 400` — assert 400
- [x] 1.14 Implement `GET /sessions?status=<other-invalid> returns 400` — assert 400

## 2. Credential Test Suite — Unskip and Implement

- [x] 2.1 Convert `describe.skip("credential store …")` to `describe.skipIf(!hasPg)(…)` pattern
- [x] 2.2 Add PG setup/teardown helpers (seed credential row, truncate credentials table)
- [x] 2.3 Implement `inserts a credential and retrieves it by id` — real DB insert + findById
- [x] 2.4 Implement `returns null for non-existent credential` — query missing ID, assert null
- [x] 2.5 Implement `queries all credentials` — seed 3 rows, assert count
- [x] 2.6 Implement `queries credentials by status` — seed mixed statuses, assert filter
- [x] 2.7 Implement `updates credential status` — update status, refetch, assert new value
- [x] 2.8 Implement `queries expired cooldowns` — seed past-cooldown row, assert returned
- [x] 2.9 Implement `queries stale leases` — seed old leasedAt row, assert returned
- [x] 2.10 Convert `describe.skip("credential pool — lifecycle …")` to `describe.skipIf(!hasPg)(…)`
- [x] 2.11 Implement `adds a credential and lists it` — pool.add(), pool.list(), assert present
- [x] 2.12 Implement `leases a credential and marks it as leased` — pool.lease(), assert status=leased
- [x] 2.13 Implement `releases a leased credential back to available` — pool.release(), assert status=available
- [x] 2.14 Implement `returns null when pool is exhausted` — lease all rows, assert null on next
- [x] 2.15 Implement `returns null when leasing a type that does not exist` — assert null
- [x] 2.16 Implement `release fails for non-existent credential` — assert error/null
- [x] 2.17 Implement `release fails for credential not in leased state` — assert error
- [x] 2.18 Implement `supports lease -> release -> re-lease cycle` — full round-trip, assert states
- [x] 2.19 Convert `describe.skip("credential pool — rate limit rotation …")` to `describe.skipIf(!hasPg)(…)`
- [x] 2.20 Implement `puts credential on cooldown and leases next available` — reportRateLimit(), pool.lease() returns next
- [x] 2.21 Implement `returns null for next when pool exhausted after cooldown` — assert null
- [x] 2.22 Implement `returns null for non-existent credential` (rotation) — assert null
- [x] 2.23 Implement `recovers from cooldown after expiry` — set past cooldownUntil, assert reavailable
- [x] 2.24 Convert `describe.skip("credential pool — stale lease cleanup …")` to `describe.skipIf(!hasPg)(…)`
- [x] 2.25 Implement `cleans up stale leases after TTL expires` — seed old leasedAt, run cleanup, assert available
- [x] 2.26 Implement `does not clean up recent leases` — seed fresh lease, run cleanup, assert still leased
- [x] 2.27 Implement `cleans up multiple stale leases at once` — seed 3 stale leases, run cleanup, assert all available

## 3. Acceptance Test — WebSocket Status Fix

- [x] 3.1 Audit `apps/agent/__tests__/acceptance/api-contracts.test.ts` lines 104-117 for stale 404 expectations
- [x] 3.2 Update `GET /sessions/{id}/stream` test: expect 401 (not 404) when no `NEXUS_ATTACH_SECRET` header
- [x] 3.3 Update `GET /sessions/{id}/interact` test: expect 401 (not 404) when no `NEXUS_ATTACH_SECRET` header
- [x] 3.4 Add variant assertions: with valid `NEXUS_ATTACH_SECRET=test`, expect 404 (no PTY) not auth error
- [x] 3.5 Update test descriptions to reflect auth-first semantics
- [x] 3.6 Add `x-nexus-secret` auth header to all REST route requests in acceptance tests (health, sessions, projects, CORS, unknown-route)

## 4. Server Global State Isolation

- [x] 4.1 Create `ServerState` class in `apps/agent/src/server.ts` encapsulating `allSockets`, `pongDeadlines`, `pingTimer`, and `streamManager`
- [x] 4.2 Add `ServerState.create()` static factory that initialises a fresh `HealthCollector` and `StreamManager`
- [x] 4.3 Refactor `startServer()` to instantiate `ServerState` internally and return the instance
- [x] 4.4 Update acceptance tests to call `ServerState.create()` and receive isolated state per test file
- [x] 4.5 Remove module-level singleton assignments for the encapsulated globals
- [x] 4.6 Verify no cross-file state leakage by running acceptance suite twice in the same process

## 5. Rust stream.rs Unit Tests

- [ ] 5.1 Add `#[cfg(test)] mod tests` block to `crates/nexus-tui/src/stream.rs`
- [ ] 5.2 Test reconnection: mock a failing gRPC endpoint, assert backoff attempts up to `MAX_RECONNECT_ATTEMPTS`
- [ ] 5.3 Test channel capacity: send `STREAM_CHANNEL_CAPACITY + 1` messages, assert oldest is dropped not panicked
- [ ] 5.4 Test `StreamMessage::SessionMeta` variant: assert fields round-trip correctly
- [ ] 5.5 Test `StreamMessage::Disconnected` is emitted after max reconnect attempts exhausted
- [ ] 5.6 Test `StreamMessage::Heartbeat` carries formatted timestamp string

## 6. Rust stream_state.rs Unit Tests

- [ ] 6.1 Add `#[cfg(test)] mod tests` block to `crates/nexus-tui/src/stream_state.rs`
- [ ] 6.2 Test buffer eviction: push 10 001 lines, assert `lines.len() <= 10_000`
- [ ] 6.3 Test scroll offset clamping: set scroll beyond line count, assert clamped to max valid offset
- [ ] 6.4 Test `auto_scroll` resets to true when scrolled to bottom
- [ ] 6.5 Test metadata fields (`model`, `rate_limit_utilization`, `total_cost_usd`) preserved across line appends
- [ ] 6.6 Test `partial_buf` accumulates then flushes on newline

## 7. CI Environment

- [ ] 7.1 Confirm `POSTGRES_URL` is available in CI for PG-gated suites (document in test file header)
- [ ] 7.2 Confirm `NEXUS_ATTACH_SECRET=test` is exported in CI for acceptance tests
- [ ] 7.3 Run full test suite (`cargo test` + `bun test`) and confirm no regressions
