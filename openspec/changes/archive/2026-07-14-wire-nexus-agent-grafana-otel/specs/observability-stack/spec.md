## ADDED Requirements

### Requirement: OTel Metrics Export
The system SHALL export process and health metrics via OTLP through a `MeterProvider` sibling to
the existing `NodeTracerProvider` in `otel.ts`, using the same Bun-compile-safe vendor package
family (`@opentelemetry/sdk-metrics` + `@opentelemetry/exporter-metrics-otlp-http`, not the
monolithic `sdk-node` bundle). Metrics SHALL be recorded on the existing `HealthCollector`
5-second tick rather than a new poller.

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
the existing `getTracer()` accessor, tagging `http.method`, `http.route`, and
`http.status_code`.

#### Scenario: Request span recorded
- **WHEN** an HTTP request is dispatched through `createRequestHandler`
- **THEN** a span is created with `http.method`/`http.route`/`http.status_code` attributes and
  ends when the response is produced

#### Scenario: WS dispatch tracing unaffected
- **WHEN** a WebSocket message is dispatched via `socket-server/dispatcher.ts`
- **THEN** its existing `startActiveSpan` behavior is unchanged by this requirement

### Requirement: Logger OTLP Transport Migration
The system SHALL NOT use `pino-opentelemetry-transport` for OTLP log export. `logger.ts` SHALL
emit plain stdout JSON in all environments and rely solely on `mixin()` for trace/span-id
correlation.

#### Scenario: No worker transport regardless of endpoint
- **WHEN** `OTEL_EXPORTER_OTLP_ENDPOINT` is set
- **THEN** the logger still writes plain JSON to stdout with no pino transport attached

#### Scenario: Trace correlation preserved
- **WHEN** a log line is emitted inside a span registered via `otel.ts`
- **THEN** the JSON output still includes `traceId` and `spanId` via the mixin

### Requirement: Per-Machine OTLP Endpoint Auth
The system SHALL support HTTP Basic authentication via `OTEL_EXPORTER_OTLP_HEADERS` for both the
trace and metrics OTLP exporters, so a nexus-agent instance on a machine other than the homelab
host can reach the public `https://otlp.leonardoacosta.dev` ingest, while the co-located
homelab instance keeps using the unauthenticated `http://localhost:4318` path.

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
