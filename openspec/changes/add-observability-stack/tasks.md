## 1. Phase 1 — Standardize Pino Logging (Node.js)
- [ ] 1.1 Add `pino` dependency to `packages/core/package.json`
- [ ] 1.2 Rewrite `packages/core/src/logger.ts` — Pino-based `createLogger(name)` factory with `LOG_LEVEL` env var, JSON output, child logger support
- [ ] 1.3 Export `createLogger` and `Logger` type from `packages/core/src/index.ts`
- [ ] 1.4 Replace `console.error` in `apps/nexus-register/src/index.ts` with Pino logger
- [ ] 1.5 Add `pino-pretty` as devDependency for local development
- [ ] 1.6 Verify: `LOG_LEVEL=debug bun run apps/nexus-register/src/index.ts start` emits structured JSON

## 2. Phase 2 — Sentry Integration
- [ ] 2.1 Add `@sentry/node` to `apps/agent/package.json`, create `apps/agent/src/instrument.ts` with `Sentry.init()`
- [ ] 2.2 Add `@sentry/nextjs` to `apps/nextjs/package.json`, create `apps/nextjs/sentry.server.config.ts` and `sentry.client.config.ts`
- [ ] 2.3 Add `sentry` crate to `Cargo.toml` workspace dependencies
- [ ] 2.4 Initialize Sentry in `crates/nexus-agent/src/main.rs` — `sentry::init()` with DSN, environment, release
- [ ] 2.5 Initialize Sentry in `crates/nexus-tui/src/main.rs`
- [ ] 2.6 Initialize Sentry in `crates/nexus-mcp/src/main.rs`
- [ ] 2.7 Add breadcrumbs in `crates/nexus-agent/src/services/credential_pool.rs` — credential rotation events
- [ ] 2.8 Add breadcrumbs in `crates/nexus-agent/src/notification_engine.rs` — notification delivery
- [ ] 2.9 Add breadcrumbs in `crates/nexus-agent/src/grpc/` — gRPC call failures
- [ ] 2.10 Configure `SENTRY_DSN` and `SENTRY_ENVIRONMENT` in `.env` template / Doppler
- [ ] 2.11 Verify: trigger a panic in dev and confirm it appears in Sentry dashboard

## 3. Phase 2b — Sentry AI Agent Monitoring
- [ ] 3.1 Identify all Anthropic API call sites — `crates/nexus-agent/src/usage_api.rs` (`query_usage`), `crates/nexus-agent/src/services/credential_pool.rs`
- [ ] 3.2 Add Sentry spans wrapping `query_usage()` calls with `op: "ai"` metadata
- [ ] 3.3 Configure PII scrubbing — ensure access tokens in `Authorization` headers are not captured
- [ ] 3.4 Add custom Sentry tags: `ai.provider: anthropic`, `ai.operation: usage_query`
- [ ] 3.5 Verify: confirm AI spans appear in Sentry Performance with correct tags

## 4. Phase 3 — OTel + Tracing Correlation
- [ ] 4.1 Add `opentelemetry`, `opentelemetry-otlp`, `tracing-opentelemetry` to Rust workspace dependencies
- [ ] 4.2 Update `crates/nexus-agent/src/main.rs` — compose `tracing-opentelemetry` layer into subscriber
- [ ] 4.3 Update `crates/nexus-tui/src/main.rs` — same OTel subscriber layer
- [ ] 4.4 Update `crates/nexus-mcp/src/main.rs` — same OTel subscriber layer
- [ ] 4.5 Add `pino-opentelemetry-transport` to `packages/core/package.json`
- [ ] 4.6 Update `createLogger` factory to optionally attach OTel transport when `OTEL_EXPORTER_OTLP_ENDPOINT` is set
- [ ] 4.7 Inject `traceId` and `spanId` into Pino log serialization
- [ ] 4.8 Add custom spans for: session start/stop, credential rotation cycle, gRPC StreamEvents, health collection
- [ ] 4.9 Verify: end-to-end trace from Next.js request through agent gRPC call with correlated logs
