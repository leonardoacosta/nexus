# Proposal

## Change ID
fix-session-management-lifecycle

## Summary
Fix ten bugs and gaps in session lifecycle management across the Rust gRPC layer, TypeScript REST routes, in-memory session manager, and Next.js session detail page — eliminating orphaned sessions, duplicate spawns, stale registry entries, and missing error boundaries.

## Context
The nexus-agent exposes session management across two surfaces: a Rust gRPC service (`crates/nexus-agent/src/grpc/sessions.rs`) and a TypeScript REST agent (`apps/agent/src/routes/sessions.ts`). The in-memory `SessionManager` (`apps/agent/src/session-manager.ts`) drives the TypeScript agent's view of active sessions. The Next.js frontend (`apps/nextjs/src/app/session/[id]/page.tsx`) renders session detail. All four surfaces have correctness defects that compound each other: a failed bootstrap leaves a ghost registry entry; a duplicate POST registers the same project twice; `VALID_STATUSES` rejects valid enum values; the sweeper never evicts ended sessions; the detail page has no fallback UI for slow loads or fetch errors.

Epic: nx-r2oh

## Motivation
- **Data integrity**: orphaned registry entries (nx-q75y) and double-spawn (nx-8oib) corrupt the sessions list visible to TUI and dashboard consumers.
- **API correctness**: filtering on `?status=stale` or `?status=errored` returns 400 today (nx-0554), silently hiding sessions that exist in the DB.
- **Reliability**: SIGKILL is fire-and-forget — `registry.remove()` runs before the OS confirms process death (nx-spkw).
- **Observability**: 4 of 6 gRPC handlers are invisible to OTel (nx-zan1).
- **Memory safety**: ended sessions accumulate in the in-memory Map indefinitely (nx-7f05).
- **Frontend resilience**: no loading or error boundaries on the session detail page causes full-page failures on network errors (nx-ia5f).
- **Test coverage**: all route integration tests are skipped post-PG migration (nx-jl1z) and session status transitions are untested (nx-xlxx).

## Requirements

### Req-1: Atomic Registration + Spawn
The gRPC `StartSession` handler MUST register the session in the registry only after the bootstrap process spawns successfully. If `tokio::process::Command::new("claude")` fails to spawn (i.e., returns `Err`), the registry entry MUST be removed before the handler returns an error. Sessions that complete bootstrap with a non-zero exit code MAY remain registered (bootstrap output failure is not a spawn failure).

Addresses: nx-q75y (`grpc/sessions.rs:177-200`)

#### Scenario: spawn error rolls back registry
- **WHEN** `tokio::process::Command::new("claude")` returns `Err` (binary not found)
- **THEN** `registry.remove(&session_id)` is called before the handler returns
- **AND** the handler returns `Status::internal` with a descriptive message
- **AND** no orphaned session entry is visible via `GetSessions`

#### Scenario: bootstrap non-zero exit keeps session
- **WHEN** the `claude` process spawns but exits with a non-zero code
- **THEN** the registry entry is NOT removed
- **AND** the handler returns a successful `StartSessionResponse` with a warning log

### Req-2: Idempotent Session Creation
The `register_managed` call in `StartSession` MUST be guarded by a check for an existing session with the same `cwd` (project path) and a non-ended status. If a matching live session already exists, the handler MUST return the existing `session_id` without spawning a new process.

Addresses: nx-8oib (`grpc/sessions.rs:110-120`)

#### Scenario: duplicate project path rejected
- **WHEN** `StartSession` is called for `cwd="/home/user/dev/nx"` while a session with that cwd and status `active` already exists
- **THEN** no new registry entry is created
- **AND** the existing `session_id` is returned in `StartSessionResponse`
- **AND** no new `claude` process is spawned

#### Scenario: ended session allows re-creation
- **WHEN** `StartSession` is called for `cwd="/home/user/dev/nx"` while the only matching session has status `ended`
- **THEN** a new session is created and registered normally

### Req-3: VALID_STATUSES Completeness
The `VALID_STATUSES` set in `routes/sessions.ts` MUST include `"stale"` and `"errored"` in addition to the existing `"active"`, `"idle"`, and `"ended"` values. The 400 error message MUST enumerate all valid values.

Addresses: nx-0554 (`routes/sessions.ts:10`)

#### Scenario: stale filter accepted
- **WHEN** `GET /sessions?status=stale` is called
- **THEN** a `200` response is returned with sessions matching `status = "stale"`
- **AND** no 400 error is raised

#### Scenario: errored filter accepted
- **WHEN** `GET /sessions?status=errored` is called
- **THEN** a `200` response is returned with sessions matching `status = "errored"`

#### Scenario: truly invalid status rejected
- **WHEN** `GET /sessions?status=bogus` is called
- **THEN** a `400` response is returned listing all five valid status values

### Req-4: Validated Registration Fields
The `handle_register_session` handler MUST reject requests where `pid == 0`, `cwd` is empty, or `session_id` is empty. Each validation failure MUST return `Status::invalid_argument` with a field-specific message.

Addresses: nx-4fci (`grpc/sessions.rs:316-337`)

#### Scenario: zero pid rejected
- **WHEN** `RegisterSession` is called with `pid = 0`
- **THEN** the handler returns `Status::invalid_argument("pid must be non-zero")`
- **AND** no session is registered

#### Scenario: empty cwd rejected
- **WHEN** `RegisterSession` is called with `cwd = ""`
- **THEN** the handler returns `Status::invalid_argument("cwd must not be empty")`

#### Scenario: empty session_id rejected
- **WHEN** `RegisterSession` is called with `session_id = ""`
- **THEN** the handler returns `Status::invalid_argument("session_id must not be empty")`

#### Scenario: valid fields accepted
- **WHEN** `RegisterSession` is called with `pid = 1234`, non-empty `cwd`, and non-empty `session_id`
- **THEN** the session is registered and `created = true` is returned

### Req-5: Complete OTel Instrumentation
All six gRPC session handlers MUST carry `#[tracing::instrument]` attributes: `handle_get_sessions`, `handle_get_session`, `handle_start_session` (already present), `handle_stop_session` (already present), `handle_register_session`, `handle_unregister_session`, and `handle_heartbeat`. Each span MUST use a `name` of the form `"session.<verb>"` and MUST `skip(self, request)`.

Addresses: nx-zan1 (`grpc/sessions.rs:13-57`)

#### Scenario: get_sessions span emitted
- **WHEN** `GetSessions` gRPC call is made
- **THEN** a span named `"session.get_all"` is emitted in the OTel trace

#### Scenario: get_session span emitted
- **WHEN** `GetSession` gRPC call is made with a known session ID
- **THEN** a span named `"session.get"` is emitted with `session_id` recorded as a field

#### Scenario: register_session span emitted
- **WHEN** `RegisterSession` gRPC call is made
- **THEN** a span named `"session.register"` is emitted

#### Scenario: unregister_session span emitted
- **WHEN** `UnregisterSession` gRPC call is made
- **THEN** a span named `"session.unregister"` is emitted

#### Scenario: heartbeat span emitted
- **WHEN** `Heartbeat` gRPC call is made
- **THEN** a span named `"session.heartbeat"` is emitted

### Req-6: Ended Session Eviction in sweepIdle
The `sweepIdle` function in `session-manager.ts` MUST evict sessions whose `status === "ended"` and whose `endedAt` timestamp is older than a configurable TTL (default: 1 hour). The TTL MUST be configurable via an options parameter at `createSessionManager()` construction time.

Addresses: nx-7f05 (`session-manager.ts:105-115`)

#### Scenario: ended session evicted after TTL
- **WHEN** a session's status is `"ended"` and `endedAt` is 2 hours ago
- **THEN** `sweepIdle()` removes it from the internal Map
- **AND** subsequent `getAll()` calls do not include that session

#### Scenario: recently ended session retained
- **WHEN** a session's status is `"ended"` and `endedAt` is 30 minutes ago (TTL = 1h)
- **THEN** `sweepIdle()` does NOT remove it

#### Scenario: default TTL is 1 hour
- **WHEN** `createSessionManager()` is called without options
- **THEN** ended sessions older than 60 minutes are evicted, sessions ended within 60 minutes are retained

#### Scenario: custom TTL respected
- **WHEN** `createSessionManager({ endedSessionTtlMs: 10_000 })` is called
- **AND** a session ended 15 seconds ago
- **THEN** `sweepIdle()` evicts that session

### Req-7: Session Detail Error Boundaries
The Next.js route `app/session/[id]/` MUST have a co-located `loading.tsx` that renders a skeleton placeholder and an `error.tsx` that renders a user-facing error card with a retry button. The `page.tsx` MUST wrap the async data fetch in a `<Suspense>` boundary so that `loading.tsx` activates during SSR streaming.

Addresses: nx-ia5f (`app/session/[id]/page.tsx:14`)

#### Scenario: loading skeleton shown during fetch
- **WHEN** the session detail page is navigated to and `fetchSessionDetail` has not resolved
- **THEN** the `loading.tsx` skeleton is rendered by Next.js streaming

#### Scenario: error card shown on fetch failure
- **WHEN** `fetchSessionDetail` throws (e.g., agent unreachable)
- **THEN** the `error.tsx` component is rendered with the error message and a "Try again" button

#### Scenario: suspense boundary wraps async component
- **GIVEN** `page.tsx` renders a child async Server Component
- **THEN** the child is wrapped in `<Suspense fallback={<LoadingSkeleton />}>` so the boundary activates

## Scope

**In scope:**
- `crates/nexus-agent/src/grpc/sessions.rs` — Req-1, Req-2, Req-4, Req-5
- `apps/agent/src/routes/sessions.ts` — Req-3
- `apps/agent/src/session-manager.ts` — Req-6
- `apps/nextjs/src/app/session/[id]/loading.tsx` — Req-7 (new file)
- `apps/nextjs/src/app/session/[id]/error.tsx` — Req-7 (new file)
- `apps/agent/src/routes/sessions.test.ts` — un-skip and implement (nx-jl1z)
- `apps/agent/src/session-manager.test.ts` — add status transition tests (nx-xlxx)

**Out of scope:**
- Changes to the gRPC proto definitions
- Changes to the SQLite / PostgreSQL schema
- TUI rendering changes

## Impact

- **Affected specs:** `session-launch`, `session-persistence`, `observability-stack`
- **Affected code:** `crates/nexus-agent/src/grpc/sessions.rs`, `apps/agent/src/routes/sessions.ts`, `apps/agent/src/session-manager.ts`, `apps/nextjs/src/app/session/[id]/`
- **Breaking changes:** None. Field validation in `handle_register_session` is a new rejection path; previously zero-pid registrations silently succeeded.

## Risks

- **Risk: registry.remove() race in rollback** — `register_managed` and `remove` are async; a concurrent `GetSessions` call between the two could briefly observe the orphan. Mitigation: acceptable transient exposure (< 1 ms window); a distributed lock is out of scope.
- **Risk: duplicate-guard false positive** — if `cwd` resolution differs (e.g., symlinks), two paths to the same directory could both pass the idempotency check. Mitigation: normalize `cwd` with `std::fs::canonicalize` before comparison.
- **Risk: sweepIdle TTL misconfiguration** — a very short TTL could evict sessions the TUI is actively displaying. Mitigation: default 1 h is conservative; warn in logs when TTL < 5 min.
- **Risk: integration tests require live PG** — un-skipping tests requires a test PG instance in CI. Mitigation: use `testcontainers` or a `docker-compose` fixture; document in task notes.
