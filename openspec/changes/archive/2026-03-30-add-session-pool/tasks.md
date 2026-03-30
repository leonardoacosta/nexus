<!-- beads:epic:nexus-60f -->

## 1. Proto: Extend CommandRequest [beads:nexus-x4j]

- [x] Add optional `string project = 3` field to `CommandRequest` in `proto/nexus.proto`
- [x] Add `SESSION_TYPE_POOLED = 3` to `SessionType` enum
- [x] Regenerate protobuf code

## 2. Core: Session Type Extension [beads:nexus-612]

- [x] Add `Pooled` variant to session type in `crates/nexus-core/src/session.rs`
- [x] Pooled sessions are tracked separately from managed and ad-hoc sessions
- [x] Pooled sessions do not appear in `GetSessions` by default (filter opt-in)

## 3. Service: Session Pool Implementation [beads:nexus-eec]

- [x] Create `crates/nexus-agent/src/services/session_pool.rs`
  - `SessionPool` struct holding `HashMap<String, PooledSession>` (project code → session)
  - `PooledSession`: session_id, created_at, last_used_at, status (warming/ready/busy/draining)
  - `get_or_create(project: &str) -> Result<String>` — returns session ID, creating if needed
  - `release(session_id: &str)` — mark session as available after command completes
  - Pool creation: `StartSession` with bootstrap prompt, wait for ready signal
  - Concurrency: `tokio::sync::RwLock` for pool state, `tokio::sync::Semaphore` per session
    (one command at a time per pooled session)

## 4. Service: Pool Lifecycle Management [beads:nexus-x9u]

- [x] Idle eviction: background task checks `last_used_at` every 60s, evicts sessions idle > 15min
- [x] Health checking: periodically verify pooled session PID is alive, replace dead sessions
- [x] Drain on shutdown: graceful shutdown sends stop to all pooled sessions
- [x] Max pool size: configurable limit (default 5 concurrent pooled sessions across all projects)

## 5. Config: Pool Settings [beads:nexus-jyn]

- [x] Add `[pool]` section to `agents.toml` config:
  ```toml
  [pool]
  enabled = true
  max_sessions = 5
  idle_timeout_minutes = 15
  warmup_on_startup = []  # project codes to pre-warm
  ```
- [x] Integrate with config hot-reload

## 6. gRPC: Extend SendCommand [beads:nexus-fzl]

- [x] When `CommandRequest.project` is set (and `session_id` is empty):
  - Resolve project via registry
  - Acquire pooled session via `SessionPool::get_or_create`
  - Execute command against pooled session
  - Release session back to pool after stream completes
- [x] When both `session_id` and `project` are set, prefer `session_id`
- [x] Return `UNAVAILABLE` if pool is at capacity and all sessions busy

## 7. Integration: Wire into Agent [beads:nexus-m1m]

- [x] Initialize `SessionPool` in agent startup
- [x] Pass pool reference to gRPC service
- [x] Register pool cleanup in graceful shutdown handler
- [x] Add pool stats to `GetHealth` response (active/idle/total pooled sessions)

## 8. Tests [beads:nexus-p00]

- [x] Unit tests for pool state machine (warming → ready → busy → ready → draining)
- [x] Unit tests for idle eviction logic
- [x] Integration test: SendCommand with project field creates pooled session
- [x] Integration test: second command reuses existing pooled session
- [x] Integration test: idle session evicted after timeout
