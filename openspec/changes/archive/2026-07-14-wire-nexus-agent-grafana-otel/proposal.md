---
status: draft
---

# Proposal: Wire nexus-agent into the Grafana OTel Stack

## Change ID
`wire-nexus-agent-grafana-otel`

## Summary
nexus-agent already registers a live `NodeTracerProvider` (`apps/agent/src/otel.ts`) but exports
only traces, from exactly one span site, to a `ConsoleSpanExporter` fallback that has likely
never been pointed at a real collector in production. This closes the gap so nexus-agent's
metrics, HTTP traces, and logs actually reach the already-deployed Grafana LGTM stack at
`grafana.leonardoacosta.dev`.

## Context
- Extends: `apps/agent/src/otel.ts` (existing trace provider, adds a sibling metrics provider),
  `packages/core/src/logger.ts` (drops the fleet-banned `pino-opentelemetry-transport`),
  `apps/agent/src/server-request-handler.ts` (adds request-level tracing), `apps/agent/src/health-collector.ts`
  (reuses its existing 5s tick to also emit metrics), `deploy/secrets.env.example`.
- Related: `openspec/specs/observability-stack/spec.md` (parent capability — still describes a
  Rust/gRPC/Sentry-era design; this proposal only ADDS to it, does not touch the stale
  Sentry/Rust requirements — that removal is a separate, canon-scoped proposal). Archived
  `2026-07-05-explore-native-otel-telemetry` (a different concern: nexus reading CC's own native
  OTEL telemetry via `VM_URL`, not nexus-agent exporting its own telemetry — not touched here).
  `~/.claude/skills/deploy-and-env` § Observability Canon (the fleet-wide Grafana/OTLP
  wiring recipes this proposal follows).
- touches: `packages/core/src/logger.ts`, `apps/agent/src/otel.ts`, `apps/agent/src/health-collector.ts`,
  `apps/agent/src/server-request-handler.ts`, `apps/agent/src/routes/version-builder.ts`,
  `deploy/secrets.env.example`, `apps/agent/package.json`

## Motivation
The homelab already runs a full Grafana/Prometheus/Loki/Tempo/Alloy/VictoriaMetrics stack,
publicly reachable at `grafana.leonardoacosta.dev`, with an OTLP ingest path documented in the
fleet's Observability Canon (`http://localhost:4318` on-host, `https://otlp.leonardoacosta.dev`
+ HTTP Basic auth off-host). nexus-agent is not visible there today:

- Its trace provider (`otel.ts`) exists and is imported at process start, but only one span site
  wraps it (`socket-server/dispatcher.ts`) — HTTP request handling (103 routes) produces no
  spans at all.
- No metrics are exported at all — only traces. The existing `HealthCollector` already gathers
  cpu/mem/disk/docker data every 5s and persists it to Postgres, but never pushes it as OTel
  metrics.
- `packages/core/src/logger.ts` still wires `pino-opentelemetry-transport`, a worker-thread log
  shipper the fleet canon explicitly retired (2026-07-12, after it silently failed under
  Next.js's webpack bundling elsewhere in the fleet). The canon-sanctioned replacement is plain
  stdout + a trace-context `mixin()` — which `logger.ts` already implements correctly, just
  alongside the now-superseded transport.
- The exporters have no Basic-auth wiring, so a nexus-agent instance running on a machine other
  than the homelab host (nexus-agent is a per-machine daemon) cannot reach the public
  `otlp.leonardoacosta.dev` ingest, which requires it.
- `deploy/secrets.env.example` documents `OTEL_EXPORTER_OTLP_ENDPOINT` as a commented-out example
  only — nothing confirms it is actually set on any live `.env`. Its own header claims the active
  secrets file is `~/.config/nexus/secrets.env`, but `deploy/nexus-agent.service:66` actually
  sources `~/.env` — a doc/code drift this proposal corrects while touching that file.

## Requirements

### Requirement: OTel Metrics Export
The system SHALL export process and health metrics via OTLP through a `MeterProvider` sibling to
the existing `NodeTracerProvider` in `otel.ts`, using the same Bun-compile-safe vendor package
family (`@opentelemetry/sdk-metrics` + `@opentelemetry/exporter-metrics-otlp-http`, not the
monolithic `sdk-node` bundle `otel.ts` already avoids). Metrics SHALL be recorded on the
existing `HealthCollector` 5-second tick rather than a new poller.

#### Scenario: Metrics recorded on health tick
- **WHEN** `HealthCollector` completes a collection cycle
- **THEN** cpu load, memory used, disk usage, and docker container count are recorded as OTel
  gauges via a shared `getMeter()` accessor

#### Scenario: No exporter without endpoint
- **WHEN** `OTEL_EXPORTER_OTLP_ENDPOINT` is not set
- **THEN** metrics are recorded locally but no OTLP export occurs, mirroring the trace
  provider's existing console/no-op fallback

### Requirement: HTTP Request Tracing
The system SHALL wrap HTTP request dispatch in `createRequestHandler` with an active span from
the existing `getTracer()` accessor (`otel.ts`), tagging `http.method`, `http.route`, and
`http.status_code`.

#### Scenario: Request span recorded
- **WHEN** an HTTP request is dispatched through `createRequestHandler`
- **THEN** a span is created with `http.method`/`http.route`/`http.status_code` attributes and
  ends when the response is produced

#### Scenario: WS dispatch tracing unaffected
- **WHEN** a WebSocket message is dispatched via `socket-server/dispatcher.ts`
- **THEN** its existing `startActiveSpan` behavior is unchanged by this requirement

### Requirement: Logger OTLP Transport Migration
The system SHALL NOT use `pino-opentelemetry-transport` for OTLP log export. Per the fleet
Observability Canon, `packages/core/src/logger.ts` SHALL emit plain stdout JSON in all
environments and rely solely on `mixin()` for trace/span-id correlation.

#### Scenario: No worker transport regardless of endpoint
- **WHEN** `OTEL_EXPORTER_OTLP_ENDPOINT` is set
- **THEN** the logger still writes plain JSON to stdout with no pino transport attached

#### Scenario: Trace correlation preserved
- **WHEN** a log line is emitted inside a span registered via `otel.ts`
- **THEN** the JSON output still includes `traceId` and `spanId` via the mixin

### Requirement: Per-Machine OTLP Endpoint Auth
The system SHALL support HTTP Basic authentication via `OTEL_EXPORTER_OTLP_HEADERS` for both the
trace and metrics OTLP exporters, so a nexus-agent instance on a machine other than the homelab
host can reach the public `https://otlp.leonardoacosta.dev` ingest (Basic-auth only, per the
canon), while the co-located homelab instance keeps using the unauthenticated
`http://localhost:4318` path.

#### Scenario: Basic auth header applied when configured
- **WHEN** `OTEL_EXPORTER_OTLP_HEADERS` is set to an `Authorization: Basic ...` value
- **THEN** both the trace and metrics exporters send that header on every export request

#### Scenario: No header required for on-host export
- **WHEN** `OTEL_EXPORTER_OTLP_ENDPOINT` points at `http://localhost:4318` and
  `OTEL_EXPORTER_OTLP_HEADERS` is unset
- **THEN** export still succeeds, matching the existing unauthenticated internal path

### Requirement: OTel Wiring Visibility
The system SHALL expose whether OTLP export is active and its configured endpoint via the
agent's capability/version surface, without ever including the auth header value.

#### Scenario: Version response includes otel status
- **WHEN** `GET /version` is requested
- **THEN** the response includes an `otel` field with `enabled` (boolean) and `endpoint`
  (string or `null`), and never includes the `OTEL_EXPORTER_OTLP_HEADERS` value

## Scope
- **IN**: nexus-agent's own OTel export wiring — metrics provider, HTTP request tracing, logger
  transport migration, per-machine Basic-auth config, `/version` visibility field, and
  `deploy/secrets.env.example` documentation (including fixing the stale secrets-file-path claim
  the new OTel guidance sits next to).
- **OUT**: any homelab-repo change (separate git remote) — a Prometheus/Alloy scrape target if
  one turns out to be needed, a Grafana dashboard panel/folder for nexus-agent, or an
  Alertmanager/Grafana-alerting rule for "nexus-agent down/erroring." Leo asked for dashboard +
  alert; the alert RULE itself is homelab-side config and is tracked as a follow-up, not built
  here — this proposal's job is to make sure the signal the alert would key on (structured
  error/fatal logs tagged `service.name=nexus-agent`, plus a liveness metric) actually exists.
- **OUT**: removing the existing `@sentry/node` integration (`apps/agent/src/instrument.ts`) —
  the fleet canon calls Sentry removal a separate downstream proposal; it stays as dormant
  no-op-when-`SENTRY_DSN`-unset code.
- **OUT**: the `explore-native-otel-telemetry` line of work (CC's own native OTEL telemetry
  flowing INTO nexus via VictoriaMetrics) — an unrelated, already-explored direction.
- **OUT**: actually flipping `OTEL_EXPORTER_OTLP_ENDPOINT` on in each machine's live `~/.env` —
  that file is machine-local and gitignored by design; this is a `[user]` rollout step, not a
  code change.

## Testing
| Affected seam | Unit task | E2E task |
|----------------|-----------|----------|
| `packages/core/src/logger.ts` transport removal | `[2.1]` | N/A — logging output, no user-facing flow |
| `apps/agent/src/otel.ts` metrics provider | `[2.2]` | N/A — internal SDK wiring |
| `apps/agent/src/health-collector.ts` metrics emission | `[2.2]` | N/A — reuses existing tick, covered by unit test |
| `apps/agent/src/server-request-handler.ts` span wrapper | `[2.3]` | `[2.3]` (integration test asserts span attributes on a real dispatched request) |
| `apps/agent/src/routes/version-builder.ts` otel field | `[2.4]` | N/A — small capability-field addition |
| Live Grafana data landing | N/A — cannot be unit-tested | `[4.1]` `[user]` manual dashboard check after rollout |

## Impact
| Area | Change |
|------|--------|
| `packages/core/src/logger.ts` | Remove `buildTransport()`/`pino-opentelemetry-transport`; keep `buildMixin()` unchanged |
| `apps/agent/src/otel.ts` | Add `MeterProvider` + OTLP metrics exporter + Basic-auth header support on both exporters; export `getMeter()` |
| `apps/agent/src/health-collector.ts` | Push cpu/mem/disk/docker gauges via `getMeter()` on the existing tick |
| `apps/agent/src/server-request-handler.ts` | Wrap `handleRequest` dispatch in `getTracer().startActiveSpan(...)` |
| `apps/agent/src/routes/version-builder.ts` | Add `otel: {enabled, endpoint}` to the `/version` response |
| `deploy/secrets.env.example` | Expand OTel section (per-machine guidance, Basic-auth footgun note, fix stale `~/.config/nexus/secrets.env` path claim) |
| `apps/agent/package.json` | Add `@opentelemetry/sdk-metrics`, `@opentelemetry/exporter-metrics-otlp-http` |

## Risks
| Risk | Mitigation |
|------|-----------|
| New OTel metrics packages break `bun build --compile` (the exact failure `otel.ts`'s comment says `sdk-trace-node` was chosen over `sdk-node` to avoid) | Use the same vendor-package family (`sdk-metrics`, not `sdk-node`); verify with a `bun build --compile` gate before merge |
| `OTEL_EXPORTER_OTLP_HEADERS` `=`-padding footgun corrupts the Basic-auth value (documented fleet incident, sj 2026-07-11) | curl-test the header value directly against `otlp.leonardoacosta.dev` before trusting it, per the canon's own footgun note |
| Enabling real OTLP export changes production log/trace destinations before verified | Console/no-op fallback stays default when the endpoint env var is unset; rollout is opt-in per machine, not forced by this change |
| `service.name` collision with a future cc-native-OTel-ingest Collector on the same homelab box | Use `service.name=nexus-agent` (not the generic `nexus` the logger defaults to today) so nexus-agent's own telemetry is distinguishable from any future cc-ingest pipeline |
