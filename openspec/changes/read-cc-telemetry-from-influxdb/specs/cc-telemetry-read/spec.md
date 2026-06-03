# cc-telemetry-read Specification

## ADDED Requirements

### Requirement: InfluxDB Read Client
The agent SHALL provide a read-only InfluxDB client that queries the `sensors` bucket via the
InfluxDB 2.x HTTP/Flux API. The client SHALL read `INFLUXDB_URL`, `INFLUXDB_TOKEN`, and
`INFLUXDB_ORG` from the environment. The client SHALL be read-only — it SHALL NOT write points.
When any required variable is unset, the client SHALL degrade gracefully (return empty results),
and the agent SHALL start normally without it.

#### Scenario: Client queries with configuration present
- **WHEN** `INFLUXDB_URL`, `INFLUXDB_TOKEN`, and `INFLUXDB_ORG` are all set
- **AND** a cost read is requested for a session present in the `sensors` bucket
- **THEN** the client issues a Flux query against the `sensors` bucket and returns the matching
  `claude_code.cost.usage` rows

#### Scenario: Degraded when unconfigured
- **WHEN** `INFLUXDB_URL` is not set
- **THEN** the read client returns an empty result and the agent continues to serve requests
  without error

#### Scenario: Read-only — no write path
- **WHEN** the InfluxDB read client is used anywhere in the agent
- **THEN** it exposes only query operations and no write/point-insert operation exists on it

### Requirement: Per-Session Cost and Token Read
The agent SHALL source per-session cost and token usage from native Claude Code OpenTelemetry
series in InfluxDB — `claude_code.cost.usage` and `claude_code.token.usage` (token `type`:
input / output / cacheRead / cacheCreation) — keyed by session identifier and the `project`
resource attribute. The `GET /sessions/{id}/tokens` endpoint SHALL return cost and token
breakdowns sourced from these series.

#### Scenario: Cost read for an instrumented session
- **WHEN** `GET /sessions/{id}/tokens` is called for a session whose `claude_code.*` series exist in
  InfluxDB
- **THEN** the response cost and per-type token totals are derived from the InfluxDB series, not
  from transcript reconstruction

#### Scenario: Token type breakdown preserved
- **WHEN** a session's `claude_code.token.usage` series contains input, output, cacheRead, and
  cacheCreation points
- **THEN** the endpoint returns each token `type` total separately

#### Scenario: Missing series yields empty, not error
- **WHEN** `GET /sessions/{id}/tokens` is called for a session with no `claude_code.*` series in
  InfluxDB
- **THEN** the endpoint returns a zero/empty cost breakdown with HTTP 200, not a 5xx error

### Requirement: Read-Path Verification Gate Before Retirement
The system SHALL verify that `claude_code.cost.usage` and `claude_code.token.usage` series exist in
the InfluxDB `sensors` bucket — proving Claude Code is emitting native telemetry — BEFORE any
transcript-tail or hook-capture path is removed. Retirement of capture code SHALL NOT proceed while
the series are absent.

#### Scenario: Series present unblocks retirement
- **WHEN** a query against the `sensors` bucket returns non-empty `claude_code.cost.usage` rows for
  a recent session
- **THEN** the transcript-tail and hook-capture retirement tasks are unblocked

#### Scenario: Series absent blocks retirement
- **WHEN** the `sensors` bucket contains no `claude_code.*` rows
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
The cc hook pipeline SHALL be retained ONLY for signals that have no InfluxDB analog:
orchestration-lifecycle events (`command_start` / `command_end` carrying `run_id` / `spec` /
`wave` / `phase`, and `agent_telemetry` engineer-cost) and welded session side-effects (PostCompact
context re-injection, Notification TTS, terminal bell). The hook pipeline's capture of
metric / cost / token signals that InfluxDB now provides SHALL be removed. The retained side-effects
SHALL continue to fire.

#### Scenario: Orchestration events still ingested via hook
- **WHEN** a `command_start` event with `run_id` and `spec` is emitted by cc
- **THEN** the residual hook still routes it to the agent (InfluxDB does not carry orchestration
  events)

#### Scenario: TTS side-effect preserved
- **WHEN** a Notification hook event fires
- **THEN** the TTS side-effect still executes (the read-path migration does not remove side-effects)

#### Scenario: Metric capture path removed from hook
- **WHEN** the residual hook receives a signal whose data is now sourced from InfluxDB
  (cost / token / metric)
- **THEN** the hook no longer persists that signal as the cost/token source of truth
