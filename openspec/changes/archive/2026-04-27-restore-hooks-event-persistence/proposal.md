---
status: draft
---

# Proposal: restore-hooks-event-persistence

## Change ID
`restore-hooks-event-persistence`

## Summary
Restore actual persistence in `apps/agent/src/routes/hooks.ts` `handleHooks`. The endpoint regressed to a no-op stub that logs incoming events and returns 200 OK without writing to the events table or updating the sessions table. Extend `session_summary` persistence to populate `total_cost_usd`, `ended_at`, `status='ended'`, and token-usage fields when cc telemetry includes them.

## Context
- Affects: `apps/agent/src/routes/hooks.ts`, `apps/agent/src/db/sessions.ts`, `apps/agent/src/db/events.ts`
- Capabilities: extends `hooks-endpoint` and `session-persistence`
- Companion proposal: cc-side `populate-and-backfill-cost-telemetry` that supplies the cost data this proposal persists
- Related archived: `add-http-hooks-receiver`, `add-sqlite-store`

## Motivation

### The bug

`handleHooks` self-confesses in source comments: "Current behavior: acknowledge and log. Event processing... tracked as future work." All known event types (`session_start`, `session_stop`, `session_summary`, `stop_failure`, `stop_success`, `session_heartbeat`) return 200 OK without DB writes.

### Empirical evidence

| Symptom | Observation |
|---|---|
| Last event row | 2026-04-04T20:04:41 |
| Total events after April 4 | 0 |
| Sessions with `ended_at` | 0 of 147 |
| Sessions with `total_cost_usd` | 0 of 147 |
| Live diagnostic ping (`event_type: "diagnostic_ping"`) | Received by agent (logged), NOT in events table |

The `/hooks` endpoint is up, accepts payloads, returns 200 — but persists nothing. The 147 historical `session_start` rows were written by an earlier code path that the 2026-04-24 refactor (which removed the unix-socket layer in favor of HTTP) accidentally turned into a no-op.

### Why this matters now

cc downstream operations cannot answer empirical cost questions:
- Compare `/audit:waves` omnibus bundling vs old per-spec bundling
- Quantify `/apply:all` per-phase token spend
- Aggregate cost-per-session across 11 registered projects

All require populated session data. The schema is ready (`total_cost_usd`, `ended_at`, `model`, `rate_limit_*` columns exist); the write path is missing.

## What Changes

### `handleHooks` writes events (always)

Every recognized event type SHALL produce a row in the `events` table. Required columns: `event_type`, `session_id`, `project`, `timestamp`, plus full JSON payload in a `data` column.

### `session_start` updates sessions table

When `session_start` arrives, INSERT a row into `sessions` with `status='active'`, `started_at`, `model`, `cwd`, `branch`, `project`, `cc_session_id`. ON CONFLICT `(id)`, UPDATE the metadata fields.

### `session_summary` populates cost fields

When `session_summary` arrives carrying `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, and/or `cost_usd` fields, UPDATE the corresponding session row's `total_cost_usd` and per-turn token aggregates. Compute cost server-side from token counts + `model` if `cost_usd` is absent.

### `session_stop` finalizes the row

When `session_stop` arrives, UPDATE `ended_at = NOW()` and `status = 'ended'` for the session.

### `stop_failure` marks failure

When `stop_failure` arrives, UPDATE `status = 'errored'`, store `stop_reason` in event row.

## Impact

### Behavior change
- `/hooks` endpoint becomes non-trivial. Latency increases from <1ms (log only) to ~5–15ms per event (one or two writes). Acceptable — events are fire-and-forget from cc.
- 147 stale sessions stay open unless an explicit cleanup migration retires them. RECOMMEND: a one-time UPDATE setting `status='ended'` for sessions with `started_at < 2026-04-24` (the regression date). Filed as task 1.7 below.

### Schema
No schema migration required — existing columns are sufficient. All target fields (`total_cost_usd`, `ended_at`, `status`) already exist.

### Companion dependency
Without cc-side `populate-and-backfill-cost-telemetry` (which extends `cc-session-stats` and the `session_summary` payload), this proposal alone produces incomplete data — events are written but cost fields stay NULL because cc never sends them. The two proposals MUST land in either order; nx side won't break cc, cc side won't break nx.

### Trade-offs accepted

| Trade-off | Decision rationale |
|---|---|
| Latency: ~5–15ms per event vs <1ms | cc events are fire-and-forget; acceptable |
| Cost computed server-side if absent | Simpler than requiring all callers to pre-compute |
| 147 stale sessions retired by date heuristic | Cleaner than requiring per-session manual close |
| No schema change | Lowest-risk path; columns already exist |
