# Change: Fix Integration Test Coverage Gaps

## Why

A platform audit (2026-04-06) found that six test suites across the agent and TUI layers
contain no real assertions: session route tests are `expect(true).toBe(true)` stubs, seven of
eight credential suites are `.skip`-guarded stubs, WebSocket acceptance tests carry stale
expectations from before auth was added, server-level globals cause test interference, and both
Rust stream modules (`stream.rs`, `stream_state.rs`) have zero unit tests. These gaps leave
critical paths — session queries, credential lifecycle, WebSocket auth, buffer eviction —
completely unverified.

## What Changes

- **Session route tests** (`apps/agent/src/routes/sessions.test.ts`): replace all
  `expect(true).toBe(true)` stubs with real HTTP assertions against a live PG instance
  (`POSTGRES_URL`). Cover GET /sessions (list, project filter, status filter, combined filter,
  invalid status 400), GET /sessions/:id (found, 404 shape), and GET /projects.
- **Credential tests** (`apps/agent/src/credentials/credentials.test.ts`): unskip and implement
  all seven `.skip` suites — store CRUD, pool lifecycle (add/lease/release/re-lease/exhaustion),
  rate-limit rotation (cooldown, recovery), and stale-lease cleanup — using live PG with
  `POSTGRES_URL`.
- **Acceptance test expectations** (`apps/agent/__tests__/acceptance/api-contracts.test.ts`):
  update WebSocket endpoint assertions from HTTP 404 → 401 to match auth-guarded behavior added
  since original test authoring. Pass `NEXUS_ATTACH_SECRET` header in test context.
- **Server global state** (`apps/agent/src/server.ts`): encapsulate `allSockets`,
  `pongDeadlines`, and `streamManager` into a `ServerState` class with a `create()` factory so
  each test file gets an isolated instance. `startServer()` returns a `ServerState` handle.
  **BREAKING**: callers that access module-level `streamManager` or `allSockets` must use the
  returned handle.
- **Rust stream unit tests** (`crates/nexus-tui/src/stream.rs`): add `#[cfg(test)]` module
  covering reconnection backoff logic, channel capacity enforcement, and `StreamMessage` variant
  construction.
- **Rust stream_state unit tests** (`crates/nexus-tui/src/stream_state.rs`): add `#[cfg(test)]`
  module covering buffer eviction at 10 000 lines, scroll offset clamping, and metadata field
  preservation across updates.

## Impact

- Affected specs: `test-infrastructure` (new), `async-safety` (MODIFIED — adds global-state
  isolation requirement)
- Affected code:
  - `apps/agent/src/routes/sessions.test.ts`
  - `apps/agent/src/credentials/credentials.test.ts`
  - `apps/agent/__tests__/acceptance/api-contracts.test.ts`
  - `apps/agent/src/server.ts`
  - `crates/nexus-tui/src/stream.rs`
  - `crates/nexus-tui/src/stream_state.rs`
- No API shape changes visible to TUI or external consumers; `ServerState` refactor is internal.
- CI must supply `POSTGRES_URL` and `NEXUS_ATTACH_SECRET=test` for the PG-gated suites.
