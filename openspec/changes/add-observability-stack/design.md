## Context

Nexus is a Node.js + Rust hybrid monorepo deployed across a Tailscale mesh with role-based
topology (datastore on homelab, notifier on Mac). The Rust side (nexus-agent, nexus-tui,
nexus-mcp) already uses `tracing` + `tracing-subscriber` with `EnvFilter`. The Node.js side
(Next.js frontend, Bun agent, nexus-register CLI) has a minimal custom logger that wraps
`console.log` with JSON formatting. There is no error tracking, no distributed tracing, and
no structured logging correlation across the stack.

Key stakeholders: the developer (single user), but production reliability matters because
nexus-agent runs as a systemd/launchd daemon across multiple machines.

## Goals / Non-Goals

**Goals:**
- Structured, level-filtered logging on both Node.js and Rust sides
- Centralized crash/error tracking via Sentry for all binaries
- Visibility into Anthropic API call health (usage queries)
- Trace context correlation across gRPC calls between agent, TUI, and MCP

**Non-Goals:**
- Replacing `tracing` on the Rust side (it stays; we layer OTel on top)
- Adding Prometheus metrics export (future work)
- Browser-side Sentry for the Next.js frontend (server-side only in Phase 2; client can be added later)
- Centralized log aggregation service (logs stay local; OTel traces go to Sentry or Jaeger)

## Decisions

### D1: Pino for Node.js logging
**Decision:** Replace the custom logger with Pino.
**Why:** Pino is the fastest structured logger for Node.js, supports child loggers, and has a
native OTel transport. The existing logger duplicates what Pino does but without performance
optimizations, child context, or transport extensibility.
**Alternatives:** Winston (heavier, slower), Bunyan (unmaintained), keep custom (no OTel path).

### D2: Sentry for both Rust and Node.js
**Decision:** Use the official `sentry` Rust crate and `@sentry/node` / `@sentry/nextjs`.
**Why:** Sentry provides a single pane for errors across both runtimes. The Rust crate hooks
into `tracing` via `sentry-tracing`, and the Node.js SDK has first-class Next.js support.
**Alternatives:** Datadog (overkill for single-user), self-hosted ELK (heavy), Axiom (good but
Sentry already has AI monitoring).

### D3: Sentry AI monitoring over custom instrumentation
**Decision:** Use Sentry's built-in AI agent monitoring spans rather than building custom
dashboards for Anthropic API health.
**Why:** Sentry AI monitoring provides latency tracking, token counting, and error grouping
out of the box. The Anthropic API calls are HTTP-based (`reqwest`), so wrapping them in Sentry
spans is trivial.
**Alternatives:** Custom PostHog events (already available but lacks trace correlation),
Datadog APM (overkill).

### D4: `tracing-opentelemetry` layer, not replacement
**Decision:** Add OTel as an additional `tracing-subscriber` layer, keeping the existing
`fmt` layer for local stdout.
**Why:** The existing `tracing` setup works well for local debugging. OTel adds export
capability without disrupting the current developer experience. The subscriber composition
pattern (`Registry` + `fmt::Layer` + `OpenTelemetryLayer`) is well-documented.
**Alternatives:** Replace `tracing` with OTel SDK directly (invasive, loses `tracing` macros).

### D5: OTLP exporter to Sentry
**Decision:** Use `opentelemetry-otlp` with Sentry's OTLP ingest endpoint as the default
backend.
**Why:** Sentry supports OTLP ingest, keeping everything in one tool. If a local Jaeger is
preferred for development, the endpoint is just an env var swap.
**Alternatives:** Jaeger-only (no error tracking), separate backends for traces and errors
(more operational complexity).

### D6: Pino logger lives in packages/core
**Decision:** Keep the logger in `packages/core/src/logger.ts` (same file, rewritten).
**Why:** All Node.js apps already depend on `@nexus/core`. No new package needed.
**Alternatives:** Separate `@nexus/logger` package (unnecessary indirection for 3 consumers).

## Risks / Trade-offs

- **Binary size increase (Rust):** The `sentry` crate + `opentelemetry` + `tracing-opentelemetry`
  will add to compile time and binary size. Mitigation: use feature flags to make OTel opt-in
  (disabled in release builds if not needed).
- **Runtime overhead:** Sentry and OTel add per-request overhead. Mitigation: Sentry's
  `traces_sample_rate` defaults to a low value; OTel batch exporter buffers spans.
- **Env var proliferation:** Four new env vars (`LOG_LEVEL`, `SENTRY_DSN`, `SENTRY_ENVIRONMENT`,
  `OTEL_EXPORTER_OTLP_ENDPOINT`). Mitigation: only `SENTRY_DSN` is required; others have sensible
  defaults. Document in `.env.example`.
- **Anthropic token leakage:** Sentry could capture `Authorization` headers. Mitigation: configure
  `before_send_transaction` to strip authorization headers and use Sentry's `send_default_pii: false`.

## Migration Plan

1. **Phase 1 (logging):** Drop-in replacement. The `logger` export from `@nexus/core` changes
   from custom to Pino, but the `.info()`, `.error()`, `.warn()`, `.debug()` API shape is
   preserved. Callers update imports if using `LogLevel`/`LogEntry` types (these become Pino types).
2. **Phase 2 (Sentry):** Additive. Sentry init is added at process entry points. No existing
   code is removed.
3. **Phase 2b (AI monitoring):** Additive. Wraps existing `query_usage()` calls in Sentry spans.
4. **Phase 3 (OTel):** Additive. Composes a new layer into the existing tracing subscriber.

Rollback: each phase is independently revertable. Removing Sentry init or OTel layer does not
affect application logic.

## Open Questions

- Should the Next.js client-side Sentry SDK be included in Phase 2 or deferred? (Current
  proposal defers it.)
- Is there a preferred Sentry project/org already configured, or should we create a new one?
- Should OTel traces also feed into PostHog for session replay correlation?
