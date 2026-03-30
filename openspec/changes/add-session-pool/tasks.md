## 1. Proto: Extend CommandRequest

- [ ] Add optional `string project = 3` field to `CommandRequest` in `proto/nexus.proto`
- [ ] Add `SESSION_TYPE_POOLED = 3` to `SessionType` enum
- [ ] Regenerate protobuf code

## 2. Core: Session Type Extension

- [ ] Add `Pooled` variant to session type in `crates/nexus-core/src/session.rs`
- [ ] Pooled sessions are tracked separately from managed and ad-hoc sessions
- [ ] Pooled sessions do not appear in `GetSessions` by default (filter opt-in)

## 3. Service: Session Pool Implementation

- [ ] Create `crates/nexus-agent/src/services/session_pool.rs`
  - `SessionPool` struct holding `HashMap<String, PooledSession>` (project code → session)
  - `PooledSession`: session_id, created_at, last_used_at, status (warming/ready/busy/draining)
  - `get_or_create(project: &str) -> Result<String>` — returns session ID, creating if needed
  - `release(session_id: &str)` — mark session as available after command completes
  - Pool creation: `StartSession` with bootstrap prompt, wait for ready signal
  - Concurrency: `tokio::sync::RwLock` for pool state, `tokio::sync::Semaphore` per session
    (one command at a time per pooled session)

## 4. Service: Pool Lifecycle Management

- [ ] Idle eviction: background task checks `last_used_at` every 60s, evicts sessions idle > 15min
- [ ] Health checking: periodically verify pooled session PID is alive, replace dead sessions
- [ ] Drain on shutdown: graceful shutdown sends stop to all pooled sessions
- [ ] Max pool size: configurable limit (default 5 concurrent pooled sessions across all projects)

## 5. Config: Pool Settings

- [ ] Add `[pool]` section to `agents.toml` config:
  ```toml
  [pool]
  enabled = true
  max_sessions = 5
  idle_timeout_minutes = 15
  warmup_on_startup = []  # project codes to pre-warm
  ```
- [ ] Integrate with config hot-reload

## 6. gRPC: Extend SendCommand

- [ ] When `CommandRequest.project` is set (and `session_id` is empty):
  - Resolve project via registry
  - Acquire pooled session via `SessionPool::get_or_create`
  - Execute command against pooled session
  - Release session back to pool after stream completes
- [ ] When both `session_id` and `project` are set, prefer `session_id`
- [ ] Return `UNAVAILABLE` if pool is at capacity and all sessions busy

## 7. Integration: Wire into Agent

- [ ] Initialize `SessionPool` in agent startup
- [ ] Pass pool reference to gRPC service
- [ ] Register pool cleanup in graceful shutdown handler
- [ ] Add pool stats to `GetHealth` response (active/idle/total pooled sessions)

## 8. Tests

- [ ] Unit tests for pool state machine (warming → ready → busy → ready → draining)
- [ ] Unit tests for idle eviction logic
- [ ] Integration test: SendCommand with project field creates pooled session
- [ ] Integration test: second command reuses existing pooled session
- [ ] Integration test: idle session evicted after timeout
