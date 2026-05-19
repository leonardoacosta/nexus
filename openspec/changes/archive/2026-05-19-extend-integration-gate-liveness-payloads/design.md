# Design: Extend integration gate with liveness + live-session + payload decoders

## Liveness Probe Extension

### Surface

`GET /health` returns the existing `HealthMetrics` payload plus three new top-level fields:

| Field | Type | Source | Semantic |
| --- | --- | --- | --- |
| `db_ok` | `boolean` | `await db.execute(sql\`select 1\`)` succeeds | Drizzle pool can issue a trivial query |
| `last_watcher_tick_ms` | `number` | `processWatcher.lastTickMs()` — monotonic ms since the last `reconcileOnce()` completion | Watcher heartbeat freshness |
| `socket_server_listening` | `boolean` | `socketServer.isListening()` — checks `Bun.serve.unix` is bound and accepting | Socket spine reachable |

Rationale for extending `/health` instead of adding `/livez`:
- One endpoint, one fetch — dashboard already polls `/health` for the metrics view.
- Liveness is part of "is this agent serving requests well?" — same question as CPU/RAM.
- Future error UX (banner on stale watcher) consumes the same payload it already decodes.

### Implementation Surface

- `packages/core/src/types/health.ts` — extend `HealthMetrics` interface (TS).
- `apps/agent/src/server-health-handler.ts` — extend `stubbedHealthPayload()` + the live path.
- `apps/agent/src/services/process-watcher.ts` — expose `lastTickMs()` getter (writes inside
  `reconcileOnce`).
- `apps/agent/src/services/socket-server.ts` — expose `isListening()` getter.

### Failure Semantics

The endpoint MUST NOT throw on subsystem failure. Each field is computed under a per-field try
block and falls back to:

| Field | Failure fallback |
| --- | --- |
| `db_ok` | `false` |
| `last_watcher_tick_ms` | `-1` (sentinel: never ticked) |
| `socket_server_listening` | `false` |

The HTTP response stays 200; the dashboard reads the booleans to decide what to surface. This
matches how the existing `cpu`/`ram` fields tolerate transient platform-query failures.

## Live-Session Socket-Spine Injection

### Mechanism

The existing socket-spine roundtrip test (`homelab-transport.test.ts:161`) proves a
`session_start` NDJSON written to the agent's socket reaches the dispatcher's `onEvent`
callback. This change extends it: after the event is dispatched, the test polls
`GET /sessions` until the new row materialises in the query result.

```
1. test connects to agent's UNIX socket (~/.config/nexus/agent.sock OR test-scoped path)
2. test writes { event: "session_start", session_id: "gate-fixture-1", ... } + "\n"
3. agent dispatcher processes the event → inserts into sessions table
4. test polls GET /sessions until id="gate-fixture-1" appears (poll 25ms × 2s deadline)
5. test asserts row has the canonical SessionRow shape (id, machine, status, startedAt, pid)
6. cleanup: test emits { event: "session_end", session_id: "gate-fixture-1" }
```

### Why Socket-Spine, Not PG Seed

- **No PG dependency** — the gate stays runnable on a developer machine without `POSTGRES_URL`.
  The existing socket-spine test runs unconditionally under `NEXUS_HEAVY_TESTS=1`; this
  extension inherits the same gate.
- **Real path** — exercises the same code path that `nexus-emit` uses in production. A PG
  seed bypasses the dispatcher and tests only the read path.
- **Idempotent** — the test owns a deterministic session_id (`gate-fixture-1`); session_end
  closes it cleanly between runs.

### Tier Placement

Tier A under `NEXUS_HEAVY_TESTS=1`. Same path as the existing socket-spine roundtrip. The
existing `hasPg` guard on the contract-shape leg stays — only the new live-session leg
escapes the PG gate (it can run on a PG-less host because the dispatcher's INSERT goes
through the same Drizzle config; if PG is absent, the dispatcher's insert fails and the
test fails — which is exactly what we want).

Wait — the dispatcher writes to PG, so this needs PG too. **Corrected**: the live-session
leg ALSO carries the `hasPg` guard. Without PG, it skips. The Tier A gate path always has
PG available (the gate's resource-bearing path).

## Per-Endpoint Payload Decode Tests (Swift)

### File

`apps/swift/NexusSharedTests/PayloadDecodeTests.swift` — new test class alongside the
existing `SessionDecodingTests.swift` / `AggregateStateTests.swift` / `SettingsStoreTests.swift`.

### Coverage

| Model | Endpoint | Fixture Source | Assertion |
| --- | --- | --- | --- |
| `ProjectAggregate` | `GET /projects` | Inline JSON literal | `id != nil`, `hidden == false`, `sessionCount > 0` |
| `CredentialState` | `GET /credentials` | Inline JSON literal | At least one provider key, expected `state` enum value |
| `SpecMeta` | `GET /specs` | Inline JSON literal | Decoder accepts proposal/design/tasks tri-state, capability slug |
| `Notification` | `GET /notifications` | Inline JSON literal | Decoder handles severity + delivery state |
| `FailureRecord` | `GET /failures` | Inline JSON literal | Decoder accepts trace_id + stack_truncated |

### Why Inline Fixtures, Not Stub-Agent

- **Decode-only** — these tests assert Codable contracts, not transport. No HTTP needed.
- **No race window** — inline data is deterministic and self-contained; no flaky fixture
  startup.
- **Fast** — adds ~50ms total to the xcodebuild test bundle.

Each fixture is the JSON the dashboard sees on a real fetch (captured via curl during initial
authoring). When the agent's JSON output changes shape, the fixture MUST be updated alongside
the model — the test failure makes the contract change visible at the gate.

### Tier Placement

Tier A `xcodebuild test -only-testing:NexusSharedTests`. The gate already invokes this
bundle; this adds one test class without changing the invocation.

## Gate Wiring

`deploy/hooks.d/pre-push/01-deploy` already runs:
1. `bun install` + `turbo test` (Tier A bun side, with `NEXUS_HEAVY_TESTS=1` for the
   resource-bearing leg).
2. `deploy/check-bundle-integrity.sh` (xcodebuild release product).
3. `xcodebuild test -only-testing:nexus-mac-Tests` (unit suites — includes NexusSharedTests).
4. Tier B `xcodebuild test -only-testing:nexus-mac-UITests` (macOS-only).

No new gate invocation is needed. The new tests slot into existing invocations:
- Liveness + socket-inject → `homelab-transport.test.ts` (Tier A bun).
- Payload decoders → `NexusSharedTests` bundle (Tier A xcodebuild).

The gate's `# nexus:blocking` sentinel comment on `01-deploy` already propagates non-zero
exit to the dispatcher.

## Risk

| Risk | Mitigation |
| --- | --- |
| `last_watcher_tick_ms` produces a flaky comparison in tests (clock drift) | Assert `>= 0 && < 5 * 60_000` — wide enough to absorb 5-minute pauses without false-positives |
| Socket-inject test races a real session_start with the same fixture id | Use a generated id `gate-fixture-${Date.now()}-${pid}` and assert WHERE id matches |
| Adding fields to HealthMetrics breaks existing dashboard decoder | Swift `HealthMetrics` model uses default values for new optional fields; verified in PayloadDecodeTests |
| `/health` becomes a slow endpoint due to the new DB ping | The `select 1` is sub-ms on a warm pool; instrument with pino timing and fail the gate if p99 > 50ms |
