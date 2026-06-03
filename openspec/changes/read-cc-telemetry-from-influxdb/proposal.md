# Change: Read Claude Code telemetry from InfluxDB instead of hook-capturing it

## Why

Nexus currently reconstructs per-session cost and token usage with a **transcript-tail hack**
(`apps/agent/src/credentials/token-stream/*` + `model-pricing.ts`) that re-reads
`~/.claude/projects/<cwd>/<session>.jsonl` to approximate native cost — a workaround for the
absence of a real cost feed. It also captures most `claude_code.*` signals through a **custom hook
pipeline** (`telemetry.sh` -> `nexus-emit` -> socket-server dispatcher -> Postgres).

The homelab now exposes a **shared OTLP ingress** (Telegraf `:4317` -> InfluxDB `sensors` bucket;
Alloy `:4318` -> Loki). Claude Code 2.1.158 ships native OpenTelemetry: with
`CLAUDE_CODE_ENABLE_TELEMETRY=1` it emits `claude_code.cost.usage`, `claude_code.token.usage`
(attr `type`: input/output/cacheRead/cacheCreation), `session.count`, and structured log events
straight to that ingress. **The authoritative cost + token data already lands in InfluxDB.**

So Nexus should **read** that data, not re-capture it. Reading native `claude_code.*` series from
InfluxDB lets us delete the transcript-tail reconstruction and retire the hook pipeline's
metric-capture paths — replacing an approximation with the source of truth and removing a fragile
parser. This supersedes the `explore-native-otel-telemetry` exploration (which proposed a
Collector -> Postgres mapping shim): reading InfluxDB directly is simpler and needs no new ingress.

This is a **read-not-write** posture: Nexus consumes the homelab observability store; it does NOT
self-instrument with an OTEL SDK. (That sidesteps the Bun-compiled-binary auto-instrumentation
problem entirely.)

## What Changes

- **ADD** capability `cc-telemetry-read`: a read-only InfluxDB client in `apps/agent` (Flux/HTTP
  against the `sensors` bucket, env-driven, degraded no-op when unconfigured) plus a cost/token
  read service that sources per-session cost from `claude_code.cost.usage` / `claude_code.token.usage`
  keyed by session and `project` resource attribute.
- **REPOINT** the session cost/token endpoint (`GET /sessions/{id}/tokens`) to the InfluxDB read
  service.
- **RETIRE** the transcript-tail cost reconstruction (`credentials/token-stream/*`,
  `model-pricing.ts`) and the hook pipeline's **metric/cost/token capture** paths once the read-path
  is verified.
- **KEEP** a residual cc hook for signals InfluxDB cannot carry: orchestration-lifecycle events
  (`command_start`/`command_end` with `run_id`/`spec`/`wave`/`phase`, `agent_telemetry`) and welded
  session side-effects (PostCompact context re-injection, Notification TTS, terminal bell). These
  have **no native OTEL analog** and MUST NOT be removed.
- **MODIFY** `observability-stack` spec: remove the two requirements that target Rust binaries that
  no longer exist (`Sentry Error Tracking — Rust Binaries`, `OpenTelemetry Trace Export — Rust`) —
  the agent is now Bun/TS and `nexus-tui` is retired. Sentry-Node + pino requirements stay.
- **SUPERSEDE** the `explore-native-otel-telemetry` exploration (archive it; the read-from-InfluxDB
  approach replaces the Collector -> Postgres shim).

## Impact

- **Affected specs:**
  - NEW `cc-telemetry-read` (the read client + cost/token read service + residual-hook boundary)
  - MODIFIED `observability-stack` (remove orphaned Rust requirements)
  - `hooks-endpoint` / `cc-hook-helper` (residual-only after migration — event taxonomy narrows to
    orchestration + side-effects; documented here, formalized if their contracts shift)
- **Affected code:**
  - NEW `apps/agent/src/telemetry/influx-read.ts` (read client)
  - `apps/agent/src/routes/sessions.ts` (`/sessions/{id}/tokens` repoint)
  - `apps/agent/src/credentials/token-stream/*`, `apps/agent/src/credentials/model-pricing.ts`
    (deleted)
  - `apps/agent/src/services/socket-server/dispatcher.ts` (residual-only)
  - `packages/db/src/schema/sessionTokenTurns.ts`, `sessionTokenWatcherState.ts` (retirement
    candidates — confirm no remaining writers)
  - `deploy/secrets.env.example` (INFLUXDB_URL / INFLUXDB_TOKEN / INFLUXDB_ORG)
- **Hard prerequisite (GATE-0):** Claude Code must already be emitting `claude_code.*` to InfluxDB
  (`CLAUDE_CODE_ENABLE_TELEMETRY=1` + OTLP env pointed at `:4317`, account credit available). If the
  series are absent, the read-path has nothing to read and retirement is blocked. The handoff noted
  real CC telemetry was credit-gated — verify before deleting any capture path.
- **Out of scope:** `~/.claude` / `~/dev/cc` edits (enabling CC emission is a cc-side config handed
  off as a prerequisite, not changed here); self-instrumentation of nexus apps with an OTEL SDK
  (explicitly rejected — read, don't write); Loki log reads (metrics-only this change).

## Context
- touches: `apps/agent/src/telemetry/influx-read.ts`, `apps/agent/src/routes/sessions.ts`, `apps/agent/src/services/socket-server/dispatcher.ts`, `apps/agent/src/credentials/model-pricing.ts`, `packages/db/src/schema/sessionTokenTurns.ts`, `packages/db/src/schema/sessionTokenWatcherState.ts`, `openspec/specs/observability-stack/spec.md`, `deploy/secrets.env.example`
- supersedes: `explore-native-otel-telemetry`
