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

### Requirement: Sentry Error Tracking — Rust Binaries
The system SHALL initialize Sentry in all Rust binary entry points (nexus-agent, nexus-tui, nexus-mcp) using the `sentry` crate. Initialization SHALL read `SENTRY_DSN` from the environment. When `SENTRY_DSN` is not set, Sentry SHALL be disabled with no runtime impact.

#### Scenario: Sentry captures panic
- **WHEN** a panic occurs in nexus-agent with `SENTRY_DSN` configured
- **THEN** the panic is reported to Sentry with stack trace, environment tag, and release version

#### Scenario: Sentry disabled without DSN
- **WHEN** `SENTRY_DSN` is not set
- **THEN** the Sentry guard is a no-op and the application starts normally

#### Scenario: Sentry environment tagging
- **WHEN** `SENTRY_ENVIRONMENT` is set to `production`
- **THEN** all Sentry events include `environment: "production"`

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

### Requirement: OpenTelemetry Trace Export — Rust
The system SHALL compose a `tracing-opentelemetry` layer into the tracing subscriber stack in all Rust binaries. The OTel layer SHALL export spans via OTLP to the endpoint configured in `OTEL_EXPORTER_OTLP_ENDPOINT`. When the env var is not set, the OTel layer SHALL not be added.

#### Scenario: OTel layer active with endpoint
- **WHEN** `OTEL_EXPORTER_OTLP_ENDPOINT` is set to `http://localhost:4317`
- **THEN** `tracing::info_span!` calls in nexus-agent produce spans exported to that endpoint

#### Scenario: OTel layer skipped without endpoint
- **WHEN** `OTEL_EXPORTER_OTLP_ENDPOINT` is not set
- **THEN** the tracing subscriber uses only the `fmt` layer (no OTel overhead)

#### Scenario: Existing fmt layer preserved
- **WHEN** OTel is enabled
- **THEN** the `tracing_subscriber::fmt` layer still emits to stdout as before

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

