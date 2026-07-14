## MODIFIED Requirements

### Requirement: Per-Session Cost and Token Read

The agent SHALL source per-session cost and token usage from native Claude Code OpenTelemetry
series in VictoriaMetrics — `claude_code_cost_usage_USD_total` and `claude_code_token_usage_total`
(label `type`: input / output / cacheRead / cacheCreation) — keyed by session identifier and the
`project` label. Queries SHALL filter on `session_id=~".+"`, matching the filter cc's own Grafana
dashboard requires to avoid the reset-collision inflation bug on series that share a label set
across concurrent sessions/subagents. `GET /statusline?sessionId=<id>` SHALL return cost and
token breakdowns sourced from these series (`session.usage` field, per `redesign-status-usage-
endpoints`'s `session-persistence` delta), replacing the retired standalone
`GET /sessions/{id}/tokens` route. `readSessionCostTokens` itself is unchanged — only its caller
moves.

#### Scenario: Cost read for an instrumented session
- **WHEN** `GET /statusline?sessionId=<id>` is called for a session whose `claude_code_*` series
  exist in VictoriaMetrics
- **THEN** the response's `session.usage` cost and per-type token totals are derived from the
  VictoriaMetrics series, not from transcript reconstruction

#### Scenario: Token type breakdown preserved
- **WHEN** a session's `claude_code_token_usage_total` series contains input, output, cacheRead, and
  cacheCreation points
- **THEN** `session.usage` in the `GET /statusline?sessionId=` response contains each token `type`
  total separately

#### Scenario: Missing series yields empty, not error
- **WHEN** `GET /statusline?sessionId=<id>` is called for a session with no `claude_code_*` series in
  VictoriaMetrics
- **THEN** `session.usage` is the zero/empty cost breakdown with HTTP 200, not a 5xx error

#### Scenario: Reset-collision filter applied
- **WHEN** a `claude_code_cost_usage_USD_total` series lacks a `session_id` label (a known collision
  source for concurrent/subagent dispatches)
- **THEN** the read service's query excludes it via `session_id=~".+"`, matching cc's dashboard
  mitigation, rather than double-counting or inflating the total

#### Scenario: Standalone route retired

- **WHEN** a client requests the old `GET /sessions/{id}/tokens` path
- **THEN** the route no longer exists (removed by `redesign-status-usage-endpoints` task 2.5);
  callers use `GET /statusline?sessionId=<id>` instead
