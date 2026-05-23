# Spec: cc-session-tracking

## ADDED Requirements

### Requirement: process-watcher-health-endpoint
The agent SHALL expose `GET /health/process-watcher` returning a JSON snapshot of process-watcher liveness and last-pass observations.

#### Scenario: healthy response after a recent tick
Given the process watcher has completed a reconciliation pass within the last 30 seconds,
When `GET /health/process-watcher` is called,
Then the response is HTTP 200 with JSON body containing `lastTickMs` (number, ms timestamp of last tick), `lastTickAgoSeconds` (number, < 90), `lastReconcileError` (null), `livePidCount` (number), `staleRowCount` (number), `resolverCacheHitRatio` (number in [0,1]), and `healthy: true`.

#### Scenario: unhealthy when tick is stale
Given the process watcher has not ticked in the last 90 seconds,
When `GET /health/process-watcher` is called,
Then the response is HTTP 200 with `lastTickAgoSeconds >= 90` and `healthy: false`.

#### Scenario: never-ticked agent
Given the agent has just started and the watcher has not yet completed a first pass,
When `GET /health/process-watcher` is called,
Then the response is HTTP 200 with `lastTickMs: null`, `lastTickAgoSeconds: null`, and `healthy: false`.

#### Scenario: reconcile error surfaced
Given the most recent tick threw an error captured in `error_text`,
When `GET /health/process-watcher` is called,
Then `lastReconcileError` contains the error message string and `healthy: false`.

---

### Requirement: process-watcher-metrics
The agent SHALL expose Prometheus-style counters, gauges, and histograms describing process-watcher work at the `/metrics` endpoint.

#### Scenario: counter increments on session open
Given the watcher inserts a new session row for a newly-observed claude pid,
When `/metrics` is scraped,
Then `nexus_pw_pids_opened_total` has incremented by one since the prior scrape.

#### Scenario: counter increments on session close
Given the watcher transitions a session row to `status = "ended"` because its pid disappeared,
When `/metrics` is scraped,
Then `nexus_pw_pids_closed_total` has incremented by one since the prior scrape.

#### Scenario: resolver cache hit and miss counters
Given the git-project resolver returns a cached result for one pid and a fresh-resolve result for another in the same tick,
When `/metrics` is scraped,
Then `nexus_pw_resolver_cache_hits_total` increased by one AND `nexus_pw_resolver_cache_misses_total` increased by one.

#### Scenario: tick duration histogram populated
Given the watcher has completed at least one reconciliation pass,
When `/metrics` is scraped,
Then `nexus_pw_tick_duration_ms` exposes histogram buckets with at least one observation recorded.

#### Scenario: stale rows gauge reflects current state
Given the DB contains three session rows whose pids are no longer alive but have not yet been closed (between ticks),
When `/metrics` is scraped,
Then `nexus_pw_stale_rows` reports `3`.

---

### Requirement: process-watcher-tick-history-and-alert
The system SHALL persist tick observations in a `process_watcher_state` table and SHALL emit a `ProcessWatcherStalled` lifecycle event when the latest tick is older than 30 seconds or recorded an error.

#### Scenario: tick observation persisted after each pass
Given the watcher completes a reconciliation pass,
When the pass finishes,
Then a row is inserted into `process_watcher_state` with `observed_at` (now), `live_pid_count` (count of live claude pids this pass), `tick_duration_ms` (wall-clock duration of the pass), and `error_text` (null on success).

#### Scenario: history bounded to N rows
Given the `process_watcher_state` table holds 100 rows and the watcher completes another pass (the configured retention default is 100),
When the new row is inserted,
Then the oldest row is deleted so the table never exceeds 100 rows.

#### Scenario: error captured in row when reconcile throws
Given a reconciliation pass throws an exception,
When the tick completes,
Then the inserted row has `error_text` set to the exception message (non-null) and `tick_duration_ms` reflecting the partial-pass duration.

#### Scenario: alert fires when tick age exceeds threshold
Given the most recent row in `process_watcher_state` is older than 30 seconds,
When the alerting check runs,
Then a `ProcessWatcherStalled` lifecycle event is emitted via the dispatcher with the latest row's `observed_at`, `live_pid_count`, and any `error_text`.

#### Scenario: alert fires when latest row has error_text
Given the most recent row in `process_watcher_state` has `error_text` set (regardless of recency),
When the alerting check runs,
Then a `ProcessWatcherStalled` lifecycle event is emitted with the row's error details.
