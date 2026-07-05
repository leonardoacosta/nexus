# cc-telemetry-read Specification

## Purpose
TBD - created by archiving change read-cc-telemetry-from-influxdb. Update Purpose after archive.
## Requirements
### Requirement: VictoriaMetrics Read Client
The agent SHALL provide a read-only VictoriaMetrics client that queries via the PromQL-compatible
HTTP API (`/api/v1/query` / `/api/v1/query_range`). The client SHALL read `VM_URL` from the
environment (default `http://172.20.0.200:8428`, the compose-pinned static IP of the
`victoria-metrics` container). The client SHALL be read-only — it SHALL NOT write/remote-write
points. When `VM_URL` is unset, the client SHALL degrade gracefully (return empty results), and the
agent SHALL start normally without it.

#### Scenario: Client queries with configuration present
- **WHEN** `VM_URL` is set
- **AND** a cost read is requested for a session present in VictoriaMetrics
- **THEN** the client issues a PromQL query against `VM_URL` and returns the matching
  `claude_code_cost_usage_USD_total` samples

#### Scenario: Degraded when unconfigured
- **WHEN** `VM_URL` is not set
- **THEN** the read client returns an empty result and the agent continues to serve requests
  without error

#### Scenario: Read-only — no write path
- **WHEN** the VictoriaMetrics read client is used anywhere in the agent
- **THEN** it exposes only query operations and no write/remote-write operation exists on it

### Requirement: Per-Session Cost and Token Read
The agent SHALL source per-session cost and token usage from native Claude Code OpenTelemetry
series in VictoriaMetrics — `claude_code_cost_usage_USD_total` and `claude_code_token_usage_total`
(label `type`: input / output / cacheRead / cacheCreation) — keyed by session identifier and the
`project` label. Queries SHALL filter on `session_id=~".+"`, matching the filter cc's own Grafana
dashboard requires to avoid the reset-collision inflation bug on series that share a label set
across concurrent sessions/subagents. The `GET /sessions/{id}/tokens` endpoint SHALL return cost and
token breakdowns sourced from these series.

#### Scenario: Cost read for an instrumented session
- **WHEN** `GET /sessions/{id}/tokens` is called for a session whose `claude_code_*` series exist in
  VictoriaMetrics
- **THEN** the response cost and per-type token totals are derived from the VictoriaMetrics series,
  not from transcript reconstruction

#### Scenario: Token type breakdown preserved
- **WHEN** a session's `claude_code_token_usage_total` series contains input, output, cacheRead, and
  cacheCreation points
- **THEN** the endpoint returns each token `type` total separately

#### Scenario: Missing series yields empty, not error
- **WHEN** `GET /sessions/{id}/tokens` is called for a session with no `claude_code_*` series in
  VictoriaMetrics
- **THEN** the endpoint returns a zero/empty cost breakdown with HTTP 200, not a 5xx error

#### Scenario: Reset-collision filter applied
- **WHEN** a `claude_code_cost_usage_USD_total` series lacks a `session_id` label (a known collision
  source for concurrent/subagent dispatches)
- **THEN** the read service's query excludes it via `session_id=~".+"`, matching cc's dashboard
  mitigation, rather than double-counting or inflating the total

### Requirement: Read-Path Verification Gate Before Retirement
The system SHALL verify that `claude_code_cost_usage_USD_total` and `claude_code_token_usage_total`
series exist in VictoriaMetrics — proving Claude Code is emitting native telemetry — BEFORE any
transcript-tail or hook-capture path is removed. Retirement of capture code SHALL NOT proceed while
the series are absent. This gate is satisfied as of 2026-07-05 (76 cost-metric series confirmed via
a direct PromQL query from the homelab host) — retirement tasks are unblocked, not pending.

#### Scenario: Series present unblocks retirement
- **WHEN** a query against VictoriaMetrics returns non-empty `claude_code_cost_usage_USD_total`
  samples for a recent session
- **THEN** the transcript-tail and hook-capture retirement tasks are unblocked

#### Scenario: Series absent blocks retirement
- **WHEN** VictoriaMetrics contains no `claude_code_*` samples
- **THEN** the capture paths remain in place and the read-path falls back to (or coexists with) the
  existing source until emission is confirmed

### Requirement: Transcript-Tail Cost Reconstruction Removed
The agent SHALL NOT read `~/.claude/projects/<cwd>/<session>.jsonl` to reconstruct per-session cost.
After the Read-Path Verification Gate passes, the `credentials/token-stream/*` reader and
`credentials/model-pricing.ts` price table SHALL be removed as the per-session cost source, and the
token-stream watcher SHALL NOT be started.

#### Scenario: No transcript read for cost
- **WHEN** per-session cost is computed after this change
- **THEN** no code path reads the per-session `.jsonl` transcript to reconstruct cost

#### Scenario: Token-watcher state no longer written
- **WHEN** the agent runs after retirement
- **THEN** the `sessionTokenWatcherState` table has no active writer and the token-stream watcher is
  not started

### Requirement: Residual Hook Boundary
The cc hook pipeline SHALL be retained ONLY for signals that have no VictoriaMetrics analog:
orchestration-lifecycle events (`command_start` / `command_end` carrying `run_id` / `spec` /
`wave` / `phase`, and `agent_telemetry` engineer-cost) and welded session side-effects (PostCompact
context re-injection, Notification TTS, terminal bell). The hook pipeline's capture of
metric / cost / token signals that VictoriaMetrics now provides SHALL be removed. The retained
side-effects SHALL continue to fire.

#### Scenario: Orchestration events still ingested via hook
- **WHEN** a `command_start` event with `run_id` and `spec` is emitted by cc
- **THEN** the residual hook still routes it to the agent (VictoriaMetrics does not carry
  orchestration events)

#### Scenario: TTS side-effect preserved
- **WHEN** a Notification hook event fires
- **THEN** the TTS side-effect still executes (the read-path migration does not remove side-effects)

#### Scenario: Metric capture path removed from hook
- **WHEN** the residual hook receives a signal whose data is now sourced from VictoriaMetrics
  (cost / token / metric)
- **THEN** the hook no longer persists that signal as the cost/token source of truth

