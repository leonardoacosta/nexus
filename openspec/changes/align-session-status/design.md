# Design: Align session status across Rust, DB, and TS layers

## Context

The Nexus platform has three representations of session status/shape:

1. **Rust** (`nexus-core::session::SessionStatus`) — canonical in-memory model used by the agent
   daemon and gRPC layer.
2. **DB** (`packages/db/src/schema/sessions.ts`) — PostgreSQL persistence layer used by the Bun
   HTTP agent and Next.js dashboard.
3. **TypeScript** (`@nexus/core` types, `session-manager.ts`) — runtime model used by the Bun
   agent overlay and Next.js.

These layers drifted: Rust has no `Ended` variant, the DB schema is missing 13 fields, and the
serialization format for `session_type` is wrong. Two operational bugs (stale dedup block, SIGKILL
fire-and-forget) stem from the same model gaps.

## Goals / Non-Goals

- Goals:
  - `SessionStatus::Ended` exists in Rust and maps cleanly to `"ended"` in DB and TS
  - DB sessions table has feature parity with the in-memory Rust `Session` struct
  - `session_type` serializes as `"ad_hoc"` everywhere (Rust, DB, TS, proto)
  - Stale sessions do not permanently block restart of a session at the same `cwd`
  - SIGKILL confirms process death before registry removal
  - Route handlers return structured errors instead of crashing on DB failure
  - `fetchSessionDetail` latency is O(1) not O(N) across agents
  - Integration tests exercise real route logic (no stub `expect(true).toBe(true)`)
  - `session.agent` in the session detail UI is null-safe
  - Duration for ended sessions shows elapsed time, not time-since-start-to-now

- Non-Goals:
  - Migrating existing production rows to back-fill the 13 new columns (NULLs are acceptable)
  - Removing the Rust gRPC layer entirely (Bun overlay coexists with it)
  - Changing the TUI crate session model

## Decisions

### 1. Add `Ended` variant to `SessionStatus`

**Decision:** Add `Ended` as a fifth variant of the `SessionStatus` enum in
`nexus-core/src/session.rs`. Keep `#[serde(rename_all = "snake_case")]` — `Ended` serializes as
`"ended"` automatically.

**Why:** TS and DB already use `"ended"`. The Rust registry's `session_from_record` match arm falls
through to `Stale` for any unknown status string (line 531), silently corrupting recovered sessions
that were ended. Adding the variant makes the conversion complete.

**Proto impact:** The `SessionStatus` proto enum (`proto/nexus.proto`) must gain an `ENDED = 5`
variant. The `From<SessionStatus>` conversion in `nexus-core` must map `Ended ↔ ENDED`.

**Alternatives considered:** Treat `Ended` as a sentinel in the TS layer only. Rejected — the Rust
registry loads sessions from DB on startup and must distinguish ended sessions from stale ones.

### 2. DB schema migration — 13 missing fields

**Decision:** Add a new Drizzle migration that adds the following columns to `sessions`:

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `branch` | `text` | YES | git branch at session start |
| `session_type` | `text` | YES | `"ad_hoc"`, `"managed"`, `"pooled"` |
| `model` | `text` | YES | claude model string |
| `rate_limit_utilization` | `real` | YES | 0.0–1.0 |
| `total_cost_usd` | `double precision` | YES | |
| `ended_at` | `timestamp` | YES | already existed in original schema, keep |
| `rate_limit_reset_at` | `timestamp` | YES | |
| `idle_since` | `timestamp` | YES | |
| `project_id` | `text` | YES | FK to projects table (loose ref) |
| `cc_session_id` | `text` | YES | Claude Code internal session UUID |
| `tmux_session` | `text` | YES | tmux session name |
| `tmux_target` | `text` | YES | pane identifier e.g. "main:0.1" |
| `spec` | `text` | YES | openspec change being worked |

`ended_at` already exists in the current schema — confirm before adding. The migration MUST be
additive only (no column drops). All new columns are nullable; existing rows receive NULLs.

**Alternatives considered:** Create a new `sessions_v2` table. Rejected — unnecessary complexity;
additive migration is safe and simpler.

### 3. Fix `session_type` serialization

**Decision:** Implement `std::fmt::Display` for `SessionType` in `nexus-core/src/session.rs`:

```rust
impl std::fmt::Display for SessionType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionType::AdHoc   => write!(f, "ad_hoc"),
            SessionType::Managed => write!(f, "managed"),
            SessionType::Pooled  => write!(f, "pooled"),
        }
    }
}
```

Replace `format!("{:?}", session.session_type).to_lowercase()` in `registry.rs:504` with
`session.session_type.to_string()`.

**Why:** `{:?}` on `AdHoc` produces `"AdHoc"`, which `.to_lowercase()` turns into `"adhoc"`, not
`"ad_hoc"`. The DB and TS layers expect `"ad_hoc"`.

### 4. Dedup guard: exclude Stale AND Errored

**Decision:** Change the dedup guard in `grpc/sessions.rs:114` from:

```rust
.find(|s| s.cwd == cwd && s.status != SessionStatus::Errored)
```

to:

```rust
.find(|s| s.cwd == cwd
    && s.status != SessionStatus::Errored
    && s.status != SessionStatus::Stale
    && s.status != SessionStatus::Ended)
```

**Why:** Stale sessions should not block restart. A session becomes stale when its heartbeat
exceeds 300s — it is effectively dead. Ended sessions (new variant) should also not block restart.

**Alternatives considered:** Whitelist approach — only return existing session if `Active` or
`Idle`. Preferred over blacklist. Rewrite as:

```rust
.find(|s| s.cwd == cwd
    && matches!(s.status, SessionStatus::Active | SessionStatus::Idle))
```

This is cleaner and future-proof. **Use the whitelist form.**

### 5. SIGKILL death confirmation

**Decision:** After sending SIGKILL, poll `/proc/{pid}` existence with exponential backoff (max 2s,
10 polls at 200ms intervals) before calling `self.registry.remove()`. On Linux this is reliable; on
macOS fall back to a fixed 500ms sleep (compile-time cfg gate).

```rust
// Poll for process death (Linux)
#[cfg(target_os = "linux")]
async fn wait_for_death(pid: u32, timeout_ms: u64) -> bool {
    let path = format!("/proc/{pid}");
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    while tokio::time::Instant::now() < deadline {
        if !std::path::Path::new(&path).exists() { return true; }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}
```

**Why:** The current 500ms sleep is a best-effort guess. If the process is slow to die, the
registry removes it while `/proc/{pid}` still exists, and a rapid restart could collide.

**Alternatives considered:** `waitpid` with `WNOHANG` in a loop. Rejected — requires the agent to
be the process parent, which is not always the case (Claude Code sessions may be started by other
processes).

### 6. Route error handling

**Decision:** Wrap all awaited DB calls in `routes/sessions.ts` in try/catch blocks. On error,
return HTTP 500 with a structured JSON body:

```ts
{ "error": "internal error", "detail": "<error message>" }
```

Do NOT expose raw DB error strings in production; include them only when `process.env.NODE_ENV !==
"production"`.

### 7. `sessionsCache` test isolation

**Decision:** Convert the module-level `sessionsCache` singleton to a closure-scoped variable
inside an exported factory function, or accept an optional injectable cache in the handler
functions. The `clearSessionsCache()` export already exists — retain it. The immediate fix is
to ensure `clearSessionsCache()` is called in `beforeEach` in tests. For structural isolation,
scope the cache to a `createSessionHandlers(db)` factory so each test gets a fresh instance.

### 8. Integration tests — real coverage

**Decision:** Replace all stub `expect(true).toBe(true)` tests with real handler invocations.
Tests call `handleGetSessions(db, url)` and `handleGetSessionById(db, id)` directly (no HTTP
server needed). Use an in-memory SQLite or the existing `POSTGRES_URL` pattern with proper seed
and teardown.

### 9. `session.agent` null guard (Next.js UI)

**Decision:** Change `page.tsx:113` from:

```tsx
<Badge>{session.agent}</Badge>
```

to:

```tsx
<Badge>{session.agent ?? "unknown"}</Badge>
```

### 10. Duration calculation for ended sessions

**Decision:** Change `page.tsx:25-27` from:

```ts
const duration = formatDuration(
  Date.now() - new Date(session.startedAt).getTime(),
);
```

to:

```ts
const endMs = session.endedAt
  ? new Date(session.endedAt).getTime()
  : Date.now();
const duration = formatDuration(endMs - new Date(session.startedAt).getTime());
```

### 11. `fetchSessionDetail` — parallel agent fetch

**Decision:** Replace sequential `for` loop in `session-detail.ts:24-31` with `Promise.all` across
all agents, returning the first non-null result:

```ts
const results = await Promise.all(
  statuses.map(async (status) => {
    const session = await client.fetchSession(status.name, sessionId);
    if (!session) return null;
    const host = await getAgentHost(status.name);
    return { session, agentHost: host ?? "127.0.0.1:7400" };
  }),
);
return results.find((r) => r !== null) ?? null;
```

**Why:** O(N) sequential latency adds up as the number of agents grows. `Promise.all` makes all
fetches concurrent, reducing latency to max(individual fetch latency).

### 12. `detect_stale` — include managed sessions

**Decision:** Remove the `if session.tmux_session.is_some() { continue; }` early-exit guard in
`registry.rs:426-428`. Apply the stale detection logic uniformly. Managed sessions with a tmux
session should still be reaped if their heartbeat has expired — the process may have died leaving
the tmux session name stale.

### 13. `session-manager.ts` — produce stale/errored

**Decision:** Extend the `sweepIdle` function in `session-manager.ts` to add a second pass:
sessions that are `idle` and have been idle for more than a configurable `staleThresholdMs`
(default 300_000) transition to `stale`. Sessions whose `pid` has no `/proc/{pid}` entry on Linux
transition to `errored`. On non-Linux, rely on heartbeat expiry.

## Risks / Trade-offs

- **Proto enum change:** Adding `ENDED = 5` to the proto is backward-compatible (new variant, no
  renumbering). Old TUI clients will receive unknown enum value and fall through to default. This
  is acceptable — TUI clients should be updated in the same release.
- **DB migration additive:** No data loss. Existing rows get NULLs for new columns.
- **`Ended` variant in Rust enum:** All match arms on `SessionStatus` must be exhaustive. The Rust
  compiler will flag non-exhaustive matches, making this a compile-time safety net.
- **`detect_stale` change for managed sessions:** Managed sessions with a live tmux session but
  expired heartbeat will now be marked stale. This is correct behavior — the tmux target alone is
  not proof of liveness.

## Migration Plan

1. Add `Ended` variant to Rust enum → fix all match arms (compiler-guided).
2. Add `ENDED` proto variant → update `From` conversions in `nexus-core`.
3. Implement `Display` for `SessionType` → replace `{:?}` usages in `registry.rs`.
4. Fix dedup guard (whitelist form) in `grpc/sessions.rs`.
5. Add `wait_for_death` helper; wire into stop handler.
6. Write and run Drizzle migration for 13 new DB columns.
7. Update `packages/db/src/schema/sessions.ts` Drizzle schema to match.
8. Add try/catch error handling in `routes/sessions.ts`.
9. Refactor `sessionsCache` for test isolation; update tests.
10. Replace stub tests with real integration tests.
11. Extend `session-manager.ts` sweepIdle with stale/errored transitions.
12. Fix `detect_stale` to include managed sessions.
13. Fix `session.agent` null guard in `page.tsx`.
14. Fix duration calculation in `page.tsx`.
15. Fix `fetchSessionDetail` to use `Promise.all`.
16. Run `cargo test`, `cargo clippy`, `bun test`, `pnpm typecheck`.

**Rollback:** All DB changes are additive. Drop new columns if rollback needed. Proto and Rust
changes require a coordinated binary rollback (agent + TUI). The Bun overlay is stateless so it
rolls back independently.

## Open Questions

- Does the TUI proto client handle unknown enum values gracefully (i.e., does it panic on `ENDED`
  before TUI is updated)? Verify with a proto enum decode test.
- Should `idle_since` be tracked by the Rust registry or only by the Bun `session-manager.ts`?
  Current plan: set by the Rust registry when transitioning to `Idle` status.
- Are there existing Drizzle migrations in `packages/db/drizzle/` that must be sequenced before
  this one? Check migration numbering.
