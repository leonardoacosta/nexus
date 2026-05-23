# Proposal: Process Watcher Health Monitoring

## Change ID
`process-watcher-health-monitoring`

## Summary
Add observability to the process watcher (`apps/agent/src/services/process-watcher.ts`) so operators can detect when the 30s reconciliation loop hangs, lags, or errors. Today the watcher is a black box — when it stalls, the dashboard's session list silently goes stale and there is no signal until a human notices ended sessions still showing `status = "active"`. This proposal adds three surfaces: a JSON health endpoint, Prometheus-style counters, and a persisted tick-history table with an alert lifecycle event.

## Why
The process watcher is the authoritative reconciler between live `claude` pids and the `sessions` table. If it hangs (tmux subprocess wedged, pgrep blocking, db connection starved), every downstream view (Swift dashboard, statusline, beads context) silently diverges from reality:

- Closed sessions stay marked `active` because no tick fires to flip `status = "ended"`.
- New sessions never appear because the `INSERT` path is never reached.
- `last_activity` stops moving so freshness-windowed UIs hide live sessions.

There is no metric, no alert, no log signal that distinguishes "watcher healthy, no pid changes" from "watcher dead, all observations stale." The recently-shipped `lastTickMs()` getter (nx-yf45h) gives us the raw heartbeat but nothing reads it yet. This proposal closes the loop: expose the heartbeat as a health probe, count the work the watcher does, and persist enough history to fire an alert when ticks lag past the interval.

## What Changes
- Add `GET /health/process-watcher` JSON probe surfacing `lastTickMs`, `lastTickAgoSeconds`, `lastReconcileError`, `livePidCount`, `staleRowCount`, `resolverCacheHitRatio`, and a derived `healthy` boolean (true when `lastTickAgoSeconds < 90`).
- Add Prometheus-style counters and histograms at `/metrics`: `nexus_pw_pids_opened_total`, `nexus_pw_pids_closed_total`, `nexus_pw_resolver_cache_hits_total`, `nexus_pw_resolver_cache_misses_total`, `nexus_pw_tick_duration_ms` (histogram), `nexus_pw_stale_rows` (gauge).
- Add `process_watcher_state` table tracking the last 100 tick observations (`id`, `observed_at`, `live_pid_count`, `tick_duration_ms`, `error_text`), pruned beyond N rows. Emit `ProcessWatcherStalled` lifecycle event via the dispatcher when the latest row's tick age exceeds 30s OR `error_text` is set.

## Context
- depends on: (none)
- touches: `apps/agent/src/services/process-watcher.ts`, `apps/agent/src/server-request-handler.ts`, `apps/agent/src/routes/health-processes.ts`, `packages/db/src/schema/process-watcher-state.ts`, `packages/db/drizzle/0037_process_watcher_state.sql`

## Impact
- **Capability:** `cc-session-tracking` (NEW spec — no parent exists today; this proposal authors the initial requirements).
- **Breaking:** No. Strictly additive — no existing route, schema, or lifecycle event changes shape.
- **Migration:** Yes — adds one new table (`process_watcher_state`). No backfill required (history populates organically from the next tick onward).
- **Runtime cost:** ~1 INSERT + 1 prune-DELETE per 30s tick; counters are in-process atomics; histogram uses fixed buckets. Negligible.
- **Operator-facing:** New health probe and metrics endpoint are pull-based — no new push, no new external dependency.
