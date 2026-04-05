## MODIFIED Requirements

### Requirement: Atomic Session Registration
The `StartSession` gRPC handler MUST register sessions only after bootstrap spawn succeeds.

#### Scenario: spawn failure rolls back registry entry
- **WHEN** `tokio::process::Command::new("claude")` returns `Err`
- **THEN** `registry.remove(&session_id)` is called and no orphaned session is visible

#### Scenario: successful spawn retains registry entry
- **WHEN** the bootstrap process spawns successfully
- **THEN** the session remains registered

### Requirement: Idempotent Session Creation
`StartSession` MUST return the existing session_id if a live session for the same `cwd` exists.

#### Scenario: duplicate project path returns existing session
- **WHEN** `StartSession` is called for a `cwd` with an active session
- **THEN** the existing `session_id` is returned and no new process is spawned

#### Scenario: ended session allows re-creation
- **WHEN** the only matching session has status `ended`
- **THEN** a new session is created normally

### Requirement: Complete Session Status Filter
`GET /sessions` MUST accept `stale` and `errored` as valid `?status=` filter values.

#### Scenario: stale filter accepted
- **WHEN** `GET /sessions?status=stale` is called
- **THEN** HTTP 200 is returned with matching sessions

#### Scenario: errored filter accepted
- **WHEN** `GET /sessions?status=errored` is called
- **THEN** HTTP 200 is returned with matching sessions

#### Scenario: invalid status rejected
- **WHEN** `GET /sessions?status=bogus` is called
- **THEN** HTTP 400 is returned listing all five valid values

### Requirement: Validated gRPC Registration Fields
`RegisterSession` MUST reject zero pid, empty cwd, and empty session_id.

#### Scenario: zero pid rejected
- **WHEN** `RegisterSession` is called with `pid = 0`
- **THEN** `Status::invalid_argument("pid must be non-zero")` is returned

#### Scenario: valid fields accepted
- **WHEN** all fields are non-empty and pid is non-zero
- **THEN** the session is registered successfully

### Requirement: Complete OTel Instrumentation
All six gRPC session handlers MUST have `#[tracing::instrument]` with span names `session.<verb>`.

#### Scenario: get_sessions span emitted
- **WHEN** `GetSessions` is called
- **THEN** a span named `session.get_all` is present in the trace

#### Scenario: heartbeat span emitted
- **WHEN** `Heartbeat` is called
- **THEN** a span named `session.heartbeat` is present in the trace

### Requirement: Ended Session Eviction
`sweepIdle` MUST evict sessions with `status === "ended"` older than a configurable TTL (default 1h).

#### Scenario: ended session evicted after TTL
- **WHEN** a session is `ended` and `endedAt` is 2 hours ago
- **THEN** `sweepIdle` removes it from the Map

#### Scenario: recently ended session retained
- **WHEN** `endedAt` is 30 minutes ago (TTL = 1h)
- **THEN** `sweepIdle` does NOT remove it

### Requirement: Session Detail Error Boundaries
The session detail route MUST have `loading.tsx`, `error.tsx`, and a Suspense boundary.

#### Scenario: loading skeleton during fetch
- **WHEN** `fetchSessionDetail` has not resolved
- **THEN** `loading.tsx` skeleton is rendered

#### Scenario: error card on fetch failure
- **WHEN** `fetchSessionDetail` throws
- **THEN** `error.tsx` renders with message and retry button
