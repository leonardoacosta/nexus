# Change: Add Observability Stack

## Why
Nexus has no centralized error tracking, no structured logging on the Node.js side, and no
distributed tracing across its Rust + Node.js hybrid architecture. Failures in the agent daemon,
TUI client, or Next.js frontend are only visible via raw stdout/stderr. Adding Sentry, Pino, and
OpenTelemetry correlation gives us crash visibility, structured log search, and cross-service
trace context across the Tailscale mesh.

## What Changes

### Phase 1: Standardize Pino Logging (Node.js)
- Replace the custom `packages/core/src/logger.ts` with Pino-based `createLogger` factory
- Replace `console.log`/`console.error` calls in `apps/nexus-register/src/index.ts`
- Add `LOG_LEVEL` env var support (default: `info`)
- Rust side already uses `tracing` with `EnvFilter` — no changes needed there

### Phase 2: Add Sentry Integration
- Add `@sentry/node` to Node.js apps (`apps/nextjs`, `apps/agent`, `apps/nexus-register`)
- Add `sentry` crate to Rust crates (`nexus-agent`, `nexus-tui`, `nexus-mcp`)
- Configure DSN via `SENTRY_DSN` env var, environment tagging, release tracking
- Add breadcrumbs in critical paths: credential rotation, gRPC failures, notification delivery

### Phase 2b: Sentry AI Agent Monitoring
- Add `sentryAIIntegration()` for Anthropic API calls in the credential pool usage queries
- Configure privacy controls (PII scrubbing on access tokens)
- Monitor Anthropic OAuth usage API call latency and failure rates

### Phase 3: OTel + Tracing Correlation
- Add `tracing-opentelemetry` to Rust crates for span export
- Add `pino-opentelemetry-transport` to Node.js apps
- Inject `traceId`/`spanId` into Pino log output and tracing subscriber
- Custom spans for key operations: session lifecycle, credential rotation, gRPC calls, health checks

## Impact
- Affected specs: `core` (logger module changes), `credential-pool` (breadcrumbs), `failure-store` (Sentry integration)
- Affected code:
  - `packages/core/src/logger.ts` — rewrite to Pino factory
  - `apps/nexus-register/src/index.ts` — adopt Pino logger
  - `apps/nextjs/` — Sentry SDK init, instrumentation
  - `apps/agent/` — Sentry SDK init
  - `crates/nexus-agent/Cargo.toml` + `src/main.rs` — sentry crate, tracing-opentelemetry
  - `crates/nexus-tui/Cargo.toml` + `src/main.rs` — sentry crate
  - `crates/nexus-core/Cargo.toml` — shared sentry types (optional)
  - `crates/nexus-mcp/Cargo.toml` + `src/main.rs` — sentry crate
- New dependencies: `pino`, `@sentry/node`, `@sentry/nextjs`, `pino-opentelemetry-transport`, `sentry` (Rust), `tracing-opentelemetry`, `opentelemetry-otlp`
- New env vars: `LOG_LEVEL`, `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `OTEL_EXPORTER_OTLP_ENDPOINT`
