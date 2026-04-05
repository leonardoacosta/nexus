# observability-stack Specification

## Purpose
TBD - created by archiving change add-observability-stack. Update Purpose after archive.
## Requirements
### Requirement: Pino Structured Logging
The system SHALL provide a `createLogger(name: string)` factory in `packages/core` that returns a Pino logger instance. The factory SHALL read `LOG_LEVEL` from the environment (defaulting to `info`). All Node.js applications SHALL use this factory instead of `console.log` or the previous custom logger.

#### Scenario: Logger respects LOG_LEVEL
- **WHEN** `LOG_LEVEL` is set to `warn`
- **THEN** calls to `logger.info()` produce no output and calls to `logger.warn()` produce JSON output

#### Scenario: Logger includes context
- **WHEN** `createLogger("nexus-register")` is called and `.info("event", { sessionId: "abc" })` is invoked
- **THEN** the output includes `"name":"nexus-register"` and `"sessionId":"abc"` in the JSON line

#### Scenario: Child logger inherits parent context
- **WHEN** a child logger is created with `logger.child({ requestId: "123" })`
- **THEN** all log lines from the child include `"requestId":"123"`

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
The system SHALL initialize `@sentry/node` (or `@sentry/nextjs` for the Next.js app) in all Node.js application entry points. Configuration SHALL include DSN, environment, and release from `package.json` version.

#### Scenario: Unhandled exception captured
- **WHEN** an unhandled exception is thrown in the Node.js agent process
- **THEN** the exception is reported to Sentry before the process exits

#### Scenario: Next.js server error captured
- **WHEN** a server-side error occurs in a Next.js API route or Server Component
- **THEN** the error is captured by `@sentry/nextjs` with request context

### Requirement: Sentry Breadcrumbs in Critical Paths
The system SHALL record Sentry breadcrumbs at key decision points: credential rotation events, notification delivery attempts, and gRPC call failures.

#### Scenario: Credential rotation breadcrumb
- **WHEN** the credential pool performs a symlink swap rotation
- **THEN** a Sentry breadcrumb is recorded with category `credential` and the account name

#### Scenario: Notification delivery breadcrumb
- **WHEN** the notification engine attempts TTS or push delivery
- **THEN** a Sentry breadcrumb is recorded with category `notification` and delivery method

#### Scenario: gRPC failure breadcrumb
- **WHEN** a gRPC call to a peer agent fails
- **THEN** a Sentry breadcrumb is recorded with category `grpc`, peer address, and error status

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
The system SHALL create named spans for: session start/stop lifecycle, credential rotation cycle, gRPC `StreamEvents` calls, and health collection rounds.

#### Scenario: Session lifecycle span
- **WHEN** a session start event is received via the Unix socket
- **THEN** a span named `session.start` is created with `session_id` attribute

#### Scenario: Credential rotation span
- **WHEN** the credential pool begins a rotation cycle
- **THEN** a span named `credential.rotation` is created covering the full scan-parse-swap cycle

#### Scenario: Health collection span
- **WHEN** the health collector runs its periodic collection
- **THEN** a span named `health.collect` is created with `agent_name` attribute

