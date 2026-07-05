# Tasks: Read Claude Code telemetry from VictoriaMetrics instead of hook-capturing it
<!-- beads:epic:nx-ev2x5 -->
<!-- beads:feature:nx-c18o7 -->
<!-- Corrected 2026-07-05: target backend is VictoriaMetrics, not InfluxDB (retired). See proposal.md's Correction note. Same epic/feature beads IDs retained. -->

## DB Batch

- [x] [1.1] GATE-0: Verify `claude_code_cost_usage_USD_total` and `claude_code_token_usage_total` series exist in VictoriaMetrics with a `project`/`session_id` label (proves CC emits via `CLAUDE_CODE_ENABLE_TELEMETRY=1`). **DONE 2026-07-05**: `curl http://172.20.0.200:8428/api/v1/query -d 'query=count(claude_code_cost_usage_USD_total)'` returned 76 series from the homelab host. Retirement unblocked. [owner:db-engineer] [beads:nx-em0l5]
- [x] [1.2] Confirm `sessionTokenTurns` + `sessionTokenWatcherState` have no remaining writers after the API batch; mark for retirement (no data drop in this change) [owner:db-engineer] [beads:nx-co1fe]

## API Batch

- [x] [2.1] Add read-only VictoriaMetrics client `apps/agent/src/telemetry/vm-read.ts` (PromQL/HTTP against `VM_URL`, default `http://172.20.0.200:8428`, degraded no-op when unset, query-only — no remote-write) [owner:api-engineer] [beads:nx-4xmyw]
- [x] [2.2] Add cost/token read service sourcing per-session cost from `claude_code_cost_usage_USD_total` + per-type tokens from `claude_code_token_usage_total`, keyed by `session_id` + `project` label. MUST filter `session_id=~".+"` (excludes the label-collision series cc's own dashboard had to filter — see proposal.md's Why section) [owner:api-engineer] [beads:nx-a3jx4]
- [x] [2.3] Repoint `GET /sessions/{id}/tokens` to the VictoriaMetrics read service; empty breakdown + HTTP 200 when no series [owner:api-engineer] [beads:nx-t1jwv]
- [x] [2.4] Remove transcript-tail cost reconstruction (`credentials/token-stream/*`, `credentials/model-pricing.ts`); stop the token-stream watcher [owner:api-engineer] [beads:nx-1io0x]
- [x] [2.5] Scope cc hook dispatcher to residual-only: keep orchestration events + side-effects (PostCompact/TTS/bell); remove metric/cost/token capture paths [owner:api-engineer] [beads:nx-vjlrf]
- [x] [2.6] Add `VM_URL` to `deploy/secrets.env.example` + agent startup config (default `http://172.20.0.200:8428`; no auth token needed — VM has no auth layer on this internal-only endpoint) [owner:api-engineer] [beads:nx-8fbrq]

## UI Batch

- [ ] [3.1] Verify dashboard consumers of `/sessions/{id}/tokens` (Swift dashboards — nexus-mac/ios) render per-session cost/tokens unchanged from the repointed endpoint [owner:ui-engineer] [beads:nx-nt5ex]

## E2E Batch

- [ ] [4.1] E2E: `GET /sessions/{id}/tokens` returns cost + per-type tokens sourced from VictoriaMetrics for a session with `claude_code_*` series present [owner:e2e-engineer] [beads:nx-fmvr9]
- [ ] [4.2] E2E: read client degrades gracefully — `VM_URL` unset yields empty breakdown (HTTP 200), agent stays healthy [owner:e2e-engineer] [beads:nx-kyq8m]
- [ ] [4.3] E2E: residual hook still delivers an orchestration event (`command_start` with `run_id`) and still fires the Notification TTS side-effect [owner:e2e-engineer] [beads:nx-hysk5]
- [ ] [4.4] E2E: a `claude_code_cost_usage_USD_total` series without a `session_id` label is excluded from the per-session total (reset-collision filter regression test) [owner:e2e-engineer] [new task — no beads ID yet, mint on next spec-sync]

## Housekeeping

- [ ] Archive/supersede the `explore-native-otel-telemetry` exploration (read-from-VictoriaMetrics replaces its Collector -> Postgres shim)
