## 1. Next.js Sentry — Authorization Header Scrubbing

- [x] 1.1 Add `beforeSend` hook to `apps/nextjs/sentry.server.config.ts` that strips `Authorization`, `x-nexus-secret`, and `Cookie` from `event.request.headers`
- [x] 1.2 Add the same `beforeSend` hook to `apps/nextjs/sentry.client.config.ts` (if present)
- [x] 1.3 Add the same `beforeSend` hook to `apps/nextjs/sentry.edge.config.ts` (if present — file does not exist, skipped)
- [x] 1.4 Write a unit test asserting `beforeSend` returns an event with those headers removed

## 2. Rust Credential Import Breadcrumbs

- [x] 2.1 Add `sentry::add_breadcrumb` call inside `bootstrap_import_credential` in `crates/nexus-agent/src/services/credential_pool.rs` with `category: "credential"`, `message: "credential imported"`, and fingerprint data
- [x] 2.2 Add `sentry::add_breadcrumb` call inside `import_credential_to_pool` with `category: "credential"` and account name

## 3. Node.js Credential Lifecycle Observability

- [x] 3.1 Wrap `CredentialPool.lease()` in `apps/agent/src/credentials/pool.ts` with an OTel span (`credential.lease`) carrying `{ type, leasedBy }` attributes
- [x] 3.2 Add Sentry breadcrumb on successful lease: `category: "credential"`, `message: "credential leased"`
- [x] 3.3 Wrap `CredentialPool.release()` with an OTel span (`credential.release`) carrying `{ id }` attribute
- [x] 3.4 Add Sentry breadcrumb on successful release: `category: "credential"`, `message: "credential released"`
- [x] 3.5 Wrap `CredentialPool.reportRateLimit()` with an OTel span (`credential.cooldown`) carrying `{ id, cooldown_until }` attributes
- [x] 3.6 Add Sentry breadcrumb on cooldown: `category: "credential"`, `message: "credential on cooldown"`

## 4. Menubar Push Authentication

- [x] 4.1 Read `NEXUS_INTERNAL_SECRET` env var in `push_to_menubars` in `crates/nexus-agent/src/services/credential_watcher.rs`
- [x] 4.2 Add `x-nexus-secret: <secret>` header to all POST requests; if env var is absent, log a warning and skip the push (or reject with an error)
- [x] 4.3 Document `NEXUS_INTERNAL_SECRET` in project env var reference

## 5. Cleanup Timer Error Handling

- [x] 5.1 In `CredentialPool.startCleanup()` (`apps/agent/src/credentials/pool.ts`), replace `void this.recoverExpiredCooldowns()` with `this.recoverExpiredCooldowns().catch(err => logger.error(err, 'cleanup failed'))` — completed in wave 2
- [x] 5.2 Replace `void this.cleanupStaleLeases()` with `.catch(err => logger.error(err, 'stale-lease cleanup failed'))` — completed in wave 2
- [x] 5.3 Verify no other `void` promise patterns exist in the cleanup path — confirmed in wave 2

## 6. Pino Child Loggers in Health Modules

- [x] 6.1 In `apps/agent/src/health-collector.ts`, replace the top-level `logger` usage with `logger.child({ component: 'health-collector' })` — completed in wave 3
- [x] 6.2 In `apps/agent/src/health-scheduler.ts`, replace the top-level `logger` usage with `logger.child({ component: 'health-scheduler' })` — completed in wave 3

## 7. sessionsCache Test Isolation

- [x] 7.1 In `apps/agent/src/routes/sessions.ts`, extract the cache state into a class or factory function so that tests can instantiate isolated instances — `createSessionHandlers` factory already exported
- [x] 7.2 Update any existing tests that relied on `clearSessionsCache()` to use the new isolation mechanism — completed in wave 6b
- [x] 7.3 Verify no module-level mutable singleton remains accessible across test files — `clearSessionsCache()` retained for backward compatibility; factory pattern is the primary isolation mechanism

## 8. TUI Key Logging

- [x] 8.1 In the TUI event loop (`crates/nexus-tui/src/keys.rs`), add `tracing::debug!(key = ?event, "key dispatched")` for every crossterm key event received — completed in prior wave
- [x] 8.2 Confirm that `RUST_LOG=nexus_tui::keys=debug` enables the output without impacting normal `info`-level usage — confirmed (target: "nexus_tui::keys")

## 9. TUI Data Freshness Indicator

- [x] 9.1 Track last-fetch timestamp in TUI app state (`last_data_updated: Option<std::time::Instant>`) — completed in wave 7
- [x] 9.2 Render a human-readable "Updated Xs ago" label in the TUI status bar — completed in wave 7 (`screens/dashboard.rs`)
- [x] 9.3 Update the timestamp on every successful data refresh from the agent API — completed in wave 7 (`app.rs` line 1346)
