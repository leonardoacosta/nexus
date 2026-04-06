# Change: Improve Platform Observability — Cross-Cutting Gaps

## Why

A platform audit (2026-04-06) identified ten observability gaps spanning credential management, session handling, health monitoring, and the TUI client. The most significant risks are: Authorization headers leaking into Sentry from Next.js configs (P2), unauthenticated internal HTTP pushes carrying credential metadata (P3), and silently-swallowed cleanup-timer rejections that mask runtime errors. Closing these gaps brings the platform to a consistent, auditable observability baseline.

## What Changes

- **Sentry `beforeSend` hook**: Add to all Next.js Sentry configs (`apps/nextjs/sentry.server.config.ts`, `sentry.client.config.ts`, `sentry.edge.config.ts`) to scrub `Authorization`, `x-nexus-secret`, and `Cookie` request headers before events leave the process.
- **Credential import breadcrumbs (Rust)**: Add `sentry::add_breadcrumb` calls inside `bootstrap_import_credential` and `import_credential_to_pool` in `crates/nexus-agent/src/services/credential_pool.rs`.
- **Credential lifecycle OTel/Sentry spans (Node.js)**: Wrap `lease`, `release`, and `reportRateLimit` in `apps/agent/src/credentials/pool.ts` with OTel spans; add Sentry breadcrumbs on each transition.
- **Menubar push authentication**: Add `x-nexus-secret` header to all POST requests in `push_to_menubars` (`crates/nexus-agent/src/services/credential_watcher.rs`); read secret from `NEXUS_INTERNAL_SECRET` env var.
- **Cleanup timer error handling**: Replace `void this.recoverExpiredCooldowns()` and `void this.cleanupStaleLeases()` with `.catch(err => logger.error(err, 'cleanup failed'))` chains in `apps/agent/src/credentials/pool.ts`.
- **Pino child loggers in health modules**: Derive child loggers with `{ component: 'health-collector' }` and `{ component: 'health-scheduler' }` in `apps/agent/src/health-collector.ts` and `health-scheduler.ts`.
- **sessionsCache factory pattern**: Replace module-level `sessionsCache` singleton in `apps/agent/src/routes/sessions.ts` with a factory or injectable parameter to prevent test bleed.
- **TUI key logging**: Log key events at `TRACE` level via `tracing` in `crates/nexus-tui/src/` event loop when `RUST_LOG=trace` is active.
- **TUI data freshness indicator**: Render a last-updated timestamp in the TUI status bar so operators can distinguish stale from live data.

## Impact

- Affected specs: `observability-stack`
- Affected code:
  - `apps/nextjs/sentry.server.config.ts`, `sentry.client.config.ts`, `sentry.edge.config.ts`
  - `apps/agent/src/credentials/pool.ts`
  - `apps/agent/src/routes/sessions.ts`
  - `apps/agent/src/health-collector.ts`, `health-scheduler.ts`
  - `crates/nexus-agent/src/services/credential_pool.rs`
  - `crates/nexus-agent/src/services/credential_watcher.rs`
  - `crates/nexus-tui/src/app.rs` (or equivalent event-loop file)
- No breaking changes to external APIs or DB schema.
- `NEXUS_INTERNAL_SECRET` env var is required in production for authenticated menubar pushes.
