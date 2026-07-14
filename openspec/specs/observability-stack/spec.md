# observability-stack Specification

## Purpose
TBD - created by archiving change add-observability-stack. Update Purpose after archive.
## Requirements
### Requirement: Pino Structured Logging
The system SHALL provide a `createLogger(name: string)` factory in `packages/core` that returns a Pino logger instance. The factory SHALL read `LOG_LEVEL` from the environment (defaulting to `info`). All Node.js applications SHALL use this factory instead of `console.log` or the previous custom logger. Components with distinct operational concerns SHALL derive child loggers with a `component` field (e.g., `{ component: 'health-collector' }`) to enable per-component log filtering.

#### Scenario: Logger respects LOG_LEVEL
- **WHEN** `LOG_LEVEL` is set to `warn`
- **THEN** calls to `logger.info()` produce no output and calls to `logger.warn()` produce JSON output

#### Scenario: Logger includes context
- **WHEN** `createLogger("nexus-register")` is called and `.info("event", { sessionId: "abc" })` is invoked
- **THEN** the output includes `"name":"nexus-register"` and `"sessionId":"abc"` in the JSON line

#### Scenario: Child logger inherits parent context
- **WHEN** a child logger is created with `logger.child({ requestId: "123" })`
- **THEN** all log lines from the child include `"requestId":"123"`

#### Scenario: Health-collector child logger
- **WHEN** health-collector.ts emits a log line
- **THEN** the JSON output includes `"component":"health-collector"`

#### Scenario: Health-scheduler child logger
- **WHEN** health-scheduler.ts emits a log line
- **THEN** the JSON output includes `"component":"health-scheduler"`

### Requirement: Sentry Error Tracking — Node.js Applications
The system SHALL initialize `@sentry/node` (or `@sentry/nextjs` for the Next.js app) in all Node.js application entry points. Configuration SHALL include DSN, environment, and release from `package.json` version. All Next.js Sentry configurations (`sentry.server.config.ts`, `sentry.client.config.ts`, `sentry.edge.config.ts`) SHALL include a `beforeSend` hook that removes `Authorization`, `x-nexus-secret`, and `Cookie` values from `event.request.headers` before the event is transmitted to Sentry.

#### Scenario: Unhandled exception captured
- **WHEN** an unhandled exception is thrown in the Node.js agent process
- **THEN** the exception is reported to Sentry before the process exits

#### Scenario: Next.js server error captured
- **WHEN** a server-side error occurs in a Next.js API route or Server Component
- **THEN** the error is captured by `@sentry/nextjs` with request context

#### Scenario: Authorization header scrubbed
- **WHEN** a Sentry event contains a request with an `Authorization` header
- **THEN** the `beforeSend` hook removes the `Authorization` header value before the event leaves the process

#### Scenario: x-nexus-secret header scrubbed
- **WHEN** a Sentry event contains a request with an `x-nexus-secret` header
- **THEN** the `beforeSend` hook removes the `x-nexus-secret` header value before the event leaves the process

#### Scenario: Cookie header scrubbed
- **WHEN** a Sentry event contains a request with a `Cookie` header
- **THEN** the `beforeSend` hook removes the `Cookie` header value before the event leaves the process

### Requirement: Sentry Breadcrumbs in Critical Paths
The system SHALL record Sentry breadcrumbs at key decision points: credential import events (Rust), credential rotation events, credential lease/release/cooldown lifecycle transitions (Node.js), notification delivery attempts, and gRPC call failures.

#### Scenario: Credential rotation breadcrumb
- **WHEN** the credential pool performs a symlink swap rotation
- **THEN** a Sentry breadcrumb is recorded with category `credential` and the account name

#### Scenario: Notification delivery breadcrumb
- **WHEN** the notification engine attempts TTS or push delivery
- **THEN** a Sentry breadcrumb is recorded with category `notification` and delivery method

#### Scenario: gRPC failure breadcrumb
- **WHEN** a gRPC call to a peer agent fails
- **THEN** a Sentry breadcrumb is recorded with category `grpc`, peer address, and error status

#### Scenario: Credential import breadcrumb (Rust)
- **WHEN** `bootstrap_import_credential` or `import_credential_to_pool` completes in nexus-agent
- **THEN** a Sentry breadcrumb is recorded with `category: "credential"` and the credential fingerprint

#### Scenario: Credential lease breadcrumb (Node.js)
- **WHEN** `CredentialPool.lease()` successfully leases a credential
- **THEN** a Sentry breadcrumb is recorded with `category: "credential"` and `message: "credential leased"`

#### Scenario: Credential release breadcrumb (Node.js)
- **WHEN** `CredentialPool.release()` successfully releases a credential
- **THEN** a Sentry breadcrumb is recorded with `category: "credential"` and `message: "credential released"`

#### Scenario: Credential cooldown breadcrumb (Node.js)
- **WHEN** `CredentialPool.reportRateLimit()` places a credential on cooldown
- **THEN** a Sentry breadcrumb is recorded with `category: "credential"` and `message: "credential on cooldown"`

### Requirement: Sentry AI Monitoring for Anthropic API Calls
The system SHALL wrap Anthropic API calls (OAuth usage queries) in Sentry performance spans with `op: "ai"` operation type. Access tokens in request headers SHALL NOT be captured by Sentry.

#### Scenario: Usage query span recorded
- **WHEN** `query_usage()` calls the Anthropic OAuth usage endpoint
- **THEN** a Sentry span is created with `op: "ai"`, `description: "anthropic.usage_query"`, and `ai.provider: "anthropic"` tag

#### Scenario: Access token not leaked
- **WHEN** Sentry captures a transaction containing an Anthropic API span
- **THEN** the `Authorization` header value is scrubbed and not present in the Sentry event

### Requirement: OpenTelemetry Trace Correlation — Node.js Logs
The system SHALL configure the Pino logger to inject `traceId` and `spanId` into log output when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. The logger SHALL use `pino-opentelemetry-transport` for span-aware log export.

#### Scenario: Trace context in log lines
- **WHEN** a log line is emitted inside an active OTel span
- **THEN** the JSON output includes `"traceId"` and `"spanId"` fields matching the active context

#### Scenario: No trace context without OTel
- **WHEN** `OTEL_EXPORTER_OTLP_ENDPOINT` is not set
- **THEN** log lines do not include `traceId` or `spanId` fields

### Requirement: Custom Spans for Key Operations
The system SHALL create named spans for: session start/stop lifecycle, credential rotation cycle, gRPC `StreamEvents` calls, health collection rounds, and credential lease/release/cooldown operations in the Node.js agent.

#### Scenario: Session lifecycle span
- **WHEN** a session start event is received via the Unix socket
- **THEN** a span named `session.start` is created with `session_id` attribute

#### Scenario: Credential rotation span
- **WHEN** the credential pool begins a rotation cycle
- **THEN** a span named `credential.rotation` is created covering the full scan-parse-swap cycle

#### Scenario: Health collection span
- **WHEN** the health collector runs its periodic collection
- **THEN** a span named `health.collect` is created with `agent_name` attribute

#### Scenario: Credential lease span (Node.js)
- **WHEN** `CredentialPool.lease()` is called in the Node.js agent
- **THEN** an OTel span named `credential.lease` is created with `type` and `leasedBy` attributes

#### Scenario: Credential release span (Node.js)
- **WHEN** `CredentialPool.release()` is called in the Node.js agent
- **THEN** an OTel span named `credential.release` is created with `id` attribute

#### Scenario: Credential cooldown span (Node.js)
- **WHEN** `CredentialPool.reportRateLimit()` is called in the Node.js agent
- **THEN** an OTel span named `credential.cooldown` is created with `id` and `cooldown_until` attributes

### Requirement: Menubar Push Authentication
Internal HTTP requests from `push_to_menubars` in the credential watcher SHALL include an `x-nexus-secret` header populated from the `NEXUS_INTERNAL_SECRET` environment variable. When `NEXUS_INTERNAL_SECRET` is not set, the push SHALL be skipped and a warning SHALL be logged.

#### Scenario: Secret header attached
- **WHEN** `NEXUS_INTERNAL_SECRET` is set to a non-empty value
- **THEN** every POST request from `push_to_menubars` includes `x-nexus-secret: <value>` in the request headers

#### Scenario: Push skipped without secret
- **WHEN** `NEXUS_INTERNAL_SECRET` is not set
- **THEN** `push_to_menubars` logs a warning and sends no HTTP request

### Requirement: Cleanup Timer Error Propagation
The credential pool's periodic cleanup timer SHALL attach `.catch` handlers to all async calls so that failures are logged via the structured logger rather than becoming unhandled promise rejections.

#### Scenario: Cooldown recovery error logged
- **WHEN** `recoverExpiredCooldowns()` throws inside the cleanup interval
- **THEN** the error is caught and logged at `error` level with the message `'cleanup failed'`; the timer continues running

#### Scenario: Stale-lease cleanup error logged
- **WHEN** `cleanupStaleLeases()` throws inside the cleanup interval
- **THEN** the error is caught and logged at `error` level with the message `'stale-lease cleanup failed'`; the timer continues running

### Requirement: Sessions Cache Test Isolation
The module-level `sessionsCache` singleton in `apps/agent/src/routes/sessions.ts` SHALL be encapsulated so that independent test suites receive isolated cache state without shared mutable state.

#### Scenario: Factory produces isolated instances
- **WHEN** two test suites each instantiate the sessions route handler independently
- **THEN** entries written in one suite's cache are not visible in the other suite's cache

#### Scenario: Backward-compatible cache clear
- **WHEN** `clearSessionsCache()` is called in a test
- **THEN** the next call to the handler fetches fresh data from the database

### Requirement: TUI Key Event Logging
The TUI event loop SHALL log each crossterm key event at `TRACE` level using the `tracing` crate. Key logging SHALL be suppressed at `info` level and above to avoid noise in production.

#### Scenario: Key event logged at trace
- **WHEN** `RUST_LOG=nexus_tui=trace` is set and a key is pressed
- **THEN** a `TRACE` log line is emitted containing the key event details

#### Scenario: Key logging silent at info
- **WHEN** `RUST_LOG` is at the default `info` level and a key is pressed
- **THEN** no key-event log line is emitted

### Requirement: TUI Data Freshness Indicator
The TUI status bar SHALL display a "last refreshed" timestamp indicating how long ago data was fetched from the agent API. The indicator SHALL update on every successful data refresh.

#### Scenario: Freshness shown after refresh
- **WHEN** the TUI successfully fetches sessions data from the agent
- **THEN** the status bar displays a label such as "Updated 2s ago" reflecting the elapsed time

#### Scenario: Stale data indicated
- **WHEN** the last successful refresh was more than 30 seconds ago
- **THEN** the freshness label uses a visually distinct style (e.g., dimmed or yellow) to indicate staleness

### Requirement: Logging directive parse fallback
The tracing subscriber initialisation in all Rust binaries SHALL use
`.unwrap_or_else(|_| Directive::default())` when parsing hardcoded filter directives. A
malformed or unparseable directive MUST NOT cause a panic; the default directive (no extra
filter) SHALL be used instead.

#### Scenario: Valid directive parses normally
- **WHEN** the hardcoded directive `"nexus_tui=info"` is parsed
- **THEN** the directive is applied and `nexus_tui` spans are filtered to INFO and above

#### Scenario: Invalid directive falls back silently
- **WHEN** a directive string fails to parse (e.g. due to a future code change introducing
  an invalid string)
- **THEN** `Directive::default()` is used and the binary continues startup without panic

### Requirement: PostHog provider in Next.js dashboard

The dashboard MUST wire PostHog via `posthog-js` at the app root. Initialization MUST be gated on `NEXT_PUBLIC_POSTHOG_KEY` — when the env var is missing, the provider MUST no-op silently and not throw.

#### Scenario: Production with key

- **GIVEN** `NEXT_PUBLIC_POSTHOG_KEY` is set in the Next.js runtime
- **WHEN** the app root renders
- **THEN** PostHog is initialized exactly once and subsequent `usePostHog()` hooks return a valid client

#### Scenario: Dev without key

- **GIVEN** `NEXT_PUBLIC_POSTHOG_KEY` is unset
- **WHEN** the app root renders
- **THEN** no PostHog initialization occurs, no network request is made, and `usePostHog()` returns a no-op stub

### Requirement: Health endpoint for uptime monitoring

The dashboard MUST expose `GET /api/health` returning `{ status: "ok", version: string, timestamp: string }` with HTTP 200 under normal operation. The endpoint MUST be dynamic (no static prerendering) and MUST NOT perform DB or agent calls in v1.

#### Scenario: Deploy monitor health check

- **GIVEN** the dashboard is running after a deploy
- **WHEN** the deploy monitor issues `curl /api/health`
- **THEN** a 200 response is returned within 50ms with the shape above

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

