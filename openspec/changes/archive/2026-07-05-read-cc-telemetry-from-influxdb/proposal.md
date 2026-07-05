# Change: Read Claude Code telemetry from VictoriaMetrics instead of hook-capturing it

> **Correction (2026-07-05):** this proposal originally targeted InfluxDB. Smoke-tested against
> live infra before implementation started: Telegraf + InfluxDB were retired in the homelab
> (`hl` repo, `openspec/changes/retire-telegraf-to-lgtm`) — no `influxdb`/`telegraf` service exists
> in the current compose (`homelab/compose/observability.yml:7` says so explicitly), only orphaned
> volumes. cc's own `settings.json` confirms the live OTLP endpoint is `localhost:4318` (HTTP), not
> the `:4317` gRPC path this proposal assumed. Current architecture is `cc -> Alloy (:4318) ->
> VictoriaMetrics` (PromQL-compatible, 24mo retention, explicitly replacing InfluxDB's retention
> role per the retirement proposal). Verified live 2026-07-05 from this same host:
> `curl http://172.20.0.200:8428/api/v1/query -d 'query=count(claude_code_cost_usage_USD_total)'`
> returned **76 series** — GATE-0 is satisfied, not blocked. The directory/change-id keeps the
> `-influxdb` name for git-history and beads continuity (`nx-ev2x5`/`nx-c18o7`); only the target
> backend below is corrected.

## Why

Nexus currently reconstructs per-session cost and token usage with a **transcript-tail hack**
(`apps/agent/src/credentials/token-stream/*` + `model-pricing.ts`) that re-reads
`~/.claude/projects/<cwd>/<session>.jsonl` to approximate native cost — a workaround for the
absence of a real cost feed. It also captures most `claude_code.*` signals through a **custom hook
pipeline** (`telemetry.sh` -> `nexus-emit` -> socket-server dispatcher -> Postgres).

The homelab's shared OTLP ingress is `Alloy (:4318 HTTP)`, fanning out to **VictoriaMetrics**
(metrics, PromQL-compatible, 24mo retention) and Loki (logs). Claude Code 2.1.158+ ships native
OpenTelemetry: with `CLAUDE_CODE_ENABLE_TELEMETRY=1` (already set in cc's `settings.json`) it emits
`claude_code_cost_usage_USD_total`, `claude_code_token_usage_total` (attr `type`:
input/output/cacheRead/cacheCreation), `claude_code.session.count`, and structured log events
straight to that ingress. **The authoritative cost + token data already lands in VictoriaMetrics**
— confirmed live, not aspirational (76 cost-metric series present as of 2026-07-05). Note: cc's own
Grafana dashboard hit a reset-collision inflation bug on these exact series (concurrent
sessions/subagents sharing a label set without `session_id`) — any VM reader here MUST apply the
same `session_id=~".+"` filter cc's dashboard fix uses, or per-session totals will be wrong for
subagent-heavy sessions.

So Nexus should **read** that data, not re-capture it. Reading native `claude_code_*` series from
VictoriaMetrics lets us delete the transcript-tail reconstruction and retire the hook pipeline's
metric-capture paths — replacing an approximation with the source of truth and removing a fragile
parser. This supersedes the `explore-native-otel-telemetry` exploration (which proposed a
Collector -> Postgres mapping shim): reading VictoriaMetrics directly is simpler and needs no new
ingress — it's the same store cc's own Grafana dashboard already queries.

This is a **read-not-write** posture: Nexus consumes the homelab observability store; it does NOT
self-instrument with an OTEL SDK. (That sidesteps the Bun-compiled-binary auto-instrumentation
problem entirely.) Network note: VictoriaMetrics has no host-published port in the compose file
(reachable only inside the `homelab` docker network in general) — but `nexus-agent` already runs
directly on the `homelab` host (confirmed via `systemctl --user status nexus-agent` + a live curl
to the container's static compose IP, `172.20.0.200:8428`, from this host), so no new network path
or port-publish is needed.

## What Changes

- **ADD** capability `cc-telemetry-read`: a read-only VictoriaMetrics client in `apps/agent`
  (PromQL/HTTP against `VM_URL`, env-driven, degraded no-op when unconfigured) plus a cost/token
  read service that sources per-session cost from `claude_code_cost_usage_USD_total` /
  `claude_code_token_usage_total`, keyed by session and `project` label, with the `session_id=~".+"`
  filter applied to avoid the reset-collision inflation bug cc's own dashboard hit on these series.
- **REPOINT** the session cost/token endpoint (`GET /sessions/{id}/tokens`) to the VictoriaMetrics
  read service.
- **RETIRE** the transcript-tail cost reconstruction (`credentials/token-stream/*`,
  `model-pricing.ts`) and the hook pipeline's **metric/cost/token capture** paths once the read-path
  is verified.
- **KEEP** a residual cc hook for signals VictoriaMetrics cannot carry: orchestration-lifecycle
  events (`command_start`/`command_end` with `run_id`/`spec`/`wave`/`phase`, `agent_telemetry`) and
  welded session side-effects (PostCompact context re-injection, Notification TTS, terminal bell).
  These have **no native OTEL analog** and MUST NOT be removed.
- **MODIFY** `observability-stack` spec: remove the two requirements that target Rust binaries that
  no longer exist (`Sentry Error Tracking — Rust Binaries`, `OpenTelemetry Trace Export — Rust`) —
  the agent is now Bun/TS and `nexus-tui` is retired. Sentry-Node + pino requirements stay.
- **SUPERSEDE** the `explore-native-otel-telemetry` exploration (archive it; the
  read-from-VictoriaMetrics approach replaces the Collector -> Postgres shim).

## Impact

- **Affected specs:**
  - NEW `cc-telemetry-read` (the read client + cost/token read service + residual-hook boundary)
  - MODIFIED `observability-stack` (remove orphaned Rust requirements)
  - `hooks-endpoint` / `cc-hook-helper` (residual-only after migration — event taxonomy narrows to
    orchestration + side-effects; documented here, formalized if their contracts shift)
- **Affected code:**
  - NEW `apps/agent/src/telemetry/vm-read.ts` (read client)
  - `apps/agent/src/routes/sessions.ts` (`/sessions/{id}/tokens` repoint)
  - `apps/agent/src/credentials/token-stream/*`, `apps/agent/src/credentials/model-pricing.ts`
    (deleted)
  - `apps/agent/src/services/socket-server/dispatcher.ts` (residual-only)
  - `packages/db/src/schema/sessionTokenTurns.ts`, `sessionTokenWatcherState.ts` (retirement
    candidates — confirm no remaining writers)
  - `deploy/secrets.env.example` (`VM_URL`, default `http://172.20.0.200:8428` — the compose file
    pins this as a static `ipv4_address`, so the IP is stable, not a fragile guess)
- **Hard prerequisite (GATE-0): SATISFIED, verified 2026-07-05.** Claude Code is already emitting
  `claude_code_cost_usage_USD_total` / `claude_code_token_usage_total` to VictoriaMetrics
  (`CLAUDE_CODE_ENABLE_TELEMETRY=1` in cc's `settings.json`, OTLP pointed at `:4318` HTTP -> Alloy ->
  VM). 76 cost-metric series confirmed present via a direct PromQL query from the homelab host. No
  further verification task is needed before implementation starts — task 1.1 in tasks.md now
  records this as done rather than as an open blocker.
- **Out of scope:** `~/.claude` / `~/dev/cc` edits (cc's emission config is already correct, nothing
  to change there); self-instrumentation of nexus apps with an OTEL SDK (explicitly rejected — read,
  don't write); Loki log reads (metrics-only this change).

## Context
- touches: `apps/agent/src/telemetry/vm-read.ts`, `apps/agent/src/routes/sessions.ts`, `apps/agent/src/services/socket-server/dispatcher.ts`, `apps/agent/src/credentials/model-pricing.ts`, `packages/db/src/schema/sessionTokenTurns.ts`, `packages/db/src/schema/sessionTokenWatcherState.ts`, `openspec/specs/observability-stack/spec.md`, `deploy/secrets.env.example`
- supersedes: `explore-native-otel-telemetry`
