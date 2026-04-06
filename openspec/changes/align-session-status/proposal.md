# Change: Align session status across Rust, DB, and TS layers

## Why

The platform audit (2026-04-06) found 13 gaps between the Rust `SessionStatus` enum, the DB
sessions schema, and the TypeScript session model. These mismatches cause silent data loss, contract
violations at the API boundary, and unreachable code paths (e.g., `ended` sessions are persisted by
TS but the Rust enum has no `Ended` variant). Two operational bugs — stale sessions blocking
restarts and SIGKILL fire-and-forget — are included because they share the same status model.

## What Changes

- **BREAKING**: Add `Ended` variant to `SessionStatus` enum in `nexus-core/src/session.rs`
- **BREAKING**: DB migration to expand `sessions` table with 13 missing fields: `branch`,
  `session_type`, `model`, `rate_limit_utilization`, `total_cost_usd`, `ended_at`,
  `rate_limit_reset_at`, `idle_since`, `project_id`, `pid` (already exists — widen to bigint),
  `cwd` (already exists), plus `cc_session_id` and `tmux_target`
- Fix `session_type` serialization: implement `Display` trait on `SessionType` to produce `"ad_hoc"`
  instead of using `{:?}` which produces `"AdHoc"` (`registry.rs:504`)
- Fix dedup guard: exclude `Stale` AND `Errored` from blocking session restart; currently only
  `Errored` is excluded, meaning stale sessions permanently block new sessions for that `cwd`
  (`grpc/sessions.rs:114`)
- Fix SIGKILL: poll `/proc/{pid}` or use `waitpid` to confirm process death before removing from
  registry; currently fire-and-forget after 500ms sleep (`grpc/sessions.rs:310-314`)
- Fix error handling: wrap `handleGetSessions` and `handleGetSessionById` DB calls in try/catch
  with structured JSON error responses (`routes/sessions.ts:66,83`)
- Fix `sessionsCache` module-level singleton to accept an injectable cache object for test isolation
  (`routes/sessions.ts:23`)
- Fix `session.agent` rendered without null guard in session detail page (`page.tsx:113`)
- Fix duration calculation for ended sessions: use `endedAt` not `Date.now()` (`page.tsx:25-27`)
- Fix `fetchSessionDetail` sequential agent iteration: use `Promise.all` for parallel fetching
  (`session-detail.ts:24-31`)
- Fix `detect_stale` to include managed sessions: currently skips them via `tmux_session.is_some()`
  guard, leaving hung managed sessions unreachable (`registry.rs:426`)
- Fix `session-manager.ts` to produce `stale` and `errored` statuses during sweep; currently only
  transitions to `idle` (`session-manager.ts:121`)
- Replace all stub integration tests with real route coverage (`routes/sessions.test.ts`)

## Impact

- Affected specs: `session-persistence`, `core`
- Affected code:
  - `crates/nexus-core/src/session.rs` — enum change (breaking)
  - `crates/nexus-agent/src/registry.rs` — serialization fix, stale detection
  - `crates/nexus-agent/src/grpc/sessions.rs` — dedup guard, SIGKILL confirmation
  - `packages/db/src/schema/sessions.ts` — schema expansion (DB migration required)
  - `apps/agent/src/routes/sessions.ts` — error handling, cache isolation
  - `apps/agent/src/routes/sessions.test.ts` — real integration tests
  - `apps/agent/src/session-manager.ts` — stale/errored status transitions
  - `apps/nextjs/src/app/session/[id]/page.tsx` — null guard, duration fix
  - `apps/nextjs/src/app/actions/session-detail.ts` — parallel agent fetch
- Proto definitions may need updating if `SessionStatus` proto enum does not have an `ENDED` variant
