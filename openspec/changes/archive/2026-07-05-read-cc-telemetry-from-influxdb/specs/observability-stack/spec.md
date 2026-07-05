# observability-stack Specification

## REMOVED Requirements

### Requirement: Sentry Error Tracking — Rust Binaries
**Reason**: The Rust binaries this requirement targets (`nexus-agent`, `nexus-tui`, `nexus-mcp`) no
longer exist. `nexus-agent` is now a Bun/TypeScript process (`bun build --compile`) covered by the
retained `Sentry Error Tracking — Node.js Applications` requirement, and `nexus-tui` (ratatui) is
retired. The `sentry` Rust crate is not a dependency of the current codebase.
**Migration**: Node.js agent error tracking is already provided by `apps/agent/src/instrument.ts`
(`@sentry/node`), governed by the unchanged `Sentry Error Tracking — Node.js Applications`
requirement. No runtime behavior is lost.

### Requirement: OpenTelemetry Trace Export — Rust
**Reason**: This requirement specifies `tracing-opentelemetry` trace export from Rust binaries that
no longer exist. Nexus's telemetry posture is now read-not-write: it consumes Claude Code's native
`claude_code_*` telemetry from the homelab's VictoriaMetrics store (see capability
`cc-telemetry-read`) rather than self-exporting spans via an OTEL SDK. There is no Rust OTel layer
to compose and no nexus-side OTLP exporter.
**Migration**: Per-session cost / token observability is provided by the `cc-telemetry-read`
capability (reading `claude_code_cost_usage_USD_total` / `claude_code_token_usage_total` from
VictoriaMetrics). Self-export of nexus application spans is intentionally not pursued; if
app-level tracing is wanted later it will be specified as a new requirement against the Bun/TS
runtime, not reinstated here.
