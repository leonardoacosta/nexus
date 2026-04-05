<!-- beads:epic:nx-sgh8 -->

## 1. Phase 1 — Standardize Pino Logging (Node.js)
- [x] 1.1 Add `pino` dependency to `packages/core/package.json` [beads:nx-c960]
- [x] 1.2 Rewrite `packages/core/src/logger.ts` — Pino-based `createLogger(name)` factory with `LOG_LEVEL` env var, JSON output, child logger support [beads:nx-pida]
- [x] 1.3 Export `createLogger` and `Logger` type from `packages/core/src/index.ts` [beads:nx-pxtd]
- [x] 1.4 Replace `console.error` in `apps/nexus-register/src/index.ts` with Pino logger [beads:nx-66up]
- [x] 1.5 Add `pino-pretty` as devDependency for local development [beads:nx-2aaj]
- [x] 1.6 Verify: `LOG_LEVEL=debug bun run apps/nexus-register/src/index.ts start` emits structured JSON [beads:nx-47ab]

## 2. Phase 2 — Sentry Integration
- [x] 2.1 Add `@sentry/node` to `apps/agent/package.json`, create `apps/agent/src/instrument.ts` with `Sentry.init()` [beads:nx-bdno]
- [x] 2.2 Add `@sentry/nextjs` to `apps/nextjs/package.json`, create `apps/nextjs/sentry.server.config.ts` and `sentry.client.config.ts` [beads:nx-v1yt]
- [x] 2.3 Add `sentry` crate to `Cargo.toml` workspace dependencies [beads:nx-4dit]
- [x] 2.4 Initialize Sentry in `crates/nexus-agent/src/main.rs` — `sentry::init()` with DSN, environment, release [beads:nx-qmw4]
- [x] 2.5 Initialize Sentry in `crates/nexus-tui/src/main.rs` [beads:nx-jo6o]
- [x] 2.6 Initialize Sentry in `crates/nexus-mcp/src/main.rs` [beads:nx-prbv]
- [x] 2.7 Add breadcrumbs in `crates/nexus-agent/src/services/credential_pool.rs` — credential rotation events [beads:nx-nudq]
- [x] 2.8 Add breadcrumbs in `crates/nexus-agent/src/notification_engine.rs` — notification delivery [beads:nx-od80]
- [x] 2.9 Add breadcrumbs in `crates/nexus-agent/src/grpc/` — gRPC call failures [beads:nx-go4f]
- [x] 2.10 Configure `SENTRY_DSN` and `SENTRY_ENVIRONMENT` in `.env` template / Doppler [beads:nx-725f]
- [x] 2.11 Verify: trigger a panic in dev and confirm it appears in Sentry dashboard [beads:nx-jz8w]

## 3. Phase 2b — Sentry AI Agent Monitoring
- [x] 3.1 Identify all Anthropic API call sites — `crates/nexus-agent/src/usage_api.rs` (`query_usage`), `crates/nexus-agent/src/services/credential_pool.rs` [beads:nx-cyeh]
- [x] 3.2 Add Sentry spans wrapping `query_usage()` calls with `op: "ai"` metadata [beads:nx-6dm3]
- [x] 3.3 Configure PII scrubbing — ensure access tokens in `Authorization` headers are not captured [beads:nx-ezym]
- [x] 3.4 Add custom Sentry tags: `ai.provider: anthropic`, `ai.operation: usage_query` [beads:nx-w2d6]
- [x] 3.5 Verify: confirm AI spans appear in Sentry Performance with correct tags [beads:nx-mid0]

## 4. Phase 3 — OTel + Tracing Correlation
- [x] 4.1 Add `opentelemetry`, `opentelemetry-otlp`, `tracing-opentelemetry` to Rust workspace dependencies [beads:nx-5io7]
- [x] 4.2 Update `crates/nexus-agent/src/main.rs` — compose `tracing-opentelemetry` layer into subscriber [beads:nx-oie5]
- [x] 4.3 Update `crates/nexus-tui/src/main.rs` — same OTel subscriber layer [beads:nx-et5r]
- [x] 4.4 Update `crates/nexus-mcp/src/main.rs` — same OTel subscriber layer [beads:nx-34rs]
- [x] 4.5 Add `pino-opentelemetry-transport` to `packages/core/package.json` [beads:nx-y4hu]
- [x] 4.6 Update `createLogger` factory to optionally attach OTel transport when `OTEL_EXPORTER_OTLP_ENDPOINT` is set [beads:nx-31jd]
- [x] 4.7 Inject `traceId` and `spanId` into Pino log serialization [beads:nx-h4uf]
- [x] 4.8 Add custom spans for: session start/stop, credential rotation cycle, gRPC StreamEvents, health collection [beads:nx-gg2c]
- [x] 4.9 Verify: end-to-end trace from Next.js request through agent gRPC call with correlated logs [beads:nx-gufw]
