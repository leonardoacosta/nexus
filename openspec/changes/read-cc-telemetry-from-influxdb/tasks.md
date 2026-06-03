# Tasks: Read Claude Code telemetry from InfluxDB instead of hook-capturing it
<!-- beads:epic:nx-ev2x5 -->
<!-- beads:feature:nx-c18o7 -->

## DB Batch

- [ ] [1.1] GATE-0: Verify `claude_code.cost.usage` and `claude_code.token.usage` series exist in the InfluxDB `sensors` bucket with a `project`/session resource attribute (proves CC emits via `CLAUDE_CODE_ENABLE_TELEMETRY=1`); blocks all retirement — escalate if absent, do not delete capture code [owner:db-engineer] [beads:nx-em0l5]
- [ ] [1.2] Confirm `sessionTokenTurns` + `sessionTokenWatcherState` have no remaining writers after the API batch; mark for retirement (no data drop in this change) [owner:db-engineer] [beads:nx-co1fe]

## API Batch

- [ ] [2.1] Add read-only InfluxDB client `apps/agent/src/telemetry/influx-read.ts` (HTTP/Flux, `sensors` bucket, env `INFLUXDB_URL`/`INFLUXDB_TOKEN`/`INFLUXDB_ORG`, degraded no-op when unset, query-only) [owner:api-engineer] [beads:nx-4xmyw]
- [ ] [2.2] Add cost/token read service sourcing per-session cost from `claude_code.cost.usage` + per-type tokens from `claude_code.token.usage`, keyed by session + `project` [owner:api-engineer] [beads:nx-a3jx4]
- [ ] [2.3] Repoint `GET /sessions/{id}/tokens` to the InfluxDB read service; empty breakdown + HTTP 200 when no series [owner:api-engineer] [beads:nx-t1jwv]
- [ ] [2.4] Remove transcript-tail cost reconstruction (`credentials/token-stream/*`, `credentials/model-pricing.ts`); stop the token-stream watcher [owner:api-engineer] [beads:nx-1io0x]
- [ ] [2.5] Scope cc hook dispatcher to residual-only: keep orchestration events + side-effects (PostCompact/TTS/bell); remove metric/cost/token capture paths [owner:api-engineer] [beads:nx-vjlrf]
- [ ] [2.6] Add `INFLUXDB_URL`/`INFLUXDB_TOKEN`/`INFLUXDB_ORG` to `deploy/secrets.env.example` + agent startup config [owner:api-engineer] [beads:nx-8fbrq]

## UI Batch

- [ ] [3.1] Verify dashboard consumers of `/sessions/{id}/tokens` (Swift dashboards — nexus-mac/ios) render per-session cost/tokens unchanged from the repointed endpoint [owner:ui-engineer] [beads:nx-nt5ex]

## E2E Batch

- [ ] [4.1] E2E: `GET /sessions/{id}/tokens` returns cost + per-type tokens sourced from InfluxDB for a session with `claude_code.*` series present [owner:e2e-engineer] [beads:nx-fmvr9]
- [ ] [4.2] E2E: read client degrades gracefully — `INFLUXDB_URL` unset yields empty breakdown (HTTP 200), agent stays healthy [owner:e2e-engineer] [beads:nx-kyq8m]
- [ ] [4.3] E2E: residual hook still delivers an orchestration event (`command_start` with `run_id`) and still fires the Notification TTS side-effect [owner:e2e-engineer] [beads:nx-hysk5]

## Housekeeping

- [ ] Archive/supersede the `explore-native-otel-telemetry` exploration (read-from-InfluxDB replaces its Collector -> Postgres shim)
